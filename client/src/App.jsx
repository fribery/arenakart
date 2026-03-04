import React, { useEffect, useMemo, useRef, useState } from "react";
import WebApp from "@twa-dev/sdk";
import QRCode from "qrcode";
import { AnimatePresence, motion } from "framer-motion";
import "./App.css";

function App() {
  const [status, setStatus] = useState("Загрузка...");
  const [auth, setAuth] = useState(null);
  const [profile, setProfile] = useState(null);
  const [needsRegistration, setNeedsRegistration] = useState(false);
  const [balance, setBalance] = useState(0);
  const [txs, setTxs] = useState([]);

  const [tab, setTab] = useState("profile"); // profile | history | qr
  const nameRef = useRef(null);
  const phoneRef = useRef(null);
  const [agree, setAgree] = useState(false);

  const [totalSpent, setTotalSpent] = useState(0);
  const [league, setLeague] = useState(null); // { name, cashbackPercent }
  const [nextLeague, setNextLeague] = useState(null); // { name, min, cashbackPercent } | null
  const [progressToNext, setProgressToNext] = useState(null); // { progress, toNext, currentMin, nextMin }

  const [qrPayload, setQrPayload] = useState("");
  const [qrExpiresAt, setQrExpiresAt] = useState("");

  const [admin, setAdmin] = useState({
  targetTelegramId: "",
  orderAmount: "",   // ₽ для кешбека
  spendPoints: "",   // баллы для списания
  note: "",
  qrPayload: "",
  });

  const inTelegram = Boolean(WebApp.initDataUnsafe?.user) && Boolean(WebApp.initData);

  const [kids, setKids] = useState([]); // массив ключей для рендера
  const kidsRefs = useRef({}); // {key: { nameRef, dateRef }}

function addKid() {
  const key = String(Date.now()) + "_" + String(Math.random()).slice(2);
  kidsRefs.current[key] = {
    nameRef: React.createRef(),
    dateRef: React.createRef(),
  };
  setKids((prev) => [...prev, key]);
}

function removeKid(key) {
  setKids((prev) => prev.filter((k) => k !== key));

  // ВАЖНО: удаляем refs ПОСЛЕ того как React размонтирует DOM и вызовет ref(null)
  setTimeout(() => {
    delete kidsRefs.current[key];
  }, 0);
}

  async function api(path, payload) {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return r.json();
  }

  async function refreshAll() {
    setStatus("Обновление...");

    const me = await api("/api/me", { initData: WebApp.initData });
    if (!me.ok) throw new Error(`${me.error}${me.details ? " | " + me.details : ""}`);

    setAuth(me.auth);
    setProfile(me.profile);
    setNeedsRegistration(Boolean(me.needsRegistration));
    setBalance(Number(me.balance || 0));
    setTotalSpent(Number(me.totalSpent || 0));
    setLeague(me.league || null);
    setNextLeague(me.nextLeague || null);
    setProgressToNext(me.progressToNext || null);

    const tx = await api("/api/transactions", { initData: WebApp.initData, limit: 50 });
    if (tx.ok) setTxs(tx.items || []);

    setStatus("Готово");
  }

  useEffect(() => {
    try {
      WebApp.ready();
      WebApp.expand();
    } catch {}

    if (!inTelegram) {
      setStatus("Открой приложение в Telegram");
      return;
    }

    refreshAll().catch((e) => setStatus("Ошибка: " + String(e?.message || e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

async function loadQrToken() {
  setStatus("Генерируем QR...");
  const r = await api("/api/qr-token", { initData: WebApp.initData });
  if (!r.ok) {
    setStatus(`Ошибка QR: ${r.error}${r.details ? " | " + r.details : ""}`);
    return;
  }
  setQrPayload(r.payload);
  setQrExpiresAt(r.expiresAt);
  setStatus("Готово");
}

useEffect(() => {
  if (!inTelegram) return;
  if (tab !== "qr") return;
  loadQrToken().catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [tab]);

const [qrDataUrl, setQrDataUrl] = useState("");

useEffect(() => {
  let cancelled = false;
  async function make() {
    if (!qrPayload) return;
    const url = await QRCode.toDataURL(qrPayload, { margin: 1, width: 300 });
    if (!cancelled) setQrDataUrl(url);
  }
  make().catch(() => {});
  return () => { cancelled = true; };
}, [qrPayload]);

  // admin helpers
  const onAdminChange = (key) => (e) =>
    setAdmin((prev) => ({
      ...prev,
      [key]: e.target.value,
    }));

  async function adminSpend() {
    try {
      const amount = Number(admin.spendPoints);

      if (!Number.isFinite(amount) || amount <= 0) {
        setStatus("Введите количество баллов для списания");
        return;
      }

      setStatus("Списание...");

      const r = await api("/api/admin/spend", {
        initData: WebApp.initData,
        targetTelegramId: Number(admin.targetTelegramId),
        amount,
        note: admin.note,
      });

      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return;
      }

      await refreshAll();
      setStatus("Списано ✅");
    } catch (e) {
      setStatus("Ошибка: " + String(e?.message || e));
    }
  }

  function scanClientQr() {
  try {
    if (!WebApp.showScanQrPopup) {
      setStatus("Сканер QR недоступен в этой версии Telegram");
      return;
    }

    WebApp.showScanQrPopup({ text: "Сканируй QR клиента" }, (text) => {
      const payload = String(text || "").trim();
      setAdmin((p) => ({ ...p, qrPayload: payload }));

      try { WebApp.closeScanQrPopup(); } catch {}
      setStatus(payload ? "QR считан ✅" : "QR пустой");
    });
  } catch (e) {
    setStatus("Ошибка сканера: " + String(e?.message || e));
  }
}

async function adminEarnAuto() {
  try {
    setStatus("Админ: начисляем кешбек...");

    const orderAmount = Number(admin.orderAmount);
    if (!Number.isFinite(orderAmount) || orderAmount <= 0) {
      setStatus("Введите сумму заказа (₽)");
      return;
    }

    const payload = {
      initData: WebApp.initData,
      orderAmount,
      note: admin.note,
    };

    // ✅ цель: QR или ID
    if (admin.qrPayload) payload.qrPayload = admin.qrPayload;
    else payload.targetTelegramId = Number(admin.targetTelegramId);

    const r = await api("/api/admin/order", payload);

    if (!r.ok) {
      setStatus(`Ошибка: ${r.error}${r.details ? " | " + r.details : ""}`);
      return;
    }

    // QR одноразовый — очищаем
    setAdmin((p) => ({ ...p, qrPayload: "" }));

    await refreshAll();
    setStatus(
      `Готово ✅ ${r.league?.name || ""} ${(r.league?.percent * 100 || 0).toFixed(
        0
      )}% → +${r.tx?.amount || 0} баллов`
    );
  } catch (e) {
    setStatus("Ошибка: " + String(e?.message || e));
  }
}

async function adminCashback() {
  try {
    setStatus("Админ: начисляем кешбек...");

    const payload = {
      initData: WebApp.initData,
      orderAmount: Number(admin.orderAmount),
      note: admin.note,
    };

    if (admin.qrPayload) payload.qrPayload = admin.qrPayload;
    else payload.targetTelegramId = Number(admin.targetTelegramId);

    const r = await api("/api/admin/order", payload);

    if (!r.ok) {
      setStatus(`Ошибка: ${r.error}${r.details ? " | " + r.details : ""}`);
      return;
    }

    setAdmin((p) => ({ ...p, qrPayload: "" })); // QR одноразовый
    await refreshAll();
    setStatus(
      `Готово ✅ ${r.league?.name || ""} ${(r.league?.percent * 100 || 0).toFixed(0)}% → +${r.tx?.amount || 0} баллов`
    );
  } catch (e) {
    setStatus("Ошибка: " + String(e?.message || e));
  }
}

async function adminSpendByQr() {
  try {
    const amount = Number(admin.spendPoints);

    if (!Number.isFinite(amount) || amount <= 0) {
      setStatus("Введите количество баллов для списания");
      return;
    }

    setStatus("Списание по QR...");

    const r = await api("/api/admin/spend-by-qr", {
      initData: WebApp.initData,
      qrPayload: admin.qrPayload,
      amount,
      note: admin.note,
    });

    if (!r.ok) {
      setStatus(`Ошибка: ${r.error}`);
      return;
    }

    setAdmin((p) => ({ ...p, qrPayload: "" }));
    await refreshAll();
    setStatus("Списано по QR ✅");
  } catch (e) {
    setStatus("Ошибка: " + String(e?.message || e));
  }
}

  // animations
const screenVariants = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.22 } },
  exit: { opacity: 0, y: -8, transition: { duration: 0.18 } },
};

  if (!inTelegram) {
    return (
      <Page>
        <Header title="GoKart" subtitle="Запусти мини-апп в Telegram" />
        <Card>
          <div className="muted">{status}</div>
        </Card>
      </Page>
    );
  }

if (needsRegistration) {
  const canRegister = agree; // + можно добавить проверку длины уже при submit

  return (
    <Page>
      <Header subtitle="Залетаем в лигу: +200 баллов 🎁" />

      <Card>
        <div className="field">
          <div className="label">Имя</div>
          <input
            ref={nameRef}
            className="input"
            placeholder="Например, Eugene"
            autoComplete="name"
            onFocus={() => {
              try {
                WebApp.expand();
                WebApp.disableVerticalSwipes?.(); // помогает iOS Telegram
              } catch {}
            }}
          />
        </div>

        <div className="field">
          <div className="label">Телефон</div>
          <input
            ref={phoneRef}
            className="input"
            placeholder="+7 999 123-45-67"
            inputMode="tel"
            autoComplete="tel"
            onFocus={() => {
              try {
                WebApp.expand();
                WebApp.disableVerticalSwipes?.();
              } catch {}
            }}
          />
        </div>

        <div className="gap" />

<button
  type="button"
  className="btn btn-secondary"
  onClick={addKid}
>
  + Добавить ребёнка
</button>

{kids.length > 0 ? (
  <div className="kids">
    {kids.map((key, idx) => (
      <div className="kid-card" key={key}>
        <div className="row-between">
          <div className="strong">Ребёнок #{idx + 1}</div>
          <button
            type="button"
            className="kid-remove"
            onClick={() => removeKid(key)}
          >
            ✕
          </button>
        </div>

        <div className="field">
          <div className="label">Имя</div>
          <input
            ref={(el) => {
              if (!kidsRefs.current[key]) kidsRefs.current[key] = { nameEl: null, dateEl: null };
              kidsRefs.current[key].nameEl = el;
            }}
            className="input"
            placeholder="Имя ребёнка"
          />
        </div>

        <div className="field">
          <div className="label">Дата рождения</div>
          <input
            ref={(el) => {
              if (!kidsRefs.current[key]) kidsRefs.current[key] = { nameEl: null, dateEl: null };
              kidsRefs.current[key].dateEl = el;
            }}
            className="input"
            type="date"
          />
        </div>
      </div>
    ))}
  </div>
) : null}

        <label className="check">
          <input
            type="checkbox"
            checked={agree}
            onChange={(e) => setAgree(e.target.checked)}
          />
          <span>Согласен с правилами программы</span>
        </label>

        <div className="gap-lg" />

        <button
          className={`btn btn-primary ${canRegister ? "" : "btn-disabled"}`}
          disabled={!canRegister}
          onClick={async () => {
            try {
              const name = (nameRef.current?.value || "").trim();
              const phone = (phoneRef.current?.value || "").trim();

              if (name.length < 2) {
                setStatus("Введите имя (минимум 2 символа)");
                return;
              }

              if (phone.length < 8) {
                setStatus("Введите телефон (минимум 8 символов)");
                return;
              }

              // 👇👇👇 ВОТ ЭТО НОВЫЙ КОД — сбор детей
              const children = kids
              .map((key) => {
                const refs = kidsRefs.current[key];
                return {
                  name: (refs?.nameEl?.value || "").trim(),
                  birthDate: (refs?.dateEl?.value || "").trim(),
                };
              })
              .filter((c) => c.name && c.birthDate);
              // 👆👆👆 КОНЕЦ НОВОГО КОДА

              setStatus("Сохраняем...");

              const r = await api("/api/register", {
                initData: WebApp.initData,
                name,
                phone,
                agree: true,
                children, // 👈 вот здесь добавляем
              });

              if (!r.ok) {
                setStatus(r.error);
                return;
              }

              await refreshAll();

              try {
                WebApp.showPopup({
                  title: "Готово",
                  message: "Регистрация сохранена",
                });
              } catch {}

            } catch (e) {
              setStatus("Ошибка: " + String(e?.message || e));
            }
          }}
        >
          Стартовать
        </button>
      </Card>

      <Status status={status} />
    </Page>
  );
}

  return (
    <div className="page">
      <div className="container">
        <div className="content">
          <div className="topbar">
            <Header
              subtitle={
                profile?.name
                  ? `Пилот: ${profile.name}`
                  : auth?.firstName
                  ? `Пилот: ${auth.firstName}`
                  : "Пилот"
              }
            />
          </div>

          <AnimatePresence mode="wait">
            {tab === "profile" && (
              <motion.div
                key="profile"
                variants={screenVariants}
                initial="initial"
                animate="animate"
                exit="exit"
              >
                <Card className="card-balance">
                  <div className="row-between">
                    <div>
                      <div className="muted">Баланс</div>
                      <div className="balance">{balance}</div>
                      <div className="balance-sub">баллов</div>
                    </div>
                    <div className="badge">
                      <span className="badge-dot" />
                      ACTIVE
                    </div>
                  </div>

                  <div className="meter">
                    <div
                      className="meter-fill"
                      style={{
                        width: `${Math.min(100, Math.max(8, (balance / 1000) * 100))}%`,
                      }}
                    />
                  </div>
                </Card>

                <Card className="mt-14">
                <div className="row-between">
                  <div>
                    <div className="muted">Лига</div>
                    <div className="strong" style={{ fontSize: 18 }}>
                      {league?.name || "—"}
                    </div>
                    <div className="hint">
                      Кешбек: {league ? `${Math.round(league.cashbackPercent * 100)}%` : "—"}
                    </div>
                  </div>

                  <div className="pill">
                    {league ? `${Math.round(league.cashbackPercent * 100)}%` : "—"}
                  </div>
                </div>

                <div className="gap" />

                <div className="row-between">
                  <div className="muted">Потрачено</div>
                  <div className="strong">
                    {Math.round(totalSpent).toLocaleString("ru-RU")} ₽
                  </div>
                </div>

                {nextLeague && progressToNext ? (
                  <>
                    <div className="gap" />

                    <div className="hint">
                      До <b>{nextLeague.name}</b> осталось{" "}
                      <b>{Math.round(progressToNext.toNext).toLocaleString("ru-RU")} ₽</b> (кешбек{" "}
                      {Math.round(nextLeague.cashbackPercent * 100)}%)
                    </div>

                    <div className="meter" style={{ marginTop: 10 }}>
                      <div
                        className="meter-fill"
                        style={{ width: `${Math.round((progressToNext.progress || 0) * 100)}%` }}
                      />
                    </div>
                  </>
                ) : (
                  <div className="hint" style={{ marginTop: 10 }}>
                    Максимальная лига достигнута 🏆
                  </div>
                )}
              </Card>

                <Card className="mt-14">
                  <div className="row-between">
                    <div className="muted">Имя</div>
                    <div className="strong">{profile?.name || "—"}</div>
                  </div>
                  <div className="row-between mt-10">
                    <div className="muted">Телефон</div>
                    <div className="strong">{profile?.phone || "—"}</div>
                  </div>
                  <div className="row-between mt-10">
                    <div className="muted">Ваш ID</div>
                    <div className="strong">{profile?.telegram_id || "—"}</div>
                  </div>
                  <div className="row-between mt-10">
                    <div className="muted">Telegram</div>
                    <div className="strong">@{auth?.username || "—"}</div>
                  </div>
                </Card>

                {auth?.isAdmin && (
                  <Card className="mt-14">
                    <div className="section-head">
                      <div>
                        <div className="section-title">Админ панель</div>
                        <div className="hint">Начисление/списание по telegramId</div>
                      </div>
                      <div className="pill">ADMIN</div>
                    </div>

                    <div className="field">
                      <div className="label">telegramId клиента</div>
                      <input
                        className="input"
                        inputMode="numeric"
                        placeholder="например 589918672"
                        value={admin.targetTelegramId}
                        onChange={onAdminChange("targetTelegramId")}
                      />
                    </div>

                    <div className="field">
                      <div className="label">Сумма заказа (₽)</div>
                      <input
                        className="input"
                        inputMode="numeric"
                        placeholder="например 200"
                        value={admin.orderAmount}
                        onChange={onAdminChange("orderAmount")}
                      />
                    </div>

                    <div className="field">
                      <div className="label">Списать баллы</div>
                      <input
                        className="input"
                        inputMode="numeric"
                        placeholder="например 50"
                        value={admin.spendPoints}
                        onChange={onAdminChange("spendPoints")}
                      />
                    </div>

                    <div className="field">
                      <div className="label">Комментарий</div>
                      <input
                        className="input"
                        placeholder="опционально"
                        value={admin.note}
                        onChange={onAdminChange("note")}
                      />
                    </div>

                    <div className="gap" />

                  <button className="btn btn-secondary" onClick={scanClientQr}>
                    Сканировать QR
                  </button>

                  {admin.qrPayload ? (
                    <div className="hint" style={{ marginTop: 10 }}>
                      QR считан:{" "}
                      <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                        {admin.qrPayload.slice(0, 28)}...
                      </span>
                    </div>
                  ) : (
                    <div className="hint" style={{ marginTop: 10 }}>
                      QR не выбран (будет списание по ID)
                    </div>
                  )}

                    <div className="row">
                      <button className="btn btn-primary" onClick={adminEarnAuto}>
                        {admin.qrPayload ? "Начислить кешбек (QR)" : "Начислить кешбек (ID)"}
                      </button>
                      <button
                        className="btn btn-secondary"
                        onClick={admin.qrPayload ? adminSpendByQr : adminSpend}
                      >
                        {admin.qrPayload ? "Списать по QR" : "Списать по ID"}
                      </button>
                    </div>
                  </Card>
                )}
              </motion.div>
            )}

            {tab === "history" && (
              <motion.div
                key="history"
                variants={screenVariants}
                initial="initial"
                animate="animate"
                exit="exit"
              >
                <div className="section-head">
                  <div>
                    <div className="section-title">История</div>
                    <div className="hint">Все движения по счету</div>
                  </div>
                  <div className="pill">{txs.length}</div>
                </div>

                {txs.length === 0 ? (
                  <Card>
                    <div className="muted">Пока нет операций</div>
                  </Card>
                ) : (
                  <div className="list">
                    {txs.map((t) => (
                      <motion.div
                        key={t.id}
                        className="card tx"
                        layout
                        whileTap={{ scale: 0.98 }}
                      >
                        <div>
                          <div className="tx-type">
                            {t.type === "EARN"
                              ? "Начисление"
                              : t.type === "SPEND"
                              ? "Списание"
                              : "Корректировка"}
                          </div>
                          <div className="tx-date">{new Date(t.created_at).toLocaleString()}</div>
                          {t.note ? <div className="tx-note">{t.note}</div> : null}
                        </div>

                        <div className={`tx-amount ${t.amount > 0 ? "pos" : "neg"}`}>
                          {t.amount > 0 ? `+${t.amount}` : t.amount}
                        </div>
                      </motion.div>
                    ))}
                  </div>
                )}
              </motion.div>
            )}

            {tab === "qr" && (
              <motion.div
                key="qr"
                variants={screenVariants}
                initial="initial"
                animate="animate"
                exit="exit"
              >
                <div className="section-head">
                  <div>
                    <div className="section-title">QR-код</div>
                    <div className="hint">Покажи администратору на кассе</div>
                  </div>
                  <div className="pill">SCAN</div>
                </div>

                <Card>
                  <div className="qrWrap">
                    {qrDataUrl ? (
                      <img className="qrImg" src={qrDataUrl} alt="QR" />
                    ) : (
                      <div className="muted">Генерируем QR…</div>
                    )}
                  </div>

                  <div className="gap" />
                  <button className="btn btn-secondary" onClick={() => loadQrToken().catch(()=>{})}>
                    Обновить QR (5 минут)
                  </button>

                  {qrExpiresAt ? (
                    <div className="hint" style={{ marginTop: 10 }}>
                      Действует до: {new Date(qrExpiresAt).toLocaleTimeString()}
                    </div>
                  ) : null}
                </Card>
              </motion.div>
            )}
          </AnimatePresence>

          <Status status={status} />
        </div>
      </div>

      <BottomNav tab={tab} setTab={setTab} />
    </div>
  );
}

function Header({ subtitle }) {
  const tgUser = WebApp.initDataUnsafe?.user;
  const photoUrl = tgUser?.photo_url || "";

  // Фоллбек: инициалы
  const initials = (() => {
    const a = (tgUser?.first_name || "").trim();
    const b = (tgUser?.last_name || "").trim();
    const i1 = a ? a[0].toUpperCase() : "";
    const i2 = b ? b[0].toUpperCase() : "";
    return (i1 + i2) || (tgUser?.username ? tgUser.username[0].toUpperCase() : "U");
  })();

  return (
    <div className="header-clean">
      <div className="header-inner">
        <div className="avatar-box">
          {photoUrl ? (
            <img className="avatar-img" src={photoUrl} alt="avatar" />
          ) : (
            <div className="avatar-fallback">{initials}</div>
          )}
        </div>
      </div>

      {subtitle ? <div className="header-subtitle">{subtitle}</div> : null}
    </div>
  );
}

function Card({ children, className = "" }) {
  return <div className={`card ${className}`}>{children}</div>;
}

function Status({ status }) {
  return <div className="status">{status}</div>;
}

function BottomNav({ tab, setTab }) {
  const Item = ({ id, icon, label }) => (
    <button
      className={`nav-item ${tab === id ? "active" : ""}`}
      onClick={() => setTab(id)}
    >
      <span className="nav-ic">{icon}</span>
      <span className="nav-tx">{label}</span>
      {tab === id ? <span className="nav-active" /> : null}
    </button>
  );

  return (
    <div className="bottom-nav">
      <Item id="profile" icon="🏁" label="Профиль" />
      <Item id="history" icon="🧾" label="История" />
      <Item id="qr" icon="📟" label="QR" />
    </div>
  );
}

function Page({ children }) {
  return (
    <div className="page">
      <div className="container">
        <div className="content">{children}</div>
      </div>
    </div>
  );
}

export default App;