require("dotenv").config();
const { validateEnv } = require("./config/validateEnv");
validateEnv();

require("./config/firebase.js");
const express = require("express");
const cors = require("cors");
const { error } = require("./lib/response");

const app = express();

const corsOrigin = process.env.CORS_ORIGIN;
app.use(
  cors({
    origin:
      corsOrigin === undefined || corsOrigin === ""
        ? "*"
        : corsOrigin.split(",").map((o) => o.trim()),
    credentials: true,
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Her isteği terminalde göster (test için)
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.get("/", (req, res) => {
  res.send("Backend çalışıyor 🚀");
});

app.get("/api/test", (req, res) => {
  res.json({
    message: "API çalışıyor",
  });
});

const userRoutes = require("./routes/userRoutes");
const languageRoutes = require("./routes/languageRoutes");
const learningTrackRoutes = require("./routes/learningTrackRoutes");
const wordRoutes = require("./routes/wordRoutes");
const userAnswerRoutes = require("./routes/userAnswerRoutes");
const subscriptionRoutes = require("./routes/subscriptionRoutes");
const adminRoutes = require("./routes/adminRoutes");
const panelRoutes = require("./routes/panelRoutes");
app.use("/api/users", userRoutes);
app.use("/api/languages", languageRoutes);
app.use("/api/learning-tracks", learningTrackRoutes);
app.use("/api/words", wordRoutes);
app.use("/api/user-answers", userAnswerRoutes);
app.use("/api/subscriptions", subscriptionRoutes);
app.use("/admin", adminRoutes);
app.use("/panel/v1", panelRoutes);
const inactivityReminder = require("./jobs/inactivityReminder");
inactivityReminder.start();

// Yakalanmamış route hataları ve promise rejection → 500, stack sadece development'ta
app.use((err, req, res, next) => {
  console.error("[unhandled route error]", err);
  const isDev = process.env.NODE_ENV !== "production";
  return error(
    res,
    "SERVER_ERROR",
    isDev ? (err.message || "Sunucu hatası") : "Sunucu hatası",
    isDev && err.stack ? { stack: err.stack } : null,
    500
  );
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[unhandledRejection]", reason);
});

const PORT = Number(process.env.PORT) || 3035;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
} else {
  module.exports = app;
  }
