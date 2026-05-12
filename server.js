const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'cambia_esto_en_produccion';

// Pool de conexiones PostgreSQL — soporta alto tráfico
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,           // máximo 20 conexiones simultáneas
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

app.use(cors());
app.use(express.json());
app.get('/', (req, res) => {
  let html = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');
  html = html.replace('GOOGLE_MAPS_KEY', process.env.GOOGLE_MAPS_KEY || '');
  res.send(html);
});
app.use(express.static(path.join(__dirname, 'public')));

// ─── SSE: clientes conectados al mapa en tiempo real ───────────────────────

const sseClients = new Set();

app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // importante para nginx
  });
  res.flushHeaders();
  res.write(':connected\n\n');

  // Heartbeat cada 30s para mantener la conexión viva
  const heartbeat = setInterval(() => res.write(':heartbeat\n\n'), 30000);

  sseClients.add(res);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(client => client.write(msg));
}

// ─── GET /api/stations — Todas las estaciones con estado ──────────────────

app.get('/api/stations', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, nombre, direccion, lat, lng, tiene_gasolina,
             to_char(updated_at AT TIME ZONE 'America/Guayaquil', 'HH24:MI') AS updated_at
      FROM gasolineras
      ORDER BY nombre
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener estaciones' });
  }
});

// ─── POST /api/auth/login ─────────────────────────────────────────────────

app.post('/api/auth/login', async (req, res) => {
  const { cedula, password } = req.body;
  if (!cedula || !password) return res.status(400).json({ error: 'Faltan datos' });

  try {
    const { rows } = await pool.query(
      'SELECT * FROM gasolineras WHERE cedula = $1',
      [cedula.trim()]
    );
    if (!rows.length) return res.status(401).json({ error: 'Credenciales incorrectas' });

    const ok = await bcrypt.compare(password, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Credenciales incorrectas' });

    const token = jwt.sign({ id: rows[0].id }, JWT_SECRET, { expiresIn: '8h' });

    res.json({
      token,
      station: {
        id: rows[0].id,
        nombre: rows[0].nombre,
        direccion: rows[0].direccion,
        lat: rows[0].lat,
        lng: rows[0].lng,
        tiene_gasolina: rows[0].tiene_gasolina,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ─── Middleware de autenticación JWT ─────────────────────────────────────

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

// ─── PUT /api/stations/:id/status — Actualizar estado ────────────────────

app.put('/api/stations/:id/status', authMiddleware, async (req, res) => {
  const stationId = parseInt(req.params.id);

  // Solo el dueño puede actualizar su propia estación
  if (req.user.id !== stationId) {
    return res.status(403).json({ error: 'No tienes permiso para esto' });
  }

  const { tiene_gasolina } = req.body;
  if (typeof tiene_gasolina !== 'boolean') {
    return res.status(400).json({ error: 'tiene_gasolina debe ser boolean' });
  }

  try {
    const { rows } = await pool.query(`
      UPDATE gasolineras
      SET tiene_gasolina = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING id, nombre, lat, lng, tiene_gasolina,
                to_char(updated_at AT TIME ZONE 'America/Guayaquil', 'HH24:MI') AS updated_at
    `, [tiene_gasolina, stationId]);

    if (!rows.length) return res.status(404).json({ error: 'Estación no encontrada' });

    // Notificar a todos los usuarios del mapa en tiempo real
    broadcast({ type: 'status_update', station: rows[0] });

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar' });
  }
});

// ─── POST /api/stations/register — Registrar nueva gasolinera (admin) ────

app.post('/api/stations/register', async (req, res) => {
  const { cedula, password, nombre, direccion, lat, lng } = req.body;
  if (!cedula || !password || !nombre || !lat || !lng) {
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  }

  try {
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(`
      INSERT INTO gasolineras (cedula, password_hash, nombre, direccion, lat, lng)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, nombre
    `, [cedula, hash, nombre, direccion, lat, lng]);

    res.status(201).json({ id: rows[0].id, nombre: rows[0].nombre });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Cédula ya registrada' });
    console.error(err);
    res.status(500).json({ error: 'Error al registrar' });
  }
});

app.listen(PORT, () => {
  console.log(`GasolinaEC API corriendo en puerto ${PORT}`);
  console.log(`SSE clients activos: ${sseClients.size}`);
});

