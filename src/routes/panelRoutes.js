const express = require("express");
const pool = require("../config/db");
const panelAuth = require("../middleware/panelAuth");

const router = express.Router();
router.use(panelAuth);

function positiveInt(value, fallback, max = 100) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function pagination(page, limit, total) {
  return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

function cleanString(value, { allowEmpty = false } = {}) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (!trimmed && !allowEmpty) return null;
  return trimmed;
}

function likeTerm(value) {
  return `%${String(value || "").trim()}%`;
}

function mapUser(row) {
  const displayName =
    [row.first_name, row.last_name].filter(Boolean).join(" ") ||
    row.email ||
    `Kullanıcı #${row.id}`;
  return {
    id: row.id,
    authId: row.firebase_uid || row.email || String(row.id),
    displayName,
    email: row.email,
    status: "active",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    extras: {
      firebaseUid: row.firebase_uid,
      learningTrackId: row.learning_track_id,
      isPremium: row.is_premium === true,
    },
  };
}

function mapLanguage(row) {
  return {
    id: row.code,
    code: row.code,
    name: row.name,
    nativeName: row.native_name || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTrack(row) {
  return {
    id: row.id,
    languageCode: row.language_code,
    title: row.title,
    description: row.description,
    level: row.level,
    sortOrder: Number(row.sort_order || 0),
    wordCount: Number(row.word_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWord(row) {
  return {
    id: row.id,
    learningTrackId: row.learning_track_id,
    trackTitle: row.track_title || null,
    languageCode: row.language_code || null,
    word: row.word,
    translation: row.translation,
    level: row.level,
    sortOrder: Number(row.sort_order || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapNotification(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    message: row.message,
    createdAt: row.created_at,
  };
}

router.get("/health", (_req, res) => res.json({ ok: true, service: "lingolajob-panel" }));

router.get("/options", async (_req, res) => {
  try {
    const [languagesResult, tracksResult, levelsResult] = await Promise.all([
      pool.query("SELECT code, name FROM languages ORDER BY code ASC"),
      pool.query(
        `SELECT lt.id, lt.language_code, lt.title
         FROM learning_tracks lt
         ORDER BY lt.language_code ASC, lt.sort_order ASC, lt.id ASC`
      ),
      pool.query(
        `SELECT DISTINCT level FROM learning_tracks WHERE level IS NOT NULL AND TRIM(level) != '' ORDER BY level ASC`
      ),
    ]);

    return res.json({
      ok: true,
      data: {
        languages: languagesResult.rows.map((row) => ({ code: row.code, name: row.name })),
        tracks: tracksResult.rows.map((row) => ({
          id: row.id,
          languageCode: row.language_code,
          title: row.title,
        })),
        levels: levelsResult.rows.map((row) => row.level),
      },
    });
  } catch (error) {
    console.error("Lingola Job panel options error:", error);
    return res.status(500).json({ ok: false, error: "Seçenekler alınamadı." });
  }
});

router.get("/analyse", async (_req, res) => {
  try {
    const [userTotals, catalog, dailyResult, languageRows, levelRows] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)::int AS total_users,
          COUNT(*) FILTER (
            WHERE EXISTS (
              SELECT 1 FROM subscriptions s
              WHERE s.user_id = users.id
                AND s.status = 'active'
                AND (s.expires_at IS NULL OR s.expires_at > NOW())
            )
          )::int AS premium_users,
          COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE)::int AS new_users_today
        FROM users
      `),
      pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM languages) AS total_languages,
          (SELECT COUNT(*)::int FROM learning_tracks) AS total_tracks,
          (SELECT COUNT(*)::int FROM words) AS total_words
      `),
      pool.query(`
        SELECT created_at::date AS date, COUNT(*)::int AS new_users
        FROM users
        WHERE created_at >= CURRENT_DATE - INTERVAL '13 days'
        GROUP BY created_at::date
        ORDER BY date ASC
      `),
      pool.query(`
        SELECT lt.language_code AS label, COUNT(*)::int AS count
        FROM learning_tracks lt
        GROUP BY lt.language_code
        ORDER BY count DESC, label ASC
      `),
      pool.query(`
        SELECT COALESCE(level, '—') AS label, COUNT(*)::int AS count
        FROM learning_tracks
        GROUP BY level
        ORDER BY count DESC, label ASC
      `),
    ]);

    const totals = userTotals.rows[0] || {};
    const stats = catalog.rows[0] || {};
    const totalUsers = Number(totals.total_users || 0);
    const premiumUsers = Number(totals.premium_users || 0);

    return res.json({
      ok: true,
      contractVersion: 1,
      timezone: "Europe/Istanbul",
      summary: {
        totalUsers,
        premiumUsers,
        newUsersToday: Number(totals.new_users_today || 0),
        totalLanguages: Number(stats.total_languages || 0),
        totalTracks: Number(stats.total_tracks || 0),
        totalWords: Number(stats.total_words || 0),
      },
      daily: dailyResult.rows.map((row) => ({
        date: row.date,
        newUsers: Number(row.new_users || 0),
      })),
      insights: {
        premiumSplit: [
          { label: "Premium", count: premiumUsers },
          { label: "Ücretsiz", count: Math.max(totalUsers - premiumUsers, 0) },
        ],
        tracksByLanguage: languageRows.rows,
        tracksByLevel: levelRows.rows,
      },
    });
  } catch (error) {
    console.error("Lingola Job panel analyse error:", error);
    return res.status(500).json({ ok: false, error: "Analiz verisi alınamadı." });
  }
});

router.get("/users", async (req, res) => {
  try {
    const page = positiveInt(req.query.page, 1);
    const limit = positiveInt(req.query.limit, 20);
    const offset = (page - 1) * limit;
    const search = cleanString(req.query.search);
    const premium = cleanString(req.query.premium);

    const where = ["1=1"];
    const params = [];
    let paramIndex = 1;

    if (search) {
      where.push(
        `(u.email ILIKE $${paramIndex} OR u.first_name ILIKE $${paramIndex} OR u.last_name ILIKE $${paramIndex} OR u.firebase_uid ILIKE $${paramIndex} OR CAST(u.id AS TEXT) = $${paramIndex + 1})`
      );
      params.push(likeTerm(search), search);
      paramIndex += 2;
    }

    if (premium === "1" || premium === "true") {
      where.push(`EXISTS (
        SELECT 1 FROM subscriptions s
        WHERE s.user_id = u.id AND s.status = 'active'
          AND (s.expires_at IS NULL OR s.expires_at > NOW())
      )`);
    }
    if (premium === "0" || premium === "false") {
      where.push(`NOT EXISTS (
        SELECT 1 FROM subscriptions s
        WHERE s.user_id = u.id AND s.status = 'active'
          AND (s.expires_at IS NULL OR s.expires_at > NOW())
      )`);
    }

    const whereSql = `WHERE ${where.join(" AND ")}`;
    const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM users u ${whereSql}`, params);
    const total = Number(countResult.rows[0]?.total || 0);

    const rowsResult = await pool.query(
      `SELECT u.*,
        EXISTS (
          SELECT 1 FROM subscriptions s
          WHERE s.user_id = u.id AND s.status = 'active'
            AND (s.expires_at IS NULL OR s.expires_at > NOW())
        ) AS is_premium
       FROM users u
       ${whereSql}
       ORDER BY u.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    );

    return res.json({
      ok: true,
      data: rowsResult.rows.map(mapUser),
      pagination: pagination(page, limit, total),
    });
  } catch (error) {
    console.error("Lingola Job panel users error:", error);
    return res.status(500).json({ ok: false, error: "Kullanıcılar alınamadı." });
  }
});

router.patch("/users/:userId", async (req, res) => {
  try {
    const userId = Number.parseInt(req.params.userId, 10);
    if (!Number.isFinite(userId) || userId < 1) {
      return res.status(400).json({ ok: false, error: "Geçersiz kullanıcı id." });
    }

    const exists = await pool.query("SELECT id FROM users WHERE id = $1 LIMIT 1", [userId]);
    if (!exists.rows.length) {
      return res.status(404).json({ ok: false, error: "Kullanıcı bulunamadı." });
    }

    const body = req.body || {};
    const sets = [];
    const params = [];
    let paramIndex = 1;

    if (body.learningTrackId !== undefined) {
      const trackId = body.learningTrackId === null || body.learningTrackId === ""
        ? null
        : Number.parseInt(body.learningTrackId, 10);
      if (trackId !== null && (!Number.isFinite(trackId) || trackId < 1)) {
        return res.status(400).json({ ok: false, error: "Geçersiz track id." });
      }
      sets.push(`learning_track_id = $${paramIndex++}`);
      params.push(trackId);
    }

    if (!sets.length) {
      return res.status(400).json({ ok: false, error: "Güncellenecek alan yok." });
    }

    params.push(userId);
    await pool.query(
      `UPDATE users SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $${paramIndex}`,
      params
    );

    const rowResult = await pool.query(
      `SELECT u.*,
        EXISTS (
          SELECT 1 FROM subscriptions s
          WHERE s.user_id = u.id AND s.status = 'active'
            AND (s.expires_at IS NULL OR s.expires_at > NOW())
        ) AS is_premium
       FROM users u WHERE u.id = $1 LIMIT 1`,
      [userId]
    );

    return res.json({ ok: true, data: mapUser(rowResult.rows[0]) });
  } catch (error) {
    console.error("Lingola Job panel user patch error:", error);
    if (error.code === "23503") {
      return res.status(400).json({ ok: false, error: "Track bulunamadı." });
    }
    return res.status(500).json({ ok: false, error: "Kullanıcı güncellenemedi." });
  }
});

router.get("/languages", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM languages ORDER BY code ASC"
    );
    return res.json({ ok: true, data: rows.map(mapLanguage) });
  } catch (error) {
    console.error("Lingola Job panel languages error:", error);
    return res.status(500).json({ ok: false, error: "Diller alınamadı." });
  }
});

