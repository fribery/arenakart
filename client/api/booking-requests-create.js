import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

export const config = { runtime: "nodejs" };

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_ENV_MISSING");
  return createClient(url, key, { auth: { persistSession: false } });
}

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

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim());
}

function isValidTime(value) {
  const s = String(value || "").trim();
  if (!/^\d{2}:\d{2}$/.test(s)) return false;

  const [hh, mm] = s.split(":").map(Number);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return false;

  if (hh < 10 || hh > 22) return false;
  if (hh === 22 && mm !== 0) return false;
  if (![0, 15, 30, 45].includes(mm)) return false;

  return true;
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
      try { body = JSON.parse(body); } catch { body = null; }
    }

    const initData = body?.initData;
    const title = String(body?.title || "Запись в картинг").trim();
    const requestedDate = String(body?.requested_date || "").trim();
    const requestedTime = String(body?.requested_time || "").trim();
    const guestsCount =
      body?.guests_count === null || body?.guests_count === undefined || body?.guests_count === ""
        ? null
        : Number(body.guests_count);
    const comment = String(body?.comment || "").trim();

    if (!initData) {
      return res.status(400).end(JSON.stringify({ ok: false, error: "NO_INIT_DATA" }));
    }
    if (!isValidDate(requestedDate)) {
      return res.status(400).end(JSON.stringify({ ok: false, error: "BAD_REQUESTED_DATE" }));
    }
    if (!isValidTime(requestedTime)) {
      return res.status(400).end(JSON.stringify({ ok: false, error: "BAD_REQUESTED_TIME" }));
    }
    if (guestsCount !== null && (!Number.isFinite(guestsCount) || guestsCount <= 0)) {
      return res.status(400).end(JSON.stringify({ ok: false, error: "BAD_GUESTS_COUNT" }));
    }

    const check = checkTelegramInitData(initData, botToken);
    if (!check.ok) {
      return res.status(401).end(JSON.stringify({ ok: false, error: check.error }));
    }

    let user = null;
    try { user = check.data.user ? JSON.parse(check.data.user) : null; } catch {}

    if (!user?.id) {
      return res.status(400).end(JSON.stringify({ ok: false, error: "NO_USER" }));
    }

    const telegramId = user.id;
    const supabase = getSupabase();

    const { data: profile } = await supabase
    .from("profiles")
    .select("name, phone")
    .eq("telegram_id", telegramId)
    .maybeSingle();

    const { data, error } = await supabase
      .from("booking_requests")
      .insert({
        telegram_id: telegramId,
        status: "pending",
        title: title || "Запись в картинг",
        requested_date: requestedDate,
        requested_time: requestedTime,
        guests_count: guestsCount,
        comment: comment || null,
      })
      .select("id, telegram_id, status, title, requested_date, requested_time, guests_count, comment, created_at")
      .single();

    if (error) {
      return res.status(500).end(JSON.stringify({
        ok: false,
        error: "SUPABASE_ERROR",
        details: error.message,
      }));
    }

    const adminIds = getAdminTelegramIds(process.env.ADMIN_TG_IDS || "");

    if (adminIds.length > 0) {
      const text =
        `📥 Новая заявка на картинг\n\n` +
        `👤 Клиент: ${profile?.name || "—"}\n` +
        `📞 Телефон: ${profile?.phone || "—"}\n` +
        `🆔 Telegram ID: ${telegramId}\n` +
        `📅 Дата: ${requestedDate}\n` +
        `🕒 Время: ${requestedTime}\n` +
        `${guestsCount ? `👥 Гостей: ${guestsCount}\n` : ""}` +
        `${comment ? `💬 ${comment}\n` : ""}` +
        `\nПроверьте экран "Актуальные заявки".`;

      try {
        await notifyAllAdmins(botToken, adminIds, text);
      } catch {}
    }

    return res.status(200).end(JSON.stringify({ ok: true, request: data }));
  } catch (err) {
    return res.status(500).end(JSON.stringify({
      ok: false,
      error: "INTERNAL_ERROR",
      details: String(err?.message || err),
    }));
  }
}