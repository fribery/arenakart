import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

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

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const calculatedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (calculatedHash.length !== receivedHash.length) return { ok: false, error: "HASH_LENGTH_MISMATCH" };

  const ok = crypto.timingSafeEqual(Buffer.from(calculatedHash, "utf8"), Buffer.from(receivedHash, "utf8"));
  return { ok, data, error: ok ? null : "BAD_SIGNATURE" };
}

function isAdmin(tgId, adminList) {
  const set = new Set((adminList || "").split(",").map((s) => s.trim()).filter(Boolean));
  return set.has(String(tgId));
}

function parsePayload(payload) {
  const str = String(payload || "").trim();
  if (!str.startsWith("GK1:")) return null;
  const token = str.slice(4);
  if (!token || token.length < 20) return null;
  return token;
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  try {
    if (req.method !== "POST") {
      return res.status(405).end(JSON.stringify({ ok: false, error: "METHOD_NOT_ALLOWED" }));
    }

    const botToken = process.env.BOT_TOKEN;
    if (!botToken) return res.status(500).end(JSON.stringify({ ok: false, error: "NO_BOT_TOKEN" }));

    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = null; }
    }

    const initData = body?.initData;
    const qrPayload = body?.qrPayload;
    const amount = Number(body?.amount);
    const note = String(body?.note || "").trim();

    if (!initData) return res.status(400).end(JSON.stringify({ ok: false, error: "NO_INIT_DATA" }));
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).end(JSON.stringify({ ok: false, error: "BAD_AMOUNT" }));

    const token = parsePayload(qrPayload);
    if (!token) return res.status(400).end(JSON.stringify({ ok: false, error: "BAD_QR" }));

    const check = checkTelegramInitData(initData, botToken);
    if (!check.ok) return res.status(401).end(JSON.stringify({ ok: false, error: check.error }));

    let user = null;
    try { user = check.data.user ? JSON.parse(check.data.user) : null; } catch {}
    if (!user?.id) return res.status(400).end(JSON.stringify({ ok: false, error: "NO_USER" }));

    const adminTelegramId = user.id;
    if (!isAdmin(adminTelegramId, process.env.ADMIN_TG_IDS || "")) {
      return res.status(403).end(JSON.stringify({ ok: false, error: "FORBIDDEN" }));
    }

    const supabase = getSupabase();

    // найти токен
    const { data: qrRow, error: qrErr } = await supabase
      .from("qr_tokens")
      .select("token, telegram_id, expires_at, used_at")
      .eq("token", token)
      .maybeSingle();

    if (qrErr) return res.status(500).end(JSON.stringify({ ok: false, error: "SUPABASE_ERROR", details: qrErr.message }));
    if (!qrRow) return res.status(400).end(JSON.stringify({ ok: false, error: "QR_NOT_FOUND" }));

    if (qrRow.used_at) return res.status(400).end(JSON.stringify({ ok: false, error: "QR_ALREADY_USED" }));
    if (new Date(qrRow.expires_at).getTime() < Date.now()) return res.status(400).end(JSON.stringify({ ok: false, error: "QR_EXPIRED" }));

    const targetTelegramId = qrRow.telegram_id;

    // создать транзакцию начисления
    const { data: tx, error: txErr } = await supabase
      .from("transactions")
      .insert({
        telegram_id: targetTelegramId,
        type: "EARN",
        amount: Math.trunc(amount),
        note: note || `EARN by admin ${adminTelegramId} (QR)`,
      })
      .select("id, telegram_id, type, amount, note, created_at")
      .single();

    if (txErr) return res.status(500).end(JSON.stringify({ ok: false, error: "SUPABASE_ERROR", details: txErr.message }));

    // пометить токен использованным
    const { error: updErr } = await supabase
      .from("qr_tokens")
      .update({ used_at: new Date().toISOString(), used_by_admin: adminTelegramId })
      .eq("token", token)
      .is("used_at", null);

    if (updErr) {
      return res.status(200).end(JSON.stringify({ ok: true, tx, targetTelegramId, warning: "QR_USED_MARK_FAILED" }));
    }

    return res.status(200).end(JSON.stringify({ ok: true, tx, targetTelegramId }));
  } catch (err) {
    return res.status(500).end(JSON.stringify({ ok: false, error: "INTERNAL_ERROR", details: String(err?.message || err) }));
  }
}