router.post("/languages", async (req, res) => {
  try {
    const code = cleanString(req.body?.code);
    const name = cleanString(req.body?.name);
    const nativeName = cleanString(req.body?.nativeName, { allowEmpty: true }) || name;
    if (!code || !name) {
      return res.status(400).json({ ok: false, error: "Kod ve ad zorunludur." });
    }

    const result = await pool.query(
      `INSERT INTO languages (code, name, native_name, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (code) DO UPDATE SET
         name = EXCLUDED.name,
         native_name = EXCLUDED.native_name,
         updated_at = NOW()
       RETURNING *`,
      [code, name, nativeName]
    );

    return res.status(201).json({ ok: true, data: mapLanguage(result.rows[0]) });
  } catch (error) {
    console.error("Lingola Job panel language create error:", error);
    return res.status(500).json({ ok: false, error: "Dil kaydedilemedi." });
  }
});

router.patch("/languages/:languageId", async (req, res) => {
  try {
    const code = cleanString(req.params.languageId);
    if (!code) return res.status(400).json({ ok: false, error: "Geçersiz dil kodu." });

    const exists = await pool.query("SELECT code FROM languages WHERE code = $1 LIMIT 1", [code]);
    if (!exists.rows.length) {
      return res.status(404).json({ ok: false, error: "Dil bulunamadı." });
    }

    const name = cleanString(req.body?.name);
    const nativeName = cleanString(req.body?.nativeName, { allowEmpty: true });
    const sets = [];
    const params = [];
    let paramIndex = 1;

    if (name) {
      sets.push(`name = $${paramIndex++}`);
      params.push(name);
    }
    if (nativeName !== null) {
      sets.push(`native_name = $${paramIndex++}`);
      params.push(nativeName);
    }
    if (!sets.length) {
      return res.status(400).json({ ok: false, error: "Güncellenecek alan yok." });
    }

    params.push(code);
    const result = await pool.query(
      `UPDATE languages SET ${sets.join(", ")}, updated_at = NOW() WHERE code = $${paramIndex} RETURNING *`,
      params
    );

    return res.json({ ok: true, data: mapLanguage(result.rows[0]) });
  } catch (error) {
    console.error("Lingola Job panel language patch error:", error);
    return res.status(500).json({ ok: false, error: "Dil güncellenemedi." });
  }
});

