// server.js
import express from "express";
import morgan from "morgan";
import cors from "cors";
import { neon } from "@neondatabase/serverless";

const app = express();
app.use(express.json());
app.use(morgan("tiny"));
app.use(cors());

const sql = neon(process.env.DATABASE_URL);
const APP_SECRET = process.env.LEADERBOARD_APP_SECRET;

// --- security: обязательный секрет в заголовке для всех методов ---
app.use((req, res, next) => {
  const got = req.header("x-app-secret");
  if (!APP_SECRET || got !== APP_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

// --- База: ensure schema once ---
async function ensureSchema() {
  await sql/*sql*/`
    CREATE TABLE IF NOT EXISTS players (
      device_id         TEXT PRIMARY KEY,
      username          TEXT UNIQUE,
      rating_classic    INT  NOT NULL DEFAULT 0,
      rating_infinity   INT  NOT NULL DEFAULT 0,
      achievements_count INT NOT NULL DEFAULT 0,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;

  // Уникальность ника без учёта регистра (только для ненулевых username)
  await sql/*sql*/`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE indexname = 'idx_players_username_lower'
      ) THEN
        CREATE UNIQUE INDEX idx_players_username_lower
          ON players (LOWER(username))
          WHERE username IS NOT NULL;
      END IF;
    END$$;
  `;
}
ensureSchema().catch(console.error);

// --- helpers ---
const OK_NAME = /^[A-Za-z0-9_. ]{3,16}$/; // латиница, цифры, подчёркивание, точка, пробел

function mapRowToApiPlayer(r) {
  return {
    id: r.device_id,                            // id = device_id
    username: r.username ?? "Player",
    ratingClassic: Number(r.rating_classic) || 0,
    ratingInfinity: Number(r.rating_infinity) || 0,
    achievementsCount: Number(r.achievements_count) || 0,
    updatedAt: r.updated_at?.toISOString?.() ?? r.updated_at
  };
}

function orderByForMode(mode) {
  // сортировка: рейтинг (по режиму) ↓, achievements_count ↓, created_at ↑ (старые выше)
  if (mode === "infinity") {
    return `ORDER BY rating_infinity DESC, achievements_count DESC, created_at ASC`;
  }
  return `ORDER BY rating_classic DESC, achievements_count DESC, created_at ASC`;
}

async function rankOfDeviceId(deviceId, mode) {
  const orderBy = orderByForMode(mode);
  const rows = await sql/*sql*/`
    SELECT device_id FROM players
    ${sql.unsafe(orderBy)}
  `;
  let pos = 1;
  for (const r of rows) {
    if (r.device_id === deviceId) return pos;
    pos++;
  }
  return null;
}

// --- API ---

// Проверка ника
app.get("/api/check-username", async (req, res) => {
  const username = (req.query.username ?? "").trim();
  if (!OK_NAME.test(username)) {
    return res.json({ ok: false, reason: "bad_format" });
  }
  const exists = await sql/*sql*/`
    SELECT 1 FROM players
    WHERE username IS NOT NULL AND LOWER(username) = LOWER(${username})
    LIMIT 1
  `;
  if (exists.length > 0) {
    return res.json({ ok: false, reason: "taken" });
  }
  return res.json({ ok: true });
});

// Upsert игрока (рейтинги/ачивки и, опционально, ник)
app.post("/api/upsert", async (req, res) => {
  try {
    const {
      deviceId,
      username,
      ratingClassic,
      ratingInfinity,
      achievementsCount
    } = req.body ?? {};

    if (!deviceId) return res.status(400).json({ error: "deviceId required" });

    // если просят установить username — валидируем и проверяем уникальность (кроме своего устройства)
    if (username != null) {
      const u = (username + "").trim();
      if (!OK_NAME.test(u)) return res.status(400).json({ error: "bad_username_format" });

      const conflict = await sql/*sql*/`
        SELECT device_id FROM players
        WHERE username IS NOT NULL
          AND LOWER(username) = LOWER(${u})
          AND device_id <> ${deviceId}
        LIMIT 1
      `;
      if (conflict.length > 0) return res.status(409).json({ error: "username_taken" });
    }

    // делаем upsert
    const rows = await sql/*sql*/`
      INSERT INTO players (device_id, username, rating_classic, rating_infinity, achievements_count)
      VALUES (
        ${deviceId},
        ${username ?? null},
        ${Number.isFinite(ratingClassic) ? ratingClassic : 0},
        ${Number.isFinite(ratingInfinity) ? ratingInfinity : 0},
        ${Number.isFinite(achievementsCount) ? achievementsCount : 0}
      )
      ON CONFLICT (device_id) DO UPDATE
        SET
          username           = COALESCE(EXCLUDED.username, players.username),
          rating_classic     = COALESCE(EXCLUDED.rating_classic, players.rating_classic),
          rating_infinity    = COALESCE(EXCLUDED.rating_infinity, players.rating_infinity),
          achievements_count = COALESCE(EXCLUDED.achievements_count, players.achievements_count),
          updated_at         = NOW()
      RETURNING *;
    `;

    return res.json(mapRowToApiPlayer(rows[0]));
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "internal" });
  }
});

// ВЕСЬ рейтинг (вот этот эндпойнт надо дергать из клиента)
app.get("/api/leaderboard", async (req, res) => {
  try {
    const mode = (req.query.mode === "infinity") ? "infinity" : "classic";
    const orderBy = orderByForMode(mode);
    const rows = await sql/*sql*/`
      SELECT device_id, username, rating_classic, rating_infinity, achievements_count, updated_at
      FROM players
      ${sql.unsafe(orderBy)}
    `;
    const items = rows.map(mapRowToApiPlayer);
    res.json({ items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

// /api/top оставляю для совместимости (но он не нужен, можно игнорить на клиенте)
app.get("/api/top", async (req, res) => {
  try {
    const mode = (req.query.mode === "infinity") ? "infinity" : "classic";
    const limit = Math.max(1, Math.min(parseInt(req.query.limit || "10", 10), 100000));
    const orderBy = orderByForMode(mode);
    const rows = await sql/*sql*/`
      SELECT device_id, username, rating_classic, rating_infinity, achievements_count, updated_at
      FROM players
      ${sql.unsafe(orderBy)}
      LIMIT ${limit}
    `;
    res.json({ items: rows.map(mapRowToApiPlayer) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

// /api/me — возвращает мою карточку + место
app.get("/api/me", async (req, res) => {
  try {
    const deviceId = req.query.device_id;
    const mode = (req.query.mode === "infinity") ? "infinity" : "classic";
    if (!deviceId) return res.status(400).json({ error: "device_id required" });

    const rows = await sql/*sql*/`
      SELECT device_id, username, rating_classic, rating_infinity, achievements_count, updated_at
      FROM players
      WHERE device_id = ${deviceId}
      LIMIT 1
    `;
    const me = rows[0] ? mapRowToApiPlayer(rows[0]) : null;
    const rank = me ? await rankOfDeviceId(deviceId, mode) : null;

    res.json({ me, rank });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Leaderboard listening on " + PORT));
