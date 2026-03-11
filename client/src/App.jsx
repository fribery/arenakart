import React, { useEffect, useRef, useState } from "react";
import WebApp from "@twa-dev/sdk";
import QRCode from "qrcode";
import { AnimatePresence, motion } from "framer-motion";
import "./App.css";

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

function handlePhoneInput(value) {
  let digits = String(value || "").replace(/\D/g, "");

  if (digits.startsWith("8")) {
    digits = "7" + digits.slice(1);
  }

  if (!digits.startsWith("7")) {
    digits = "7" + digits;
  }

  digits = digits.slice(0, 11);

  let result = "+7";

  if (digits.length > 1) {
    result += " " + digits.slice(1, 4);
  }
  if (digits.length >= 5) {
    result += " " + digits.slice(4, 7);
  }
  if (digits.length >= 8) {
    result += "-" + digits.slice(7, 9);
  }
  if (digits.length >= 10) {
    result += "-" + digits.slice(9, 11);
  }

  return result;
}

function isValidPhone(value) {
  return /^\+7\d{10}$/.test(String(value || "").trim());
}

function formatBirthDate(value) {
  const s = String(value || "").trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "Дата не указана";
  return `${m[3]}.${m[2]}.${m[1]}`;
}

function formatInventoryDate(value) {
  if (!value) return "Без срока";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "Без срока";
  return d.toLocaleDateString("ru-RU");
}

function inventoryStatusLabel(status) {
  if (status === "used") return "Использовано";
  if (status === "expired") return "Истекло";
  return "Активно";
}

function inventoryTypeLabel(type) {
  if (type === "discount") return "Скидка";
  if (type === "certificate") return "Сертификат";
  if (type === "reward") return "Подарок";
  if (type === "medal") return "Медаль";
  return type || "Предмет";
}

  function inventoryEmoji(type) {
  if (type === "discount") return "🏷️";
  if (type === "certificate") return "🎟️";
  if (type === "reward") return "🎁";
  if (type === "medal") return "🏅";
  return "📦";
}

