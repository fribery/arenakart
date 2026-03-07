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

function makeItemCode() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
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
    const targetTelegramId = Number(body?.targetTelegramId);
    const type = String(body?.type || "").trim();
    const title = String(body?.title || "").trim();
    const description = String(body?.description || "").trim();
    const expiresAt = body?.expiresAt ? String(body.expiresAt) : null;
    const meta = body?.meta && typeof body.meta === "object" ? body.meta : {};

    if (!initData) {
      return res.status(400).end(JSON.stringify({ ok: false, error: "NO_INIT_DATA" }));
    }

    if (!Number.isFinite(targetTelegramId) || targetTelegramId <= 0) {
      return res.status(400).end(JSON.stringify({ ok: false, error: "BAD_TARGET_TELEGRAM_ID" }));
    }

    if (!type || !title) {
      return res.status(400).end(JSON.stringify({ ok: false, error: "BAD_ITEM_DATA" }));
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

    const adminTgId = user.id;
    if (!isAdminByEnvList(adminTgId, process.env.ADMIN_TG_IDS || "")) {
      return res.status(403).end(JSON.stringify({ ok: false, error: "FORBIDDEN" }));
    }

    const supabase = getSupabase();

    const { data, error } = await supabase
      .from("inventory_items")
      .insert({
        telegram_id: targetTelegramId,
        type,
        title,
        description: description || null,
        status: "active",
        code: makeItemCode(),
        meta,
        expires_at: expiresAt || null,
      })
      .select("id, telegram_id, type, title, description, status, code, meta, issued_at, expires_at, used_at, created_at")
      .single();

    if (error) {
      return res.status(500).end(JSON.stringify({
        ok: false,
        error: "SUPABASE_ERROR",
        details: error.message,
      }));
    }

    return res.status(200).end(JSON.stringify({
      ok: true,
      item: data,
    }));
  } catch (err) {
    return res.status(500).end(JSON.stringify({
      ok: false,
      error: "INTERNAL_ERROR",
      details: String(err?.message || err),
    }));
  }
}