router.get("/tracks", async (req, res) => {
  try {
    const page = positiveInt(req.query.page, 1);
    const limit = positiveInt(req.query.limit, 20);
    const offset = (page - 1) * limit;
    const search = cleanString(req.query.search);
    const languageCode = cleanString(req.query.languageCode);

    const where = ["1=1"];
    const params = [];
    let paramIndex = 1;

    if (search) {
      where.push(`(lt.title ILIKE $${paramIndex} OR lt.description ILIKE $${paramIndex} OR CAST(lt.id AS TEXT) = $${paramIndex + 1})`);
      params.push(likeTerm(search), search);
      paramIndex += 2;
    }
    if (languageCode) {
      where.push(`lt.language_code = $${paramIndex++}`);
      params.push(languageCode);
    }

    const whereSql = `WHERE ${where.join(" AND ")}`;
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM learning_tracks lt ${whereSql}`,
      params
    );
    const total = Number(countResult.rows[0]?.total || 0);

    const rowsResult = await pool.query(
      `SELECT lt.*,
        (SELECT COUNT(*)::int FROM words w WHERE w.learning_track_id = lt.id) AS word_count
       FROM learning_tracks lt
       ${whereSql}
       ORDER BY lt.language_code ASC, lt.sort_order ASC, lt.id ASC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    );

    return res.json({
      ok: true,
      data: rowsResult.rows.map(mapTrack),
      pagination: pagination(page, limit, total),
    });
  } catch (error) {
    console.error("Lingola Job panel tracks error:", error);
    return res.status(500).json({ ok: false, error: "Track listesi alınamadı." });
  }
});

