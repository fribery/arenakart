export { default } from "./auth/me.js";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

/**
 * Service-role клиент: только для серверных вычислений (баланс/профиль и т.п.)
 * НЕ использовать в admin/users (там пойдём по RLS).
 */
function getSupabaseService() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_ENV_MISSING");
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Anon-клиент: нужен, чтобы уметь прочитать Supabase Auth пользователя по access_token
 * и достать app_metadata.role => admin
 */
function getSupabaseAnon(authToken) {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error("SUPABASE_ANON_ENV_MISSING");

  const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
  return createClient(url, anon, {
    auth: { persistSession: false },
    global: { headers },
  });
}

function getBearerToken(req) {
  const h = req.headers?.authorization || req.headers?.Authorization;
  if (!h) return null;
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
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

async function getRoleFromSupabaseJWT(req) {
  const token = getBearerToken(req);
  if (!token) return { role: null, source: "none" };

  try {
    const sb = getSupabaseAnon(token);
    const { data, error } = await sb.auth.getUser();
    if (error) return { role: null, source: "jwt_error" };
    const role = data?.user?.app_metadata?.role || null;
    return { role, source: "jwt" };
  } catch {
    return { role: null, source: "jwt_exception" };
  }
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

/** Сколько всего потрачено (₽) по таблице orders */
async function getTotalSpent(supabase, telegramId) {
  const { data, error } = await supabase
    .from("orders")
    .select("amount")
    .eq("telegram_id", telegramId);

  // если таблицы ещё нет — не падаем жестко, просто 0
  if (error) return 0;

  let sum = 0;
  for (const row of data) sum += Number(row.amount) || 0;
  return sum;
}

/** Настройка лиг */
const LEAGUES = [
  { name: "Новичок", min: 0, percent: 0.03 },
  { name: "Любитель", min: 10000, percent: 0.05 },
  { name: "Профессионал", min: 30000, percent: 0.07 },
  { name: "Супер гонщик", min: 60000, percent: 0.1 },
];

function leagueFor(totalSpent) {
  let current = LEAGUES[0];
  for (const l of LEAGUES) if (totalSpent >= l.min) current = l;
  return current;
}

function nextLeagueFor(totalSpent) {
  const sorted = [...LEAGUES].sort((a, b) => a.min - b.min);
  for (let i = 0; i < sorted.length; i++) {
    if (totalSpent < sorted[i].min) return sorted[i];
  }
  return null;
}

function progressToNext(totalSpent) {
  const current = leagueFor(totalSpent);
  const next = nextLeagueFor(totalSpent);

  if (!next) {
    return { current, next: null, progress: 1, toNext: 0, span: 0 };
  }

  const start = current.min;
  const end = next.min;
  const span = Math.max(1, end - start);
  const done = Math.min(span, Math.max(0, totalSpent - start));
  const progress = done / span;

  return {
    current,
    next,
    progress,
    toNext: Math.max(0, end - totalSpent),
    span,
  };
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

    // 1) Telegram auth (как у тебя сейчас)
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

    const telegramId = user.id;

    // 2) Роль из Supabase JWT (если клиент прислал Authorization: Bearer <token>)
    const { role: jwtRole } = await getRoleFromSupabaseJWT(req);
    const isAdminByRole = jwtRole === "admin";

    // 3) Fallback на env список (чтобы ничего не сломалось пока)
    const isAdminFallback = isAdminByEnvList(
      telegramId,
      process.env.ADMIN_TG_IDS || ""
    );

    const isAdmin = isAdminByRole || isAdminFallback;

    // 4) Данные профиля/баланс/лиги — как у тебя (service role)
    const supabase = getSupabaseService();

    const { data: profile, error: profErr } = await supabase
      .from("profiles")
      .select("telegram_id, name, phone, created_at")
      .eq("telegram_id", telegramId)
      .maybeSingle();

    if (profErr) {
      return res.status(500).end(
        JSON.stringify({
          ok: false,
          error: "SUPABASE_ERROR",
          details: profErr.message,
        })
      );
    }

    const balance = await getBalance(supabase, telegramId);

    const totalSpent = await getTotalSpent(supabase, telegramId);
    const prog = progressToNext(totalSpent);

    return res.status(200).end(
      JSON.stringify({
        ok: true,
        auth: {
          telegramId,
          username: user.username || null,
          firstName: user.first_name || null,
          lastName: user.last_name || null,

          // ✅ новое: роль (если пришла из JWT)
          role: jwtRole,

          // ✅ теперь isAdmin предпочитает роль, но пока есть fallback
          isAdmin,
        },
        needsRegistration: !profile,
        profile: profile || null,
        balance,

        totalSpent,
        league: {
          name: prog.current.name,
          cashbackPercent: prog.current.percent,
        },
        nextLeague: prog.next
          ? {
              name: prog.next.name,
              min: prog.next.min,
              cashbackPercent: prog.next.percent,
            }
          : null,
        progressToNext: {
          progress: prog.progress,
          toNext: prog.toNext,
          currentMin: prog.current.min,
          nextMin: prog.next ? prog.next.min : prog.current.min,
        },
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