const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

require("dotenv").config();

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.get("/api/health", (req, res) => res.json({ ok: true }));

function parseInitData(initData) {
  // initData: "query_id=...&user=...&auth_date=...&hash=..."
  const params = new URLSearchParams(initData);
  const data = {};
  for (const [k, v] of params.entries()) data[k] = v;
  return data;
}

function checkTelegramInitData(initData, botToken) {
  const data = parseInitData(initData);
  const receivedHash = data.hash;
  if (!receivedHash) return { ok: false, reason: "NO_HASH" };

  // строим data_check_string: сортируем ключи, исключаем hash
  const keys = Object.keys(data).filter((k) => k !== "hash").sort();
  const dataCheckString = keys.map((k) => `${k}=${data[k]}`).join("\n");

  // secret_key = HMAC_SHA256("WebAppData", bot_token)
  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();

  // hash = HMAC_SHA256(data_check_string, secret_key) hex
  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  const ok =
    calculatedHash.length === receivedHash.length &&
    crypto.timingSafeEqual(Buffer.from(calculatedHash), Buffer.from(receivedHash));

  return { ok, data, dataCheckString, calculatedHash, receivedHash };
}

function isAdminTgId(tgId) {
  const raw = process.env.ADMIN_TG_IDS || "";
  const set = new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
  return set.has(String(tgId));
}

app.post("/api/auth/telegram", (req, res) => {
  const { initData } = req.body || {};
  if (!initData) return res.status(400).json({ ok: false, error: "NO_INIT_DATA" });

  const botToken = process.env.BOT_TOKEN;
  if (!botToken) return res.status(500).json({ ok: false, error: "NO_BOT_TOKEN" });

  const result = checkTelegramInitData(initData, botToken);
  if (!result.ok) return res.status(401).json({ ok: false, error: "BAD_SIGNATURE" });

  // user приходит как JSON строка
  let user = null;
  try {
    user = result.data.user ? JSON.parse(result.data.user) : null;
  } catch {
    user = null;
  }

  if (!user?.id) return res.status(400).json({ ok: false, error: "NO_USER" });

  // Тут позже будет БД. Пока просто отдаём профиль.
  const profile = {
    telegramId: user.id,
    username: user.username || null,
    firstName: user.first_name || null,
    lastName: user.last_name || null,
    isAdmin: isAdminTgId(user.id),
    balance: 0
  };

  return res.json({ ok: true, profile });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`API on http://localhost:${PORT}`));