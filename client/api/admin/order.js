import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

const LEAGUES = [
  { name: "Новичок", min: 0, percent: 0.03 },
  { name: "Любитель", min: 10000, percent: 0.05 },
  { name: "Профессионал", min: 30000, percent: 0.07 },
  { name: "Супер гонщик", min: 60000, percent: 0.10 },
];

function leagueFor(totalSpent) {
  let current = LEAGUES[0];
  for (const l of LEAGUES) if (totalSpent >= l.min) current = l;
  return current;
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

function parseQrPayload(payload) {
  const str = String(payload || "").trim();
  if (!str.startsWith("GK1:")) return null;
  const token = str.slice(4);
  if (!token || token.length < 20) return null;
  return token;
}

async function getTotalSpent(supabase, telegramId) {
  const { data, error } = await supabase
    .from("orders")
    .select("amount")
    .eq("telegram_id", telegramId);

  if (error) throw new Error("SUPABASE_TOTAL_SPENT_ERROR: " + error.message);

  let sum = 0;
  for (const row of data) sum += Number(row.amount) || 0;
  return sum;
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
    const orderAmount = Number(body?.orderAmount);
    const note = String(body?.note || "").trim();

    const targetTelegramIdRaw = body?.targetTelegramId;
    const qrPayload = body?.qrPayload;

    if (!initData) return res.status(400).end(JSON.stringify({ ok: false, error: "NO_INIT_DATA" }));
    if (!Number.isFinite(orderAmount) || orderAmount <= 0) {
      return res.status(400).end(JSON.stringify({ ok: false, error: "BAD_ORDER_AMOUNT" }));
    }

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

    // Определяем клиента: либо по QR, либо по ID
    let targetTelegramId = null;
    let source = "id";
    let usedQrToken = null;

    if (qrPayload) {
      const token = parseQrPayload(qrPayload);
      if (!token) return res.status(400).end(JSON.stringify({ ok: false, error: "BAD_QR" }));

      const { data: qrRow, error: qrErr } = await supabase
        .from("qr_tokens")
        .select("token, telegram_id, expires_at, used_at")
        .eq("token", token)
        .maybeSingle();

      if (qrErr) return res.status(500).end(JSON.stringify({ ok: false, error: "SUPABASE_ERROR", details: qrErr.message }));
      if (!qrRow) return res.status(400).end(JSON.stringify({ ok: false, error: "QR_NOT_FOUND" }));
      if (qrRow.used_at) return res.status(400).end(JSON.stringify({ ok: false, error: "QR_ALREADY_USED" }));
      if (new Date(qrRow.expires_at).getTime() < Date.now()) return res.status(400).end(JSON.stringify({ ok: false, error: "QR_EXPIRED" }));

      targetTelegramId = qrRow.telegram_id;
      source = "qr";
      usedQrToken = token;
    } else {
      const idNum = Number(targetTelegramIdRaw);
      if (!Number.isFinite(idNum) || idNum <= 0) {
        return res.status(400).end(JSON.stringify({ ok: false, error: "NO_TARGET_TELEGRAM_ID" }));
      }
      targetTelegramId = idNum;
    }

    // Считаем totalSpent ДО заказа
    const totalSpentBefore = await getTotalSpent(supabase, targetTelegramId);
    const league = leagueFor(totalSpentBefore);
    const cashbackPoints = Math.floor(orderAmount * league.percent);

    // Пишем order
    const { data: orderRow, error: orderErr } = await supabase
      .from("orders")
      .insert({
        telegram_id: targetTelegramId,
        amount: orderAmount,
        cashback_percent: league.percent,
        cashback_points: cashbackPoints,
        admin_telegram_id: adminTelegramId,
        source,
        qr_token: usedQrToken,
      })
      .select("id, telegram_id, amount, cashback_percent, cashback_points, created_at")
      .single();

    if (orderErr) return res.status(500).end(JSON.stringify({ ok: false, error: "SUPABASE_ERROR", details: orderErr.message }));

    // Пишем транзакцию начисления баллов (если 0 — всё равно можно писать order, но транзакцию не надо)
    let tx = null;
    if (cashbackPoints > 0) {
      const autoNote = `Кешбек ${(league.percent * 100).toFixed(0)}% с заказа ${orderAmount}`;
      const { data: txRow, error: txErr } = await supabase
        .from("transactions")
        .insert({
          telegram_id: targetTelegramId,
          type: "EARN",
          amount: cashbackPoints,
          note: note || autoNote,
        })
        .select("id, telegram_id, type, amount, note, created_at")
        .single();

      if (txErr) return res.status(500).end(JSON.stringify({ ok: false, error: "SUPABASE_ERROR", details: txErr.message }));
      tx = txRow;
    }

    // Если было QR — сжигаем токен
    if (usedQrToken) {
      await supabase
        .from("qr_tokens")
        .update({ used_at: new Date().toISOString(), used_by_admin: adminTelegramId })
        .eq("token", usedQrToken)
        .is("used_at", null);
    }

    return res.status(200).end(
      JSON.stringify({
        ok: true,
        targetTelegramId,
        order: orderRow,
        tx,
        league: { name: league.name, percent: league.percent },
        totalSpentBefore,
        totalSpentAfter: totalSpentBefore + orderAmount,
      })
    );
  } catch (err) {
    return res.status(500).end(JSON.stringify({ ok: false, error: "INTERNAL_ERROR", details: String(err?.message || err) }));
  }
}