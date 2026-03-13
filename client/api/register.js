import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

export const config = { runtime: "nodejs" };

const REG_BONUS = 200;

function normalizeCyrillicName(value) {
  return String(value || "")
    .replace(/[^А-Яа-яЁё\s-]/g, "")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .trim();
}

function isValidCyrillicName(value) {
  return /^[А-Яа-яЁё]+(?:[ -][А-Яа-яЁё]+)*$/.test(String(value || "").trim());
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  let d = digits;

  if (d.startsWith("8") && d.length === 11) {
    d = "7" + d.slice(1);
  }

  if (d.startsWith("7") && d.length === 11) {
    return `+7${d.slice(1)}`;
  }

  return "";
}

function isValidPhone(value) {
  return /^\+7\d{10}$/.test(String(value || "").trim());
}

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

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  try {
    if (req.method !== "POST") {
      return res.status(405).end(
        JSON.stringify({ ok: false, error: "METHOD_NOT_ALLOWED" })
      );
    }

    const botToken = process.env.BOT_TOKEN;
    if (!botToken) {
      return res.status(500).end(
        JSON.stringify({ ok: false, error: "NO_BOT_TOKEN" })
      );
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
    const agree = Boolean(body?.agree);

    const name = normalizeCyrillicName(body?.name);
    const phone = normalizePhone(body?.phone);

    const children = Array.isArray(body?.children)
      ? body.children
          .map((c) => ({
            name: normalizeCyrillicName(c?.name),
            birthDate: String(c?.birthDate || "").trim(),
          }))
          .filter((c) => c.name && c.birthDate)
      : [];

    if (!initData) {
      return res.status(400).end(
        JSON.stringify({ ok: false, error: "NO_INIT_DATA" })
      );
    }

    if (!agree) {
      return res.status(400).end(
        JSON.stringify({ ok: false, error: "MUST_AGREE" })
      );
    }

    if (!isValidCyrillicName(name)) {
      return res.status(400).end(
        JSON.stringify({ ok: false, error: "BAD_NAME" })
      );
    }

    if (!isValidPhone(phone)) {
      return res.status(400).end(
        JSON.stringify({ ok: false, error: "BAD_PHONE" })
      );
    }

    for (const child of children) {
      if (!isValidCyrillicName(child.name)) {
        return res.status(400).end(
          JSON.stringify({ ok: false, error: "BAD_CHILD_NAME" })
        );
      }
    }

    const check = checkTelegramInitData(initData, botToken);
    if (!check.ok) {
      return res.status(401).end(
        JSON.stringify({ ok: false, error: check.error || "BAD_SIGNATURE" })
      );
    }

    let user = null;
    try {
      user = check.data.user ? JSON.parse(check.data.user) : null;
    } catch {}

    if (!user?.id) {
      return res.status(400).end(
        JSON.stringify({ ok: false, error: "NO_USER" })
      );
    }

    const telegramId = user.id;
    const supabase = getSupabase();

    const { data: existedProfile, error: existedErr } = await supabase
      .from("profiles")
      .select("telegram_id")
      .eq("telegram_id", telegramId)
      .maybeSingle();

    if (existedErr) {
      return res.status(500).end(
        JSON.stringify({
          ok: false,
          error: "SUPABASE_ERROR",
          details: existedErr.message,
        })
      );
    }

    const isFirstRegistration = !existedProfile;

    const { data: profile, error: profErr } = await supabase
      .from("profiles")
      .upsert(
        { telegram_id: telegramId, name, phone, children },
        { onConflict: "telegram_id" }
      )
      .select("telegram_id, name, phone, created_at")
      .single();

    if (profErr) {
      return res.status(500).end(
        JSON.stringify({
          ok: false,
          error: "SUPABASE_ERROR",
          details: profErr.message,
        })
      );
    }

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

      if (!txErr) bonusTx = tx;
    }

    const adminIds = getAdminTelegramIds(process.env.ADMIN_TG_IDS || "");

    if (isFirstRegistration && adminIds.length > 0) {
      const childrenCount = Array.isArray(children) ? children.length : 0;

      const text =
        `🆕 Новая регистрация в GoKart\n\n` +
        `👤 Имя: ${profile?.name || name || "—"}\n` +
        `📞 Телефон: ${profile?.phone || phone || "—"}\n` +
        `🆔 Telegram ID: ${telegramId}\n` +
        `👶 Детей: ${childrenCount}\n` +
        `${user?.username ? `🔗 @${user.username}\n` : ""}` +
        `\nОткройте админку, чтобы посмотреть профиль.`;

      try {
        await notifyAllAdmins(botToken, adminIds, text);
      } catch {}
    }

    return res.status(200).end(
      JSON.stringify({ ok: true, profile, bonusTx })
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