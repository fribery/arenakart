import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
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

  const ok =
    calculatedHash.length === receivedHash.length &&
    crypto.timingSafeEqual(
      Buffer.from(calculatedHash),
      Buffer.from(receivedHash)
    );

  return { ok, data };
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false });
    }

    const botToken = process.env.BOT_TOKEN;
    const supabase = getSupabase();

    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body);

    const initData = body?.initData;
    const bookingId = body?.bookingId;
    const booking_date = body?.booking_date;
    const booking_time = body?.booking_time;

    const check = checkTelegramInitData(initData, botToken);
    if (!check.ok) return res.status(401).json({ ok: false });

    const user = JSON.parse(check.data.user);

    const { error } = await supabase
      .from("bookings")
      .update({
        booking_date,
        booking_time,
      })
      .eq("id", bookingId)
      .eq("telegram_id", user.id);

    if (error) {
      return res.status(500).json({ ok: false });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
}