router.get("/tracks/:trackId", async (req, res) => {
  try {
    const trackId = Number.parseInt(req.params.trackId, 10);
    if (!Number.isFinite(trackId) || trackId < 1) {
      return res.status(400).json({ ok: false, error: "Geçersiz track id." });
    }

    const result = await pool.query(
      `SELECT lt.*,
        (SELECT COUNT(*)::int FROM words w WHERE w.learning_track_id = lt.id) AS word_count
       FROM learning_tracks lt
       WHERE lt.id = $1
       LIMIT 1`,
      [trackId]
    );
    if (!result.rows.length) {
      return res.status(404).json({ ok: false, error: "Track bulunamadı." });
    }

    return res.json({ ok: true, data: mapTrack(result.rows[0]) });
  } catch (error) {
    console.error("Lingola Job panel track detail error:", error);
    return res.status(500).json({ ok: false, error: "Track alınamadı." });
  }
});

router.post("/tracks", async (req, res) => {
  try {
    const languageCode = cleanString(req.body?.languageCode);
    const title = cleanString(req.body?.title);
    const description = cleanString(req.body?.description, { allowEmpty: true });
    const level = cleanString(req.body?.level, { allowEmpty: true });
    const sortOrder = Number.parseInt(req.body?.sortOrder, 10);

    if (!languageCode || !title) {
      return res.status(400).json({ ok: false, error: "Dil kodu ve başlık zorunludur." });
    }

    const result = await pool.query(
      `INSERT INTO learning_tracks (language_code, title, description, level, sort_order, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING *`,
      [
        languageCode,
        title,
        description,
        level,
        Number.isFinite(sortOrder) ? sortOrder : 0,
      ]
    );

    return res.status(201).json({ ok: true, data: mapTrack(result.rows[0]) });
  } catch (error) {
    console.error("Lingola Job panel track create error:", error);
    if (error.code === "23503") {
      return res.status(400).json({ ok: false, error: "Dil kodu geçersiz." });
    }
    return res.status(500).json({ ok: false, error: "Track oluşturulamadı." });
  }
});

