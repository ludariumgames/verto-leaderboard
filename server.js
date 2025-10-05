/**
 * Verto Leaderboard server
 * ------------------------
 * Что нужно настроить на Render (Settings → Environment):
 *   - DATABASE_URL = ВАША_СТРОКА_ИЗ_NEON (postgresql://...sslmode=require&channel_binding=require)
 *   - APP_SECRET   = ТОТ_ЖЕ_СЕКРЕТ, ЧТО В Android (gradle.properties → LEADERBOARD_APP_SECRET)
 */

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// === СЕКРЕТ: сервер принимает запись только с правильным X-App-Secret ===
const APP_SECRET =
  process.env.APP_SECRET ||
  process.env.LEADERBOARD_APP_SECRET || // на всякий случай поддержим оба имени
  '';

function requireSecret(req, res, next) {
  if (!APP_SECRET) return res.status(500).json({ error: 'server_misconfigured' });
  const got = req.get('X-App-Secret') || '';
  if (got !== APP_SECRET) return res.status(403).json({ error: 'forbidden' });
  next();
}

// === БД: строка подключения из Neon в переменной окружения DATABASE_URL ===
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // вставлять вручную НЕ нужно — задаётся в Render
  ssl: { rejectUnauthorized: false } // это нужно для Neon
});

// создаём таблицу, если её ещё нет
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL DEFAULT 'Player',
      rating_classic INT NOT NULL DEFAULT 1000,
      rating_infinity INT NOT NULL DEFAULT 1000,
      achievements_count INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_players_rc ON players (rating_classic DESC, updated_at ASC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_players_ri ON players (rating_infinity DESC, updated_at ASC);`);
}

// healthcheck
app.get('/ping', (_, res) => res.send('pong'));

// === POST /api/upsert (write, требует X-App-Secret) ===
// Тело запроса (JSON):
// { deviceId, username, ratingClassic, ratingInfinity, achievementsCount }
app.post('/api/upsert', requireSecret, async (req, res) => {
  try {
    const { deviceId, username, ratingClassic, ratingInfinity, achievementsCount } = req.body || {};
    if (!deviceId) return res.status(400).json({ error: 'deviceId_required' });

    const q = `
      INSERT INTO players (id, username, rating_classic, rating_infinity, achievements_count, updated_at)
      VALUES ($1, COALESCE($2, 'Player'), COALESCE($3, 1000), COALESCE($4, 1000), COALESCE($5, 0), now())
      ON CONFLICT (id) DO UPDATE SET
        username = COALESCE(EXCLUDED.username, players.username),
        rating_classic = COALESCE(EXCLUDED.rating_classic, players.rating_classic),
        rating_infinity = COALESCE(EXCLUDED.rating_infinity, players.rating_infinity),
        achievements_count = COALESCE(EXCLUDED.achievements_count, players.achievements_count),
        updated_at = now()
      RETURNING
        id,
        username,
        rating_classic   AS "ratingClassic",
        rating_infinity  AS "ratingInfinity",
        achievements_count AS "achievementsCount",
        updated_at       AS "updatedAt";
    `;
    const { rows } = await pool.query(q, [
      deviceId,
      username ?? null,
      ratingClassic ?? null,
      ratingInfinity ?? null,
      achievementsCount ?? null
    ]);
    res.json(rows[0]);
  } catch (e) {
    console.error('upsert error', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// === GET /api/top?mode=classic|infinity&limit=10 ===
// Ответ: { items: ApiPlayer[] }
app.get('/api/top', async (req, res) => {
  try {
    const mode = req.query.mode === 'infinity' ? 'infinity' : 'classic';
    const limit = Math.max(1, Math.min(parseInt(req.query.limit || '10', 10), 50));

    const sqlClassic = `
      SELECT id, username,
             rating_classic  AS "ratingClassic",
             rating_infinity AS "ratingInfinity",
             achievements_count AS "achievementsCount",
             updated_at      AS "updatedAt"
      FROM players
      ORDER BY rating_classic DESC, updated_at ASC
      LIMIT $1;
    `;
    const sqlInfinity = `
      SELECT id, username,
             rating_classic  AS "ratingClassic",
             rating_infinity AS "ratingInfinity",
             achievements_count AS "achievementsCount",
             updated_at      AS "updatedAt"
      FROM players
      ORDER BY rating_infinity DESC, updated_at ASC
      LIMIT $1;
    `;

    const { rows } = await pool.query(mode === 'classic' ? sqlClassic : sqlInfinity, [limit]);
    res.json({ items: rows });
  } catch (e) {
    console.error('top error', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// === GET /api/me?device_id=...&mode=classic|infinity ===
// Ответ: { me: ApiPlayer|null, rank: number|null }
app.get('/api/me', async (req, res) => {
  try {
    const id = req.query.device_id;
    if (!id) return res.status(400).json({ error: 'device_id_required' });
    const mode = req.query.mode === 'infinity' ? 'infinity' : 'classic';

    const sqlRankClassic = `
      SELECT id, username,
             rating_classic  AS "ratingClassic",
             rating_infinity AS "ratingInfinity",
             achievements_count AS "achievementsCount",
             updated_at      AS "updatedAt",
             RANK() OVER (ORDER BY rating_classic DESC, updated_at ASC) AS r
      FROM players;
    `;
    const sqlRankInfinity = `
      SELECT id, username,
             rating_classic  AS "ratingClassic",
             rating_infinity AS "ratingInfinity",
             achievements_count AS "achievementsCount",
             updated_at      AS "updatedAt",
             RANK() OVER (ORDER BY rating_infinity DESC, updated_at ASC) AS r
      FROM players;
    `;

    const { rows } = await pool.query(mode === 'classic' ? sqlRankClassic : sqlRankInfinity);
    const meRow = rows.find((r) => r.id === id) || null;
    res.json({
      me: meRow ? {
        id: meRow.id,
        username: meRow.username,
        ratingClassic: meRow.ratingClassic,
        ratingInfinity: meRow.ratingInfinity,
        achievementsCount: meRow.achievementsCount,
        updatedAt: meRow.updatedAt
      } : null,
      rank: meRow ? Number(meRow.r) : null
    });
  } catch (e) {
    console.error('me error', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// стартуем сервер
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  try {
    await ensureTables();
    console.log('Leaderboard server listening on ' + PORT);
  } catch (e) {
    console.error('ensureTables error', e);
  }
});
