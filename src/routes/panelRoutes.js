const express = require("express");
const { query, exec } = require("../utils/panelDb");
const panelAuth = require("../middleware/panelAuth");

const router = express.Router();
router.use(panelAuth);

const PREMIUM_EXISTS = `EXISTS (
  SELECT 1 FROM subscriptions s
  WHERE s.user_id = u.id AND s.status = 'active'
    AND (s.expires_at IS NULL OR s.expires_at > NOW())
)`;

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

function isPremiumValue(value) {
  return value === true || value === 1;
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
      isPremium: isPremiumValue(row.is_premium),
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

function fkError(error) {
  return error?.code === "ER_NO_REFERENCED_ROW_2" || error?.errno === 1452;
}

function dupError(error) {
  return error?.code === "ER_DUP_ENTRY" || error?.errno === 1062;
}

router.get("/health", (_req, res) => res.json({ ok: true, service: "lingolajob-panel" }));

router.get("/options", async (_req, res) => {
  try {
    const [languagesResult, tracksResult, levelsResult] = await Promise.all([
      query("SELECT code, name FROM languages ORDER BY code ASC"),
      query(
        `SELECT lt.id, lt.language_code, lt.title
         FROM learning_tracks lt
         ORDER BY lt.language_code ASC, lt.sort_order ASC, lt.id ASC`
      ),
      query(
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
      query(`
        SELECT
          COUNT(*) AS total_users,
          SUM(CASE WHEN EXISTS (
            SELECT 1 FROM subscriptions s
            WHERE s.user_id = users.id
              AND s.status = 'active'
              AND (s.expires_at IS NULL OR s.expires_at > NOW())
          ) THEN 1 ELSE 0 END) AS premium_users,
          SUM(CASE WHEN DATE(created_at) = CURDATE() THEN 1 ELSE 0 END) AS new_users_today
        FROM users
      `),
      query(`
        SELECT
          (SELECT COUNT(*) FROM languages) AS total_languages,
          (SELECT COUNT(*) FROM learning_tracks) AS total_tracks,
          (SELECT COUNT(*) FROM words) AS total_words
      `),
      query(`
        SELECT DATE(created_at) AS date, COUNT(*) AS new_users
        FROM users
        WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 13 DAY)
        GROUP BY DATE(created_at)
        ORDER BY date ASC
      `),
      query(`
        SELECT lt.language_code AS label, COUNT(*) AS count
        FROM learning_tracks lt
        GROUP BY lt.language_code
        ORDER BY count DESC, label ASC
      `),
      query(`
        SELECT COALESCE(level, '—') AS label, COUNT(*) AS count
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

    if (search) {
      const term = likeTerm(search);
      where.push(
        `(u.email LIKE ? OR u.first_name LIKE ? OR u.last_name LIKE ? OR u.firebase_uid LIKE ? OR CAST(u.id AS CHAR) = ?)`
      );
      params.push(term, term, term, term, search);
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
    const countResult = await query(`SELECT COUNT(*) AS total FROM users u ${whereSql}`, params);
    const total = Number(countResult.rows[0]?.total || 0);

    const rowsResult = await query(
      `SELECT u.*, ${PREMIUM_EXISTS} AS is_premium
       FROM users u
       ${whereSql}
       ORDER BY u.created_at DESC
       LIMIT ? OFFSET ?`,
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

    const exists = await query("SELECT id FROM users WHERE id = ? LIMIT 1", [userId]);
    if (!exists.rows.length) {
      return res.status(404).json({ ok: false, error: "Kullanıcı bulunamadı." });
    }

    const body = req.body || {};
    const sets = [];
    const params = [];

    if (body.learningTrackId !== undefined) {
      const trackId = body.learningTrackId === null || body.learningTrackId === ""
        ? null
        : Number.parseInt(body.learningTrackId, 10);
      if (trackId !== null && (!Number.isFinite(trackId) || trackId < 1)) {
        return res.status(400).json({ ok: false, error: "Geçersiz track id." });
      }
      sets.push("learning_track_id = ?");
      params.push(trackId);
    }

    if (!sets.length) {
      return res.status(400).json({ ok: false, error: "Güncellenecek alan yok." });
    }

    params.push(userId);
    await exec(`UPDATE users SET ${sets.join(", ")}, updated_at = NOW() WHERE id = ?`, params);

    const rowResult = await query(
      `SELECT u.*, ${PREMIUM_EXISTS} AS is_premium FROM users u WHERE u.id = ? LIMIT 1`,
      [userId]
    );

    return res.json({ ok: true, data: mapUser(rowResult.rows[0]) });
  } catch (error) {
    console.error("Lingola Job panel user patch error:", error);
    if (fkError(error)) {
      return res.status(400).json({ ok: false, error: "Track bulunamadı." });
    }
    return res.status(500).json({ ok: false, error: "Kullanıcı güncellenemedi." });
  }
});

router.get("/languages", async (_req, res) => {
  try {
    const { rows } = await query("SELECT * FROM languages ORDER BY code ASC");
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

    await exec(
      `INSERT INTO languages (code, name, native_name, updated_at)
       VALUES (?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         native_name = VALUES(native_name),
         updated_at = NOW()`,
      [code, name, nativeName]
    );

    const result = await query("SELECT * FROM languages WHERE code = ? LIMIT 1", [code]);
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

    const exists = await query("SELECT code FROM languages WHERE code = ? LIMIT 1", [code]);
    if (!exists.rows.length) {
      return res.status(404).json({ ok: false, error: "Dil bulunamadı." });
    }

    const name = cleanString(req.body?.name);
    const nativeName = cleanString(req.body?.nativeName, { allowEmpty: true });
    const sets = [];
    const params = [];

    if (name) {
      sets.push("name = ?");
      params.push(name);
    }
    if (nativeName !== null) {
      sets.push("native_name = ?");
      params.push(nativeName);
    }
    if (!sets.length) {
      return res.status(400).json({ ok: false, error: "Güncellenecek alan yok." });
    }

    params.push(code);
    await exec(`UPDATE languages SET ${sets.join(", ")}, updated_at = NOW() WHERE code = ?`, params);

    const result = await query("SELECT * FROM languages WHERE code = ? LIMIT 1", [code]);
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

    if (search) {
      const term = likeTerm(search);
      where.push(`(lt.title LIKE ? OR lt.description LIKE ? OR CAST(lt.id AS CHAR) = ?)`);
      params.push(term, term, search);
    }
    if (languageCode) {
      where.push("lt.language_code = ?");
      params.push(languageCode);
    }

    const whereSql = `WHERE ${where.join(" AND ")}`;
    const countResult = await query(`SELECT COUNT(*) AS total FROM learning_tracks lt ${whereSql}`, params);
    const total = Number(countResult.rows[0]?.total || 0);

    const rowsResult = await query(
      `SELECT lt.*,
        (SELECT COUNT(*) FROM words w WHERE w.learning_track_id = lt.id) AS word_count
       FROM learning_tracks lt
       ${whereSql}
       ORDER BY lt.language_code ASC, lt.sort_order ASC, lt.id ASC
       LIMIT ? OFFSET ?`,
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

    const result = await query(
      `SELECT lt.*,
        (SELECT COUNT(*) FROM words w WHERE w.learning_track_id = lt.id) AS word_count
       FROM learning_tracks lt
       WHERE lt.id = ?
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

    const insertResult = await exec(
      `INSERT INTO learning_tracks (language_code, title, description, level, sort_order, updated_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [
        languageCode,
        title,
        description,
        level,
        Number.isFinite(sortOrder) ? sortOrder : 0,
      ]
    );

    const result = await query(
      `SELECT lt.*,
        (SELECT COUNT(*) FROM words w WHERE w.learning_track_id = lt.id) AS word_count
       FROM learning_tracks lt WHERE lt.id = ? LIMIT 1`,
      [insertResult.insertId]
    );

    return res.status(201).json({ ok: true, data: mapTrack(result.rows[0]) });
  } catch (error) {
    console.error("Lingola Job panel track create error:", error);
    if (fkError(error)) {
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

    const exists = await query("SELECT id FROM learning_tracks WHERE id = ? LIMIT 1", [trackId]);
    if (!exists.rows.length) {
      return res.status(404).json({ ok: false, error: "Track bulunamadı." });
    }

    const body = req.body || {};
    const sets = [];
    const params = [];

    if (body.languageCode !== undefined) {
      const languageCode = cleanString(body.languageCode);
      if (!languageCode) return res.status(400).json({ ok: false, error: "Dil kodu boş olamaz." });
      sets.push("language_code = ?");
      params.push(languageCode);
    }
    if (body.title !== undefined) {
      const title = cleanString(body.title);
      if (!title) return res.status(400).json({ ok: false, error: "Başlık boş olamaz." });
      sets.push("title = ?");
      params.push(title);
    }
    if (body.description !== undefined) {
      sets.push("description = ?");
      params.push(cleanString(body.description, { allowEmpty: true }));
    }
    if (body.level !== undefined) {
      sets.push("level = ?");
      params.push(cleanString(body.level, { allowEmpty: true }));
    }
    if (body.sortOrder !== undefined) {
      const sortOrder = Number.parseInt(body.sortOrder, 10);
      sets.push("sort_order = ?");
      params.push(Number.isFinite(sortOrder) ? sortOrder : 0);
    }

    if (!sets.length) {
      return res.status(400).json({ ok: false, error: "Güncellenecek alan yok." });
    }

    params.push(trackId);
    await exec(`UPDATE learning_tracks SET ${sets.join(", ")}, updated_at = NOW() WHERE id = ?`, params);

    const result = await query(
      `SELECT lt.*,
        (SELECT COUNT(*) FROM words w WHERE w.learning_track_id = lt.id) AS word_count
       FROM learning_tracks lt WHERE lt.id = ? LIMIT 1`,
      [trackId]
    );

    return res.json({ ok: true, data: mapTrack(result.rows[0]) });
  } catch (error) {
    console.error("Lingola Job panel track patch error:", error);
    if (fkError(error)) {
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

    const result = await exec("DELETE FROM learning_tracks WHERE id = ?", [trackId]);
    if (!result.affectedRows) {
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

    if (search) {
      const term = likeTerm(search);
      where.push(`(w.word LIKE ? OR w.translation LIKE ? OR CAST(w.id AS CHAR) = ?)`);
      params.push(term, term, search);
    }
    if (trackId) {
      where.push("w.learning_track_id = ?");
      params.push(Number.parseInt(trackId, 10));
    }

    const whereSql = `WHERE ${where.join(" AND ")}`;
    const countResult = await query(`SELECT COUNT(*) AS total FROM words w ${whereSql}`, params);
    const total = Number(countResult.rows[0]?.total || 0);

    const rowsResult = await query(
      `SELECT w.*, lt.title AS track_title, lt.language_code
       FROM words w
       LEFT JOIN learning_tracks lt ON lt.id = w.learning_track_id
       ${whereSql}
       ORDER BY w.learning_track_id ASC, w.sort_order ASC, w.id ASC
       LIMIT ? OFFSET ?`,
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

    const result = await query(
      `SELECT w.*, lt.title AS track_title, lt.language_code
       FROM words w
       LEFT JOIN learning_tracks lt ON lt.id = w.learning_track_id
       WHERE w.id = ?
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

    await exec(
      `INSERT INTO words (learning_track_id, word, translation, level, sort_order, updated_at)
       VALUES (?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         translation = VALUES(translation),
         level = VALUES(level),
         sort_order = VALUES(sort_order),
         updated_at = NOW()`,
      [
        learningTrackId,
        word,
        translation,
        level,
        Number.isFinite(sortOrder) ? sortOrder : 0,
      ]
    );

    const detail = await query(
      `SELECT w.*, lt.title AS track_title, lt.language_code
       FROM words w
       LEFT JOIN learning_tracks lt ON lt.id = w.learning_track_id
       WHERE w.learning_track_id = ? AND w.word = ?
       LIMIT 1`,
      [learningTrackId, word]
    );

    return res.status(201).json({ ok: true, data: mapWord(detail.rows[0]) });
  } catch (error) {
    console.error("Lingola Job panel word create error:", error);
    if (fkError(error)) {
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

    const exists = await query("SELECT id FROM words WHERE id = ? LIMIT 1", [wordId]);
    if (!exists.rows.length) {
      return res.status(404).json({ ok: false, error: "Kelime bulunamadı." });
    }

    const body = req.body || {};
    const sets = [];
    const params = [];

    if (body.learningTrackId !== undefined) {
      const learningTrackId = Number.parseInt(body.learningTrackId, 10);
      if (!Number.isFinite(learningTrackId) || learningTrackId < 1) {
        return res.status(400).json({ ok: false, error: "Geçersiz track id." });
      }
      sets.push("learning_track_id = ?");
      params.push(learningTrackId);
    }
    if (body.word !== undefined) {
      const wordValue = cleanString(body.word);
      if (!wordValue) return res.status(400).json({ ok: false, error: "Kelime boş olamaz." });
      sets.push("word = ?");
      params.push(wordValue);
    }
    if (body.translation !== undefined) {
      sets.push("translation = ?");
      params.push(cleanString(body.translation, { allowEmpty: true }));
    }
    if (body.level !== undefined) {
      sets.push("level = ?");
      params.push(cleanString(body.level, { allowEmpty: true }));
    }
    if (body.sortOrder !== undefined) {
      const sortOrder = Number.parseInt(body.sortOrder, 10);
      sets.push("sort_order = ?");
      params.push(Number.isFinite(sortOrder) ? sortOrder : 0);
    }

    if (!sets.length) {
      return res.status(400).json({ ok: false, error: "Güncellenecek alan yok." });
    }

    params.push(wordId);
    await exec(`UPDATE words SET ${sets.join(", ")}, updated_at = NOW() WHERE id = ?`, params);

    const detail = await query(
      `SELECT w.*, lt.title AS track_title, lt.language_code
       FROM words w
       LEFT JOIN learning_tracks lt ON lt.id = w.learning_track_id
       WHERE w.id = ?
       LIMIT 1`,
      [wordId]
    );

    return res.json({ ok: true, data: mapWord(detail.rows[0]) });
  } catch (error) {
    console.error("Lingola Job panel word patch error:", error);
    if (fkError(error)) {
      return res.status(400).json({ ok: false, error: "Track bulunamadı." });
    }
    if (dupError(error)) {
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

    const result = await exec("DELETE FROM words WHERE id = ?", [wordId]);
    if (!result.affectedRows) {
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
      const countResult = await query("SELECT COUNT(*) AS total FROM admin_notifications");
      total = Number(countResult.rows[0]?.total || 0);
      const rowsResult = await query(
        `SELECT id, type, title, message, created_at
         FROM admin_notifications
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
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
