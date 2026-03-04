import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

const REG_BONUS = 200;

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

function cleanPhone(input) {
  return String(input || "").trim();
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
    const name = String(body?.name || "").trim();
    const phone = cleanPhone(body?.phone);
    const agree = Boolean(body?.agree);

    if (!initData) return res.status(400).end(JSON.stringify({ ok: false, error: "NO_INIT_DATA" }));
    if (!agree) return res.status(400).end(JSON.stringify({ ok: false, error: "MUST_AGREE" }));
    if (name.length < 2) return res.status(400).end(JSON.stringify({ ok: false, error: "BAD_NAME" }));
    if (phone.length < 8) return res.status(400).end(JSON.stringify({ ok: false, error: "BAD_PHONE" }));

    const check = checkTelegramInitData(initData, botToken);
    if (!check.ok) {
      return res.status(401).end(JSON.stringify({ ok: false, error: check.error || "BAD_SIGNATURE" }));
    }

    let user = null;
    try { user = check.data.user ? JSON.parse(check.data.user) : null; } catch {}

    if (!user?.id) return res.status(400).end(JSON.stringify({ ok: false, error: "NO_USER" }));

    const telegramId = user.id;
    const supabase = getSupabase();

    // Был ли профиль до регистрации?
    const { data: existedProfile, error: existedErr } = await supabase
      .from("profiles")
      .select("telegram_id")
      .eq("telegram_id", telegramId)
      .maybeSingle();

    if (existedErr) {
      return res.status(500).end(JSON.stringify({ ok: false, error: "SUPABASE_ERROR", details: existedErr.message }));
    }

    const isFirstRegistration = !existedProfile;

    const childrenRaw = body?.children;
    const children = Array.isArray(childrenRaw)
      ? childrenRaw
      .map((c) => ({
        name: String(c?.name || "").trim(),
        birthDate: String(c?.birthDate || "").trim(), // "YYYY-MM-DD"
      }))
      .filter((c) => c.name.length >= 1 && c.birthDate.length >= 8)
    : [];

    // upsert профиля
    const { data: profile, error: profErr } = await supabase
      .from("profiles")
      .upsert({ telegram_id: telegramId, name, phone, children }, { onConflict: "telegram_id" })
      .select("telegram_id, name, phone, created_at")
      .single();

    if (profErr) {
      return res.status(500).end(JSON.stringify({ ok: false, error: "SUPABASE_ERROR", details: profErr.message }));
    }

    // Бонус 200 только один раз
    let bonusTx = null;
    if (isFirstRegistration) {
      const ref = `REG_BONUS:${telegramId}`;
      const { data: tx, error: txErr } = await supabase
        .from("transactions")
        .insert({
          telegram_id: telegramId,
          type: "EARN",
          amount: REG_BONUS,
          note: "Бонус за регистрацию",
          ref,
        })
        .select("id, telegram_id, type, amount, note, created_at, ref")
        .single();

      // если вдруг гонка/дубль — unique index по ref, Supabase вернёт ошибку
      // это не критично: просто считаем, что бонус уже есть
      if (!txErr) bonusTx = tx;
    }

    return res.status(200).end(JSON.stringify({ ok: true, profile, bonusTx }));
  } catch (err) {
    return res.status(500).end(
      JSON.stringify({ ok: false, error: "INTERNAL_ERROR", details: String(err?.message || err) })
    );
  }
}