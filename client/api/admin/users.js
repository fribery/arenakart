import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

// ---------- Telegram initData verify ----------
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

// ---------- JWT mint (HS256) for Supabase RLS ----------
function base64url(input) {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  return b
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signHS256(unsigned, secret) {
  return base64url(
    crypto.createHmac("sha256", secret).update(unsigned).digest()
  );
}

/**
 * JWT, который Supabase/PostgREST примет и который даст auth.jwt() в RLS.
 * Ключ: SUPABASE_JWT_SECRET
 */
function makeSupabaseAdminJWT({ jwtSecret, expSeconds = 60, sub = "admin" }) {
  const header = { alg: "HS256", typ: "JWT" };

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: "authenticated",
    role: "authenticated",
    sub: String(sub),
    iat: now,
    exp: now + expSeconds,
    app_metadata: { role: "admin" },
  };

  const h = base64url(JSON.stringify(header));
  const p = base64url(JSON.stringify(payload));
  const unsigned = `${h}.${p}`;
  const sig = signHS256(unsigned, jwtSecret);
  return `${unsigned}.${sig}`;
}

function getSupabaseAnonWithJWT(token) {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error("SUPABASE_ANON_ENV_MISSING");

  return createClient(url, anon, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

// ---------- leagues ----------
function leagueByTotalSpent(totalSpent) {
  const v = Number(totalSpent) || 0;
  if (v >= 60000) return "Legend";
  if (v >= 30000) return "Elite";
  if (v >= 10000) return "Pro";
  return "Rookie";
}

/**
 * Суммируем amount по telegram_id для списка id.
 * ВАЖНО: чтобы не тянуть "всё за всю жизнь", можно ограничить период.
 * Сейчас — без периода, но зафиксирован лимит на количество telegramIds (limit страницы).
 */
async function sumByTelegramIds(supabase, table, amountCol, telegramIds) {
  if (!telegramIds.length) return new Map();

  const { data, error } = await supabase
    .from(table)
    .select(`telegram_id, ${amountCol}`)
    .in("telegram_id", telegramIds);

  if (error) {
    if (table === "orders") return new Map(); // таблицы может не быть
    throw new Error(`SUPABASE_${table.toUpperCase()}_ERROR: ${error.message}`);
  }

  const m = new Map();
  for (const row of data || []) {
    const id = row.telegram_id;
    const prev = m.get(id) || 0;
    m.set(id, prev + (Number(row[amountCol]) || 0));
  }
  return m;
}

function toFiniteNumberOrNull(x) {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function monthFromBirthDate(value) {
  const s = String(value || "").trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return Number(m[2]);
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // небольшой кеш на edge/cdn если включено (не критично)
  res.setHeader("Cache-Control", "s-maxage=20, stale-while-revalidate=40");

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

    const jwtSecret = process.env.SUPABASE_JWT_SECRET;
    if (!jwtSecret) {
      return res
        .status(500)
        .end(JSON.stringify({ ok: false, error: "NO_SUPABASE_JWT_SECRET" }));
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
    if (!initData) {
      return res
        .status(400)
        .end(JSON.stringify({ ok: false, error: "NO_INIT_DATA" }));
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
    const isAdmin = isAdminByEnvList(adminTgId, process.env.ADMIN_TG_IDS || "");
    if (!isAdmin) {
      return res
        .status(403)
        .end(JSON.stringify({ ok: false, error: "FORBIDDEN" }));
    }

    // filters + pagination
    const limit = Math.max(1, Math.min(Number(body?.limit || 20), 50));
    const offset = Math.max(0, Number(body?.offset || 0));
    const q = String(body?.q || "").trim();
    const leagueFilter = body?.league ? String(body.league) : null;

    const minBalance = toFiniteNumberOrNull(body?.min_balance);
    const maxBalance = toFiniteNumberOrNull(body?.max_balance);
    const birthMonthRaw = toFiniteNumberOrNull(body?.birth_month);
    const birthMonth =
      birthMonthRaw && birthMonthRaw >= 1 && birthMonthRaw <= 12
        ? birthMonthRaw
        : null;

    // mint admin JWT for RLS
    const adminJwt = makeSupabaseAdminJWT({
      jwtSecret,
      expSeconds: 60,
      sub: `tg:${adminTgId}`,
    });

    const supabase = getSupabaseAnonWithJWT(adminJwt);

    // base query: profiles
    let query = supabase
      .from("profiles")
      .select("id, telegram_id, name, phone, created_at, children", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (q) {
      const isDigits = /^\d+$/.test(q);
      const qEscaped = String(q).replace(/[%_,]/g, "");

      if (isDigits) {
        query = query.or(
          `telegram_id.like.${qEscaped}%,phone.ilike.%${qEscaped}%,name.ilike.%${qEscaped}%`
        );
      } else {
        query = query.or(
          `name.ilike.%${qEscaped}%,phone.ilike.%${qEscaped}%`
        );
      }
    }

    const { data: profiles, error: profErr, count } = await query;

    if (profErr) {
      return res.status(500).end(
        JSON.stringify({
          ok: false,
          error: "SUPABASE_ERROR",
          details: profErr.message,
        })
      );
    }

    const totalRaw = Number(count || 0);

    const itemsBase = profiles || [];
    const telegramIds = itemsBase.map((p) => p.telegram_id).filter(Boolean);

    // balance = sum(transactions.amount)
    const balanceMap = await sumByTelegramIds(
      supabase,
      "transactions",
      "amount",
      telegramIds
    );

    // total_spent = sum(orders.amount) (если orders нет — будет 0)
    const totalSpentMap = await sumByTelegramIds(
      supabase,
      "orders",
      "amount",
      telegramIds
    );

    let items = itemsBase.map((p) => {
      const bal = balanceMap.get(p.telegram_id) || 0;
      const totalSpent = totalSpentMap.get(p.telegram_id) || 0;
      const lg = leagueByTotalSpent(totalSpent);

      return {
        id: p.id,
        telegram_id: p.telegram_id,
        name: p.name,
        phone: p.phone,
        created_at: p.created_at,
        children: Array.isArray(p.children) ? p.children : [],
        balance: Math.round(bal),
        total_spent: Math.round(totalSpent),
        league: lg,
      };
    });

    // league filter (после расчёта)
    if (leagueFilter) {
      items = items.filter((x) => x.league === leagueFilter);
    }

    if (birthMonth !== null) {
      items = items.filter((x) => {
        const children = Array.isArray(x.children) ? x.children : [];
        return children.some((child) => monthFromBirthDate(child?.birthDate) === birthMonth);
      });
    }

    // balance filter (после расчёта)
    if (minBalance !== null) {
      items = items.filter((x) => Number(x.balance || 0) >= minBalance);
    }
    if (maxBalance !== null) {
      items = items.filter((x) => Number(x.balance || 0) <= maxBalance);
    }

    return res.status(200).end(
      JSON.stringify({
        ok: true,
        items,
        total: items.length,      // ✅ total после фильтров
        total_raw: totalRaw,      // ✅ сколько всего до фильтров
        limit,
        offset,
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