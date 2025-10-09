/**
 * Verto Leaderboard server
 * ------------------------
 * Render → Settings → Environment:
 *   - DATABASE_URL = строка из Neon (postgresql://...sslmode=require&channel_binding=require)
 *   - APP_SECRET   = тот же секрет, что в Android (LEADERBOARD_APP_SECRET)
 */

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// === секрет ===
const APP_SECRET =
  process.env.APP_SECRET ||
  process.env.LEADERBOARD_APP_SECRET ||
  '';

function requireSecret(req, res, next) {
  if (!APP_SECRET) return res.status(500).json({ error: 'server_misconfigured' });
  const got = req.get('X-App-Secret') || '';
  if (got !== APP_SECRET) return res.status(403).json({ error: 'forbidden' });
  next();
}

// === БД ===
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// === подготовка схемы ===
async function ensureTables() {
  // базовая таблица (как у тебя было)
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

  // добавляем created_at «по-месту» (старые записи получат updated_at/now)
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;`);
  await pool.query(`UPDATE players SET created_at = COALESCE(created_at, updated_at, now());`);
  await pool.query(`ALTER TABLE players ALTER COLUMN created_at SET NOT NULL;`);
  await pool.query(`ALTER TABLE players ALTER COLUMN created_at SET DEFAULT now();`);

  // индексы под сортировку
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_players_sort_classic
      ON players (rating_classic DESC, achievements_count DESC, created_at ASC);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_players_sort_infinity
      ON players (rating_infinity DESC, achievements_count DESC, created_at ASC);
  `);
}

// healthcheck
app.get('/ping', (_, res) => res.send('pong'));

// === валидация/проверка ников ===
const NAME_RE = /^[A-Za-z0-9_. ]{3,16}$/;

app.get('/api/check-username', async (req, res) => {
  try {
    const name = (req.query.username || '').trim();
    if (!NAME_RE.test(name)) {
      return res.json({ ok: false, reason: 'bad_format' });
    }
    const q = `SELECT 1 FROM players WHERE LOWER(username) = LOWER($1) LIMIT 1;`;
    const { rows } = await pool.query(q, [name]);
    return res.json({ ok: rows.length === 0 });
  } catch (e) {
    console.error('check-username error', e);
    res.status(500).json({ ok: false, reason: 'server_error' });
  }
});

// === запись (upsert) — требует X-App-Secret ===
// body: { deviceId, username, ratingClassic, ratingInfinity, achievementsCount }
app.post('/api/upsert', requireSecret, async (req, res) => {
  try {
    const { deviceId, username, ratingClassic, ratingInfinity, achievementsCount } = req.body || {};
    if (!deviceId) return res.status(400).json({ error: 'deviceId_required' });

    // если передали имя — проверим формат и занятость (без уник. индекса)
    let finalUsername = username == null ? null : String(username).trim();
    if (finalUsername != null) {
      if (!NAME_RE.test(finalUsername)) {
        return res.status(400).json({ error: 'bad_format' });
      }
      const clash = await pool.query(
        `SELECT id FROM players WHERE LOWER(username) = LOWER($1) AND id <> $2 LIMIT 1;`,
        [finalUsername, deviceId]
      );
      if (clash.rows.length > 0) {
        return res.status(409).json({ error: 'username_taken' });
      }
    }

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
        rating_classic     AS "ratingClassic",
        rating_infinity    AS "ratingInfinity",
        achievements_count AS "achievementsCount",
        created_at         AS "createdAt",
        updated_at         AS "updatedAt";
    `;
    const { rows } = await pool.query(q, [
      deviceId,
      finalUsername ?? null,
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

// === ВЕСЬ рейтинг (новый эндпоинт) ===
// GET /api/leaderboard?mode=classic|infinity
// сортировка: рейтинг ↓, achievements_count ↓, created_at ↑
app.get('/api/leaderboard', async (req, res) => {
  try {
    const mode = req.query.mode === 'infinity' ? 'infinity' : 'classic';
    const { rows } = await pool.query(
      `
      SELECT
        id,
        username,
        rating_classic     AS "ratingClassic",
        rating_infinity    AS "ratingInfinity",
        achievements_count AS "achievementsCount",
        created_at         AS "createdAt",
        updated_at         AS "updatedAt",
        ROW_NUMBER() OVER (
          ORDER BY
            CASE WHEN $1 = 'infinity' THEN rating_infinity ELSE rating_classic END DESC,
            achievements_count DESC,
            created_at ASC
        ) AS rank
      FROM players
      ORDER BY
        CASE WHEN $1 = 'infinity' THEN rating_infinity ELSE rating_classic END DESC,
        achievements_count DESC,
        created_at ASC;
      `,
      [mode]
    );
    res.json({ items: rows });
  } catch (e) {
    console.error('leaderboard error', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// === Топ (совместимость) — теперь тоже отдаёт ВЕСЬ список ===
// GET /api/top?mode=classic|infinity&limit=10  (limit игнорируется)
app.get('/api/top', async (req, res) => {
  try {
    const mode = req.query.mode === 'infinity' ? 'infinity' : 'classic';
    const { rows } = await pool.query(
      `
      SELECT
        id,
        username,
        rating_classic     AS "ratingClassic",
        rating_infinity    AS "ratingInfinity",
        achievements_count AS "achievementsCount",
        created_at         AS "createdAt",
        updated_at         AS "updatedAt",
        ROW_NUMBER() OVER (
          ORDER BY
            CASE WHEN $1 = 'infinity' THEN rating_infinity ELSE rating_classic END DESC,
            achievements_count DESC,
            created_at ASC
        ) AS rank
      FROM players
      ORDER BY
        CASE WHEN $1 = 'infinity' THEN rating_infinity ELSE rating_classic END DESC,
        achievements_count DESC,
        created_at ASC;
      `,
      [mode]
    );
    res.json({ items: rows }); // весь список
  } catch (e) {
    console.error('top error', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// === Мой ранг/данные — считается по тем же правилам ===
// GET /api/me?device_id=...&mode=classic|infinity
app.get('/api/me', async (req, res) => {
  try {
    const id = req.query.device_id;
    if (!id) return res.status(400).json({ error: 'device_id_required' });
    const mode = req.query.mode === 'infinity' ? 'infinity' : 'classic';

    const { rows } = await pool.query(
      `
      WITH ranked AS (
        SELECT
          id,
          username,
          rating_classic     AS "ratingClassic",
          rating_infinity    AS "ratingInfinity",
          achievements_count AS "achievementsCount",
          created_at         AS "createdAt",
          updated_at         AS "updatedAt",
          ROW_NUMBER() OVER (
            ORDER BY
              CASE WHEN $1 = 'infinity' THEN rating_infinity ELSE rating_classic END DESC,
              achievements_count DESC,
              created_at ASC
          ) AS r
        FROM players
      )
      SELECT * FROM ranked WHERE id = $2;
      `,
      [mode, id]
    );

    if (rows.length === 0) {
      return res.json({ me: null, rank: null });
    }
    const meRow = rows[0];
    res.json({
      me: {
        id: meRow.id,
        username: meRow.username,
        ratingClassic: meRow.ratingClassic,
        ratingInfinity: meRow.ratingInfinity,
        achievementsCount: meRow.achievementsCount,
        createdAt: meRow.createdAt,
        updatedAt: meRow.updatedAt
      },
      rank: Number(meRow.r)
    });
  } catch (e) {
    console.error('me error', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// старт
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  try {
    await ensureTables();
    console.log('Leaderboard server listening on ' + PORT);
  } catch (e) {
    console.error('ensureTables error', e);
  }
});