router.patch("/tracks/:trackId", async (req, res) => {
  try {
    const trackId = Number.parseInt(req.params.trackId, 10);
    if (!Number.isFinite(trackId) || trackId < 1) {
      return res.status(400).json({ ok: false, error: "Geçersiz track id." });
    }

    const exists = await pool.query("SELECT id FROM learning_tracks WHERE id = $1 LIMIT 1", [trackId]);
    if (!exists.rows.length) {
      return res.status(404).json({ ok: false, error: "Track bulunamadı." });
    }

    const body = req.body || {};
    const sets = [];
    const params = [];
    let paramIndex = 1;

    if (body.languageCode !== undefined) {
      const languageCode = cleanString(body.languageCode);
      if (!languageCode) return res.status(400).json({ ok: false, error: "Dil kodu boş olamaz." });
      sets.push(`language_code = $${paramIndex++}`);
      params.push(languageCode);
    }
    if (body.title !== undefined) {
      const title = cleanString(body.title);
      if (!title) return res.status(400).json({ ok: false, error: "Başlık boş olamaz." });
      sets.push(`title = $${paramIndex++}`);
      params.push(title);
    }
    if (body.description !== undefined) {
      sets.push(`description = $${paramIndex++}`);
      params.push(cleanString(body.description, { allowEmpty: true }));
    }
    if (body.level !== undefined) {
      sets.push(`level = $${paramIndex++}`);
      params.push(cleanString(body.level, { allowEmpty: true }));
    }
    if (body.sortOrder !== undefined) {
      const sortOrder = Number.parseInt(body.sortOrder, 10);
      sets.push(`sort_order = $${paramIndex++}`);
      params.push(Number.isFinite(sortOrder) ? sortOrder : 0);
    }

    if (!sets.length) {
      return res.status(400).json({ ok: false, error: "Güncellenecek alan yok." });
    }

    params.push(trackId);
    const result = await pool.query(
      `UPDATE learning_tracks SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $${paramIndex} RETURNING *`,
      params
    );

    return res.json({ ok: true, data: mapTrack(result.rows[0]) });
  } catch (error) {
    console.error("Lingola Job panel track patch error:", error);
    if (error.code === "23503") {
      return res.status(400).json({ ok: false, error: "Dil kodu geçersiz." });
    }
    return res.status(500).json({ ok: false, error: "Track güncellenemedi." });
  }
});

router.delete("/tracks/:trackId", async (req, res) => {
  try {
    const trackId = Number.parseInt(req.params.trackId, 10);
    if (!Number.isFinite(trackId) || trackId < 1) {
      return res.status(400).json({ ok: false, error: "Geçersiz track id." });
    }

    const result = await pool.query("DELETE FROM learning_tracks WHERE id = $1 RETURNING id", [trackId]);
    if (!result.rows.length) {
      return res.status(404).json({ ok: false, error: "Track bulunamadı." });
    }

    return res.json({ ok: true, data: { id: trackId } });
  } catch (error) {
    console.error("Lingola Job panel track delete error:", error);
    return res.status(500).json({ ok: false, error: "Track silinemedi." });
  }
});

