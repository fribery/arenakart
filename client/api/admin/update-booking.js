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
  return /^\d{2}:\d{2}$/.test(String(value || "").trim());
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
    const bookingId = String(body?.bookingId || "").trim();
    const action = String(body?.action || "").trim(); // cancel | reschedule | edit

    const bookingDate = String(body?.booking_date || "").trim();
    const bookingTime = String(body?.booking_time || "").trim();
    const guestsCount =
      body?.guests_count === null || body?.guests_count === undefined || body?.guests_count === ""
        ? null
        : Number(body.guests_count);
    const comment = String(body?.comment || "").trim();
    const title = String(body?.title || "").trim();

    if (!initData) {
      return res.status(400).end(JSON.stringify({ ok: false, error: "NO_INIT_DATA" }));
    }

    if (!bookingId) {
      return res.status(400).end(JSON.stringify({ ok: false, error: "NO_BOOKING_ID" }));
    }

    if (!["cancel", "reschedule", "edit"].includes(action)) {
      return res.status(400).end(JSON.stringify({ ok: false, error: "BAD_ACTION" }));
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

    if (!isAdminByEnvList(user.id, process.env.ADMIN_TG_IDS || "")) {
      return res.status(403).end(JSON.stringify({ ok: false, error: "FORBIDDEN" }));
    }

    const supabase = getSupabase();

    const { data: booking, error: findErr } = await supabase
      .from("bookings")
      .select("*")
      .eq("id", bookingId)
      .maybeSingle();

    if (findErr) {
      return res.status(500).end(JSON.stringify({
        ok: false,
        error: "SUPABASE_ERROR",
        details: findErr.message,
      }));
    }

    if (!booking) {
      return res.status(404).end(JSON.stringify({ ok: false, error: "BOOKING_NOT_FOUND" }));
    }

    if (action === "cancel") {
      const { data: updated, error: updErr } = await supabase
        .from("bookings")
        .update({
          status: "cancelled",
          updated_at: new Date().toISOString(),
        })
        .eq("id", bookingId)
        .select("*")
        .single();

      if (updErr) {
        return res.status(500).end(JSON.stringify({
          ok: false,
          error: "SUPABASE_ERROR",
          details: updErr.message,
        }));
      }

      try {
        await sendTelegramMessage(
          botToken,
          booking.telegram_id,
          `❌ Ваша запись отменена\n\n` +
            `${booking.title || "Запись в картинг"}\n` +
            `📅 ${formatDateRu(booking.booking_date)}\n` +
            `🕒 ${booking.booking_time}\n\n` +
            `Если нужно, создайте новую заявку в приложении.`
        );
      } catch {}

      return res.status(200).end(JSON.stringify({ ok: true, booking: updated }));
    }

    if (!isValidDate(bookingDate)) {
      return res.status(400).end(JSON.stringify({ ok: false, error: "BAD_BOOKING_DATE" }));
    }

    if (!isValidTime(bookingTime)) {
      return res.status(400).end(JSON.stringify({ ok: false, error: "BAD_BOOKING_TIME" }));
    }

    if (guestsCount !== null && (!Number.isFinite(guestsCount) || guestsCount <= 0)) {
      return res.status(400).end(JSON.stringify({ ok: false, error: "BAD_GUESTS_COUNT" }));
    }

    const updatePayload = {
      booking_date: bookingDate,
      booking_time: bookingTime,
      guests_count: guestsCount,
      comment: comment || null,
      updated_at: new Date().toISOString(),
      reminder_sent_at: null,
    };

    if (action === "edit") {
      updatePayload.title = title || booking.title || "Запись в картинг";
    }

    const { data: updated, error: updErr } = await supabase
      .from("bookings")
      .update(updatePayload)
      .eq("id", bookingId)
      .select("*")
      .single();

    if (updErr) {
      return res.status(500).end(JSON.stringify({
        ok: false,
        error: "SUPABASE_ERROR",
        details: updErr.message,
      }));
    }

    try {
      const actionLabel = action === "reschedule" ? "перенесена" : "изменена";

      await sendTelegramMessage(
        botToken,
        booking.telegram_id,
        `✅ Ваша запись ${actionLabel}\n\n` +
          `${updated.title || "Запись в картинг"}\n` +
          `📅 ${formatDateRu(updated.booking_date)}\n` +
          `🕒 ${updated.booking_time}\n` +
          `${updated.guests_count ? `👥 Гостей: ${updated.guests_count}\n` : ""}` +
          `${updated.comment ? `💬 ${updated.comment}\n` : ""}\n` +
          `Ждём вас в GoKart 🏁`
      );
    } catch {}

    return res.status(200).end(JSON.stringify({ ok: true, booking: updated }));
  } catch (err) {
    return res.status(500).end(JSON.stringify({
      ok: false,
      error: "INTERNAL_ERROR",
      details: String(err?.message || err),
    }));
  }
}