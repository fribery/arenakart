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

function isAdminByEnvList(tgId, adminList) {
  const set = new Set(
    (adminList || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
  return set.has(String(tgId));
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

function formatDateRu(value) {
  const s = String(value || "").trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return value || "—";
  return `${m[3]}.${m[2]}.${m[1]}`;
}

async function sendTelegramMessage(botToken, chatId, text) {
  const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });

  const data = await r.json();
  if (!data.ok) throw new Error(data.description || "TELEGRAM_SEND_FAILED");
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
      try { body = JSON.parse(body); } catch { body = null; }
    }

    const initData = body?.initData;
    const requestId = String(body?.requestId || "").trim();
    const action = String(body?.action || "").trim(); // approve | reject | change
    const bookingDate = String(body?.booking_date || "").trim();
    const bookingTime = String(body?.booking_time || "").trim();
    const guestsCount =
      body?.guests_count === null || body?.guests_count === undefined || body?.guests_count === ""
        ? null
        : Number(body.guests_count);
    const comment = String(body?.comment || "").trim();
    const adminComment = String(body?.admin_comment || "").trim();

    if (!initData) {
      return res.status(400).end(JSON.stringify({ ok: false, error: "NO_INIT_DATA" }));
    }
    if (!requestId) {
      return res.status(400).end(JSON.stringify({ ok: false, error: "NO_REQUEST_ID" }));
    }
    if (!["approve", "reject", "change"].includes(action)) {
      return res.status(400).end(JSON.stringify({ ok: false, error: "BAD_ACTION" }));
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
    if (!isAdminByEnvList(user.id, process.env.ADMIN_TG_IDS || "")) {
      return res.status(403).end(JSON.stringify({ ok: false, error: "FORBIDDEN" }));
    }

    const supabase = getSupabase();

    const { data: reqRow, error: reqErr } = await supabase
      .from("booking_requests")
      .select("*")
      .eq("id", requestId)
      .maybeSingle();

    if (reqErr) {
      return res.status(500).end(JSON.stringify({ ok: false, error: "SUPABASE_ERROR", details: reqErr.message }));
    }
    if (!reqRow) {
      return res.status(404).end(JSON.stringify({ ok: false, error: "REQUEST_NOT_FOUND" }));
    }
    if (reqRow.status !== "pending") {
      return res.status(400).end(JSON.stringify({ ok: false, error: "REQUEST_ALREADY_PROCESSED" }));
    }

    if (action === "reject") {
      const { error: updErr } = await supabase
        .from("booking_requests")
        .update({
          status: "rejected",
          admin_comment: adminComment || null,
          processed_at: new Date().toISOString(),
          processed_by: user.id,
          updated_at: new Date().toISOString(),
        })
        .eq("id", requestId);

      if (updErr) {
        return res.status(500).end(JSON.stringify({ ok: false, error: "SUPABASE_ERROR", details: updErr.message }));
      }

      try {
        await sendTelegramMessage(
          botToken,
          reqRow.telegram_id,
          `К сожалению, вашу заявку не удалось подтвердить.\n\n${adminComment ? `Комментарий: ${adminComment}\n\n` : ""}Свяжитесь с нами для уточнения деталей.`
        );
      } catch {}

      return res.status(200).end(JSON.stringify({ ok: true, action: "reject" }));
    }

    const finalDate = action === "change" ? bookingDate : reqRow.requested_date;
    const finalTime = action === "change" ? bookingTime : reqRow.requested_time;
    const finalGuests = action === "change"
      ? (guestsCount === null ? reqRow.guests_count : guestsCount)
      : reqRow.guests_count;
    const finalComment = action === "change"
      ? (comment || reqRow.comment || null)
      : (reqRow.comment || null);

    if (!isValidDate(finalDate)) {
      return res.status(400).end(JSON.stringify({ ok: false, error: "BAD_BOOKING_DATE" }));
    }
    if (!isValidTime(finalTime)) {
      return res.status(400).end(JSON.stringify({ ok: false, error: "BAD_BOOKING_TIME" }));
    }

    const { data: booking, error: bookingErr } = await supabase
      .from("bookings")
      .insert({
        telegram_id: reqRow.telegram_id,
        status: "active",
        title: reqRow.title || "Запись в картинг",
        booking_date: finalDate,
        booking_time: finalTime,
        guests_count: finalGuests,
        comment: finalComment,
        created_by: user.id,
      })
      .select("*")
      .single();

    if (bookingErr) {
      return res.status(500).end(JSON.stringify({ ok: false, error: "SUPABASE_ERROR", details: bookingErr.message }));
    }

    const requestStatus = action === "change" ? "changed" : "approved";

    const { error: updErr } = await supabase
      .from("booking_requests")
      .update({
        status: requestStatus,
        admin_comment: adminComment || null,
        processed_at: new Date().toISOString(),
        processed_by: user.id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", requestId);

    if (updErr) {
      return res.status(500).end(JSON.stringify({ ok: false, error: "SUPABASE_ERROR", details: updErr.message }));
    }

    try {
      const text =
        `✅ Ваша запись подтверждена\n\n` +
        `${booking.title || "Запись в картинг"}\n` +
        `📅 Дата: ${formatDateRu(booking.booking_date)}\n` +
        `🕒 Время: ${booking.booking_time}\n` +
        `${booking.guests_count ? `👥 Гостей: ${booking.guests_count}\n` : ""}` +
        `${booking.comment ? `💬 ${booking.comment}\n` : ""}\n` +
        `Ждём вас в GoKart 🏁`;

      await sendTelegramMessage(botToken, reqRow.telegram_id, text);
    } catch {}

    return res.status(200).end(JSON.stringify({
      ok: true,
      action,
      booking,
    }));
  } catch (err) {
    return res.status(500).end(JSON.stringify({
      ok: false,
      error: "INTERNAL_ERROR",
      details: String(err?.message || err),
    }));
  }
}