router.get("/words", async (req, res) => {
  try {
    const page = positiveInt(req.query.page, 1);
    const limit = positiveInt(req.query.limit, 20);
    const offset = (page - 1) * limit;
    const search = cleanString(req.query.search);
    const trackId = cleanString(req.query.trackId);

    const where = ["1=1"];
    const params = [];
    let paramIndex = 1;

    if (search) {
      where.push(`(w.word ILIKE $${paramIndex} OR w.translation ILIKE $${paramIndex} OR CAST(w.id AS TEXT) = $${paramIndex + 1})`);
      params.push(likeTerm(search), search);
      paramIndex += 2;
    }
    if (trackId) {
      where.push(`w.learning_track_id = $${paramIndex++}`);
      params.push(Number.parseInt(trackId, 10));
    }

    const whereSql = `WHERE ${where.join(" AND ")}`;
    const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM words w ${whereSql}`, params);
    const total = Number(countResult.rows[0]?.total || 0);

    const rowsResult = await pool.query(
      `SELECT w.*, lt.title AS track_title, lt.language_code
       FROM words w
       LEFT JOIN learning_tracks lt ON lt.id = w.learning_track_id
       ${whereSql}
       ORDER BY w.learning_track_id ASC, w.sort_order ASC, w.id ASC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    );

    return res.json({
      ok: true,
      data: rowsResult.rows.map(mapWord),
      pagination: pagination(page, limit, total),
    });
  } catch (error) {
    console.error("Lingola Job panel words error:", error);
    return res.status(500).json({ ok: false, error: "Kelimeler alınamadı." });
  }
});

router.get("/words/:wordId", async (req, res) => {
  try {
    const wordId = Number.parseInt(req.params.wordId, 10);
    if (!Number.isFinite(wordId) || wordId < 1) {
      return res.status(400).json({ ok: false, error: "Geçersiz kelime id." });
    }

    const result = await pool.query(
      `SELECT w.*, lt.title AS track_title, lt.language_code
       FROM words w
       LEFT JOIN learning_tracks lt ON lt.id = w.learning_track_id
       WHERE w.id = $1
       LIMIT 1`,
      [wordId]
    );
    if (!result.rows.length) {
      return res.status(404).json({ ok: false, error: "Kelime bulunamadı." });
    }

    return res.json({ ok: true, data: mapWord(result.rows[0]) });
  } catch (error) {
    console.error("Lingola Job panel word detail error:", error);
    return res.status(500).json({ ok: false, error: "Kelime alınamadı." });
  }
});

router.post("/words", async (req, res) => {
  try {
    const learningTrackId = Number.parseInt(req.body?.learningTrackId, 10);
    const word = cleanString(req.body?.word);
    const translation = cleanString(req.body?.translation, { allowEmpty: true });
    const level = cleanString(req.body?.level, { allowEmpty: true });
    const sortOrder = Number.parseInt(req.body?.sortOrder, 10);

    if (!Number.isFinite(learningTrackId) || learningTrackId < 1 || !word) {
      return res.status(400).json({ ok: false, error: "Track id ve kelime zorunludur." });
    }

    const result = await pool.query(
      `INSERT INTO words (learning_track_id, word, translation, level, sort_order, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (learning_track_id, word) DO UPDATE SET
         translation = EXCLUDED.translation,
         level = EXCLUDED.level,
         sort_order = EXCLUDED.sort_order,
         updated_at = NOW()
       RETURNING *`,
      [
        learningTrackId,
        word,
        translation,
        level,
        Number.isFinite(sortOrder) ? sortOrder : 0,
      ]
    );

    const detail = await pool.query(
      `SELECT w.*, lt.title AS track_title, lt.language_code
       FROM words w
       LEFT JOIN learning_tracks lt ON lt.id = w.learning_track_id
       WHERE w.id = $1
       LIMIT 1`,
      [result.rows[0].id]
    );

    return res.status(201).json({ ok: true, data: mapWord(detail.rows[0]) });
  } catch (error) {
    console.error("Lingola Job panel word create error:", error);
    if (error.code === "23503") {
      return res.status(400).json({ ok: false, error: "Track bulunamadı." });
    }
    return res.status(500).json({ ok: false, error: "Kelime kaydedilemedi." });
  }
});

