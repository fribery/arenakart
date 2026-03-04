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

async function getBalance(supabase, telegramId) {
  const { data, error } = await supabase
    .from("transactions")
    .select("amount")
    .eq("telegram_id", telegramId);

  if (error) throw new Error("SUPABASE_BALANCE_ERROR: " + error.message);

  let sum = 0;
  for (const row of data) sum += Number(row.amount) || 0;
  return sum;
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  try {
    if (req.method !== "POST") return res.status(405).end(JSON.stringify({ ok: false, error: "METHOD_NOT_ALLOWED" }));

    const botToken = process.env.BOT_TOKEN;
    if (!botToken) return res.status(500).end(JSON.stringify({ ok: false, error: "NO_BOT_TOKEN" }));

    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = null; }
    }

    const initData = body?.initData;
    const targetTelegramId = Number(body?.targetTelegramId);
    const amount = Number(body?.amount);
    const note = String(body?.note || "").trim();

    if (!initData) return res.status(400).end(JSON.stringify({ ok: false, error: "NO_INIT_DATA" }));
    if (!Number.isFinite(targetTelegramId)) return res.status(400).end(JSON.stringify({ ok: false, error: "BAD_TARGET" }));
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).end(JSON.stringify({ ok: false, error: "BAD_AMOUNT" }));

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

    const balance = await getBalance(supabase, targetTelegramId);
    if (balance < amount) {
      return res.status(400).end(JSON.stringify({ ok: false, error: "INSUFFICIENT_FUNDS", balance }));
    }

    const { data, error } = await supabase
      .from("transactions")
      .insert({
        telegram_id: targetTelegramId,
        type: "SPEND",
        amount: -Math.trunc(amount),
        note: note || `SPEND by admin ${adminTelegramId}`,
      })
      .select("id, telegram_id, type, amount, note, created_at")
      .single();

    if (error) return res.status(500).end(JSON.stringify({ ok: false, error: "SUPABASE_ERROR", details: error.message }));

    return res.status(200).end(JSON.stringify({ ok: true, tx: data, balanceAfter: balance - amount }));
  } catch (err) {
    return res.status(500).end(JSON.stringify({ ok: false, error: "INTERNAL_ERROR", details: String(err?.message || err) }));
  }
}