function App() {
  const [status, setStatus] = useState("Загрузка...");
  const [auth, setAuth] = useState(null);
  const [profile, setProfile] = useState(null);
  const [needsRegistration, setNeedsRegistration] = useState(false);
  const [balance, setBalance] = useState(0);
  const [txs, setTxs] = useState([]);
  const [inventory, setInventory] = useState([]);
  const [selectedInventoryItem, setSelectedInventoryItem] = useState(null);

  const [bookings, setBookings] = useState([]);
  const [selectedUserForBooking, setSelectedUserForBooking] = useState(null);
  const [bookingForm, setBookingForm] = useState({
    title: "Запись в картинг",
    bookingDate: "",
    bookingTime: "",
    guestsCount: "",
    comment: "",
  });

  const [bookingRequests, setBookingRequests] = useState([]);
  const [showCreateRequestModal, setShowCreateRequestModal] = useState(false);
  const [requestForm, setRequestForm] = useState({
    title: "Запись в картинг",
    requestedDate: "",
    requestedTime: "",
    guestsCount: "",
    comment: "",
  });

  const nearestBooking = getNearestActiveBooking(bookings);

  const [tab, setTab] = useState("profile");
  const [screen, setScreen] = useState("main"); // main | adminUsers | bookingRequests

  const nameRef = useRef(null);
  const phoneRef = useRef(null);
  const [agree, setAgree] = useState(false);
  const [regName, setRegName] = useState("");
  const [regPhone, setRegPhone] = useState("");

  const [totalSpent, setTotalSpent] = useState(0);
  const [league, setLeague] = useState(null);
  const [nextLeague, setNextLeague] = useState(null);
  const [progressToNext, setProgressToNext] = useState(null);

  const [qrPayload, setQrPayload] = useState("");
  const [qrExpiresAt, setQrExpiresAt] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState("");

  const [showRescheduleModal, setShowRescheduleModal] = useState(false);
  const [newBookingDate, setNewBookingDate] = useState("");
  const [newBookingTime, setNewBookingTime] = useState("");

  const [admin, setAdmin] = useState({
    targetTelegramId: "",
    orderAmount: "",
    spendPoints: "",
    note: "",
    qrPayload: "",
    itemType: "discount",
    itemTitle: "",
    itemDescription: "",
    itemExpiresAt: "",
    redeemCode: "",
  });

  const inTelegram =
    Boolean(WebApp.initDataUnsafe?.user) && Boolean(WebApp.initData);

  const [kids, setKids] = useState([]);
  const kidsRefs = useRef({});

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

    const text = await r.text();

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${path} → ${r.status} ${r.statusText}: ${text.slice(0, 120)}`);
    }
  }

  async function refreshAll() {
    setStatus("Обновление...");

    const me = await api("/api/me", { initData: WebApp.initData });
    if (!me.ok) {
      throw new Error(`${me.error}${me.details ? " | " + me.details : ""}`);
    }

    setAuth(me.auth);
    setProfile(me.profile);
    setNeedsRegistration(Boolean(me.needsRegistration));
    setBalance(Number(me.balance || 0));
    setTotalSpent(Number(me.totalSpent || 0));
    setLeague(me.league || null);
    setNextLeague(me.nextLeague || null);
    setProgressToNext(me.progressToNext || null);

    const tx = await api("/api/transactions", {
      initData: WebApp.initData,
      limit: 50,
    });
    if (tx.ok) setTxs(tx.items || []);

    const inv = await api("/api/inventory", {
      initData: WebApp.initData,
    });
    if (inv.ok) setInventory(inv.items || []);

    const bk = await api("/api/bookings", {
      initData: WebApp.initData,
    });
    if (bk.ok) setBookings(bk.items || []);

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


  function getNearestActiveBooking(items) {
    const list = Array.isArray(items) ? items : [];

    const active = list.filter((x) => x?.status === "active");
    if (active.length === 0) return null;

    const sorted = [...active].sort((a, b) => {
      const av = `${a.booking_date || ""} ${a.booking_time || ""}`;
      const bv = `${b.booking_date || ""} ${b.booking_time || ""}`;
      return av.localeCompare(bv);
    });

    return sorted[0] || null;
  }

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

  useEffect(() => {
    let cancelled = false;

    async function make() {
      if (!qrPayload) return;
      const url = await QRCode.toDataURL(qrPayload, { margin: 1, width: 300 });
      if (!cancelled) setQrDataUrl(url);
    }

    make().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [qrPayload]);

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

        try {
          WebApp.closeScanQrPopup();
        } catch {}

        setStatus(payload ? "QR считан ✅" : "QR пустой");
      });
    } catch (e) {
      setStatus("Ошибка сканера: " + String(e?.message || e));
    }
  }

  async function createBookingRequest() {
    try {
      if (!requestForm.requestedDate) {
        setStatus("Выбери дату");
        return;
      }

      if (!requestForm.requestedTime) {
        setStatus("Выбери время");
        return;
      }

      setStatus("Отправляем заявку...");

      const r = await api("/api/booking-requests-create", {
        initData: WebApp.initData,
        title: requestForm.title || "Запись в картинг",
        requested_date: requestForm.requestedDate,
        requested_time: requestForm.requestedTime,
        guests_count: requestForm.guestsCount ? Number(requestForm.guestsCount) : null,
        comment: requestForm.comment || "",
      });

      if (!r.ok) {
        setStatus(`Ошибка заявки: ${r.error}${r.details ? " | " + r.details : ""}`);
        return;
      }

      setShowCreateRequestModal(false);
      setRequestForm({
        title: "Запись в картинг",
        requestedDate: "",
        requestedTime: "",
        guestsCount: "",
        comment: "",
      });

      setStatus("Заявка отправлена ✅");
    } catch (e) {
      setStatus("Ошибка: " + String(e?.message || e));
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

      if (admin.qrPayload) payload.qrPayload = admin.qrPayload;
      else payload.targetTelegramId = Number(admin.targetTelegramId);

      const r = await api("/api/admin/order", payload);

      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}${r.details ? " | " + r.details : ""}`);
        return;
      }

      setAdmin((p) => ({ ...p, qrPayload: "" }));

      await refreshAll();
      setStatus(
        `Готово ✅ ${r.league?.name || ""} ${((r.league?.percent || 0) * 100).toFixed(0)}% → +${r.tx?.amount || 0} баллов`
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

  async function adminGrantItem() {
    try {
      const targetTelegramId = Number(admin.targetTelegramId);
      if (!Number.isFinite(targetTelegramId) || targetTelegramId <= 0) {
        setStatus("Введите telegramId клиента для выдачи предмета");
        return;
      }

      if (!admin.itemType || !admin.itemTitle.trim()) {
        setStatus("Заполни тип и название предмета");
        return;
      }

      setStatus("Выдаём предмет...");

      const r = await api("/api/admin/grant-item", {
        initData: WebApp.initData,
        targetTelegramId,
        type: admin.itemType,
        title: admin.itemTitle.trim(),
        description: admin.itemDescription.trim(),
        expiresAt: admin.itemExpiresAt ? new Date(admin.itemExpiresAt).toISOString() : null,
        meta: {},
      });

      if (!r.ok) {
        setStatus(`Ошибка выдачи: ${r.error}${r.details ? " | " + r.details : ""}`);
        return;
      }

      setAdmin((p) => ({
        ...p,
        itemTitle: "",
        itemDescription: "",
        itemExpiresAt: "",
      }));

      await refreshAll();
      setStatus(`Предмет выдан ✅ Код: ${r.item?.code || "—"}`);
    } catch (e) {
      setStatus("Ошибка: " + String(e?.message || e));
    }
  }

  async function adminRedeemItem() {
    try {
      const code = String(admin.redeemCode || "").trim().toUpperCase();
      if (!code) {
        setStatus("Введите код предмета");
        return;
      }

      setStatus("Списываем предмет...");

      const r = await api("/api/admin/redeem-item", {
        initData: WebApp.initData,
        code,
      });

      if (!r.ok) {
        setStatus(`Ошибка списания предмета: ${r.error}${r.details ? " | " + r.details : ""}`);
        return;
      }

      setAdmin((p) => ({ ...p, redeemCode: "" }));
      await refreshAll();
      setStatus("Предмет списан ✅");
    } catch (e) {
      setStatus("Ошибка: " + String(e?.message || e));
    }
  }

  async function rescheduleMyBooking(bookingId) {
    try {
      if (!bookingId) {
        setStatus("Запись не найдена");
        return;
      }

      if (!newBookingDate) {
        setStatus("Выбери новую дату");
        return;
      }

      if (!newBookingTime) {
        setStatus("Выбери новое время");
        return;
      }

      setStatus("Переносим запись...");

      const r = await api("/api/bookings-reschedule", {
        initData: WebApp.initData,
        bookingId,
        booking_date: newBookingDate,
        booking_time: newBookingTime,
      });

      if (!r.ok) {
        setStatus(`Ошибка переноса: ${r.error}${r.details ? " | " + r.details : ""}`);
        return;
      }

      setShowRescheduleModal(false);
      setNewBookingDate("");
      setNewBookingTime("");

      await refreshAll();
      setStatus("Запись перенесена ✅");
    } catch (e) {
      setStatus("Ошибка: " + String(e?.message || e));
    }
  }

  const screenVariants = {
    initial: { opacity: 0, y: 10 },
    animate: { opacity: 1, y: 0, transition: { duration: 0.22 } },
    exit: { opacity: 0, y: -8, transition: { duration: 0.18 } },
  };

  if (!inTelegram) {
    return (
      <Page>
        <Header subtitle="Запусти мини-апп в Telegram" />
        <Card>
          <div className="muted">{status}</div>
        </Card>
      </Page>
    );
  }

  if (needsRegistration) {
    const canRegister = agree;

    return (
      <Page>
        <Header subtitle="Залетаем в лигу: +200 баллов 🎁" />

        <Card>
          <div className="field">
            <div className="label">Имя</div>
            <input
              ref={nameRef}
              className="input"
              placeholder="Например, Евгений"
              autoComplete="name"
              value={regName}
              onChange={(e) => setRegName(normalizeCyrillicName(e.target.value))}
              onBlur={(e) => setRegName(normalizeCyrillicName(e.target.value))}
              onFocus={() => {
                try {
                  WebApp.expand();
                  WebApp.disableVerticalSwipes?.();
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
              value={regPhone}
              onChange={(e) => setRegPhone(handlePhoneInput(e.target.value))}
              onBlur={(e) => setRegPhone(normalizePhone(e.target.value))}
              onFocus={() => {
                try {
                  WebApp.expand();
                  WebApp.disableVerticalSwipes?.();
                } catch {}
              }}
            />
          </div>

          <div className="gap" />

          <button type="button" className="btn btn-secondary" onClick={addKid}>
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
                      onInput={(e) => {
                        e.target.value = normalizeCyrillicName(e.target.value);
                      }}
                    />
                  </div>

                  <div className="field">
                    <div className="label">Дата рождения</div>
                    <input
                      ref={(el) => {
                        if (!kidsRefs.current[key]) {
                          kidsRefs.current[key] = { nameEl: null, dateEl: null };
                        }
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
                const name = normalizeCyrillicName(regName);
                const phone = normalizePhone(regPhone);

                if (!isValidCyrillicName(name)) {
                  setStatus("Имя должно быть на кириллице");
                  return;
                }

                if (!isValidPhone(phone)) {
                  setStatus("Введите телефон в формате +79991234567");
                  return;
                }

                const children = kids
                  .map((key) => {
                    const refs = kidsRefs.current[key];
                    return {
                      name: normalizeCyrillicName(refs?.nameEl?.value || ""),
                      birthDate: (refs?.dateEl?.value || "").trim(),
                    };
                  })
                  .filter((c) => c.name && c.birthDate);

                for (const child of children) {
                  if (!isValidCyrillicName(child.name)) {
                    setStatus("Имя ребёнка должно быть на кириллице");
                    return;
                  }
                }

                setStatus("Сохраняем...");

                const r = await api("/api/register", {
                  initData: WebApp.initData,
                  name,
                  phone,
                  agree: true,
                  children,
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

  if (screen === "adminUsers") {
    if (!auth?.isAdmin) {
      return (
        <Page>
          <Header subtitle="Нет доступа" />
          <Card>
            <div className="strong">Этот экран доступен только админам</div>
            <div className="gap" />
            <button className="btn btn-secondary" onClick={() => setScreen("main")}>
              Назад
            </button>
          </Card>
          <Status status={status} />
        </Page>
      );
    }

    return (
      <AdminUsersScreen
        api={api}
        initData={WebApp.initData}
        status={status}
        setStatus={setStatus}
        onBack={() => setScreen("main")}
      />
    );
  }

  if (screen === "bookingRequests") {
  if (!auth?.isAdmin) {
    return (
      <Page>
        <Header subtitle="Нет доступа" />
        <Card>
          <div className="strong">Этот экран доступен только админам</div>
          <div className="gap" />
          <button className="btn btn-secondary" onClick={() => setScreen("main")}>
            Назад
          </button>
        </Card>
        <Status status={status} />
      </Page>
    );
  }

  return (
    <BookingRequestsScreen
      api={api}
      initData={WebApp.initData}
      status={status}
      setStatus={setStatus}
      onBack={() => setScreen("main")}
    />
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
                <div className="section-head">
                  <div>
                    <div className="section-title">Моя запись</div>
                    <div className="hint">Актуальная запись в картинг</div>
                  </div>
                  <div className="pill">BOOKING</div>
                </div>

                {nearestBooking ? (
                  <>
                    <div className="gap" />

                    <div className="row-between">
                      <div className="muted">Дата</div>
                      <div className="strong">{formatBirthDate(nearestBooking.booking_date)}</div>
                    </div>

                    <div className="row-between mt-10">
                      <div className="muted">Время</div>
                      <div className="strong">{nearestBooking.booking_time || "—"}</div>
                    </div>

                    <div className="row-between mt-10">
                      <div className="muted">Гостей</div>
                      <div className="strong">{nearestBooking.guests_count || "—"}</div>
                    </div>

                    {nearestBooking.comment ? (
                      <div className="hint" style={{ marginTop: 10 }}>
                        {nearestBooking.comment}
                      </div>
                    ) : null}

                    {/* <div className="row mt-14">
                      <button
                        className="btn btn-secondary"
                        onClick={() => {
                          try {
                            WebApp.showPopup(
                              {
                                title: "Отмена записи",
                                message: "Вы точно уверены, что хотите отменить запись?",
                                buttons: [
                                  { id: "no", type: "cancel", text: "Нет" },
                                  { id: "yes", type: "destructive", text: "Да, отменить" },
                                ],
                              },
                              async (buttonId) => {
                                if (buttonId !== "yes") return;

                                try {
                                  setStatus("Отменяем запись...");

                                  const r = await api("/api/bookings-cancel", {
                                    initData: WebApp.initData,
                                    bookingId: nearestBooking.id,
                                  });

                                  if (!r.ok) {
                                    setStatus(`Ошибка отмены: ${r.error}${r.details ? " | " + r.details : ""}`);
                                    return;
                                  }

                                  await refreshAll();
                                  setStatus("Запись отменена ✅");
                                } catch (e) {
                                  setStatus("Ошибка: " + String(e?.message || e));
                                }
                              }
                            );
                          } catch {
                            // fallback если popup недоступен
                            const ok = window.confirm("Вы точно уверены, что хотите отменить запись?");
                            if (!ok) return;

                            (async () => {
                              try {
                                setStatus("Отменяем запись...");

                                const r = await api("/api/bookings-cancel", {
                                  initData: WebApp.initData,
                                  bookingId: nearestBooking.id,
                                });

                                if (!r.ok) {
                                  setStatus(`Ошибка отмены: ${r.error}${r.details ? " | " + r.details : ""}`);
                                  return;
                                }

                                await refreshAll();
                                setStatus("Запись отменена ✅");
                              } catch (e) {
                                setStatus("Ошибка: " + String(e?.message || e));
                              }
                            })();
                          }
                        }}
                      >
                        Отменить
                      </button>

                      <button
                        className="btn btn-primary"
                        onClick={() => {
                          setNewBookingDate(nearestBooking.booking_date || "");
                          setNewBookingTime(nearestBooking.booking_time || "");
                          setShowRescheduleModal(true);
                        }}
                      >
                        Перенести
                      </button>
                    </div> */}
                    
                  </>
                ) : (
                  <div className="muted" style={{ marginTop: 10 }}>
                    У вас пока нет активной записи
                  </div>
                )}
                <div className="row mt-14">
                  <button
                    className="btn btn-primary"
                    onClick={() => {
                      setRequestForm({
                        title: "Запись в картинг",
                        requestedDate: "",
                        requestedTime: "",
                        guestsCount: "",
                        comment: "",
                      });
                      setShowCreateRequestModal(true);
                    }}
                  >
                    Записаться на сеанс
                  </button>
                </div>
              </Card>

                <Card className="mt-14">
                <div className="section-head">
                  <div>
                    <div className="section-title">Инвентарь</div>
                    <div className="hint">Нажми на предмет, чтобы открыть детали</div>
                  </div>
                  <div className="pill">{inventory.length}</div>
                </div>

                {inventory.length === 0 ? (
                  <div className="muted" style={{ marginTop: 10 }}>
                    Пока пусто
                  </div>
                ) : (
                  <div className="inventory-grid">
                    {inventory.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className="inventory-tile"
                        onClick={() => setSelectedInventoryItem(item)}
                      >
                        <div className="inventory-tile-icon">{inventoryEmoji(item.type)}</div>
                        <div className="inventory-tile-title">{item.title || "Предмет"}</div>
                      </button>
                    ))}
                  </div>
                )}
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
                        <b>{Math.round(progressToNext.toNext).toLocaleString("ru-RU")} ₽</b>{" "}
                        (кешбек {Math.round(nextLeague.cashbackPercent * 100)}%)
                      </div>

                      <div className="meter" style={{ marginTop: 10 }}>
                        <div
                          className="meter-fill"
                          style={{
                            width: `${Math.round((progressToNext.progress || 0) * 100)}%`,
                          }}
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
                      </div>

                      <div className="row" style={{ gap: 8, alignItems: "center" }}>
                        <button
                          className="btn btn-secondary"
                          onClick={() => setScreen("adminUsers")}
                          type="button"
                        >
                          Пользователи
                        </button>

                        <button
                          className="btn btn-secondary"
                          onClick={() => setScreen("bookingRequests")}
                          type="button"
                        >
                          Заявки
                        </button>

                        <div className="pill">ADMIN</div>
                      </div>
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
                        <span
                          style={{
                            fontFamily:
                              "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                          }}
                        >
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

                    <div className="gap-lg" />

                    <div className="admin-block-title">Выдать предмет</div>
                    <div className="admin-block-subtitle">Скидка, сертификат, подарок или медаль</div>

                    <div className="field">
                      <div className="label">Тип предмета</div>
                      <select
                        className="input"
                        value={admin.itemType}
                        onChange={onAdminChange("itemType")}
                      >
                        <option value="discount">Скидка</option>
                        <option value="certificate">Сертификат</option>
                        <option value="reward">Подарок</option>
                        <option value="medal">Медаль</option>
                      </select>
                    </div>

                    <div className="field">
                      <div className="label">Название</div>
                      <input
                        className="input"
                        placeholder="Например, Скидка 15%"
                        value={admin.itemTitle}
                        onChange={onAdminChange("itemTitle")}
                      />
                    </div>

                    <div className="field">
                      <div className="label">Описание</div>
                      <input
                        className="input"
                        placeholder="Например, На день рождения"
                        value={admin.itemDescription}
                        onChange={onAdminChange("itemDescription")}
                      />
                    </div>

                    <div className="field">
                      <div className="label">Срок действия</div>
                      <input
                        className="input"
                        type="date"
                        value={admin.itemExpiresAt}
                        onChange={onAdminChange("itemExpiresAt")}
                      />
                    </div>

                    <div className="row">
                      <button className="btn btn-primary" onClick={adminGrantItem}>
                        Выдать предмет
                      </button>
                    </div>

                    <div className="gap-lg" />

                    <div className="admin-divider" />
                    <div className="admin-block-title">Списать предмет</div>
                    <div className="admin-block-subtitle">Введи код, который показывает пользователь</div>

                    <div className="field">
                      <div className="label">Код предмета</div>
                      <input
                        className="input"
                        placeholder="Например, A1B2C3D4"
                        value={admin.redeemCode}
                        onChange={onAdminChange("redeemCode")}
                      />
                    </div>

                    <div className="row">
                      <button className="btn btn-secondary" onClick={adminRedeemItem}>
                        Списать по коду
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
                  <button className="btn btn-secondary" onClick={() => loadQrToken().catch(() => {})}>
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
          {selectedInventoryItem ? (
            <InventoryModal
              item={selectedInventoryItem}
              onClose={() => setSelectedInventoryItem(null)}
            />
          ) : null}

          {showRescheduleModal && nearestBooking ? (
            <RescheduleBookingModal
              booking={nearestBooking}
              newBookingDate={newBookingDate}
              setNewBookingDate={setNewBookingDate}
              newBookingTime={newBookingTime}
              setNewBookingTime={setNewBookingTime}
              onClose={() => {
                setShowRescheduleModal(false);
                setNewBookingDate("");
                setNewBookingTime("");
              }}
              onSubmit={() => rescheduleMyBooking(nearestBooking.id)}
            />
          ) : null}

          {showCreateRequestModal ? (
            <BookingRequestCreateModal
              form={requestForm}
              setForm={setRequestForm}
              onClose={() => setShowCreateRequestModal(false)}
              onSubmit={createBookingRequest}
            />
          ) : null}
        </div>
      </div>

      <BottomNav tab={tab} setTab={setTab} />
    </div>
  );
}

function Header({ subtitle }) {
  const tgUser = WebApp.initDataUnsafe?.user;
  const photoUrl = tgUser?.photo_url || "";

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

function AdminUsersScreen({ api, initData, status, setStatus, onBack }) {
  const [state, setState] = useState({
    loading: false,
    items: [],
    total: 0,
    limit: 20,
    offset: 0,
    q: "",
    league: "",
    minBalance: "",
    maxBalance: "",
    birthMonth: "",
  });

  const [bookingModalUser, setBookingModalUser] = useState(null);
  const [bookingForm, setBookingForm] = useState({
    title: "Запись в картинг",
    bookingDate: "",
    bookingTime: "",
    guestsCount: "",
    comment: "",
  });
  const [bookingSaving, setBookingSaving] = useState(false);

  const onF = (key) => (e) =>
    setState((p) => ({
      ...p,
      [key]: e.target.value,
      offset: 0,
    }));

  useEffect(() => {
    const t = setTimeout(() => {
      load().catch((e) => setStatus("Ошибка: " + String(e?.message || e)));
    }, 300);

    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state.offset,
    state.limit,
    state.q,
    state.league,
    state.minBalance,
    state.maxBalance,
    state.birthMonth,
  ]);

  async function createBookingForUser() {
    try {
      if (!bookingModalUser?.telegram_id) {
        setStatus("Не выбран пользователь");
        return;
      }

      if (!bookingForm.bookingDate) {
        setStatus("Выбери дату записи");
        return;
      }

      if (!bookingForm.bookingTime) {
        setStatus("Выбери время записи");
        return;
      }

      setBookingSaving(true);
      setStatus("Сохраняем запись...");

      const r = await api("/api/admin/create-booking", {
        initData,
        targetTelegramId: bookingModalUser.telegram_id,
        title: bookingForm.title || "Запись в картинг",
        booking_date: bookingForm.bookingDate,
        booking_time: bookingForm.bookingTime,
        guests_count: bookingForm.guestsCount ? Number(bookingForm.guestsCount) : null,
        comment: bookingForm.comment || "",
      });

      if (!r.ok) {
        setStatus(`Ошибка записи: ${r.error}${r.details ? " | " + r.details : ""}`);
        setBookingSaving(false);
        return;
      }

      setBookingSaving(false);
      setBookingModalUser(null);
      setBookingForm({
        title: "Запись в картинг",
        bookingDate: "",
        bookingTime: "",
        guestsCount: "",
        comment: "",
      });

      setStatus("Запись добавлена ✅");
    } catch (e) {
      setBookingSaving(false);
      setStatus("Ошибка: " + String(e?.message || e));
    }
  }

  async function sendBirthdayInvite(user) {
    try {
      const month = Number(state.birthMonth || 3);

      setStatus("Отправляем сообщение...");

      const r = await api("/api/admin/send-birthday-invite", {
        initData,
        targetTelegramId: user.telegram_id,
        month,
        discountText: "скидка 15% на праздник",
      });

      if (!r.ok) {
        if (r.error === "NO_BIRTHDAY_IN_MONTH") {
          setStatus(`У этого пользователя нет детей с ДР в выбранном месяце`);
          return;
        }
        setStatus(`Ошибка рассылки: ${r.error}${r.details ? " | " + r.details : ""}`);
        return;
      }

      setStatus("Сообщение отправлено ✅");
    } catch (e) {
      setStatus("Ошибка: " + String(e?.message || e));
    }
  }

  async function load() {
    setState((p) => ({ ...p, loading: true }));
    setStatus("Загружаем пользователей...");

    const r = await api("/api/admin/users", {
      initData,
      limit: state.limit,
      offset: state.offset,
      q: (state.q || "").trim(),
      league: state.league || null,
      min_balance: state.minBalance ? Number(state.minBalance) : null,
      max_balance: state.maxBalance ? Number(state.maxBalance) : null,
      birth_month: state.birthMonth ? Number(state.birthMonth) : null,
    });

    if (!r.ok) {
      setState((p) => ({ ...p, loading: false }));
      setStatus(`Ошибка списка: ${r.error}${r.details ? " | " + r.details : ""}`);
      return;
    }

    setState((p) => ({
      ...p,
      loading: false,
      items: Array.isArray(r.items) ? r.items : [],
      total: Number(r.total || 0),
    }));

    setStatus("Готово");
  }

  return (
    <Page>
      <Header subtitle="Админ • Пользователи" />

      <Card>
        <div className="row-between" style={{ alignItems: "center" }}>
          <div>
            <div className="section-title">Список пользователей</div>
            <div className="hint">Отдельный экран для админа</div>
          </div>

          <button className="btn btn-secondary btn-small" onClick={onBack} type="button">
            Назад
          </button>
        </div>

        <div className="field">
          <div className="label">Поиск</div>
          <input
            className="input"
            placeholder="Имя, телефон или начало telegramId"
            value={state.q}
            onChange={onF("q")}
          />
        </div>

        <div className="admin-users-filters" style={{ marginTop: 12 }}>
          <div className="field">
            <div className="label">Лига</div>
            <select className="input" value={state.league} onChange={onF("league")}>
              <option value="">Все</option>
              <option value="Rookie">Rookie</option>
              <option value="Pro">Pro</option>
              <option value="Elite">Elite</option>
              <option value="Legend">Legend</option>
            </select>
          </div>

          <div className="field">
            <div className="label">Месяц рождения</div>
            <select className="input" value={state.birthMonth} onChange={onF("birthMonth")}>
              <option value="">Все</option>
              <option value="1">Январь</option>
              <option value="2">Февраль</option>
              <option value="3">Март</option>
              <option value="4">Апрель</option>
              <option value="5">Май</option>
              <option value="6">Июнь</option>
              <option value="7">Июль</option>
              <option value="8">Август</option>
              <option value="9">Сентябрь</option>
              <option value="10">Октябрь</option>
              <option value="11">Ноябрь</option>
              <option value="12">Декабрь</option>
            </select>
          </div>

          <div className="field">
            <div className="label">Мин. баланс</div>
            <input
              className="input"
              inputMode="numeric"
              placeholder="0"
              value={state.minBalance}
              onChange={onF("minBalance")}
            />
          </div>

          <div className="field">
            <div className="label">Макс. баланс</div>
            <input
              className="input"
              inputMode="numeric"
              placeholder="10000"
              value={state.maxBalance}
              onChange={onF("maxBalance")}
            />
          </div>
        </div>

        <div className="gap" />

        <div className="row-between" style={{ alignItems: "center" }}>
          <div className="pill">
            {state.loading ? "Загрузка..." : `${state.total} найдено`}
          </div>

          <div className="row" style={{ marginTop: 0, gap: 8 }}>
            <button
              className="btn btn-secondary btn-small"
              disabled={state.offset <= 0 || state.loading}
              onClick={() =>
                setState((p) => ({
                  ...p,
                  offset: Math.max(0, p.offset - p.limit),
                }))
              }
            >
              ←
            </button>

            <button
              className="btn btn-secondary btn-small"
              disabled={state.loading || state.items.length < state.limit}
              onClick={() =>
                setState((p) => ({
                  ...p,
                  offset: p.offset + p.limit,
                }))
              }
            >
              →
            </button>
          </div>
        </div>
      </Card>

      {state.items.length === 0 ? (
        <Card>
          <div className="muted">
            {state.loading ? "Загрузка..." : "Пользователи не найдены"}
          </div>
        </Card>
      ) : (
        <div className="list">
          {state.items.map((u) => (
          <motion.div
            key={u.id || u.telegram_id}
            className="card user-card-compact"
            layout
            whileTap={{ scale: 0.99 }}
          >
            <div className="user-compact-top">
              <div className="user-compact-main">
                <div className="user-compact-name">{u.name || "Без имени"}</div>
                <div className="user-compact-sub">
                  ID: {u.telegram_id}
                  {u.phone ? ` • ${u.phone}` : ""}
                </div>
              </div>

              {u.league ? (
                <div className="pill user-compact-pill">{u.league}</div>
              ) : null}
            </div>

            <div className="user-compact-stats">
              <span>Баланс: {Number(u.balance || 0)}</span>
              <span>Потрачено: {Number(u.total_spent || 0).toLocaleString("ru-RU")} ₽</span>
            </div>

            {Array.isArray(u.children) && u.children.length > 0 ? (
              <div className="user-kids-compact">
                {u.children.map((child, idx) => (
                  <div className="user-kid-row" key={`${u.telegram_id}-${idx}`}>
                    <div className="user-kid-row-name">{child?.name || "Без имени"}</div>
                    <div className="user-kid-row-date">{formatBirthDate(child?.birthDate)}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="user-kids-empty">Детей нет</div>
            )}

            <div className="user-compact-actions">
              <button
                className="btn btn-secondary btn-mini"
                onClick={() => {
                  setBookingModalUser(u);
                  setBookingForm({
                    title: "Запись в картинг",
                    bookingDate: "",
                    bookingTime: "",
                    guestsCount: "",
                    comment: "",
                  });
                }}
              >
                Запись
              </button>

              <button
                className="btn btn-secondary btn-mini"
                onClick={() => sendBirthdayInvite(u)}
              >
                ДР
              </button>
            </div>
          </motion.div>
        ))}
        </div>
      )}


      {bookingModalUser ? (
      <BookingCreateModal
        user={bookingModalUser}
        form={bookingForm}
        setForm={setBookingForm}
        loading={bookingSaving}
        onClose={() => {
          if (bookingSaving) return;
          setBookingModalUser(null);
        }}
        onSubmit={createBookingForUser}
      />
    ) : null}
      <Status status={status} />
    </Page>
  );
}

function InventoryModal({ item, onClose }) {
  return (
    <div className="inventory-modal-backdrop" onClick={onClose}>
      <div
        className="inventory-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="inventory-modal-head">
          <div className="inventory-modal-icon">{inventoryEmoji(item.type)}</div>
        </div>

        <div className="inventory-modal-title">{item.title || "Предмет"}</div>
        <div className="inventory-modal-subtitle">
          {inventoryTypeLabel(item.type)}
        </div>

        {item.description ? (
          <div className="inventory-modal-desc">{item.description}</div>
        ) : null}

        <div className="inventory-modal-meta">
          {item.code ? (
            <div className="inventory-modal-row">
              <span className="inventory-modal-label">Код</span>
              <span className="inventory-modal-code">{item.code}</span>
            </div>
          ) : null}

          <div className="inventory-modal-row">
            <span className="inventory-modal-label">Выдан</span>
            <span>{formatInventoryDate(item.issued_at || item.created_at)}</span>
          </div>

          <div className="inventory-modal-row">
            <span className="inventory-modal-label">Действует до</span>
            <span>{formatInventoryDate(item.expires_at)}</span>
          </div>
        </div>

        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Закрыть
        </button>
      </div>
    </div>
  );
}

function BookingCreateModal({
  user,
  form,
  setForm,
  onClose,
  onSubmit,
  loading = false,
}) {
  return (
    <div className="inventory-modal-backdrop" onClick={onClose}>
      <div
        className="inventory-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="inventory-modal-head">
          <div className="inventory-modal-icon">📅</div>
        </div>

        <div className="inventory-modal-title">Добавить запись</div>
        <div className="inventory-modal-subtitle">
          {user?.name || "Без имени"} • ID {user?.telegram_id}
        </div>

        <div className="field">
          <div className="label">Название</div>
          <input
            className="input"
            value={form.title}
            onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))}
            placeholder="Запись в картинг"
          />
        </div>

        <div className="field">
          <div className="label">Дата</div>
          <input
            className="input"
            type="date"
            value={form.bookingDate}
            onChange={(e) => setForm((p) => ({ ...p, bookingDate: e.target.value }))}
          />
        </div>

        <div className="field">
          <div className="label">Время</div>
          <input
            className="input"
            type="time"
            value={form.bookingTime}
            onChange={(e) => setForm((p) => ({ ...p, bookingTime: e.target.value }))}
          />
        </div>

        <div className="field">
          <div className="label">Количество гостей</div>
          <input
            className="input"
            inputMode="numeric"
            placeholder="Например, 3"
            value={form.guestsCount}
            onChange={(e) => setForm((p) => ({ ...p, guestsCount: e.target.value }))}
          />
        </div>

        <div className="field">
          <div className="label">Комментарий</div>
          <input
            className="input"
            placeholder="Например, детский день рождения"
            value={form.comment}
            onChange={(e) => setForm((p) => ({ ...p, comment: e.target.value }))}
          />
        </div>

        <div className="row">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Отмена
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onSubmit}
            disabled={loading}
          >
            {loading ? "Сохраняем..." : "Сохранить"}
          </button>
        </div>
      </div>
    </div>
  );
}


function RescheduleBookingModal({
  booking,
  newBookingDate,
  setNewBookingDate,
  newBookingTime,
  setNewBookingTime,
  onClose,
  onSubmit,
}) {
  return (
    <div className="inventory-modal-backdrop" onClick={onClose}>
      <div
        className="inventory-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="inventory-modal-head">
          <div className="inventory-modal-icon">📅</div>
        </div>

        <div className="inventory-modal-title">Перенести запись</div>
        <div className="inventory-modal-subtitle">
          {booking?.title || "Запись в картинг"}
        </div>

        <div className="field">
          <div className="label">Новая дата</div>
          <input
            className="input"
            type="date"
            value={newBookingDate}
            onChange={(e) => setNewBookingDate(e.target.value)}
          />
        </div>

        <div className="field">
          <div className="label">Новое время</div>
          <input
            className="input"
            type="time"
            value={newBookingTime}
            onChange={(e) => setNewBookingTime(e.target.value)}
          />
        </div>

        <div className="row mt-14">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Отмена
          </button>
          <button type="button" className="btn btn-primary" onClick={onSubmit}>
            Сохранить
          </button>
        </div>
      </div>
    </div>
  );
}

function BookingRequestCreateModal({
  form,
  setForm,
  onClose,
  onSubmit,
}) {
  return (
    <div className="inventory-modal-backdrop" onClick={onClose}>
      <div
        className="inventory-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="inventory-modal-head">
          <div className="inventory-modal-icon">🗓️</div>
        </div>

        <div className="inventory-modal-title">Записаться на сеанс</div>
        <div className="inventory-modal-subtitle">
          Оставьте заявку, мы свяжемся с вами
        </div>

        <div className="field">
          <div className="label">Название</div>
          <input
            className="input"
            value={form.title}
            onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))}
            placeholder="Запись в картинг"
          />
        </div>

        <div className="field">
          <div className="label">Желаемая дата</div>
          <input
            className="input"
            type="date"
            value={form.requestedDate}
            onChange={(e) => setForm((p) => ({ ...p, requestedDate: e.target.value }))}
          />
        </div>

        <div className="field">
          <div className="label">Желаемое время</div>
          <input
            className="input"
            type="time"
            value={form.requestedTime}
            onChange={(e) => setForm((p) => ({ ...p, requestedTime: e.target.value }))}
          />
        </div>

        <div className="field">
          <div className="label">Количество гостей</div>
          <input
            className="input"
            inputMode="numeric"
            value={form.guestsCount}
            onChange={(e) => setForm((p) => ({ ...p, guestsCount: e.target.value }))}
            placeholder="Например, 3"
          />
        </div>

        <div className="field">
          <div className="label">Комментарий</div>
          <input
            className="input"
            value={form.comment}
            onChange={(e) => setForm((p) => ({ ...p, comment: e.target.value }))}
            placeholder="Например, детский день рождения"
          />
        </div>

        <div className="row mt-14">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Отмена
          </button>
          <button type="button" className="btn btn-primary" onClick={onSubmit}>
            Отправить
          </button>
        </div>
      </div>
    </div>
  );
}

function BookingRequestsScreen({ api, initData, status, setStatus, onBack }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedRequest, setSelectedRequest] = useState(null);
  const [form, setForm] = useState({
    bookingDate: "",
    bookingTime: "",
    guestsCount: "",
    comment: "",
    adminComment: "",
  });

  async function load() {
    try {
      setLoading(true);
      setStatus("Загружаем заявки...");

      const r = await api("/api/admin/booking-requests", {
        initData,
      });

      if (!r.ok) {
        setStatus(`Ошибка заявок: ${r.error}${r.details ? " | " + r.details : ""}`);
        setLoading(false);
        return;
      }

      setItems(Array.isArray(r.items) ? r.items : []);
      setLoading(false);
      setStatus("Готово");
    } catch (e) {
      setLoading(false);
      setStatus("Ошибка: " + String(e?.message || e));
    }
  }

  useEffect(() => {
    load().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function processRequest(action, reqItem) {
    try {
      setStatus("Обрабатываем заявку...");

      const payload = {
        initData,
        requestId: reqItem.id,
        action,
        admin_comment: form.adminComment || "",
      };

      if (action === "change") {
        payload.booking_date = form.bookingDate;
        payload.booking_time = form.bookingTime;
        payload.guests_count = form.guestsCount ? Number(form.guestsCount) : null;
        payload.comment = form.comment || "";
      }

      const r = await api("/api/admin/booking-requests-process", payload);

      if (!r.ok) {
        setStatus(`Ошибка обработки: ${r.error}${r.details ? " | " + r.details : ""}`);
        return;
      }

      setSelectedRequest(null);
      setForm({
        bookingDate: "",
        bookingTime: "",
        guestsCount: "",
        comment: "",
        adminComment: "",
      });

      await load();
      setStatus("Заявка обработана ✅");
    } catch (e) {
      setStatus("Ошибка: " + String(e?.message || e));
    }
  }

  return (
    <Page>
      <Header subtitle="Админ • Актуальные заявки" />

      <Card>
        <div className="row-between" style={{ alignItems: "center" }}>
          <div>
            <div className="section-title">Актуальные заявки</div>
            <div className="hint">Заявки из приложения от клиентов</div>
          </div>

          <button className="btn btn-secondary btn-small" onClick={onBack} type="button">
            Назад
          </button>
        </div>
      </Card>

      {items.length === 0 ? (
        <Card>
          <div className="muted">{loading ? "Загрузка..." : "Новых заявок нет"}</div>
        </Card>
      ) : (
        <div className="list">
          {items.map((reqItem) => (
            <Card key={reqItem.id}>
              <div className="user-compact-top">
                <div className="user-compact-main">
                  <div className="user-compact-name">{reqItem.title || "Запись в картинг"}</div>
                  <div className="user-compact-sub">ID: {reqItem.telegram_id}</div>
                </div>
                <div className="pill">PENDING</div>
              </div>

              <div className="user-compact-stats" style={{ marginTop: 10 }}>
                <span>Дата: {formatBirthDate(reqItem.requested_date)}</span>
                <span>Время: {reqItem.requested_time}</span>
                <span>Гостей: {reqItem.guests_count || "—"}</span>
              </div>

              {reqItem.comment ? (
                <div className="hint" style={{ marginTop: 10 }}>
                  {reqItem.comment}
                </div>
              ) : null}

              <div className="user-compact-actions" style={{ marginTop: 12 }}>
                <button
                  className="btn btn-secondary btn-mini"
                  onClick={() => {
                    setForm({
                      bookingDate: reqItem.requested_date || "",
                      bookingTime: reqItem.requested_time || "",
                      guestsCount: reqItem.guests_count || "",
                      comment: reqItem.comment || "",
                      adminComment: "",
                    });
                    processRequest("approve", reqItem);
                  }}
                >
                  Подтвердить
                </button>

                <button
                  className="btn btn-secondary btn-mini"
                  onClick={() => {
                    setForm((p) => ({ ...p, adminComment: "" }));
                    processRequest("reject", reqItem);
                  }}
                >
                  Отказать
                </button>

                <button
                  className="btn btn-primary btn-mini"
                  onClick={() => {
                    setSelectedRequest(reqItem);
                    setForm({
                      bookingDate: reqItem.requested_date || "",
                      bookingTime: reqItem.requested_time || "",
                      guestsCount: reqItem.guests_count || "",
                      comment: reqItem.comment || "",
                      adminComment: "",
                    });
                  }}
                >
                  Изменить
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {selectedRequest ? (
        <BookingRequestProcessModal
          reqItem={selectedRequest}
          form={form}
          setForm={setForm}
          onClose={() => setSelectedRequest(null)}
          onSubmit={() => processRequest("change", selectedRequest)}
        />
      ) : null}

      <Status status={status} />
    </Page>
  );
}

function BookingRequestProcessModal({
  reqItem,
  form,
  setForm,
  onClose,
  onSubmit,
}) {
  return (
    <div className="inventory-modal-backdrop" onClick={onClose}>
      <div
        className="inventory-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="inventory-modal-head">
          <div className="inventory-modal-icon">📞</div>
        </div>

        <div className="inventory-modal-title">Изменить заявку</div>
        <div className="inventory-modal-subtitle">
          ID {reqItem?.telegram_id}
        </div>

        <div className="field">
          <div className="label">Дата</div>
          <input
            className="input"
            type="date"
            value={form.bookingDate}
            onChange={(e) => setForm((p) => ({ ...p, bookingDate: e.target.value }))}
          />
        </div>

        <div className="field">
          <div className="label">Время</div>
          <input
            className="input"
            type="time"
            value={form.bookingTime}
            onChange={(e) => setForm((p) => ({ ...p, bookingTime: e.target.value }))}
          />
        </div>

        <div className="field">
          <div className="label">Гостей</div>
          <input
            className="input"
            inputMode="numeric"
            value={form.guestsCount}
            onChange={(e) => setForm((p) => ({ ...p, guestsCount: e.target.value }))}
          />
        </div>

        <div className="field">
          <div className="label">Комментарий</div>
          <input
            className="input"
            value={form.comment}
            onChange={(e) => setForm((p) => ({ ...p, comment: e.target.value }))}
          />
        </div>

        <div className="field">
          <div className="label">Комментарий админа</div>
          <input
            className="input"
            value={form.adminComment}
            onChange={(e) => setForm((p) => ({ ...p, adminComment: e.target.value }))}
          />
        </div>

        <div className="row mt-14">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Отмена
          </button>
          <button type="button" className="btn btn-primary" onClick={onSubmit}>
            Сохранить
          </button>
        </div>
      </div>
    </div>
  );
}

export default App;