router.patch("/words/:wordId", async (req, res) => {
  try {
    const wordId = Number.parseInt(req.params.wordId, 10);
    if (!Number.isFinite(wordId) || wordId < 1) {
      return res.status(400).json({ ok: false, error: "Geçersiz kelime id." });
    }

    const exists = await pool.query("SELECT id FROM words WHERE id = $1 LIMIT 1", [wordId]);
    if (!exists.rows.length) {
      return res.status(404).json({ ok: false, error: "Kelime bulunamadı." });
    }

    const body = req.body || {};
    const sets = [];
    const params = [];
    let paramIndex = 1;

    if (body.learningTrackId !== undefined) {
      const learningTrackId = Number.parseInt(body.learningTrackId, 10);
      if (!Number.isFinite(learningTrackId) || learningTrackId < 1) {
        return res.status(400).json({ ok: false, error: "Geçersiz track id." });
      }
      sets.push(`learning_track_id = $${paramIndex++}`);
      params.push(learningTrackId);
    }
    if (body.word !== undefined) {
      const word = cleanString(body.word);
      if (!word) return res.status(400).json({ ok: false, error: "Kelime boş olamaz." });
      sets.push(`word = $${paramIndex++}`);
      params.push(word);
    }
    if (body.translation !== undefined) {
      sets.push(`translation = $${paramIndex++}`);
      params.push(cleanString(body.translation, { allowEmpty: true }));
    }
    if (body.level !== undefined) {
      sets.push(`level = $${paramIndex++}`);
      params.push(cleanString(body.level, { allowEmpty: true }));
    }
    if (body.sortOrder !== undefined) {
      const sortOrder = Number.parseInt(body.sortOrder, 10);
      sets.push(`sort_order = $${paramIndex++}`);
      params.push(Number.isFinite(sortOrder) ? sortOrder : 0);
    }

    if (!sets.length) {
      return res.status(400).json({ ok: false, error: "Güncellenecek alan yok." });
    }

    params.push(wordId);
    await pool.query(
      `UPDATE words SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $${paramIndex}`,
      params
    );

    const detail = await pool.query(
      `SELECT w.*, lt.title AS track_title, lt.language_code
       FROM words w
       LEFT JOIN learning_tracks lt ON lt.id = w.learning_track_id
       WHERE w.id = $1
       LIMIT 1`,
      [wordId]
    );

    return res.json({ ok: true, data: mapWord(detail.rows[0]) });
  } catch (error) {
    console.error("Lingola Job panel word patch error:", error);
    if (error.code === "23503") {
      return res.status(400).json({ ok: false, error: "Track bulunamadı." });
    }
    if (error.code === "23505") {
      return res.status(400).json({ ok: false, error: "Bu track içinde aynı kelime zaten var." });
    }
    return res.status(500).json({ ok: false, error: "Kelime güncellenemedi." });
  }
});

router.delete("/words/:wordId", async (req, res) => {
  try {
    const wordId = Number.parseInt(req.params.wordId, 10);
    if (!Number.isFinite(wordId) || wordId < 1) {
      return res.status(400).json({ ok: false, error: "Geçersiz kelime id." });
    }

    const result = await pool.query("DELETE FROM words WHERE id = $1 RETURNING id", [wordId]);
    if (!result.rows.length) {
      return res.status(404).json({ ok: false, error: "Kelime bulunamadı." });
    }

    return res.json({ ok: true, data: { id: wordId } });
  } catch (error) {
    console.error("Lingola Job panel word delete error:", error);
    return res.status(500).json({ ok: false, error: "Kelime silinemedi." });
  }
});

router.get("/notifications", async (req, res) => {
  try {
    const page = positiveInt(req.query.page, 1);
    const limit = positiveInt(req.query.limit, 25, 100);
    const offset = (page - 1) * limit;

    let total = 0;
    let rows = [];
    try {
      const countResult = await pool.query("SELECT COUNT(*)::int AS total FROM admin_notifications");
      total = Number(countResult.rows[0]?.total || 0);
      const rowsResult = await pool.query(
        `SELECT id, type, title, message, created_at
         FROM admin_notifications
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      rows = rowsResult.rows;
    } catch {
      total = 0;
      rows = [];
    }

    return res.json({
      ok: true,
      data: rows.map(mapNotification),
      pagination: pagination(page, limit, total),
    });
  } catch (error) {
    console.error("Lingola Job panel notifications error:", error);
    return res.status(500).json({ ok: false, error: "Bildirimler alınamadı." });
  }
});

module.exports = router;
