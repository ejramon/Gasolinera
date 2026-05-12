const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3001;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

app.use(cors());
app.use(express.json());

// Sirve index.html inyectando la API key de Google Maps
app.get('/', (req, res) => {
  let html = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');
  html = html.replace('GOOGLE_MAPS_KEY', process.env.GOOGLE_MAPS_KEY || '');
  res.send(html);
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── SSE ─────────────────────────────────────────────────────────────────────

const sseClients = new Set();

app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(':connected\n\n');
  const heartbeat = setInterval(() => res.write(':heartbeat\n\n'), 30000);
  sseClients.add(res);
  req.on('close', () => { clearInterval(heartbeat); sseClients.delete(res); });
});

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(c => c.write(msg));
}

// ─── GET /api/stations ────────────────────────────────────────────────────────

app.get('/api/stations', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, nombre, direccion, lat, lng,
             tiene_gasolina, votos_hay, votos_no_hay,
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

// ─── POST /api/vote ───────────────────────────────────────────────────────────

app.post('/api/vote', async (req, res) => {
  const { gasolinera_id, tiene_gasolina } = req.body;
  if (!gasolinera_id || typeof tiene_gasolina !== 'boolean') {
    return res.status(400).json({ error: 'Datos inválidos' });
  }

  // Hash de IP para anti-spam anónimo
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
  const ip_hash = crypto.createHash('sha256').update(ip + 'gasolinaec_salt').digest('hex');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Registrar voto (falla silenciosamente si ya votó en esta hora)
    await client.query(`
      INSERT INTO votos (gasolinera_id, ip_hash, tiene_gasolina)
      VALUES ($1, $2, $3)
      ON CONFLICT DO NOTHING
    `, [gasolinera_id, ip_hash, tiene_gasolina]);

    // Recalcular conteos
    const { rows: counts } = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE tiene_gasolina = true)  AS hay,
        COUNT(*) FILTER (WHERE tiene_gasolina = false) AS no_hay
      FROM votos
      WHERE gasolinera_id = $1
        AND created_at > NOW() - INTERVAL '20 minutes'
    `, [gasolinera_id]);

    const hay = parseInt(counts[0].hay);
    const no_hay = parseInt(counts[0].no_hay);
    const total = hay + no_hay;

    // Calcular estado: necesita al menos 3 votos, y 60% de mayoría
    let nuevo_estado = null;
    if (total >= 2) {
      if (hay / total >= 0.6) nuevo_estado = true;
      else if (no_hay / total >= 0.6) nuevo_estado = false;
    }

    // Actualizar gasolinera
    let updatedStation;
    if (nuevo_estado !== null) {
      const { rows } = await client.query(`
        UPDATE gasolineras
        SET tiene_gasolina = $1, votos_hay = $2, votos_no_hay = $3, updated_at = NOW()
        WHERE id = $4
        RETURNING id, nombre, lat, lng, tiene_gasolina, votos_hay, votos_no_hay,
                  to_char(updated_at AT TIME ZONE 'America/Guayaquil', 'HH24:MI') AS updated_at
      `, [nuevo_estado, hay, no_hay, gasolinera_id]);
      updatedStation = rows[0];
    } else {
      const { rows } = await client.query(`
        UPDATE gasolineras SET votos_hay = $1, votos_no_hay = $2
        WHERE id = $3
        RETURNING id, nombre, lat, lng, tiene_gasolina, votos_hay, votos_no_hay,
                  to_char(updated_at AT TIME ZONE 'America/Guayaquil', 'HH24:MI') AS updated_at
      `, [hay, no_hay, gasolinera_id]);
      updatedStation = rows[0];
    }

    await client.query('COMMIT');

    broadcast({ type: 'status_update', station: updatedStation });
    res.json({ ok: true, station: updatedStation });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error al votar' });
  } finally {
    client.release();
  }
});

app.listen(PORT, () => console.log(`GasolinaEC corriendo en puerto ${PORT}`));
