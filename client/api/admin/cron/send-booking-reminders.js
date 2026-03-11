import { createClient } from "@supabase/supabase-js";

export const config = { runtime: "nodejs" };

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_ENV_MISSING");
  return createClient(url, key, { auth: { persistSession: false } });
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

function todayYmd() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  try {
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
      const auth = req.headers.authorization || "";
      if (auth !== `Bearer ${cronSecret}`) {
        return res.status(401).end(JSON.stringify({ ok: false, error: "UNAUTHORIZED" }));
      }
    }

    const botToken = process.env.BOT_TOKEN;
    if (!botToken) {
      return res.status(500).end(JSON.stringify({ ok: false, error: "NO_BOT_TOKEN" }));
    }

    const supabase = getSupabase();
    const today = todayYmd();

    const { data: bookings, error } = await supabase
      .from("bookings")
      .select("id, telegram_id, title, booking_date, booking_time, guests_count, comment, reminder_sent_at, status")
      .eq("status", "active")
      .eq("booking_date", today)
      .is("reminder_sent_at", null)
      .order("booking_time", { ascending: true });

    if (error) {
      return res.status(500).end(JSON.stringify({
        ok: false,
        error: "SUPABASE_ERROR",
        details: error.message,
      }));
    }

    const items = bookings || [];
    let sent = 0;
    const errors = [];

    for (const booking of items) {
      try {
        const text =
          `⏰ Напоминание о записи\n\n` +
          `${booking.title || "Запись в картинг"}\n` +
          `📅 Дата: ${formatDateRu(booking.booking_date)}\n` +
          `🕒 Время: ${booking.booking_time}\n` +
          `${booking.guests_count ? `👥 Гостей: ${booking.guests_count}\n` : ""}` +
          `${booking.comment ? `💬 ${booking.comment}\n` : ""}\n` +
          `Сегодня ждём вас в GoKart 🏁`;

        await sendTelegramMessage(botToken, booking.telegram_id, text);

        await supabase
          .from("bookings")
          .update({ reminder_sent_at: new Date().toISOString() })
          .eq("id", booking.id);

        sent += 1;
      } catch (e) {
        errors.push({
          bookingId: booking.id,
          telegramId: booking.telegram_id,
          error: String(e?.message || e),
        });
      }
    }

    return res.status(200).end(JSON.stringify({
      ok: true,
      today,
      total: items.length,
      sent,
      errors,
    }));
  } catch (err) {
    return res.status(500).end(JSON.stringify({
      ok: false,
      error: "INTERNAL_ERROR",
      details: String(err?.message || err),
    }));
  }
}