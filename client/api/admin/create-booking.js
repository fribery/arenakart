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

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  try {
    if (req.method !== "POST") {
      return res
        .status(405)
        .end(JSON.stringify({ ok: false, error: "METHOD_NOT_ALLOWED" }));
    }

    const botToken = process.env.BOT_TOKEN;
    if (!botToken) {
      return res
        .status(500)
        .end(JSON.stringify({ ok: false, error: "NO_BOT_TOKEN" }));
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
    const title = String(body?.title || "Запись в картинг").trim();
    const bookingDate = String(body?.booking_date || "").trim();
    const bookingTime = String(body?.booking_time || "").trim();
    const guestsCount =
      body?.guests_count === null || body?.guests_count === undefined || body?.guests_count === ""
        ? null
        : Number(body.guests_count);
    const comment = String(body?.comment || "").trim();

    if (!initData) {
      return res
        .status(400)
        .end(JSON.stringify({ ok: false, error: "NO_INIT_DATA" }));
    }

    if (!Number.isFinite(targetTelegramId) || targetTelegramId <= 0) {
      return res
        .status(400)
        .end(JSON.stringify({ ok: false, error: "BAD_TARGET_TELEGRAM_ID" }));
    }

    if (!isValidDate(bookingDate)) {
      return res
        .status(400)
        .end(JSON.stringify({ ok: false, error: "BAD_BOOKING_DATE" }));
    }

    if (!isValidTime(bookingTime)) {
      return res
        .status(400)
        .end(JSON.stringify({ ok: false, error: "BAD_BOOKING_TIME" }));
    }

    if (guestsCount !== null && (!Number.isFinite(guestsCount) || guestsCount <= 0)) {
      return res
        .status(400)
        .end(JSON.stringify({ ok: false, error: "BAD_GUESTS_COUNT" }));
    }

    const check = checkTelegramInitData(initData, botToken);
    if (!check.ok) {
      return res
        .status(401)
        .end(JSON.stringify({ ok: false, error: check.error }));
    }

    let user = null;
    try {
      user = check.data.user ? JSON.parse(check.data.user) : null;
    } catch {}

    if (!user?.id) {
      return res
        .status(400)
        .end(JSON.stringify({ ok: false, error: "NO_USER" }));
    }

    const adminTgId = user.id;
    if (!isAdminByEnvList(adminTgId, process.env.ADMIN_TG_IDS || "")) {
      return res
        .status(403)
        .end(JSON.stringify({ ok: false, error: "FORBIDDEN" }));
    }

    const supabase = getSupabase();

    const { data: profile, error: profileErr } = await supabase
      .from("profiles")
      .select("telegram_id, name")
      .eq("telegram_id", targetTelegramId)
      .maybeSingle();

    if (profileErr) {
      return res.status(500).end(
        JSON.stringify({
          ok: false,
          error: "SUPABASE_ERROR",
          details: profileErr.message,
        })
      );
    }

    if (!profile) {
      return res
        .status(404)
        .end(JSON.stringify({ ok: false, error: "PROFILE_NOT_FOUND" }));
    }

    const { data, error } = await supabase
      .from("bookings")
      .insert({
        telegram_id: targetTelegramId,
        status: "active",
        title: title || "Запись в картинг",
        booking_date: bookingDate,
        booking_time: bookingTime,
        guests_count: guestsCount,
        comment: comment || null,
        created_by: adminTgId,
      })
      .select("id, telegram_id, status, title, booking_date, booking_time, guests_count, comment, created_by, created_at, updated_at")
      .single();

    if (error) {
      return res.status(500).end(
        JSON.stringify({
          ok: false,
          error: "SUPABASE_ERROR",
          details: error.message,
        })
      );
    }

    return res.status(200).end(
      JSON.stringify({
        ok: true,
        booking: data,
      })
    );
  } catch (err) {
    return res.status(500).end(
      JSON.stringify({
        ok: false,
        error: "INTERNAL_ERROR",
        details: String(err?.message || err),
      })
    );
  }
}