// server.js  — full replace
import express from "express";
import cors from "cors";
import pg from "pg";

const { Pool } = pg;

const app = express();
app.use(cors());
app.use(express.json());

// ====== ENV ======
const PORT = process.env.PORT || 3000;
const APP_SECRET = process.env.APP_SECRET || "";        // ты уже задавал на Render
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ====== UTILS ======
const USERNAME_RE = /^[A-Za-z0-9]{3,16}$/;              // латиница+цифры; длина 3..16

function requireAppSecret(req, res) {
  const s = req.get("X-App-Secret");
  if (!APP_SECRET || s !== APP_SECRET) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

async function usernameTaken(client, name, selfDeviceId = null) {
  const sql = `
    SELECT 1 FROM players
    WHERE LOWER(username) = LOWER($1)
      ${selfDeviceId ? "AND device_id <> $2" : ""}
    LIMIT 1
  `;
  const params = selfDeviceId ? [name, selfDeviceId] : [name];
  const r = await client.query(sql, params);
  return r.rowCount > 0;
}

async function generateUsername(client) {
  // Player_XXXXX (случайные цифры), пока не найдём свободный
  for (let i = 0; i < 30; i++) {
    const candidate = "Player_" + Math.floor(Math.random() * 100000).toString().padStart(5, "0");
    if (!(await usernameTaken(client, candidate))) return candidate;
  }
  // fallback если вдруг все занято
  return "Player_" + Date.now().toString().slice(-6);
}

// ====== ROUTES ======

// health
app.get("/api/ping", (_req, res) => res.json({ pong: true }));

// предварительная проверка ника
app.get("/api/check-username", async (req, res) => {
  try {
    const name = (req.query.username || "").toString().trim();
    if (!USERNAME_RE.test(name)) {
      return res.json({ ok: false, reason: "bad_format", pattern: "^[A-Za-z0-9]{3,16}$" });
    }
    const client = await pool.connect();
    try {
      const taken = await usernameTaken(client, name);
      if (taken) return res.json({ ok: false, reason: "taken" });
      return res.json({ ok: true });
    } finally {
      client.release();
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, reason: "server_error" });
  }
});

// upsert игрока + опц. смена ника
app.post("/api/upsert", async (req, res) => {
  if (!requireAppSecret(req, res)) return;

  const { deviceId, username, ratingClassic, ratingInfinity, achievementsCount } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: "bad_request", message: "deviceId required" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // есть ли игрок?
    const existing = await client.query(
      "SELECT id, device_id, username, rating_classic, rating_infinity, achievements_count FROM players WHERE device_id=$1 LIMIT 1",
      [deviceId]
    );
    let row;

    if (existing.rowCount === 0) {
      // ник — если прислали, проверим, если нет — сгенерим
      let finalName = null;
      if (username != null) {
        const u = String(username).trim();
        if (u.length > 0) {
          if (!USERNAME_RE.test(u)) {
            await client.query("ROLLBACK");
            return res.status(400).json({ error: "bad_username", message: "^[A-Za-z0-9]{3,16}$" });
          }
          if (await usernameTaken(client, u)) {
            await client.query("ROLLBACK");
            return res.status(409).json({ error: "username_taken" });
          }
          finalName = u;
        }
      }
      if (!finalName) {
        finalName = await generateUsername(client);
      }

      const ins = await client.query(
        `INSERT INTO players (device_id, username, rating_classic, rating_infinity, achievements_count)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id, device_id, username, rating_classic, rating_infinity, achievements_count, updated_at`,
        [deviceId, finalName, ratingClassic ?? 0, ratingInfinity ?? 0, achievementsCount ?? 0]
      );
      row = ins.rows[0];
    } else {
      row = existing.rows[0];

      // если прислали новый ник и он отличается — валидируем и применяем
      if (username != null) {
        const newName = String(username).trim();
        if (newName.length > 0 && newName !== row.username) {
          if (!USERNAME_RE.test(newName)) {
            await client.query("ROLLBACK");
            return res.status(400).json({ error: "bad_username", message: "^[A-Za-z0-9]{3,16}$" });
          }
          if (await usernameTaken(client, newName, deviceId)) {
            await client.query("ROLLBACK");
            return res.status(409).json({ error: "username_taken" });
          }
          row.username = newName;
        }
      }

      // обновим рейтинги/ачивки (если пришли)
      const upd = await client.query(
        `UPDATE players
           SET username=$2,
               rating_classic = COALESCE($3, rating_classic),
               rating_infinity = COALESCE($4, rating_infinity),
               achievements_count = COALESCE($5, achievements_count),
               updated_at = NOW()
         WHERE device_id=$1
         RETURNING id, device_id, username, rating_classic, rating_infinity, achievements_count, updated_at`,
        [deviceId, row.username, ratingClassic, ratingInfinity, achievementsCount]
      );
      row = upd.rows[0];
    }

    await client.query("COMMIT");
    res.json({
      id: row.id,
      username: row.username,
      ratingClassic: row.rating_classic,
      ratingInfinity: row.rating_infinity,
      achievementsCount: row.achievements_count,
      updatedAt: row.updated_at,
    });
  } catch (e) {
    await pool.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "server_error" });
  } finally {
    client.release();
  }
});

// топ
app.get("/api/top", async (req, res) => {
  const mode = (req.query.mode || "classic").toString();
  const limit = Math.min(parseInt(req.query.limit || "10", 10), 50);
  const col = mode === "infinity" ? "rating_infinity" : "rating_classic";
  const r = await pool.query(
    `SELECT id, device_id, username, rating_classic, rating_infinity, achievements_count, updated_at
       FROM players
      ORDER BY ${col} DESC, updated_at ASC
      LIMIT $1`,
    [limit]
  );
  res.json({
    items: r.rows.map((row) => ({
      id: row.id,
      username: row.username,
      ratingClassic: row.rating_classic,
      ratingInfinity: row.rating_infinity,
      achievementsCount: row.achievements_count,
      updatedAt: row.updated_at,
    })),
  });
});

// моё место
app.get("/api/me", async (req, res) => {
  const deviceId = (req.query.device_id || "").toString();
  const mode = (req.query.mode || "classic").toString();
  if (!deviceId) return res.status(400).json({ error: "bad_request" });

  const col = mode === "infinity" ? "rating_infinity" : "rating_classic";
  const meQ = await pool.query(
    "SELECT id, device_id, username, rating_classic, rating_infinity, achievements_count, updated_at FROM players WHERE device_id=$1 LIMIT 1",
    [deviceId]
  );
  if (meQ.rowCount === 0) return res.json({ me: null, rank: null });

  const me = meQ.rows[0];
  const better = await pool.query(`SELECT COUNT(*)::int as c FROM players WHERE ${col} > $1`, [
    mode === "infinity" ? me.rating_infinity : me.rating_classic,
  ]);
  const rank = better.rows[0].c + 1;

  res.json({
    me: {
      id: me.id,
      username: me.username,
      ratingClassic: me.rating_classic,
      ratingInfinity: me.rating_infinity,
      achievementsCount: me.achievements_count,
      updatedAt: me.updated_at,
    },
    rank,
  });
});

app.listen(PORT, () => console.log(`OK :${PORT}`));
