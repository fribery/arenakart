import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

export const config = { runtime: "nodejs" };

function parseInitData(initData) {
  const params = new URLSearchParams(initData);
  const data = {};
  for (const [k, v] of params.entries()) data[k] = v;
  return data;
}

function checkTelegramInitData(initData, botToken) {
  const data = parseInitData(initData);
  const receivedHash = data.hash;
  if (!receivedHash) return { ok: false, error: "NO_HASH" };

  const keys = Object.keys(data).filter((k) => k !== "hash").sort();
  const dataCheckString = keys.map((k) => `${k}=${data[k]}`).join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();

  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (calculatedHash.length !== receivedHash.length) {
    return { ok: false, error: "HASH_LENGTH_MISMATCH" };
  }

  const ok = crypto.timingSafeEqual(
    Buffer.from(calculatedHash, "utf8"),
    Buffer.from(receivedHash, "utf8")
  );

  return { ok, data, error: ok ? null : "BAD_SIGNATURE" };
}

function isAdminByEnvList(tgId, adminList) {
  const set = new Set(
    (adminList || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
  return set.has(String(tgId));
}

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_ENV_MISSING");
  return createClient(url, key, { auth: { persistSession: false } });
}

function monthFromBirthDate(value) {
  const s = String(value || "").trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return Number(m[2]);
}

function monthNameRu(month) {
  const names = [
    "",
    "январе",
    "феврале",
    "марте",
    "апреле",
    "мае",
    "июне",
    "июле",
    "августе",
    "сентябре",
    "октябре",
    "ноябре",
    "декабре",
  ];
  return names[month] || "этом месяце";
}

async function sendTelegramMessage(botToken, chatId, text) {
  const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
    }),
  });

  const data = await r.json();
  if (!data.ok) {
    throw new Error(data.description || "TELEGRAM_SEND_FAILED");
  }

  return data.result;
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  try {
    if (req.method !== "POST") {
      return res.status(405).end(JSON.stringify({ ok: false, error: "METHOD_NOT_ALLOWED" }));
    }

    const botToken = process.env.BOT_TOKEN;
    if (!botToken) {
      return res.status(500).end(JSON.stringify({ ok: false, error: "NO_BOT_TOKEN" }));
    }

    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = null;
      }
    }

    const initData = body?.initData;
    const targetTelegramId = Number(body?.targetTelegramId);
    const month = Math.max(1, Math.min(12, Number(body?.month || new Date().getMonth() + 1)));
    const discountText = String(body?.discountText || "скидка 15%");

    if (!initData) {
      return res.status(400).end(JSON.stringify({ ok: false, error: "NO_INIT_DATA" }));
    }

    if (!Number.isFinite(targetTelegramId) || targetTelegramId <= 0) {
      return res.status(400).end(JSON.stringify({ ok: false, error: "BAD_TARGET_TELEGRAM_ID" }));
    }

    const check = checkTelegramInitData(initData, botToken);
    if (!check.ok) {
      return res.status(401).end(JSON.stringify({ ok: false, error: check.error }));
    }

    let user = null;
    try {
      user = check.data.user ? JSON.parse(check.data.user) : null;
    } catch {}

    if (!user?.id) {
      return res.status(400).end(JSON.stringify({ ok: false, error: "NO_USER" }));
    }

    const adminTgId = user.id;
    const isAdmin = isAdminByEnvList(adminTgId, process.env.ADMIN_TG_IDS || "");
    if (!isAdmin) {
      return res.status(403).end(JSON.stringify({ ok: false, error: "FORBIDDEN" }));
    }

    const supabase = getSupabase();

    const { data: profile, error: profileErr } = await supabase
      .from("profiles")
      .select("telegram_id, name, phone, children")
      .eq("telegram_id", targetTelegramId)
      .maybeSingle();

    if (profileErr) {
      return res.status(500).end(JSON.stringify({
        ok: false,
        error: "SUPABASE_ERROR",
        details: profileErr.message,
      }));
    }

    if (!profile) {
      return res.status(404).end(JSON.stringify({ ok: false, error: "PROFILE_NOT_FOUND" }));
    }

    const children = Array.isArray(profile.children) ? profile.children : [];
    const birthdayKids = children.filter((c) => monthFromBirthDate(c?.birthDate) === month);

    if (birthdayKids.length === 0) {
      return res.status(400).end(JSON.stringify({ ok: false, error: "NO_BIRTHDAY_IN_MONTH" }));
    }

    const kidNames = birthdayKids
      .map((c) => String(c?.name || "").trim())
      .filter(Boolean);

    const namesText = kidNames.length > 0 ? ` (${kidNames.join(", ")})` : "";

    const text =
      `У вашего ребёнка скоро день рождения${namesText} 🎉\n\n` +
      `Приходите в GoKart отметить праздник ярко и активно.\n` +
      `Для вас подготовили специальное предложение: ${discountText}.\n\n` +
      `День рождения в ${monthNameRu(month)} — отличный повод заглянуть к нам 🏎️`;

    const tgResult = await sendTelegramMessage(botToken, targetTelegramId, text);

    return res.status(200).end(JSON.stringify({
      ok: true,
      sent: true,
      month,
      kidNames,
      messageId: tgResult?.message_id || null,
    }));
  } catch (err) {
    return res.status(500).end(JSON.stringify({
      ok: false,
      error: "INTERNAL_ERROR",
      details: String(err?.message || err),
    }));
  }
}