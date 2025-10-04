import express from "express";
import cors from "cors";
import pkg from "pg";
const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

// Подключение к Neon (строка будет из переменной окружения)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Neon требует SSL
});

// корень — просто проверка, что жив
app.get("/", (req, res) => {
  res.send("Leaderboard server is running ✅");
});

// 1) Проверить доступность имени
app.post("/username/check", async (req, res) => {
  try {
    const { username } = req.body || {};
    if (!username) return res.status(400).json({ ok: false, error: "username required" });
    const q = await pool.query("select 1 from users where username = $1", [username]);
    res.json({ ok: true, available: q.rowCount === 0 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "server error" });
  }
});

// 2) Регистрация (deviceId + username)
app.post("/register", async (req, res) => {
  try {
    const { deviceId, username } = req.body || {};
    if (!deviceId || !username) {
      return res.status(400).json({ ok: false, error: "deviceId and username required" });
    }
    await pool.query(
      `insert into users (device_id, username) values ($1, $2)`,
      [deviceId, username]
    );
    res.json({ ok: true });
  } catch (e) {
    if (e.code === "23505") {
      // уникальность нарушена
      return res.status(409).json({ ok: false, error: "username or deviceId already exists" });
    }
    console.error(e);
    res.status(500).json({ ok: false, error: "server error" });
  }
});

// 3) Смена имени
app.post("/username/change", async (req, res) => {
  try {
    const { deviceId, newUsername } = req.body || {};
    if (!deviceId || !newUsername) {
      return res.status(400).json({ ok: false, error: "deviceId and newUsername required" });
    }
    const u = await pool.query("select 1 from users where device_id = $1", [deviceId]);
    if (u.rowCount === 0) return res.status(404).json({ ok: false, error: "user not found" });

    await pool.query(
      "update users set username = $1, updated_at = now() where device_id = $2",
      [newUsername, deviceId]
    );
    res.json({ ok: true });
  } catch (e) {
    if (e.code === "23505") {
      return res.status(409).json({ ok: false, error: "username already taken" });
    }
    console.error(e);
    res.status(500).json({ ok: false, error: "server error" });
  }
});

// 4) Обновление рейтинга и количества ачивок
//    Нужен заголовок x-api-key, чтобы не накручивали извне
app.post("/rating/update", async (req, res) => {
  try {
    const apiKey = req.header("x-api-key");
    if (!apiKey || apiKey !== process.env.API_KEY) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    const { deviceId, ratingClassic, ratingInfinity, achievementsCompleted } = req.body || {};
    if (!deviceId) return res.status(400).json({ ok: false, error: "deviceId required" });

    await pool.query(
      `update users
          set rating_classic = coalesce($2, rating_classic),
              rating_infinity = coalesce($3, rating_infinity),
              achievements_completed = coalesce($4, achievements_completed),
              updated_at = now()
        where device_id = $1`,
      [deviceId, ratingClassic ?? null, ratingInfinity ?? null, achievementsCompleted ?? null]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "server error" });
  }
});

// 5) Топ (по классике или по инфинити)
// GET /leaderboard?mode=classic&limit=10
app.get("/leaderboard", async (req, res) => {
  try {
    const mode = (req.query.mode === "infinity") ? "infinity" : "classic";
    const limit = Math.min(parseInt(req.query.limit || "10", 10), 100);
    const col = mode === "infinity" ? "rating_infinity" : "rating_classic";

    const q = await pool.query(
      `select username, ${col} as rating, achievements_completed
         from users
        where username is not null
        order by ${col} desc, updated_at desc
        limit $1`,
      [limit]
    );
    res.json({ ok: true, mode, rows: q.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "server error" });
  }
});

// 6) Место игрока (возвращает rank и его данные)
// GET /me/:deviceId
app.get("/me/:deviceId", async (req, res) => {
  try {
    const { deviceId } = req.params;
    const qUser = await pool.query(
      `select device_id, username, rating_classic, rating_infinity, achievements_completed
         from users
        where device_id = $1`,
      [deviceId]
    );
    if (qUser.rowCount === 0) return res.status(404).json({ ok: false, error: "user not found" });

    const user = qUser.rows[0];

    const qRankClassic = await pool.query(
      `select 1 from users where rating_classic > $1`,
      [user.rating_classic]
    );
    const qRankInfinity = await pool.query(
      `select 1 from users where rating_infinity > $1`,
      [user.rating_infinity]
    );

    res.json({
      ok: true,
      user: {
        username: user.username,
        ratingClassic: user.rating_classic,
        ratingInfinity: user.rating_infinity,
        achievementsCompleted: user.achievements_completed
      },
      rank: {
        classic: qRankClassic.rowCount + 1,
        infinity: qRankInfinity.rowCount + 1
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "server error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server listening on port", PORT));
