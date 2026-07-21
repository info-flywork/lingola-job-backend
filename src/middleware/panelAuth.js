const crypto = require("crypto");

function configuredPanelKey() {
  return String(process.env.PANEL_API_KEY || process.env.ADMIN_API_KEY || "").trim();
}

function suppliedPanelKey(req) {
  const direct = String(req.get("x-panel-api-key") || req.get("x-panel-key") || "").trim();
  if (direct) return direct;

  const authorization = String(req.get("authorization") || "");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function panelAuth(req, res, next) {
  const expected = configuredPanelKey();
  if (!expected) {
    return res.status(503).json({ ok: false, error: "Panel API anahtarı sunucuda yapılandırılmamış." });
  }
  if (!safeEqual(suppliedPanelKey(req), expected)) {
    return res.status(401).json({ ok: false, error: "Geçersiz panel API anahtarı." });
  }
  return next();
}

module.exports = panelAuth;
