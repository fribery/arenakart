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
    const date = String(body?.date || "").trim();

    if (!initData) {
      return res.status(400).end(JSON.stringify({ ok: false, error: "NO_INIT_DATA" }));
    }

    if (!isValidDate(date)) {
      return res.status(400).end(JSON.stringify({ ok: false, error: "BAD_DATE" }));
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

    const { data: bookings, error: bookingErr } = await supabase
      .from("bookings")
      .select(
        "id, telegram_id, status, title, booking_date, booking_time, guests_count, comment, created_at, updated_at"
      )
      .eq("booking_date", date)
      .in("status", ["active", "changed", "approved"])
      .order("booking_time", { ascending: true });

    if (bookingErr) {
      return res.status(500).end(
        JSON.stringify({
          ok: false,
          error: "SUPABASE_ERROR",
          details: bookingErr.message,
        })
      );
    }

    const itemsBase = bookings || [];
    const telegramIds = [...new Set(itemsBase.map((x) => x.telegram_id).filter(Boolean))];

    let profileMap = new Map();

    if (telegramIds.length > 0) {
      const { data: profiles, error: profErr } = await supabase
        .from("profiles")
        .select("telegram_id, name, phone")
        .in("telegram_id", telegramIds);

      if (profErr) {
        return res.status(500).end(
          JSON.stringify({
            ok: false,
            error: "SUPABASE_ERROR",
            details: profErr.message,
          })
        );
      }

      profileMap = new Map(
        (profiles || []).map((p) => [
          p.telegram_id,
          {
            name: p.name || null,
            phone: p.phone || null,
          },
        ])
      );
    }

    const items = itemsBase.map((item) => {
      const profile = profileMap.get(item.telegram_id) || { name: null, phone: null };
      return {
        ...item,
        profile,
      };
    });

    return res.status(200).end(
      JSON.stringify({
        ok: true,
        date,
        items,
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