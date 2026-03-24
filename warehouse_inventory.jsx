import { useState, useEffect, useCallback, useRef, useMemo, createContext, useContext } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, Legend } from "recharts";

// ─── Constants & Helpers ──────────────────────────────────────────────────────
const K = { products: "wh-p-v5", users: "wh-u-v5", deliveries: "wh-d-v5", theme: "wh-theme-v1", waste: "wh-waste-v1", stocktakes: "wh-st-v1", clients: "wh-c-v1", suppliers: "wh-sup-v1", templates: "wh-tpl-v1", settings: "wh-set-v1" };
const generateId = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const todayStr = () => new Date().toISOString().slice(0, 10);
const fmtDate = (d) => new Date(d).toLocaleString("bg-BG", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const fmtShortDate = (iso) => new Date(iso).toLocaleDateString("bg-BG", { day: "2-digit", month: "2-digit" });
const fmt = (n) => Number(n || 0).toFixed(2);

let _supabase = null;
const getSupabase = () => {
  if (_supabase) return _supabase;
  const config = JSON.parse(localStorage.getItem(K.settings) || "{}");
  if (config.supabaseUrl && config.supabaseKey && window.supabase) {
    _supabase = window.supabase.createClient(config.supabaseUrl, config.supabaseKey);
    return _supabase;
  }
  return null;
};

const sget = async (k) => {
  try {
    const sb = getSupabase();
    if (sb) {
      const { data, error } = await sb.from("app_data").select("value").eq("key", k).single();
      if (!error && data) {
        localStorage.setItem(k, JSON.stringify(data.value));
        return data.value;
      }
    }
    return JSON.parse(localStorage.getItem(k));
  } catch { return null; }
};

const sset = async (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
    const sb = getSupabase();
    if (sb) {
      await sb.from("app_data").upsert({ key: k, value: v }, { onConflict: "key" });
    }
  } catch {}
};

// ─── Categories ───────────────────────────────────────────────────────────────
const CATEGORIES = [
  { id: "all", name: "Всички", icon: "📋", color: "#6B7280" },
  { id: "dairy", name: "Млечни", icon: "🥛", color: "#3B82F6" },
  { id: "bread", name: "Хляб", icon: "🍞", color: "#F59E0B" },
  { id: "oils", name: "Масла", icon: "🫒", color: "#84CC16" },
  { id: "meat", name: "Месо", icon: "🥩", color: "#EF4444" },
  { id: "vegs", name: "Зеленчуци", icon: "🥬", color: "#10B981" },
  { id: "eggs", name: "Яйца", icon: "🥚", color: "#F97316" },
  { id: "spices", name: "Подправки", icon: "🌶️", color: "#8B5CF6" },
  { id: "other", name: "Други", icon: "📦", color: "#6B7280" },
];

// ─── Permissions ──────────────────────────────────────────────────────────────
const PERMISSIONS = {
  owner: ["all"],
  manager: ["view_inventory", "edit_products", "create_delivery", "view_history", "view_stats", "view_report"],
  worker: ["view_inventory", "create_delivery", "view_own_history"],
};
const canDo = (user, action) => {
  if (!user) return false;
  const perms = PERMISSIONS[user.role] || [];
  return perms.includes("all") || perms.includes(action);
};

// ─── Password Hashing ─────────────────────────────────────────────────────────
async function hashPwd(plain) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(plain));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ─── Fuzzy Search ─────────────────────────────────────────────────────────────
function fuzzyMatch(query, text) {
  if (!query) return true;
  const q = query.toLowerCase().trim(), t = text.toLowerCase();
  if (t.includes(q)) return true;
  if (q.length < 2) return false;
  // Simple Levenshtein for short queries
  const maxDist = q.length <= 3 ? 1 : 2;
  for (let i = 0; i <= t.length - q.length; i++) {
    const sub = t.slice(i, i + q.length + 1);
    let dist = 0;
    for (let j = 0; j < q.length; j++) { if (q[j] !== sub[j]) dist++; }
    if (dist <= maxDist) return true;
  }
  // Check if all chars exist in order (subsequence)
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) { if (t[i] === q[qi]) qi++; }
  return qi === q.length;
}

// ─── Waste Reasons ────────────────────────────────────────────────────────────
const WASTE_REASONS = [
  { id: "expired", label: "⏰ Изтекъл срок", color: "#EF4444" },
  { id: "damaged", label: "💥 Повреден", color: "#F59E0B" },
  { id: "spoiled", label: "🦠 Развален", color: "#8B5CF6" },
  { id: "theft", label: "🔒 Кражба", color: "#DC2626" },
  { id: "other", label: "📝 Друго", color: "#6B7280" },
];

// ─── Depletion Forecast ───────────────────────────────────────────────────────
function calcDepletion(product, deliveries) {
  if (!product || product.qty === 0) return null;
  const now = new Date();
  const last30 = deliveries.filter(d => {
    const dd = new Date(d.date); return (now - dd) / 86400000 <= 30;
  });
  let totalUsed = 0;
  last30.forEach(d => d.items.forEach(i => { if (i.id === product.id) totalUsed += i.qty; }));
  const dailyRate = totalUsed / 30;
  if (dailyRate <= 0) return { days: 999, rate: 0 };
  return { days: Math.ceil(product.qty / dailyRate), rate: +(dailyRate.toFixed(1)) };
}

// ─── Sort ─────────────────────────────────────────────────────────────────────
const SORT_OPTS = [
  { id: "name-asc", label: "Име (А→Я)" }, { id: "name-desc", label: "Име (Я→А)" },
  { id: "qty-asc", label: "Количество ↑" }, { id: "qty-desc", label: "Количество ↓" },
  { id: "price-asc", label: "Цена ↑" }, { id: "price-desc", label: "Цена ↓" },
  { id: "status", label: "Статус (критични)" },
];
function sortProds(arr, id) {
  const s = [...arr];
  switch (id) {
    case "name-asc": return s.sort((a, b) => a.name.localeCompare(b.name, "bg"));
    case "name-desc": return s.sort((a, b) => b.name.localeCompare(a.name, "bg"));
    case "qty-asc": return s.sort((a, b) => a.qty - b.qty);
    case "qty-desc": return s.sort((a, b) => b.qty - a.qty);
    case "price-asc": return s.sort((a, b) => (a.price || 0) - (b.price || 0));
    case "price-desc": return s.sort((a, b) => (b.price || 0) - (a.price || 0));
    case "status": return s.sort((a, b) => { const st = p => p.qty === 0 ? 0 : p.qty <= p.minQty ? 1 : 2; return st(a) - st(b); });
    default: return s;
  }
}

// ─── Themes ───────────────────────────────────────────────────────────────────
const LIGHT = {
  bg: "#F0F4FF", surface: "#FFFFFF", border: "#E2E8F0",
  primary: "#4F6EF7", primaryD: "#3A56E0",
  text: "#1E293B", textSub: "#64748B", textMute: "#94A3B8",
  green: "#10B981", orange: "#F59E0B", red: "#EF4444",
  shadow: "0 2px 12px rgba(79,110,247,0.10)", shadowLg: "0 8px 32px rgba(79,110,247,0.15)",
};
const DARK = {
  bg: "#0F172A", surface: "#1E293B", border: "#334155",
  primary: "#6C8AFF", primaryD: "#5B7AFF",
  text: "#F1F5F9", textSub: "#94A3B8", textMute: "#64748B",
  green: "#34D399", orange: "#FBBF24", red: "#F87171",
  shadow: "0 2px 12px rgba(0,0,0,0.30)", shadowLg: "0 8px 32px rgba(0,0,0,0.40)",
};
const ThemeCtx = createContext(LIGHT);
const useT = () => useContext(ThemeCtx);

// ─── Hooks ────────────────────────────────────────────────────────────────────
function useIsMobile() {
  const [m, setM] = useState(typeof window !== "undefined" && window.innerWidth < 768);
  useEffect(() => { const h = () => setM(window.innerWidth < 768); window.addEventListener("resize", h); return () => window.removeEventListener("resize", h); }, []);
  return m;
}

// ─── CSS ──────────────────────────────────────────────────────────────────────
const getCSS = (T) => `
  @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:${T.bg};transition:background .3s;}
  ::-webkit-scrollbar{width:6px;height:6px;}
  ::-webkit-scrollbar-track{background:${T.bg};}
  ::-webkit-scrollbar-thumb{background:${T.border};border-radius:4px;}
  input::placeholder{color:${T.textMute};}
  select option{background:${T.surface};color:${T.text};}
  @keyframes slideIn{from{transform:translateX(30px);opacity:0}to{transform:none;opacity:1}}
  @keyframes slideDown{from{transform:translateY(-8px);opacity:0}to{transform:none;opacity:1}}
  @keyframes spin{to{transform:rotate(360deg)}}
  @keyframes bellShake{0%,100%{transform:rotate(0)}20%{transform:rotate(15deg)}40%{transform:rotate(-12deg)}60%{transform:rotate(8deg)}80%{transform:rotate(-5deg)}}
  .spin{animation:spin 1s linear infinite;display:inline-block;}
  .bell-shake{animation:bellShake .6s ease;}
  .slide-down{animation:slideDown .2s ease;}
  .card-hover{transition:box-shadow .2s,transform .2s;}
  .card-hover:hover{box-shadow:${T.shadowLg}!important;transform:translateY(-2px);}
  .btn-hover{transition:filter .15s,transform .1s;}
  .btn-hover:hover{filter:brightness(1.08);transform:translateY(-1px);}
  .btn-hover:active{transform:translateY(0);}
  .trow:hover td{background:${T.bg};}
  @media(max-width:768px){
    .hide-mobile{display:none!important;}
    .grid-mobile-1{grid-template-columns:1fr!important;}
    .stack-mobile{grid-template-columns:1fr!important;}
  }
`;

// ─── Seed Data ────────────────────────────────────────────────────────────────
const nextDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const SEED_PRODUCTS = [
  { id: generateId(), code: "MLK001", name: "Прясно мляко 1л", qty: 48, unit: "бр", minQty: 10, price: 0, costPrice: 0, category: "dairy", expiryDate: nextDays(5) },
  { id: generateId(), code: "BRD002", name: "Хляб Добруджа 800г", qty: 2, unit: "бр", minQty: 5, price: 0, costPrice: 0, category: "bread", expiryDate: nextDays(2) },
  { id: generateId(), code: "OIL003", name: "Слънчогледово масло 1л", qty: 60, unit: "бр", minQty: 12, price: 0, costPrice: 0, category: "oils", expiryDate: nextDays(180) },
  { id: generateId(), code: "CHZ004", name: "Кашкавал Витоша 400г", qty: 0, unit: "бр", minQty: 8, price: 0, costPrice: 0, category: "dairy", expiryDate: nextDays(30) },
  { id: generateId(), code: "EGG005", name: "Яйца кокоши (10бр)", qty: 40, unit: "пак", minQty: 10, price: 0, costPrice: 0, category: "eggs", expiryDate: nextDays(14) },
  { id: generateId(), code: "TOM006", name: "Домати пресни 1кг", qty: 3, unit: "кг", minQty: 5, price: 0, costPrice: 0, category: "vegs", expiryDate: nextDays(3) },
  { id: generateId(), code: "CHK007", name: "Пилешко филе 1кг", qty: 18, unit: "кг", minQty: 6, price: 0, costPrice: 0, category: "meat", expiryDate: nextDays(4) },
  { id: generateId(), code: "RIC008", name: "Ориз Арборио 1кг", qty: 30, unit: "бр", minQty: 8, price: 0, costPrice: 0, category: "spices", expiryDate: nextDays(365) },
  { id: generateId(), code: "SGR009", name: "Захар бяла 1кг", qty: 0, unit: "бр", minQty: 15, price: 0, costPrice: 0, category: "other", expiryDate: "" },
  { id: generateId(), code: "YOG010", name: "Кисело мляко 400г", qty: 27, unit: "бр", minQty: 10, price: 0, costPrice: 0, category: "dairy", expiryDate: nextDays(7) },
];

// ─── AI Price Fetch ───────────────────────────────────────────────────────────
async function fetchPricesAI(products) {
  const names = products.map((p, i) => `${i + 1}. ${p.name}`).join("\n");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 400,
      messages: [{ role: "user", content: `Дай реалистични цени в лева за тези хранителни стоки от български супермаркети.\nОтговори САМО с JSON: {"sell":[продажни],"cost":[доставни ~75%]}\nБез текст.\nПродукти:\n${names}` }],
    }),
  });
  const data = await res.json();
  const text = data.content?.map(b => b.text || "").join("") || '{"sell":[],"cost":[]}';
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

// ─── Font helper ──────────────────────────────────────────────────────────────
const F = "'Plus Jakarta Sans',sans-serif";

// ─── Toast ────────────────────────────────────────────────────────────────────
function Toast({ msg, type, onClose, undoable, onUndo }) {
  const T = useT();
  useEffect(() => { const t = setTimeout(onClose, undoable ? 7000 : 4500); return () => clearTimeout(t); }, [onClose, undoable]);
  const col = { success: T.green, error: T.red, info: T.primary }[type] || T.primary;
  return (
    <div style={{ position: "fixed", bottom: 24, right: 24, zIndex: 9999, background: T.surface, border: `2px solid ${col}`, color: T.text, padding: "12px 20px", borderRadius: 12, fontFamily: F, fontSize: 13, fontWeight: 600, boxShadow: `0 8px 24px ${col}33`, animation: "slideIn .25s ease", maxWidth: 320, display: "flex", alignItems: "center", gap: 10 }}>
      <span style={{ fontSize: 16 }}>{type === "success" ? "✅" : type === "error" ? "❌" : "ℹ️"}</span>
      <div style={{ flex: 1 }}>{msg}</div>
      {undoable && <button onClick={onUndo} style={{ background: T.primary, color: "#fff", border: "none", borderRadius: 8, padding: "4px 10px", fontSize: 11, cursor: "pointer", fontWeight: 700, marginLeft: 8 }}>UNDO</button>}
    </div>
  );
}

// ─── Onboarding Modal ─────────────────────────────────────────────────────────
function OnboardingModal({ onClose }) {
  const T = useT();
  const [step, setStep] = useState(0);
  const steps = [
    { t: "Добре дошли в Склад PRO! ⬡", d: "Вашата система за управление на склад вече е готова. Нека ви покажем основните функции.", i: "🚀" },
    { t: "📦 Инвентар", d: "Тук следите количествата, цените и сроковете на годност. Използвайте Ctrl+F за бързо търсене.", i: "📦" },
    { t: "🚚 Доставки", d: "Правете нови продажби или зареждания. Можете да ползвате шаблони и QR кодове.", i: "🚚" },
    { t: "📊 Анализи", d: "Следете приходите, печалбите и ABC анализа в реално време.", i: "📊" },
    { t: "⌨️ Бързи клавиши", d: "Alt + 1..5 за навигация, Ctrl+Z за Undo (отмяна).", i: "⌨️" }
  ];
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(30,41,59,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, backdropFilter: "blur(4px)" }}>
      <div style={{ background: T.surface, borderRadius: 24, padding: 32, width: 380, textAlign: "center", boxShadow: T.shadowLg, border: `1px solid ${T.border}` }}>
        <div style={{ fontSize: 54, marginBottom: 20 }}>{steps[step].i}</div>
        <div style={{ fontSize: 18, fontWeight: 800, color: T.text, marginBottom: 12, fontFamily: F }}>{steps[step].t}</div>
        <div style={{ fontSize: 14, color: T.textSub, marginBottom: 32, fontFamily: F, lineHeight: 1.5 }}>{steps[step].d}</div>
        <div style={{ display: "flex", gap: 10 }}>
          {step > 0 && <button onClick={() => setStep(s => s - 1)} style={{ flex: 1, padding: "12px 0", background: T.bg, color: T.textSub, border: `1px solid ${T.border}`, borderRadius: 12, cursor: "pointer", fontWeight: 700 }}>Назад</button>}
          <button onClick={() => step < steps.length - 1 ? setStep(s => s + 1) : onClose()} style={{ flex: 2, padding: "12px 0", background: T.primary, color: "#fff", border: "none", borderRadius: 12, cursor: "pointer", fontWeight: 700 }}>
            {step < steps.length - 1 ? "Напред" : "Започни работа"}
          </button>
        </div>
        <div style={{ display: "flex", justifyContent: "center", gap: 6, marginTop: 24 }}>
          {steps.map((_, i) => <div key={i} style={{ width: 8, height: 8, borderRadius: "50%", background: i === step ? T.primary : T.border }} />)}
        </div>
      </div>
    </div>
  );
}

// ─── Confirm Modal ────────────────────────────────────────────────────────────
function ConfirmModal({ title, message, onConfirm, onCancel, danger }) {
  const T = useT();
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(30,41,59,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 3000, backdropFilter: "blur(4px)" }}>
      <div style={{ background: T.surface, borderRadius: 20, padding: 28, width: 380, boxShadow: T.shadowLg, border: `1px solid ${T.border}` }}>
        <div style={{ fontSize: 17, fontWeight: 800, color: T.text, marginBottom: 12, fontFamily: F }}>{title}</div>
        <div style={{ fontSize: 14, color: T.textSub, marginBottom: 24, fontFamily: F, lineHeight: 1.5 }}>{message}</div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onConfirm} className="btn-hover" style={{ flex: 1, padding: "12px 0", background: danger ? T.red : T.primary, color: "#fff", border: "none", borderRadius: 12, fontFamily: F, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Потвърди</button>
          <button onClick={onCancel} className="btn-hover" style={{ flex: 1, padding: "12px 0", background: T.bg, color: T.textSub, border: `1px solid ${T.border}`, borderRadius: 12, fontFamily: F, fontSize: 14, fontWeight: 600, cursor: "pointer" }}>Откажи</button>
        </div>
      </div>
    </div>
  );
}

// ─── Notification Panel ───────────────────────────────────────────────────────
function NotificationPanel({ products, onClose }) {
  const T = useT();
  const empty = products.filter(p => p.qty === 0);
  const low = products.filter(p => p.qty > 0 && p.qty <= p.minQty);
  const all = [...empty, ...low];
  return (
    <div className="slide-down" style={{ position: "absolute", top: "calc(100% + 8px)", right: 0, width: 300, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 16, boxShadow: T.shadowLg, zIndex: 500, overflow: "hidden" }}>
      <div style={{ padding: "13px 16px", borderBottom: `1px solid ${T.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", background: T.bg }}>
        <span style={{ fontWeight: 800, fontSize: 13, color: T.text, fontFamily: F }}>🔔 Известия за склада</span>
        <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: T.textMute, fontSize: 18, lineHeight: 1, padding: "0 4px" }}>×</button>
      </div>
      <div style={{ maxHeight: 340, overflowY: "auto" }}>
        {all.length === 0 ? (
          <div style={{ padding: "28px 16px", textAlign: "center", color: T.textMute, fontSize: 13, fontFamily: F }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>🎉</div>Всички запаси са наред!
          </div>
        ) : all.map(p => {
          const ie = p.qty === 0; const col = ie ? T.red : T.orange;
          return (
            <div key={p.id} style={{ padding: "10px 16px", borderBottom: `1px solid ${T.border}`, display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 34, height: 34, borderRadius: 9, background: `${col}15`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, flexShrink: 0 }}>{ie ? "📦" : "⚠️"}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: T.text, fontFamily: F, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                <div style={{ fontSize: 11, color: col, fontWeight: 600, fontFamily: F }}>{ie ? "Изчерпан" : `Нисък: ${p.qty} ${p.unit}`}</div>
              </div>
              <div style={{ fontSize: 9, background: `${col}15`, color: col, borderRadius: 5, padding: "2px 6px", fontWeight: 700, fontFamily: F, flexShrink: 0 }}>{p.code}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Stock Alert Modal ────────────────────────────────────────────────────────
function StockAlertModal({ products, mode, onClose }) {
  const T = useT();
  const color = mode === "empty" ? T.red : T.orange;
  const items = mode === "empty" ? products.filter(p => p.qty === 0) : products.filter(p => p.qty > 0 && p.qty <= p.minQty);
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(30,41,59,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, backdropFilter: "blur(4px)" }}>
      <div style={{ background: T.surface, borderRadius: 20, width: 420, maxHeight: "80vh", overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: T.shadowLg, border: `1px solid ${T.border}` }}>
        <div style={{ background: color, padding: "18px 24px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontFamily: F, fontWeight: 800, fontSize: 16, color: "#fff" }}>{mode === "empty" ? "✕ Изчерпани продукти" : "⚠ Нисък запас"}</div>
          <button onClick={onClose} style={{ background: "rgba(255,255,255,.25)", border: "none", color: "#fff", cursor: "pointer", fontSize: 18, borderRadius: 8, width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>×</button>
        </div>
        <div style={{ overflowY: "auto", padding: "16px 24px" }}>
          {items.length === 0
            ? <div style={{ color: T.textMute, textAlign: "center", padding: "30px 0", fontFamily: F, fontSize: 14 }}>Няма такива продукти 🎉</div>
            : items.map(p => (
              <div key={p.id} style={{ display: "flex", gap: 12, padding: "12px 0", borderBottom: `1px solid ${T.border}`, alignItems: "center" }}>
                <div style={{ background: color + "20", color, borderRadius: 8, padding: "4px 8px", fontSize: 10, fontWeight: 700, fontFamily: F }}>{p.code}</div>
                <div style={{ flex: 1, fontSize: 14, fontWeight: 600, color: T.text, fontFamily: F }}>{p.name}</div>
                <div style={{ fontSize: 16, fontWeight: 800, color, fontFamily: F }}>{p.qty} {p.unit}</div>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

// ─── Daily Report Modal ───────────────────────────────────────────────────────
function DailyReportModal({ deliveries, onClose, onPrint }) {
  const T = useT();
  const todayD = deliveries.filter(d => d.date.startsWith(todayStr()));
  const byWorker = {};
  todayD.forEach(d => {
    if (!byWorker[d.userId]) byWorker[d.userId] = { name: d.userName, deliveries: 0, revenue: 0, profit: 0, items: {} };
    byWorker[d.userId].deliveries++;
    d.items.forEach(item => {
      byWorker[d.userId].revenue += (item.price || 0) * item.qty;
      byWorker[d.userId].profit += ((item.price || 0) - (item.costPrice || 0)) * item.qty;
      byWorker[d.userId].items[item.name] = (byWorker[d.userId].items[item.name] || 0) + item.qty;
    });
  });
  const totalRevenue = Object.values(byWorker).reduce((s, w) => s + w.revenue, 0);
  const totalProfit = Object.values(byWorker).reduce((s, w) => s + w.profit, 0);
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(30,41,59,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2000, backdropFilter: "blur(4px)" }}>
      <div style={{ background: T.surface, borderRadius: 20, width: 440, maxHeight: "90vh", overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: T.shadowLg, border: `1px solid ${T.border}` }}>
        <div style={{ background: `linear-gradient(135deg,${T.primary},${T.primaryD})`, padding: "20px 24px", textAlign: "center" }}>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,.7)", letterSpacing: 3, marginBottom: 4, fontFamily: F, fontWeight: 600 }}>ДНЕВЕН ОТЧЕТ</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "#fff", fontFamily: F }}>⬡ СКЛАД PRO</div>
          <div style={{ fontSize: 12, color: "rgba(255,255,255,.7)", marginTop: 4, fontFamily: F }}>{new Date().toLocaleDateString("bg-BG", { day: "2-digit", month: "long", year: "numeric" })}</div>
        </div>
        <div style={{ overflowY: "auto", padding: "20px 24px", flex: 1, background: T.bg }}>
          {Object.keys(byWorker).length === 0
            ? <div style={{ textAlign: "center", color: T.textMute, padding: "30px 0", fontSize: 14, fontFamily: F }}>Няма доставки днес</div>
            : Object.entries(byWorker).map(([uid, w]) => (
              <div key={uid} style={{ background: T.surface, borderRadius: 16, padding: 18, marginBottom: 16, border: `1px solid ${T.border}`, boxShadow: T.shadow }}>
                <div style={{ fontWeight: 800, fontSize: 15, color: T.text, marginBottom: 12, fontFamily: F }}>👤 {w.name}</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 12 }}>
                  {[{ l: "Доставки", v: w.deliveries, c: T.primary, bg: "#EEF2FF" }, { l: "Приход", v: `${fmt(w.revenue)} лв`, c: T.text, bg: T.bg }, { l: "Печалба", v: `${fmt(w.profit)} лв`, c: T.green, bg: "#ECFDF5" }].map(({ l, v, c, bg }) => (
                    <div key={l} style={{ background: bg, borderRadius: 10, padding: "10px 8px", textAlign: "center" }}>
                      <div style={{ fontSize: 9, color: T.textSub, letterSpacing: 1, marginBottom: 4, fontFamily: F, fontWeight: 600 }}>{l.toUpperCase()}</div>
                      <div style={{ fontSize: 14, fontWeight: 800, color: c, fontFamily: F }}>{v}</div>
                    </div>
                  ))}
                </div>
                <div style={{ borderTop: `1px dashed ${T.border}`, paddingTop: 10 }}>
                  {Object.entries(w.items).slice(0, 5).map(([name, qty]) => (
                    <div key={name} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 13, fontFamily: F }}>
                      <span style={{ color: T.textSub }}>{name}</span>
                      <span style={{ fontWeight: 700, color: T.text }}>{qty} бр.</span>
                    </div>
                  ))}
                  {Object.keys(w.items).length > 5 && <div style={{ color: T.textMute, fontSize: 11, marginTop: 4 }}>+{Object.keys(w.items).length - 5} повече...</div>}
                </div>
              </div>
            ))}
          {Object.keys(byWorker).length > 0 && (
            <div style={{ background: "linear-gradient(135deg,#ECFDF5,#D1FAE5)", borderRadius: 16, padding: 18, border: "1px solid #6EE7B7" }}>
              <div style={{ fontWeight: 800, fontSize: 14, color: "#065F46", marginBottom: 12, fontFamily: F }}>📊 ОБЩО ЗА ДЕНЯ</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                {[{ l: "ОБЩ ПРИХОД", v: `${fmt(totalRevenue)} лв`, c: "#1E293B" }, { l: "ОБЩА ПЕЧАЛБА", v: `${fmt(totalProfit)} лв`, c: "#059669" }].map(({ l, v, c }) => (
                  <div key={l} style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 9, color: "#065F46", letterSpacing: 1, fontFamily: F, fontWeight: 600, marginBottom: 4 }}>{l}</div>
                    <div style={{ fontSize: 20, fontWeight: 800, color: c, fontFamily: F }}>{v}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div style={{ padding: "14px 24px 20px", display: "flex", gap: 10, borderTop: `1px solid ${T.border}`, background: T.surface }}>
          <button onClick={onPrint} className="btn-hover" style={{ flex: 1, padding: "12px 0", background: T.primary, color: "#fff", border: "none", borderRadius: 12, fontFamily: F, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>🖨 Принтирай</button>
          <button onClick={onClose} className="btn-hover" style={{ flex: 1, padding: "12px 0", background: T.bg, color: T.textSub, border: `1px solid ${T.border}`, borderRadius: 12, fontFamily: F, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Затвори</button>
        </div>
      </div>
    </div>
  );
}

// ─── Receipt Modal ─────────────────────────────────────────────────────────
function ReceiptModal({ receipt, onClose, onPrint }) {
  const T = useT();
  if (!receipt) return null;
  const total = receipt.items.reduce((s, i) => s + (i.price || 0) * i.qty, 0);
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(30,41,59,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, backdropFilter: "blur(4px)" }}>
      <div style={{ background: T.surface, borderRadius: 20, width: 380, maxHeight: "90vh", overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: T.shadowLg, border: `1px solid ${T.border}` }}>
        <div style={{ background: `linear-gradient(135deg,${T.primary},${T.primaryD})`, padding: "18px 24px", textAlign: "center" }}>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,.7)", letterSpacing: 3, marginBottom: 4, fontFamily: F, fontWeight: 600 }}>СКЛАДОВА РАЗПИСКА</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: "#fff", fontFamily: F }}>ДОСТАВКА #{receipt.deliveryId}</div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,.7)", marginTop: 4, fontFamily: F }}>{fmtDate(receipt.date)} · 👤 {receipt.userName}</div>
        </div>
        <div style={{ padding: "16px 20px", maxHeight: 300, overflowY: "auto", background: T.bg }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 50px 50px 70px", gap: 4, fontSize: 11, color: T.textMute, borderBottom: `2px solid ${T.border}`, paddingBottom: 8, marginBottom: 10, fontFamily: F, fontWeight: 700, letterSpacing: .5 }}>
            <span>ПРОДУКТ</span><span style={{ textAlign: "center" }}>КОД</span><span style={{ textAlign: "center" }}>КОЛ.</span><span style={{ textAlign: "right" }}>СУМА</span>
          </div>
          {receipt.items.map((item, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 50px 50px 70px", gap: 4, fontSize: 13, marginBottom: 10, alignItems: "center", fontFamily: F }}>
              <div>
                <div style={{ fontWeight: 700, color: T.text, lineHeight: 1.3 }}>{item.name}</div>
                <div style={{ fontSize: 11, color: T.textMute }}>{item.price > 0 ? `${fmt(item.price)} лв/${item.unit}` : "—"}</div>
              </div>
              <div style={{ textAlign: "center", color: T.textSub, fontSize: 10, background: T.border, borderRadius: 6, padding: "2px 4px" }}>{item.code}</div>
              <div style={{ textAlign: "center", fontWeight: 800, color: T.text, fontSize: 15 }}>{item.qty}</div>
              <div style={{ textAlign: "right", fontWeight: 800, color: T.primary, fontSize: 14 }}>{item.price > 0 ? `${fmt(item.price * item.qty)} лв` : "—"}</div>
            </div>
          ))}
        </div>
        <div style={{ padding: "12px 20px 0", background: T.surface, borderTop: `2px solid ${T.border}` }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 18, fontWeight: 800, color: T.text, fontFamily: F }}>
            <span>ОБЩО:</span><span style={{ color: T.primary }}>{total > 0 ? `${fmt(total)} лв` : "—"}</span>
          </div>
        </div>
        <div style={{ padding: "14px 20px 20px", display: "flex", gap: 10, background: T.surface }}>
          <button onClick={onPrint} className="btn-hover" style={{ flex: 1, padding: "12px 0", background: T.primary, color: "#fff", border: "none", borderRadius: 12, fontFamily: F, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>🖨 Принтирай</button>
          <button onClick={onClose} className="btn-hover" style={{ flex: 1, padding: "12px 0", background: T.bg, color: T.textSub, border: `1px solid ${T.border}`, borderRadius: 12, fontFamily: F, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Затвори</button>
        </div>
      </div>
    </div>
  );
}

// ─── Product Modal ────────────────────────────────────────────────────────────
function ProductModal({ product, deliveries = [], onSave, onClose }) {
  const T = useT();
  const [form, setForm] = useState(product || { code: "", name: "", qty: 0, unit: "бр", minQty: 5, price: 0, costPrice: 0, category: "other" });
  const inp = { background: T.bg, border: `1.5px solid ${T.border}`, color: T.text, padding: "10px 14px", borderRadius: 10, fontFamily: F, fontSize: 14, width: "100%", outline: "none" };
  
  const p = parseFloat(form.price) || 0;
  const c = parseFloat(form.costPrice) || 0;
  const marginPct = p > 0 ? (((p - c) / p) * 100).toFixed(1) : "0.0";
  const markupPct = c > 0 ? (((p - c) / c) * 100).toFixed(1) : "0.0";

  const history = useMemo(() => {
    if (!product?.id || !deliveries.length) return [];
    const pts = [];
    deliveries.forEach(d => {
      const it = d.items.find(i => i.id === product.id);
      if (it) pts.push({ date: fmtShortDate(d.date), price: it.price || 0, cost: it.costPrice || 0 });
    });
    return pts.sort((a, b) => a.date.localeCompare(b.date)).slice(-10);
  }, [product, deliveries]);

  const fields = [
    { label: "Код", key: "code", type: "text" }, { label: "Наименование", key: "name", type: "text" },
    { label: "Количество", key: "qty", type: "number" }, { label: "Мерна единица", key: "unit", type: "text" },
    { label: "Минимален запас", key: "minQty", type: "number" },
  ];
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(30,41,59,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, backdropFilter: "blur(4px)" }}>
      <div style={{ background: T.surface, borderRadius: 20, padding: 28, width: 440, color: T.text, maxHeight: "90vh", overflowY: "auto", boxShadow: T.shadowLg, border: `1px solid ${T.border}` }}>
        <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 20, color: T.text, fontFamily: F }}>{product?.id ? "✏️ Редактирай продукт" : "➕ Нов продукт"}</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
          {fields.slice(0, 2).map(({ label, key, type }) => (
            <div key={key}>
              <label style={{ fontSize: 11, fontWeight: 700, color: T.textSub, display: "block", marginBottom: 5, fontFamily: F }}>{label.toUpperCase()}</label>
              <input style={inp} type={type} value={form[key] ?? ""} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} onFocus={e => e.target.style.borderColor = T.primary} onBlur={e => e.target.style.borderColor = T.border} />
            </div>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 14 }}>
          {fields.slice(2, 5).map(({ label, key, type }) => (
            <div key={key}>
              <label style={{ fontSize: 11, fontWeight: 700, color: T.textSub, display: "block", marginBottom: 5, fontFamily: F }}>{label.toUpperCase()}</label>
              <input style={inp} type={type} step={key === "qty" || key === "minQty" ? "0.01" : "1"} value={form[key] ?? ""} onChange={e => setForm(f => ({ ...f, [key]: type === "number" ? parseFloat(e.target.value) || 0 : e.target.value }))} onFocus={e => e.target.style.borderColor = T.primary} onBlur={e => e.target.style.borderColor = T.border} />
            </div>
          ))}
        </div>
        
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: T.textSub, display: "block", marginBottom: 5, fontFamily: F }}>ДОСТАВНА ЦЕНА (ЛВ)</label>
            <input style={inp} type="number" step="0.01" value={form.costPrice ?? ""} onChange={e => setForm(f => ({ ...f, costPrice: parseFloat(e.target.value) || 0 }))} onFocus={e => e.target.style.borderColor = T.primary} onBlur={e => e.target.style.borderColor = T.border} />
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: T.textSub, display: "block", marginBottom: 5, fontFamily: F }}>ПРОДАЖНА ЦЕНА (ЛВ)</label>
            <input style={inp} type="number" step="0.01" value={form.price ?? ""} onChange={e => setForm(f => ({ ...f, price: parseFloat(e.target.value) || 0 }))} onFocus={e => e.target.style.borderColor = T.primary} onBlur={e => e.target.style.borderColor = T.border} />
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
          <div style={{ background: T.bg, padding: 8, borderRadius: 10, border: `1px solid ${T.border}`, textAlign: "center" }}>
            <div style={{ fontSize: 10, color: T.textSub, fontWeight: 700, fontFamily: F }}>МАРЖ</div>
            <div style={{ fontSize: 14, fontWeight: 800, color: marginPct > 0 ? T.green : T.red, fontFamily: F }}>{marginPct}%</div>
          </div>
          <div style={{ background: T.bg, padding: 8, borderRadius: 10, border: `1px solid ${T.border}`, textAlign: "center" }}>
            <div style={{ fontSize: 10, color: T.textSub, fontWeight: 700, fontFamily: F }}>НАДЦЕНКА</div>
            <div style={{ fontSize: 14, fontWeight: 800, color: markupPct > 0 ? T.green : T.red, fontFamily: F }}>{markupPct}%</div>
          </div>
        </div>

        {history.length > 1 && (
          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: T.textSub, display: "block", marginBottom: 5, fontFamily: F }}>ИСТОРИЯ НА ЦЕНИТЕ (ПОСЛЕДНИ ДОСТАВКИ)</label>
            <div style={{ height: 100, background: T.bg, border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 5px 0" }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={history}>
                  <XAxis dataKey="date" hide />
                  <Tooltip contentStyle={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 11, padding: 6, fontFamily: F }} />
                  <Line type="stepAfter" dataKey="price" stroke={T.primary} strokeWidth={2} dot={{ r: 2 }} name="Продажна" />
                  <Line type="stepAfter" dataKey="cost" stroke={T.orange} strokeWidth={2} dot={{ r: 2 }} name="Доставна" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: T.textSub, display: "block", marginBottom: 5, fontFamily: F }}>КАТЕГОРИЯ</label>
            <select style={inp} value={form.category || "other"} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}>
              {CATEGORIES.filter(c => c.id !== "all").map(c => <option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: T.textSub, display: "block", marginBottom: 5, fontFamily: F }}>СРОК НА ГОДНОСТ</label>
            <input style={inp} type="date" value={form.expiryDate || ""} onChange={e => setForm(f => ({ ...f, expiryDate: e.target.value }))} onFocus={e => e.target.style.borderColor = T.primary} onBlur={e => e.target.style.borderColor = T.border} />
          </div>
        </div>
        
        <div style={{ display: "flex", gap: 10, marginTop: 24 }}>
          <button onClick={() => onSave(form)} className="btn-hover" style={{ flex: 1, padding: "12px 0", background: T.primary, color: "#fff", border: "none", borderRadius: 12, fontFamily: F, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Запази</button>
          <button onClick={onClose} className="btn-hover" style={{ flex: 1, padding: "12px 0", background: T.bg, color: T.textSub, border: `1px solid ${T.border}`, borderRadius: 12, fontFamily: F, fontSize: 14, fontWeight: 600, cursor: "pointer" }}>Откажи</button>
        </div>
      </div>
    </div>
  );
}

// ─── Manage Workers Modal ─────────────────────────────────────────────────────
function ManageWorkersModal({ onClose }) {
  const T = useT();
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({ name: "", username: "", password: "", role: "worker", pin: "" });
  const [error, setError] = useState("");
  useEffect(() => { sget(K.users).then(u => setUsers(u || [])); }, []);
  const inp = { background: T.bg, border: `1.5px solid ${T.border}`, color: T.text, padding: "9px 12px", borderRadius: 10, fontFamily: F, fontSize: 13, width: "100%", outline: "none" };
  const add = async () => {
    if (!form.name || !form.username || !form.password) { setError("Попълни всички полета"); return; }
    if (form.pin && !/^\d{4}$/.test(form.pin)) { setError("PIN трябва да бъде точно 4 цифри"); return; }
    if (users.find(u => u.username === form.username)) { setError("Потр. име е заето"); return; }
    const hashed = await hashPwd(form.password);
    const updated = [...users, { ...form, password: hashed, passwordHashed: true, id: generateId(), createdAt: Date.now() }];
    await sset(K.users, updated); setUsers(updated);
    setForm({ name: "", username: "", password: "", role: "worker", pin: "" }); setError("");
  };
  const remove = async (id) => {
    if (users.find(u => u.id === id)?.role === "owner") return;
    const updated = users.filter(u => u.id !== id);
    await sset(K.users, updated); setUsers(updated);
  };
  const roleLabel = r => r === "owner" ? "👑 Собственик" : r === "manager" ? "🔑 Мениджър" : "👤 Работник";
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(30,41,59,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2000, backdropFilter: "blur(4px)" }}>
      <div style={{ background: T.surface, borderRadius: 20, width: 440, maxHeight: "85vh", overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: T.shadowLg, border: `1px solid ${T.border}` }}>
        <div style={{ padding: "18px 24px", borderBottom: `1px solid ${T.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontFamily: F, fontWeight: 800, color: T.text, fontSize: 16 }}>👥 Управление на работници</div>
          <button onClick={onClose} style={{ background: T.bg, border: `1px solid ${T.border}`, color: T.textSub, cursor: "pointer", fontSize: 16, borderRadius: 8, width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>
        </div>
        <div style={{ overflowY: "auto", padding: "20px 24px", background: T.bg }}>
          <div style={{ background: T.surface, borderRadius: 16, padding: 18, marginBottom: 20, border: `1px solid ${T.border}`, boxShadow: T.shadow }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: T.primary, marginBottom: 14, fontFamily: F }}>➕ Нов работник</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
              {[{ l: "Име", k: "name", ph: "Иван Иванов", t: "text" }, { l: "Потр. Име", k: "username", ph: "ivan", t: "text" }, { l: "Парола", k: "password", ph: "••••••", t: "password" }].map(({ l, k, ph, t }) => (
                <div key={k} style={k === "name" ? { gridColumn: "1/-1" } : {}}>
                  <label style={{ fontSize: 11, fontWeight: 700, color: T.textSub, display: "block", marginBottom: 4, fontFamily: F }}>{l.toUpperCase()}</label>
                  <input style={inp} type={t} value={form[k]} onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))} placeholder={ph} />
                </div>
              ))}
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: T.textSub, display: "block", marginBottom: 4, fontFamily: F }}>РОЛЯ</label>
                <select style={inp} value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
                  <option value="worker">👤 Работник</option>
                  <option value="manager">🔑 Мениджър</option>
                  <option value="owner">👑 Собственик</option>
                </select>
              </div>
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: T.textSub, display: "block", marginBottom: 4, fontFamily: F }}>PIN (ОПЦИЯ)</label>
                <input style={inp} type="text" maxLength="4" value={form.pin} onChange={e => setForm(f => ({ ...f, pin: e.target.value.replace(/\D/g,"") }))} placeholder="1234" />
              </div>
            </div>
            {error && <div style={{ color: T.red, fontSize: 12, marginBottom: 10, fontFamily: F, fontWeight: 600 }}>{error}</div>}
            <button onClick={add} className="btn-hover" style={{ width: "100%", padding: "10px 0", background: T.primary, color: "#fff", border: "none", borderRadius: 10, fontFamily: F, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Добави работник</button>
          </div>
          {users.map(u => (
            <div key={u.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", background: T.surface, borderRadius: 12, marginBottom: 8, border: `1px solid ${T.border}` }}>
              <div style={{ width: 40, height: 40, borderRadius: 12, background: u.role === "owner" ? "#FEF3C7" : u.role === "manager" ? "#EDE9FE" : T.bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>{u.role === "owner" ? "👑" : u.role === "manager" ? "🔑" : "👤"}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: T.text, fontFamily: F }}>{u.name}</div>
                <div style={{ fontSize: 12, color: T.textSub, fontFamily: F }}>@{u.username} · {roleLabel(u.role)} {u.pin ? `· 🔢 ${u.pin}` : ""}</div>
              </div>
              {u.role !== "owner" && (
                <button onClick={() => remove(u.id)} className="btn-hover" style={{ background: "#FEF2F2", border: "1px solid #FECACA", color: T.red, borderRadius: 8, padding: "6px 12px", cursor: "pointer", fontFamily: F, fontSize: 12, fontWeight: 600 }}>Изтрий</button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Login Screen ─────────────────────────────────────────────────────────────
function LoginScreen({ onLogin, darkMode, setDarkMode }) {
  const T = useT();
  const [users, setUsers] = useState([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [loginMode, setLoginMode] = useState("pass"); 
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    (async () => {
      let u = await sget(K.users);
      if (!u || u.length === 0) {
        const hashed = await hashPwd("owner123");
        u = [{ id: "owner1", name: "Собственик", username: "owner", password: hashed, passwordHashed: true, role: "owner", createdAt: Date.now() }];
        await sset(K.users, u);
      }
      setUsers(u); setLoading(false);
    })();
  }, []);
  const handleLogin = async () => {
    const hash = await hashPwd(password);
    let user = users.find(u => u.username === username.trim() && u.passwordHashed && u.password === hash);
    if (!user) {
      const plain = users.find(u => u.username === username.trim() && !u.passwordHashed && u.password === password);
      if (plain) {
        user = plain;
        const updated = users.map(u => u.id === plain.id ? { ...u, password: hash, passwordHashed: true } : u);
        await sset(K.users, updated);
      }
    }
    if (!user) { setError("Грешно потребителско име или парола"); return; }
    setError(""); onLogin(user);
  };
  const handlePinLogin = (digit) => {
    const newPin = (pin + digit).slice(0, 4);
    setPin(newPin);
    if (newPin.length === 4) {
      const user = users.find(u => u.pin === newPin);
      if (user) { setError(""); onLogin(user); }
      else { setError("Невалиден PIN"); setPin(""); }
    }
  };

  const inp = { background: T.bg, border: `1.5px solid ${T.border}`, color: T.text, padding: "12px 16px", borderRadius: 12, fontFamily: F, fontSize: 15, width: "100%", outline: "none" };
  if (loading) return <div style={{ minHeight: "100vh", background: T.bg, display: "flex", alignItems: "center", justifyContent: "center", color: T.primary, fontFamily: F, fontWeight: 700, fontSize: 18 }}>Зареждане...</div>;
  return (
    <div style={{ minHeight: "100vh", background: T.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: F, padding: 20 }}>
      <div style={{ background: T.surface, borderRadius: 24, padding: loginMode === "pin" ? "32px" : "40px", width: 360, boxShadow: T.shadowLg, border: `1px solid ${T.border}` }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ width: 64, height: 64, background: `linear-gradient(135deg,${T.primary},${T.primaryD})`, borderRadius: 20, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, margin: "0 auto 16px" }}>⬡</div>
          <div style={{ fontSize: 24, color: T.text, fontWeight: 800, letterSpacing: .5 }}>Склад PRO</div>
          <button onClick={() => { setLoginMode(l => l === "pass" ? "pin" : "pass"); setError(""); setPin(""); }} style={{ background: "none", border: "none", color: T.primary, fontSize: 12, fontWeight: 700, cursor: "pointer", marginTop: 8 }}>{loginMode === "pass" ? "Вход с PIN" : "Вход с име и парола"}</button>
        </div>

        {loginMode === "pass" ? (
          <>
            {[{ label: "ПОТРЕБИТЕЛСКО ИМЕ", type: "text", val: username, set: setUsername, ph: "напр. owner" }, { label: "ПАРОЛА", type: "password", val: password, set: setPassword, ph: "••••••" }].map(({ label, type, val, set, ph }) => (
              <div key={label} style={{ marginBottom: 16 }}>
                <label style={{ fontSize: 12, fontWeight: 700, color: T.textSub, display: "block", marginBottom: 6, letterSpacing: .3 }}>{label}</label>
                <input style={inp} type={type} value={val} onChange={e => set(e.target.value)} onKeyDown={e => e.key === "Enter" && handleLogin()}
                  onFocus={e => e.target.style.borderColor = T.primary} onBlur={e => e.target.style.borderColor = T.border} placeholder={ph} />
              </div>
            ))}
            {error && <div style={{ color: T.red, fontSize: 13, marginBottom: 16, textAlign: "center", fontWeight: 600, background: "#FEF2F2", padding: "10px", borderRadius: 10, border: "1px solid #FECACA" }}>{error}</div>}
            <button onClick={handleLogin} className="btn-hover" style={{ width: "100%", padding: "14px 0", marginTop: 8, background: `linear-gradient(135deg,${T.primary},${T.primaryD})`, color: "#fff", border: "none", borderRadius: 14, fontFamily: F, fontSize: 15, fontWeight: 700, cursor: "pointer", boxShadow: `0 4px 16px ${T.primary}44` }}>Влез →</button>
          </>
        ) : (
          <div style={{ textAlign: "center" }}>
            <div style={{ display: "flex", justifyContent: "center", gap: 12, marginBottom: 24 }}>
              {[0, 1, 2, 3].map(i => (
                <div key={i} style={{ width: 14, height: 14, borderRadius: "50%", background: pin.length > i ? T.primary : T.border }} />
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, "C", 0, "×"].map(d => (
                <button key={d} onClick={() => d === "C" ? setPin("") : d === "×" ? setPin(p => p.slice(0, -1)) : handlePinLogin(d)} className="btn-hover" style={{
                  padding: "16px 0", background: T.bg, color: T.text, border: `1px solid ${T.border}`, borderRadius: 16, fontFamily: F, fontSize: 18, fontWeight: 700, cursor: "pointer"
                }}>{d}</button>
              ))}
            </div>
            {error && <div style={{ color: T.red, fontSize: 13, marginTop: 16, fontWeight: 600 }}>{error}</div>}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16 }}>
          <div style={{ fontSize: 11, color: T.textMute }}>По подразбиране: <b style={{ color: T.textSub }}>owner</b> / <b style={{ color: T.textSub }}>owner123</b></div>
          <button onClick={() => { setDarkMode(d => !d); }} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", padding: 4 }}>{darkMode ? "☀️" : "🌙"}</button>
        </div>
      </div>
    </div>
  );
}

// ─── Login Recap Modal ────────────────────────────────────────────────────────
function LoginRecapModal({ currentUser, deliveries, products, onClose }) {
  const T = useT();
  const yest = new Date(); yest.setDate(yest.getDate() - 1); const yestStr = yest.toISOString().slice(0, 10);
  const yestD = deliveries.filter(d => d.date.startsWith(yestStr));
  const yestRev = yestD.reduce((s, d) => s + d.items.reduce((ss, i) => ss + (i.price || 0) * i.qty, 0), 0);
  const yestProf = yestD.reduce((s, d) => s + d.items.reduce((ss, i) => ss + ((i.price || 0) - (i.costPrice || 0)) * i.qty, 0), 0);
  const emptyC = products.filter(p => p.qty === 0).length;
  const lowC = products.filter(p => p.qty > 0 && p.qty <= p.minQty).length;
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(30,41,59,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 3000, backdropFilter: "blur(4px)" }}>
      <div style={{ background: T.surface, borderRadius: 24, width: 400, overflow: "hidden", boxShadow: T.shadowLg, border: `1px solid ${T.border}` }}>
        <div style={{ background: `linear-gradient(135deg,${T.primary},${T.primaryD})`, padding: "28px 24px", textAlign: "center" }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>👋</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: "#fff", fontFamily: F }}>Добре дошъл, {currentUser.name}!</div>
          <div style={{ fontSize: 12, color: "rgba(255,255,255,.7)", marginTop: 6, fontFamily: F }}>{new Date().toLocaleDateString("bg-BG", { weekday: "long", day: "2-digit", month: "long" })}</div>
        </div>
        <div style={{ padding: "20px 24px", background: T.bg }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: T.textSub, marginBottom: 12, fontFamily: F }}>📊 ВЧЕРА</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 16 }}>
            {[{ l: "Доставки", v: yestD.length, c: T.primary }, { l: "Приход", v: `${fmt(yestRev)} лв`, c: T.text }, { l: "Печалба", v: `${fmt(yestProf)} лв`, c: T.green }].map(({ l, v, c }) => (
              <div key={l} style={{ background: T.surface, borderRadius: 12, padding: "12px 8px", textAlign: "center", border: `1px solid ${T.border}` }}>
                <div style={{ fontSize: 9, color: T.textMute, letterSpacing: 1, marginBottom: 4, fontFamily: F, fontWeight: 600 }}>{l.toUpperCase()}</div>
                <div style={{ fontSize: 16, fontWeight: 800, color: c, fontFamily: F }}>{v}</div>
              </div>
            ))}
          </div>
          {(emptyC > 0 || lowC > 0) && (
            <div style={{ display: "flex", gap: 10, marginBottom: 8 }}>
              {emptyC > 0 && <div style={{ flex: 1, background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 10, padding: "10px", textAlign: "center" }}>
                <div style={{ fontSize: 20 }}>📦</div>
                <div style={{ fontSize: 12, fontWeight: 700, color: T.red, fontFamily: F }}>{emptyC} изчерпани</div>
              </div>}
              {lowC > 0 && <div style={{ flex: 1, background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 10, padding: "10px", textAlign: "center" }}>
                <div style={{ fontSize: 20 }}>⚠️</div>
                <div style={{ fontSize: 12, fontWeight: 700, color: T.orange, fontFamily: F }}>{lowC} нисък запас</div>
              </div>}
            </div>
          )}
        </div>
        <div style={{ padding: "16px 24px 24px", background: T.surface }}>
          <button onClick={onClose} className="btn-hover" style={{ width: "100%", padding: "14px 0", background: `linear-gradient(135deg,${T.primary},${T.primaryD})`, color: "#fff", border: "none", borderRadius: 14, fontFamily: F, fontSize: 15, fontWeight: 700, cursor: "pointer", boxShadow: `0 4px 16px ${T.primary}44` }}>Започни работа →</button>
        </div>
      </div>
    </div>
  );
}

// ─── Product Card ─────────────────────────────────────────────────────────────
function ProductCard({ product: p, isOwner, onEdit, onDelete, onQtyChange, priceLoading, deliveries }) {
  const T = useT();
  const isEmpty = p.qty === 0;
  const isLow = !isEmpty && p.qty <= p.minQty;
  const statusColor = isEmpty ? T.red : isLow ? T.orange : T.green;
  const statusBg = isEmpty ? "#FEF2F2" : isLow ? "#FFFBEB" : "#ECFDF5";
  const cat = CATEGORIES.find(c => c.id === (p.category || "other")) || CATEGORIES[CATEGORIES.length - 1];
  // Trend arrow: compare qty changes in last 7 days from deliveries
  const trend = useMemo(() => {
    if (!deliveries || deliveries.length === 0) return 0;
    const now = new Date(); let used7 = 0, used14 = 0;
    deliveries.forEach(d => {
      const diff = (now - new Date(d.date)) / 86400000;
      d.items.forEach(i => { if (i.id === p.id) { if (diff <= 7) used7 += i.qty; if (diff > 7 && diff <= 14) used14 += i.qty; } });
    });
    return used7 > used14 ? 1 : used7 < used14 ? -1 : 0;
  }, [deliveries, p.id]);
  // Expiry
  const expiryInfo = useMemo(() => {
    if (!p.expiryDate) return null;
    const diff = Math.ceil((new Date(p.expiryDate) - new Date()) / 86400000);
    if (diff < 0) return { label: "Изтекъл!", color: T.red, icon: "💀", urgent: true };
    if (diff <= 3) return { label: `${diff} дни`, color: T.red, icon: "⏰", urgent: true };
    if (diff <= 7) return { label: `${diff} дни`, color: T.orange, icon: "⚠️", urgent: false };
    return null;
  }, [p.expiryDate, T.red, T.orange]);
  // Depletion
  const depletion = useMemo(() => calcDepletion(p, deliveries || []), [p, deliveries]);
  return (
    <div className="card-hover" style={{ background: T.surface, border: `1.5px solid ${expiryInfo?.urgent ? T.red + "66" : T.border}`, borderRadius: 16, padding: 18, boxShadow: T.shadow, position: "relative" }}>
      {expiryInfo?.urgent && <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: T.red, borderRadius: "16px 16px 0 0" }} />}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ background: "#EEF2FF", color: T.primary, borderRadius: 8, padding: "4px 10px", fontSize: 10, fontWeight: 800, letterSpacing: .5 }}>{p.code}</div>
          <div style={{ background: `${cat.color}15`, color: cat.color, borderRadius: 8, padding: "4px 8px", fontSize: 10, fontWeight: 700 }}>{cat.icon} {cat.name}</div>
          {expiryInfo && <div style={{ background: `${expiryInfo.color}15`, color: expiryInfo.color, borderRadius: 8, padding: "4px 8px", fontSize: 10, fontWeight: 700 }}>{expiryInfo.icon} {expiryInfo.label}</div>}
        </div>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          {trend !== 0 && <span style={{ fontSize: 14, color: trend > 0 ? T.red : T.green }}>{trend > 0 ? "📈" : "📉"}</span>}
          <div style={{ background: statusBg, color: statusColor, borderRadius: 8, padding: "4px 10px", fontSize: 10, fontWeight: 700 }}>{isEmpty ? "Изчерпан" : isLow ? "Нисък запас" : "Наличен"}</div>
        </div>
      </div>
      <div style={{ fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 14, lineHeight: 1.3 }}>{p.name}</div>
      <div style={{ background: `linear-gradient(135deg,${T.bg},${T.surface})`, borderRadius: 12, padding: "10px 14px", marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center", border: `1px solid ${T.border}` }}>
        <div>
          <div style={{ fontSize: 10, color: T.textSub, fontWeight: 600, marginBottom: 2 }}>ЦЕНА / {p.unit}</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: T.primary }}>
            {priceLoading ? <span className="spin" style={{ fontSize: 14, color: T.textMute }}>↻</span> : p.price > 0 ? `${fmt(p.price)} лв` : "—"}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          {depletion && depletion.days < 999 && (
            <div style={{ fontSize: 10, color: depletion.days <= 7 ? T.red : depletion.days <= 14 ? T.orange : T.textSub, fontWeight: 700, marginBottom: 2 }}>
              ~{depletion.days} дни запас
            </div>
          )}
          <div style={{ fontSize: 28 }}>{isEmpty ? "📦" : isLow ? "⚠️" : "✅"}</div>
        </div>
      </div>
      {isOwner ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <button onClick={() => onQtyChange(p.id, -1)} style={{ width: 36, height: 36, background: T.bg, border: `1.5px solid ${T.border}`, color: T.text, borderRadius: 10, cursor: "pointer", fontSize: 18, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>−</button>
          <div style={{ flex: 1, textAlign: "center" }}>
            <span style={{ fontSize: 26, fontWeight: 800, color: statusColor }}>{p.qty}</span>
            <span style={{ fontSize: 12, color: T.textSub, marginLeft: 4, fontWeight: 600 }}>{p.unit}</span>
            {trend !== 0 && <span style={{ fontSize: 12, marginLeft: 6, color: trend > 0 ? T.red : T.green, fontWeight: 700 }}>{trend > 0 ? "↑" : "↓"}</span>}
          </div>
          <button onClick={() => onQtyChange(p.id, 1)} style={{ width: 36, height: 36, background: T.bg, border: `1.5px solid ${T.border}`, color: T.text, borderRadius: 10, cursor: "pointer", fontSize: 18, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
        </div>
      ) : (
        <div style={{ textAlign: "center", marginBottom: 12 }}>
          <span style={{ fontSize: 26, fontWeight: 800, color: statusColor }}>{p.qty}</span>
          <span style={{ fontSize: 12, color: T.textSub, marginLeft: 4, fontWeight: 600 }}>{p.unit}</span>
          {trend !== 0 && <span style={{ fontSize: 12, marginLeft: 6, color: trend > 0 ? T.red : T.green, fontWeight: 700 }}>{trend > 0 ? "↑" : "↓"}</span>}
        </div>
      )}
      <div style={{ marginBottom: isOwner ? 12 : 0 }}>
        <div style={{ height: 6, background: T.bg, borderRadius: 3, overflow: "hidden", border: `1px solid ${T.border}` }}>
          <div style={{ height: "100%", borderRadius: 3, width: `${Math.min(100, (p.qty / Math.max(p.minQty * 2, 1)) * 100)}%`, background: statusColor, transition: "width .3s" }} />
        </div>
        <div style={{ fontSize: 10, color: T.textMute, marginTop: 4, fontWeight: 500 }}>Минимум: {p.minQty} {p.unit}{p.expiryDate ? ` · Годен до: ${p.expiryDate}` : ""}</div>
      </div>
      {isOwner && (
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn-hover" onClick={onEdit} style={{ flex: 1, padding: "9px 0", background: T.bg, color: T.primary, border: `1.5px solid ${T.primary}33`, borderRadius: 10, cursor: "pointer", fontFamily: F, fontSize: 12, fontWeight: 700 }}>✏️ Редактирай</button>
          <button className="btn-hover" onClick={onDelete} style={{ padding: "9px 14px", background: "#FEF2F2", color: T.red, border: "1.5px solid #FECACA", borderRadius: 10, cursor: "pointer", fontSize: 13, fontWeight: 700 }}>🗑</button>
        </div>
      )}
    </div>
  );
}

// ─── Waste & Shrinkage Modal ──────────────────────────────────────────────────
function WasteModal({ products, onSave, onClose }) {
  const T = useT();
  const [form, setForm] = useState({ productId: "", qty: "", reason: "expired", note: "" });
  const inp = { background: T.bg, border: `1.5px solid ${T.border}`, color: T.text, padding: "9px 12px", borderRadius: 10, fontFamily: F, fontSize: 13, width: "100%", outline: "none" };
  const getP = id => products.find(p => p.id === id);
  const p = getP(form.productId);
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(30,41,59,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, backdropFilter: "blur(4px)" }}>
      <div style={{ background: T.surface, borderRadius: 20, padding: 28, width: 440, color: T.text, boxShadow: T.shadowLg, border: `1px solid ${T.border}` }}>
        <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 20, fontFamily: F }}>🗑 Отписване / Брак</div>
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 12, fontWeight: 700, color: T.textSub, display: "block", marginBottom: 5 }}>ПРОДУКТ</label>
          <select style={inp} value={form.productId} onChange={e => setForm(f => ({ ...f, productId: e.target.value }))}>
            <option value="">-- Избери продукт --</option>
            {products.map(pr => <option key={pr.id} value={pr.id}>{pr.name} (Налично: {pr.qty} {pr.unit})</option>)}
          </select>
        </div>
        {p && (
          <div style={{ marginBottom: 14, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 700, color: T.textSub, display: "block", marginBottom: 5 }}>КОЛИЧЕСТВО ЗА БРАК ({p.unit})</label>
              <input style={inp} type="number" min="0.01" max={p.qty} step="0.01" value={form.qty} onChange={e => setForm(f => ({ ...f, qty: e.target.value }))} />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 700, color: T.textSub, display: "block", marginBottom: 5 }}>ПРИЧИНА</label>
              <select style={inp} value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}>
                {WASTE_REASONS.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
            </div>
          </div>
        )}
        <div style={{ marginBottom: 24 }}>
          <label style={{ fontSize: 12, fontWeight: 700, color: T.textSub, display: "block", marginBottom: 5 }}>БЕЛЕЖКА (по желание)</label>
          <input style={inp} type="text" value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} placeholder="Напр. Счупено при разтоварване..." />
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={() => { if(!p || !form.qty || form.qty > p.qty) return; onSave(form); }} disabled={!p || !form.qty || form.qty > p.qty} className="btn-hover" style={{ flex: 1, padding: "12px 0", background: T.red, color: "#fff", border: "none", borderRadius: 12, fontFamily: F, fontSize: 14, fontWeight: 700, cursor: (!p || !form.qty || form.qty > p.qty) ? "not-allowed" : "pointer", opacity: (!p || !form.qty || form.qty > p.qty) ? 0.5 : 1 }}>Отпиши</button>
          <button onClick={onClose} className="btn-hover" style={{ flex: 1, padding: "12px 0", background: T.bg, color: T.textSub, border: `1px solid ${T.border}`, borderRadius: 12, fontFamily: F, fontSize: 14, fontWeight: 600, cursor: "pointer" }}>Откажи</button>
        </div>
      </div>
    </div>
  );
}

// ─── Stock Take Modal ─────────────────────────────────────────────────────────
function StockTakeModal({ products, onSave, onClose }) {
  const T = useT();
  const [catFilter, setCatFilter] = useState("all");
  const filtered = catFilter === "all" ? products : products.filter(p => (p.category || "other") === catFilter);
  const [counts, setCounts] = useState({});
  const inp = { background: T.surface, border: `1.5px solid ${T.border}`, color: T.text, padding: "6px 8px", borderRadius: 8, fontFamily: F, fontSize: 16, width: 80, outline: "none", textAlign: "right", fontWeight: 700 };
  const startTake = () => {
    if (Object.keys(counts).length === 0) return onClose();
    const diffs = [];
    Object.entries(counts).forEach(([id, qty]) => {
      const p = products.find(x => x.id === id);
      if (p && parseFloat(qty) !== p.qty) diffs.push({ productId: p.id, oldQty: p.qty, newQty: parseFloat(qty), costPrice: p.costPrice });
    });
    onSave(diffs);
  };
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(30,41,59,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, backdropFilter: "blur(4px)" }}>
      <div style={{ background: T.bg, borderRadius: 20, width: 800, maxWidth: "95vw", maxHeight: "90vh", display: "flex", flexDirection: "column", boxShadow: T.shadowLg, border: `1px solid ${T.border}` }}>
        <div style={{ padding: "20px 24px", borderBottom: `1px solid ${T.border}`, background: T.surface, borderRadius: "20px 20px 0 0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 18, color: T.text, fontFamily: F }}>📋 Инвентаризация (Stock Take)</div>
            <div style={{ fontSize: 12, color: T.textSub, marginTop: 4 }}>Въведи реалното количество за маркираните продукти</div>
          </div>
          <button onClick={onClose} style={{ background: T.bg, border: `1px solid ${T.border}`, color: T.textSub, cursor: "pointer", fontSize: 18, borderRadius: 8, width: 36, height: 36 }}>×</button>
        </div>
        <div style={{ padding: "16px 24px", borderBottom: `1px solid ${T.border}`, display: "flex", gap: 8, overflowX: "auto" }}>
          {CATEGORIES.map(c => (
            <button key={c.id} onClick={() => setCatFilter(c.id)} className="btn-hover" style={{ padding: "6px 14px", borderRadius: 8, border: `1px solid ${catFilter === c.id ? c.color : T.border}`, background: catFilter === c.id ? `${c.color}15` : T.surface, color: catFilter === c.id ? c.color : T.textSub, cursor: "pointer", fontFamily: F, fontSize: 13, fontWeight: 700, whiteSpace: "nowrap" }}>{c.icon} {c.name}</button>
          ))}
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", fontSize: 11, color: T.textMute, borderBottom: `1px solid ${T.border}` }}>
                <th style={{ paddingBottom: 12 }}>ПРОДУКТ</th><th>СИСТЕМНО КОЛ.</th><th style={{ textAlign: "right" }}>РЕАЛНО КОЛ.</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(p => {
                const isChanged = counts[p.id] !== undefined && parseFloat(counts[p.id]) !== p.qty;
                return (
                  <tr key={p.id} className="trow" style={{ borderBottom: `1px solid ${T.border}` }}>
                    <td style={{ padding: "14px 0", fontSize: 14, fontWeight: 600, color: T.text }}>{p.name} <span style={{ fontSize: 11, color: T.textMute, background: T.surface, padding: "2px 6px", borderRadius: 4, marginLeft: 6 }}>{p.code}</span></td>
                    <td style={{ fontSize: 14, color: T.textSub, fontWeight: 700 }}>{p.qty} {p.unit}</td>
                    <td style={{ textAlign: "right" }}>
                      <input style={{ ...inp, borderColor: isChanged ? T.primary : T.border, color: isChanged ? T.primary : T.text }} type="number" step="0.01" min="0" placeholder={p.qty} value={counts[p.id] !== undefined ? counts[p.id] : ""} onChange={e => setCounts(c => ({ ...c, [p.id]: e.target.value }))} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ padding: "20px 24px", borderTop: `1px solid ${T.border}`, background: T.surface, borderRadius: "0 0 20px 20px", display: "flex", justifyContent: "flex-end", gap: 12 }}>
          <button onClick={onClose} className="btn-hover" style={{ padding: "12px 24px", background: T.bg, color: T.textSub, border: `1px solid ${T.border}`, borderRadius: 12, fontFamily: F, fontSize: 14, fontWeight: 600, cursor: "pointer" }}>Откажи</button>
          <button onClick={startTake} className="btn-hover" style={{ padding: "12px 24px", background: T.primary, color: "#fff", border: "none", borderRadius: 12, fontFamily: F, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Потвърди наличностите</button>
        </div>
      </div>
    </div>
  );
}

// ─── Compare Modal ────────────────────────────────────────────────────────────
function CompareModal({ products, onClose }) {
  const T = useT();
  const [p1, setP1] = useState("");
  const [p2, setP2] = useState("");
  const item1 = products.find(x => x.id === p1);
  const item2 = products.find(x => x.id === p2);
  const selSt = { background: T.surface, border: `1.5px solid ${T.border}`, color: T.text, padding: "10px 14px", borderRadius: 12, fontFamily: F, fontSize: 13, width: "100%", outline: "none", cursor: "pointer" };

  const diff = (v1, v2, suffix="") => {
    if(v1 === null || v1 === undefined || v2 === null || v2 === undefined) return "—";
    const d = parseFloat(v1) - parseFloat(v2);
    if(d === 0) return "=";
    return <span style={{color: d > 0 ? T.green : T.red}}>{d > 0 ? "+" : ""}{fmt(d)}{suffix}</span>;
  };
  const diffStr = (v1, v2) => {
    if(v1 === null || v1 === undefined || v2 === null || v2 === undefined) return "—";
    if(v1 === v2) return "=";
    return "≠";
  };

  const getMargin = (p) => p && p.price ? ((p.price - (p.costPrice||0)) / p.price * 100).toFixed(1) : 0;
  const getMarkup = (p) => p && p.costPrice ? ((p.price - p.costPrice) / p.costPrice * 100).toFixed(1) : 0;

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(30,41,59,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, backdropFilter: "blur(4px)" }}>
      <div style={{ background: T.surface, borderRadius: 24, width: 700, maxWidth: "95vw", maxHeight: "90vh", overflowY: "auto", display: "flex", flexDirection: "column", boxShadow: T.shadowLg, border: `1px solid ${T.border}` }}>
        <div style={{ padding: "20px 24px", borderBottom: `1px solid ${T.border}`, background: T.surface, borderRadius: "24px 24px 0 0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontWeight: 800, fontSize: 18, color: T.text, fontFamily: F }}>⚖️ Сравнение на продукти</div>
          <button onClick={onClose} style={{ background: T.bg, border: `1px solid ${T.border}`, color: T.textSub, cursor: "pointer", fontSize: 18, borderRadius: 8, width: 36, height: 36 }}>×</button>
        </div>
        <div style={{ padding: 24, background: T.bg, flex: 1 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 24 }}>
            <div>
              <label style={{ fontSize: 11, fontWeight: 700, color: T.textSub, display: "block", marginBottom: 6, fontFamily: F }}>ПРОДУКТ 1</label>
              <select style={selSt} value={p1} onChange={e => setP1(e.target.value)}>
                <option value="">-- Избери продукт --</option>
                {products.map(p => <option key={p.id} value={p.id}>{p.code} - {p.name}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 700, color: T.textSub, display: "block", marginBottom: 6, fontFamily: F }}>ПРОДУКТ 2</label>
              <select style={selSt} value={p2} onChange={e => setP2(e.target.value)}>
                <option value="">-- Избери продукт --</option>
                {products.map(p => <option key={p.id} value={p.id}>{p.code} - {p.name}</option>)}
              </select>
            </div>
          </div>

          {(item1 || item2) && (
            <div style={{ background: T.surface, borderRadius: 16, border: `1px solid ${T.border}`, overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontFamily: F }}>
                <thead>
                  <tr style={{ background: T.bg, borderBottom: `2px solid ${T.border}` }}>
                    <th style={{ padding: "14px 16px", fontSize: 12, color: T.textSub }}>Метрика</th>
                    <th style={{ padding: "14px 16px", fontSize: 13, color: T.primary }}>{item1 ? item1.name : "—"}</th>
                    <th style={{ padding: "14px 16px", fontSize: 13, color: T.orange }}>{item2 ? item2.name : "—"}</th>
                    <th style={{ padding: "14px 16px", fontSize: 12, color: T.textSub, width: 80, textAlign: "center" }}>Разлика</th>
                  </tr>
                </thead>
                <tbody style={{ fontSize: 14 }}>
                  {[
                    { l: "Категория", v1: item1?.category, v2: item2?.category, d: diffStr(item1?.category, item2?.category) },
                    { l: "Доставна цена", v1: item1?.costPrice===undefined?"—":`${fmt(item1.costPrice)} лв`, v2: item2?.costPrice===undefined?"—":`${fmt(item2.costPrice)} лв`, d: diff(item1?.costPrice, item2?.costPrice, " лв") },
                    { l: "Продажна цена", v1: item1?.price===undefined?"—":`${fmt(item1.price)} лв`, v2: item2?.price===undefined?"—":`${fmt(item2.price)} лв`, d: diff(item1?.price, item2?.price, " лв") },
                    { l: "Марж", v1: item1 ? `${getMargin(item1)}%` : "—", v2: item2 ? `${getMargin(item2)}%` : "—", d: diff(item1?getMargin(item1):null, item2?getMargin(item2):null, "%") },
                    { l: "Надценка", v1: item1 ? `${getMarkup(item1)}%` : "—", v2: item2 ? `${getMarkup(item2)}%` : "—", d: diff(item1?getMarkup(item1):null, item2?getMarkup(item2):null, "%") },
                    { l: "Наличност", v1: item1 ? `${item1.qty} ${item1.unit}` : "—", v2: item2 ? `${item2.qty} ${item2.unit}` : "—", d: diff(item1?.qty, item2?.qty) },
                  ].map((r, i) => (
                    <tr key={r.l} style={{ borderBottom: `1px solid ${T.border}`, background: i%2===0 ? "transparent" : T.bg }}>
                      <td style={{ padding: "14px 16px", fontWeight: 700, color: T.textSub, fontSize: 12 }}>{r.l}</td>
                      <td style={{ padding: "14px 16px", fontWeight: 800, color: T.text }}>{r.v1}</td>
                      <td style={{ padding: "14px 16px", fontWeight: 800, color: T.text }}>{r.v2}</td>
                      <td style={{ padding: "14px 16px", fontWeight: 800, textAlign: "center", background: T.surface }}>{item1 && item2 ? r.d : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Settings Modal ───────────────────────────────────────────────────────────
function SettingsModal({ settings, onSave, onClose }) {
  const T = useT();
  const [form, setForm] = useState(settings || { telegramToken: "", telegramChat: "" });
  const inp = { background: T.bg, border: `1.5px solid ${T.border}`, color: T.text, padding: "10px 14px", borderRadius: 10, fontFamily: F, fontSize: 13, width: "100%", outline: "none" };
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(30,41,59,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, backdropFilter: "blur(4px)" }}>
      <div style={{ background: T.surface, borderRadius: 24, padding: 28, width: 440, color: T.text, boxShadow: T.shadowLg, border: `1px solid ${T.border}` }}>
        <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 20, fontFamily: F }}>⚙️ Настройки</div>
        
        <div style={{ padding: 16, background: T.bg, borderRadius: 12, border: `1px solid ${T.border}`, marginBottom: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.primary, marginBottom: 12, fontFamily: F }}>🤖 Telegram Аларми</div>
          <div style={{ fontSize: 11, color: T.textSub, marginBottom: 12, fontFamily: F }}>Известия при нисък запас.</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div><label style={{ fontSize: 10, fontWeight: 700, color: T.textSub, display: "block", marginBottom: 4 }}>TOKEN</label><input style={inp} value={form.telegramToken} onChange={e => setForm(f => ({...f, telegramToken: e.target.value}))} /></div>
            <div><label style={{ fontSize: 10, fontWeight: 700, color: T.textSub, display: "block", marginBottom: 4 }}>CHAT ID</label><input style={inp} value={form.telegramChat} onChange={e => setForm(f => ({...f, telegramChat: e.target.value}))} /></div>
          </div>
        </div>

        <div style={{ padding: 16, background: "#EEF2FF", borderRadius: 12, border: `1px solid ${T.primary}33`, marginBottom: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.primary, marginBottom: 12, fontFamily: F }}>☁️ Supabase Cloud Sync</div>
          <div style={{ fontSize: 11, color: T.textSub, marginBottom: 12, fontFamily: F }}>Синхронизация в облака и на множество устройства.</div>
          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 10, fontWeight: 700, color: T.textSub, display: "block", marginBottom: 4 }}>PROJECT URL</label>
            <input style={inp} value={form.supabaseUrl} onChange={e => setForm(f => ({...f, supabaseUrl: e.target.value}))} />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 10, fontWeight: 700, color: T.textSub, display: "block", marginBottom: 4 }}>ANON KEY</label>
            <input style={inp} value={form.supabaseKey} onChange={e => setForm(f => ({...f, supabaseKey: e.target.value}))} />
          </div>
          <button onClick={() => { if(confirm("Всички данни от браузъра ще бъдат качени в Supabase. Продължаваме?")) window._migrate(); }} style={{ width: "100%", padding: "8px", background: T.primary, color: "#fff", border: "none", borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>📤 Качи локалните данни в облака</button>
          <div style={{ marginTop: 10, fontSize: 9, color: T.textMute, background: "#fff", padding: 8, borderRadius: 6, border: `1px solid ${T.border}` }}>
            <b>SQL Setup:</b> CREATE TABLE app_data (key TEXT PRIMARY KEY, value JSONB);
          </div>
        </div>
        
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={() => onSave(form)} className="btn-hover" style={{ flex: 1, padding: "12px 0", background: T.primary, color: "#fff", border: "none", borderRadius: 12, fontFamily: F, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Запази</button>
          <button onClick={onClose} className="btn-hover" style={{ flex: 1, padding: "12px 0", background: T.bg, color: T.textSub, border: `1px solid ${T.border}`, borderRadius: 12, fontFamily: F, fontSize: 14, fontWeight: 600, cursor: "pointer" }}>Откажи</button>
        </div>
      </div>
    </div>
  );
}

// ─── Contacts Browser Modal (Clients / Suppliers) ───────────────────────────
function ContactBrowserModal({ type, contacts, onSave, onDelete, onClose }) {
  const T = useT();
  const isClient = type === "client";
  const [form, setForm] = useState({ id: "", name: "", phone: "", address: "", vat: "" });
  const inp = { background: T.surface, border: `1.5px solid ${T.border}`, color: T.text, padding: "8px 12px", borderRadius: 8, fontFamily: F, fontSize: 13, width: "100%", outline: "none" };
  const add = () => {
    if (!form.name) return;
    onSave({ ...form, id: form.id || generateId() });
    setForm({ id: "", name: "", phone: "", address: "", vat: "" });
  };
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(30,41,59,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, backdropFilter: "blur(4px)" }}>
      <div style={{ background: T.bg, borderRadius: 20, width: 600, maxWidth: "95vw", maxHeight: "90vh", display: "flex", flexDirection: "column", boxShadow: T.shadowLg, border: `1px solid ${T.border}` }}>
        <div style={{ padding: "18px 24px", borderBottom: `1px solid ${T.border}`, background: T.surface, borderRadius: "20px 20px 0 0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontWeight: 800, fontSize: 16, color: T.text, fontFamily: F }}>{isClient ? "🤝 Управление на Клиенти" : "🏭 Управление на Доставчици"}</div>
          <button onClick={onClose} style={{ background: T.bg, border: `1px solid ${T.border}`, color: T.textSub, cursor: "pointer", fontSize: 16, borderRadius: 8, width: 32, height: 32 }}>×</button>
        </div>
        <div style={{ padding: 20, borderBottom: `1px solid ${T.border}` }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
            <div><label style={{ fontSize: 11, fontWeight: 700, color: T.textSub, display: "block", marginBottom: 4 }}>ИМЕ *</label><input style={inp} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Име / Фирма" /></div>
            <div><label style={{ fontSize: 11, fontWeight: 700, color: T.textSub, display: "block", marginBottom: 4 }}>ТЕЛЕФОН</label><input style={inp} value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder="+359..." /></div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
            <div><label style={{ fontSize: 11, fontWeight: 700, color: T.textSub, display: "block", marginBottom: 4 }}>АДРЕС</label><input style={inp} value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} placeholder="Град, Улица..." /></div>
            <div><label style={{ fontSize: 11, fontWeight: 700, color: T.textSub, display: "block", marginBottom: 4 }}>БУЛСТАТ (Опц)</label><input style={inp} value={form.vat} onChange={e => setForm(f => ({ ...f, vat: e.target.value }))} placeholder="BG..." /></div>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            {form.id && <button onClick={() => setForm({ id: "", name: "", phone: "", address: "", vat: "" })} className="btn-hover" style={{ padding: "8px 16px", background: T.bg, color: T.textSub, border: `1px solid ${T.border}`, borderRadius: 8, fontFamily: F, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Нов запис</button>}
            <button onClick={add} disabled={!form.name} className="btn-hover" style={{ padding: "8px 24px", background: T.primary, color: "#fff", border: "none", borderRadius: 8, fontFamily: F, fontSize: 13, fontWeight: 700, cursor: !form.name ? "default" : "pointer", opacity: !form.name ? 0.5 : 1 }}>{form.id ? "Обнови запис" : "+ Добави"}</button>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
          {contacts.length === 0 ? <div style={{ textAlign: "center", color: T.textMute, padding: 20, fontSize: 13 }}>Няма добавени записи</div> : 
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {contacts.map(c => (
                <div key={c.id} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: 14, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 4 }}>{c.name}</div>
                    <div style={{ fontSize: 12, color: T.textSub, display: "flex", gap: 12 }}>
                      {c.phone && <span>📞 {c.phone}</span>}{c.address && <span>📍 {c.address}</span>}{c.vat && <span>📄 {c.vat}</span>}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={() => setForm(c)} className="btn-hover" style={{ padding: "6px 12px", background: T.bg, color: T.primary, border: `1px solid ${T.border}`, borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: 700 }}>Редакция</button>
                    <button onClick={() => onDelete(c.id)} className="btn-hover" style={{ padding: "6px 12px", background: "#FEF2F2", color: T.red, border: "1px solid #FECACA", borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: 700 }}>Изтрий</button>
                  </div>
                </div>
              ))}
            </div>
          }
        </div>
      </div>
    </div>
  );
}

// ─── Dashboard View ───────────────────────────────────────────────────────────
function DashboardView({ products, deliveries, onNavigate }) {
  const T = useT();
  const isMobile = useIsMobile();
  const todayD = deliveries.filter(d => d.date.startsWith(todayStr()));
  const todayRev = todayD.reduce((s, d) => s + d.items.reduce((ss, i) => ss + (i.price || 0) * i.qty, 0), 0);
  const todayProf = todayD.reduce((s, d) => s + d.items.reduce((ss, i) => ss + ((i.price || 0) - (i.costPrice || 0)) * i.qty, 0), 0);
  const emptyC = products.filter(p => p.qty === 0).length;
  const lowC = products.filter(p => p.qty > 0 && p.qty <= p.minQty).length;
  const chartData = useMemo(() => {
    const now = new Date(); const map = {};
    for (let i = 6; i >= 0; i--) { const d = new Date(now); d.setDate(d.getDate() - i); const k = d.toISOString().slice(0, 10); map[k] = { date: fmtShortDate(k + "T12:00:00"), revenue: 0, profit: 0 }; }
    deliveries.forEach(d => { const k = d.date.slice(0, 10); if (map[k]) d.items.forEach(i => { map[k].revenue += (i.price || 0) * i.qty; map[k].profit += ((i.price || 0) - (i.costPrice || 0)) * i.qty; }); });
    return Object.values(map).map(v => ({ ...v, revenue: +v.revenue.toFixed(2), profit: +v.profit.toFixed(2) }));
  }, [deliveries]);
  const recent = [...deliveries].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 5);
  const kpis = [
    { l: "ОБЩО ПРОДУКТИ", v: products.length, u: "бр.", c: T.primary, bg: "#EEF2FF", icon: "📦" },
    { l: "ДНЕШНИ ДОСТАВКИ", v: todayD.length, u: "бр.", c: T.text, bg: T.surface, icon: "🚚" },
    { l: "ДНЕШЕН ПРИХОД", v: fmt(todayRev), u: "лв", c: T.green, bg: "#ECFDF5", icon: "💰" },
    { l: "ДНЕШНА ПЕЧАЛБА", v: fmt(todayProf), u: "лв", c: T.orange, bg: "#FFFBEB", icon: "📈" },
  ];
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4,1fr)", gap: 14, marginBottom: 24 }}>
        {kpis.map(({ l, v, u, c, bg, icon }) => (
          <div key={l} className="card-hover" style={{ background: bg, borderRadius: 16, padding: "16px 20px", border: `1px solid ${T.border}`, boxShadow: T.shadow }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: T.textSub, letterSpacing: .5, marginBottom: 6, fontFamily: F }}>{icon} {l}</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
              <span style={{ fontSize: 26, fontWeight: 800, color: c, fontFamily: F }}>{v}</span>
              <span style={{ fontSize: 12, color: T.textSub, fontWeight: 600 }}>{u}</span>
            </div>
          </div>
        ))}
      </div>
      {(emptyC > 0 || lowC > 0) && (
        <div style={{ display: "flex", gap: 14, marginBottom: 24 }}>
          {emptyC > 0 && <button onClick={() => onNavigate("inventory")} className="card-hover btn-hover" style={{ flex: 1, background: "#FEF2F2", border: "2px solid #FECACA", borderRadius: 16, padding: "16px 20px", cursor: "pointer", textAlign: "left" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.red, fontFamily: F }}>✕ ИЗЧЕРПАНИ</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: T.red }}>{emptyC}</div>
          </button>}
          {lowC > 0 && <button onClick={() => onNavigate("inventory")} className="card-hover btn-hover" style={{ flex: 1, background: "#FFFBEB", border: "2px solid #FDE68A", borderRadius: 16, padding: "16px 20px", cursor: "pointer", textAlign: "left" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.orange, fontFamily: F }}>⚠ НИСЪК ЗАПАС</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: T.orange }}>{lowC}</div>
          </button>}
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 20 }}>
        <div style={{ background: T.surface, borderRadius: 16, padding: "20px 12px 16px", border: `1px solid ${T.border}`, boxShadow: T.shadow }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: T.text, marginBottom: 12, fontFamily: F, paddingLeft: 8 }}>📈 Последни 7 дни</div>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={chartData} margin={{ top: 5, right: 16, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={T.border} />
              <XAxis dataKey="date" tick={{ fontSize: 10, fontFamily: F, fill: T.textMute }} />
              <YAxis tick={{ fontSize: 10, fontFamily: F, fill: T.textMute }} width={50} />
              <Tooltip contentStyle={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, fontFamily: F, fontSize: 12 }} />
              <Line type="monotone" dataKey="revenue" stroke={T.primary} strokeWidth={2} dot={{ r: 2 }} name="Приход" />
              <Line type="monotone" dataKey="profit" stroke={T.green} strokeWidth={2} dot={{ r: 2 }} name="Печалба" />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div style={{ background: T.surface, borderRadius: 16, padding: 20, border: `1px solid ${T.border}`, boxShadow: T.shadow }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: T.text, marginBottom: 12, fontFamily: F }}>🕐 Последни доставки</div>
          {recent.length === 0 ? <div style={{ color: T.textMute, textAlign: "center", padding: "30px 0", fontSize: 13, fontFamily: F }}>Няма доставки</div>
          : recent.map(d => (
            <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: `1px solid ${T.border}` }}>
              <div style={{ width: 32, height: 32, borderRadius: 8, background: `${T.primary}15`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, flexShrink: 0 }}>🚚</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: T.text, fontFamily: F }}>#{d.deliveryId} · {d.userName}</div>
                <div style={{ fontSize: 11, color: T.textMute, fontFamily: F }}>{fmtDate(d.date)} · {d.items.length} позиц.</div>
              </div>
              <div style={{ fontSize: 13, fontWeight: 800, color: T.primary, fontFamily: F, whiteSpace: "nowrap" }}>
                {fmt(d.items.reduce((s, i) => s + (i.price || 0) * i.qty, 0))} лв
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Inventory View ───────────────────────────────────────────────────────────
function InventoryView({ products, allProducts, search, setSearch, isOwner, onAdd, onEdit, onDelete, onQtyChange, priceLoading, onAlertMode, onRefreshPrices, onStockTake, onWaste, onCompare, deliveries }) {
  const T = useT();
  const isMobile = useIsMobile();
  const [catFilter, setCatFilter] = useState("all");
  const [sortBy, setSortBy] = useState("name-asc");
  const lowCount = allProducts.filter(p => p.qty > 0 && p.qty <= p.minQty).length;
  const emptyCount = allProducts.filter(p => p.qty === 0).length;
  const sorted = useMemo(() => {
    const filtered = catFilter === "all" ? products : products.filter(p => (p.category || "other") === catFilter);
    return sortProds(filtered, sortBy);
  }, [products, catFilter, sortBy]);
  const selSt = { background: T.surface, border: `1.5px solid ${T.border}`, color: T.text, padding: "9px 12px", borderRadius: 10, fontFamily: F, fontSize: 13, fontWeight: 600, outline: "none", cursor: "pointer" };
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 20 }} className="grid-mobile-1">
        {[
          { mode: "low", label: "⚠ НИСЪК ЗАПАС", count: lowCount, col: T.orange, bg: "#FFFBEB" },
          { mode: "empty", label: "✕ ИЗЧЕРПАНИ", count: emptyCount, col: T.red, bg: "#FEF2F2" }
        ].map(({ mode, label, count, col, bg }) => (
          <button key={mode} className="card-hover btn-hover" onClick={() => onAlertMode(mode)} style={{ background: count > 0 ? bg : T.surface, border: `2px solid ${count > 0 ? col : T.border}`, borderRadius: 16, padding: "18px 20px", cursor: "pointer", textAlign: "left", boxShadow: T.shadow }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: count > 0 ? col : T.textMute, letterSpacing: .5, marginBottom: 6 }}>{label}</div>
            <div style={{ fontSize: 32, fontWeight: 800, color: count > 0 ? col : T.textMute }}>{count}</div>
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        {CATEGORIES.map(c => (
          <button key={c.id} onClick={() => setCatFilter(c.id)} className="btn-hover" style={{ padding: "6px 12px", borderRadius: 20, border: `1.5px solid ${catFilter === c.id ? c.color : T.border}`, background: catFilter === c.id ? `${c.color}15` : T.surface, color: catFilter === c.id ? c.color : T.textSub, cursor: "pointer", fontFamily: F, fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" }}>
            {c.icon} {c.name}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
        <div style={{ position: "relative", flex: 1, minWidth: isMobile ? "100%" : 280 }}>
          <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: T.textMute, fontSize: 16 }}>🔍</span>
          <input id="search-input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Търси по име или баркод..." style={{
            width: "100%", padding: "12px 16px 12px 42px", background: T.surface, border: `1.5px solid ${T.border}`, borderRadius: 14,
            fontSize: 14, color: T.text, outline: "none", transition: "border-color .2s, box-shadow .2s", boxShadow: T.shadow,
          }} onFocus={e => { e.target.style.borderColor = T.primary; e.target.style.boxShadow = `0 0 0 4px ${T.primary}22`; }} onBlur={e => { e.target.style.borderColor = T.border; e.target.style.boxShadow = T.shadow; }} />
        </div>
        <select style={selSt} value={sortBy} onChange={e => setSortBy(e.target.value)}>
          {SORT_OPTS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        {isOwner && (
          <>
            <button className="btn-hover" onClick={onStockTake} title="Инвентаризация" style={{ padding: "11px 16px", background: T.surface, color: T.text, border: `1.5px solid ${T.border}`, borderRadius: 12, cursor: "pointer", fontFamily: F, fontSize: 16, fontWeight: 700, boxShadow: T.shadow }}>📋</button>
            <button className="btn-hover" onClick={onWaste} title="Брак/Загуби" style={{ padding: "11px 16px", background: T.surface, color: T.red, border: `1.5px solid ${T.border}`, borderRadius: 12, cursor: "pointer", fontFamily: F, fontSize: 16, fontWeight: 700, boxShadow: T.shadow }}>🗑️</button>
            <button className="btn-hover" onClick={onCompare} title="Сравни продукти" style={{ padding: "11px 16px", background: T.surface, color: T.primary, border: `1.5px solid ${T.border}`, borderRadius: 12, cursor: "pointer", fontFamily: F, fontSize: 16, fontWeight: 700, boxShadow: T.shadow }}>⚖️</button>
            <button className="btn-hover" onClick={onRefreshPrices} disabled={priceLoading} title="Обнови AI цени" style={{ padding: "11px 16px", background: T.surface, color: priceLoading ? T.textMute : T.orange, border: `1.5px solid ${T.border}`, borderRadius: 12, cursor: priceLoading ? "default" : "pointer", fontFamily: F, fontSize: 16, fontWeight: 700, boxShadow: T.shadow }}>
              <span className={priceLoading ? "spin" : ""}>↻</span>
            </button>
            <button className="btn-hover" onClick={onAdd} style={{ padding: "11px 20px", background: `linear-gradient(135deg,${T.primary},${T.primaryD})`, color: "#fff", border: "none", borderRadius: 12, fontFamily: F, fontSize: 13, fontWeight: 700, cursor: "pointer", boxShadow: `0 4px 12px ${T.primary}44`, whiteSpace: "nowrap" }}>+ Добави</button>
          </>
        )}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fill,minmax(260px,1fr))", gap: 14 }}>
        {sorted.map(p => (
          <ProductCard key={p.id} product={p} isOwner={isOwner} onEdit={() => onEdit(p)} onDelete={() => onDelete(p.id)} onQtyChange={onQtyChange} priceLoading={priceLoading} deliveries={deliveries} />
        ))}
      </div>
      {sorted.length === 0 && (
        <div style={{ textAlign: "center", color: T.textMute, padding: "60px 0", fontSize: 15, fontWeight: 600, fontFamily: F }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>📭</div>Няма намерени продукти
        </div>
      )}
    </div>
  );
}

// ─── Delivery View ────────────────────────────────────────────────────────────
function DeliveryView({ products, cart, setCart, cartQtys, setCartQtys, addToCart, removeFromCart, onConfirm, clients, templates, onSaveTemplate }) {
  const T = useT();
  const isMobile = useIsMobile();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(null);
  const [qtyInput, setQtyInput] = useState("1");
  const [clientId, setClientId] = useState("");
  const [note, setNote] = useState("");
  const [discount, setDiscount] = useState("");
  const [tplName, setTplName] = useState("");
  const [gps, setGps] = useState(null);
  const searchRef = useRef();
  const qtyRef = useRef();

  useEffect(() => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(p => setGps({ lat: p.coords.latitude, lng: p.coords.longitude }), () => {});
    }
  }, []);

  const cartProducts = cart.map(c => products.find(p => p.id === c.id)).filter(Boolean);
  const total = cartProducts.reduce((s, p) => s + (p.price || 0) * (cartQtys[p.id] || 1), 0);
  const searchResults = search.trim() ? products.filter(p => fuzzyMatch(search.toLowerCase(), p.name) || p.code.toLowerCase().includes(search.toLowerCase())) : [];
  const selectProduct = (p) => { setSelected(p); setQtyInput(String(cartQtys[p.id] || 1)); setSearch(""); setTimeout(() => qtyRef.current?.focus(), 50); };
  const confirmQty = () => { if (!selected) return; addToCart(selected, Math.max(1, parseInt(qtyInput) || 1)); setSelected(null); setQtyInput("1"); setTimeout(() => searchRef.current?.focus(), 50); };
  const cancelSelect = () => { setSelected(null); setQtyInput("1"); setTimeout(() => searchRef.current?.focus(), 50); };

  const handleConfirm = () => onConfirm({ clientId, note, location: gps, discountPct: parseFloat(discount) || 0 });

  const loadTemplate = (id) => {
    if (!id) return;
    const t = templates.find(x => x.id === id);
    if (!t) return;
    const nc = [], nq = {};
    t.items.forEach(i => { const p = products.find(x => x.id === i.id); if (p) { nc.push(p); nq[p.id] = i.qty; } });
    setCart(nc); setCartQtys(nq);
  };
  const saveTpl = () => {
    if (!tplName || cartProducts.length === 0) return;
    onSaveTemplate({ id: generateId(), name: tplName, items: cartProducts.map(p => ({ id: p.id, qty: cartQtys[p.id] || 1 })) });
    setTplName("");
  };
  const inpSt = { background: T.bg, border: `1.5px solid ${T.border}`, color: T.text, padding: "10px 14px", borderRadius: 12, fontFamily: F, fontSize: 13, width: "100%", outline: "none", marginBottom: 12 };
  return (
    <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 380px", gap: 20, alignItems: "start" }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: T.textSub, marginBottom: 14, letterSpacing: .3, fontFamily: F }}>ДОБАВЯНЕ НА ПРОДУКТИ</div>
        {!selected && (
          <div style={{ position: "relative", marginBottom: 16 }}>
            <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", fontSize: 16, color: T.textMute, zIndex: 1 }}>🔍</span>
            <input ref={searchRef} value={search} onChange={e => setSearch(e.target.value)} placeholder="Въведи код или наименование..." autoFocus
              style={{ width: "100%", background: T.surface, border: `2px solid ${T.primary}`, color: T.text, padding: "14px 16px 14px 44px", borderRadius: 14, fontFamily: F, fontSize: 15, outline: "none", boxShadow: `0 4px 16px ${T.primary}22` }} />
            {searchResults.length > 0 && (
              <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: T.surface, border: `1px solid ${T.border}`, borderRadius: "0 0 14px 14px", zIndex: 50, maxHeight: 320, overflowY: "auto", boxShadow: T.shadowLg }}>
                {searchResults.map(p => (
                  <div key={p.id} onClick={() => selectProduct(p)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 16px", cursor: "pointer", borderBottom: `1px solid ${T.border}`, transition: "background .1s" }}
                    onMouseEnter={e => e.currentTarget.style.background = T.bg} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <div style={{ background: "#EEF2FF", color: T.primary, borderRadius: 6, padding: "3px 8px", fontSize: 10, fontWeight: 800, flexShrink: 0 }}>{p.code}</div>
                    <div style={{ flex: 1, fontSize: 14, fontWeight: 600, color: T.text, fontFamily: F }}>{p.name}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: T.orange }}>{p.price > 0 ? `${fmt(p.price)} лв` : "—"}</div>
                    <div style={{ fontSize: 13, fontWeight: 800, color: p.qty === 0 ? T.red : T.green }}>{p.qty} {p.unit}</div>
                  </div>
                ))}
              </div>
            )}
            {search.trim() && searchResults.length === 0 && (
              <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: T.surface, border: `1px solid ${T.border}`, borderRadius: "0 0 14px 14px", padding: "16px", color: T.textMute, fontSize: 14, fontFamily: F, textAlign: "center" }}>Няма резултати 🔍</div>
            )}
          </div>
        )}
        {selected && (
          <div style={{ background: T.surface, border: `2px solid ${T.primary}`, borderRadius: 16, padding: 22, marginBottom: 16, boxShadow: `0 4px 20px ${T.primary}22` }}>
            <div style={{ background: "#EEF2FF", color: T.primary, borderRadius: 8, padding: "4px 10px", fontSize: 10, fontWeight: 800, display: "inline-block", marginBottom: 6 }}>{selected.code}</div>
            <div style={{ fontSize: 17, fontWeight: 800, color: T.text, marginBottom: 4, fontFamily: F }}>{selected.name}</div>
            <div style={{ fontSize: 13, color: T.green, fontWeight: 600, marginBottom: 20, fontFamily: F }}>✅ Налично: {selected.qty} {selected.unit}</div>
            <label style={{ fontSize: 12, fontWeight: 700, color: T.textSub, display: "block", marginBottom: 10, letterSpacing: .3, fontFamily: F }}>ВЪВЕДИ КОЛИЧЕСТВО ({selected.unit})</label>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <button onClick={() => setQtyInput(v => String(Math.max(1, (parseInt(v) || 1) - 1)))} style={{ width: 48, height: 52, background: T.bg, border: `1.5px solid ${T.border}`, color: T.text, borderRadius: 12, cursor: "pointer", fontSize: 22, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>−</button>
              <input ref={qtyRef} type="number" min="1" max={selected.qty} value={qtyInput}
                onChange={e => setQtyInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") confirmQty(); if (e.key === "Escape") cancelSelect(); }}
                style={{ flex: 1, background: T.bg, border: `2px solid ${T.primary}`, color: T.primary, padding: "12px", borderRadius: 12, fontFamily: F, fontSize: 28, fontWeight: 800, outline: "none", textAlign: "center" }} />
              <button onClick={() => setQtyInput(v => String((parseInt(v) || 1) + 1))} style={{ width: 48, height: 52, background: T.bg, border: `1.5px solid ${T.border}`, color: T.text, borderRadius: 12, cursor: "pointer", fontSize: 22, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <button className="btn-hover" onClick={confirmQty} style={{ flex: 2, padding: "13px 0", background: `linear-gradient(135deg,${T.primary},${T.primaryD})`, color: "#fff", border: "none", borderRadius: 12, fontFamily: F, fontSize: 14, fontWeight: 700, cursor: "pointer", boxShadow: `0 4px 12px ${T.primary}44` }}>Добави → Следващ</button>
              <button onClick={cancelSelect} style={{ flex: 1, padding: "13px 0", background: T.bg, color: T.textSub, border: `1px solid ${T.border}`, borderRadius: 12, fontFamily: F, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Отказ</button>
            </div>
            <div style={{ fontSize: 11, color: T.textMute, marginTop: 10, textAlign: "center", fontFamily: F }}>Enter — добави &nbsp;|&nbsp; Esc — отказ</div>
          </div>
        )}
        {cartProducts.length > 0 && !selected && (
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: T.textSub, marginBottom: 10, letterSpacing: .3, fontFamily: F }}>ДОБАВЕНИ ПРОДУКТИ</div>
            {cartProducts.map(p => (
              <div key={p.id} className="card-hover" style={{ display: "flex", alignItems: "center", gap: 10, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: "11px 14px", marginBottom: 8, boxShadow: T.shadow }}>
                <div style={{ background: "#EEF2FF", color: T.primary, borderRadius: 6, padding: "3px 7px", fontSize: 10, fontWeight: 800, flexShrink: 0 }}>{p.code}</div>
                <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: T.text, fontFamily: F }}>{p.name}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <button onClick={() => setCartQtys(q => ({ ...q, [p.id]: Math.max(1, (q[p.id] || 1) - 1) }))} style={{ width: 26, height: 26, background: T.bg, border: `1px solid ${T.border}`, color: T.text, borderRadius: 7, cursor: "pointer", fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>−</button>
                  <span style={{ fontSize: 15, fontWeight: 800, color: T.primary, minWidth: 28, textAlign: "center" }}>{cartQtys[p.id] || 1}</span>
                  <span style={{ fontSize: 11, color: T.textSub, fontWeight: 500 }}>{p.unit}</span>
                  <button onClick={() => setCartQtys(q => ({ ...q, [p.id]: Math.min(p.qty, (q[p.id] || 1) + 1) }))} style={{ width: 26, height: 26, background: T.bg, border: `1px solid ${T.border}`, color: T.text, borderRadius: 7, cursor: "pointer", fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
                </div>
                <div style={{ fontSize: 13, color: T.orange, fontWeight: 800, minWidth: 60, textAlign: "right" }}>{p.price > 0 ? `${fmt(p.price * (cartQtys[p.id] || 1))} лв` : "—"}</div>
                <button onClick={() => removeFromCart(p.id)} style={{ background: "#FEF2F2", border: "none", color: T.red, cursor: "pointer", fontSize: 13, padding: "4px 8px", borderRadius: 7, fontWeight: 700 }}>✕</button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 20, padding: 22, position: isMobile ? "relative" : "sticky", top: 76, boxShadow: T.shadowLg }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: T.text, marginBottom: 16, fontFamily: F }}>🚚 Доставка</div>
        {cartProducts.length === 0 ? (
          <div style={{ color: T.textMute, textAlign: "center", padding: "28px 0", fontSize: 14, fontWeight: 500, fontFamily: F }}>
            <div style={{ fontSize: 36, marginBottom: 8 }}>🛒</div>Търси и добави продукти
            {templates?.length > 0 && (
              <div style={{ marginTop: 24, textAlign: "left" }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: T.textSub, display: "block", marginBottom: 6 }}>ЗАРАДИ ОТ ШАБЛОН</label>
                <select style={inpSt} onChange={e => loadTemplate(e.target.value)} value="">
                  <option value="">-- Избери шаблон --</option>
                  {templates.map(t => <option key={t.id} value={t.id}>{t.name} ({t.items.length} поз.)</option>)}
                </select>
              </div>
            )}
          </div>
        ) : (
          <>
            <div style={{ maxHeight: "30vh", overflowY: "auto", marginBottom: 16 }}>
              {cartProducts.map(p => (
                <div key={p.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 8, color: T.text, fontWeight: 500, fontFamily: F }}>
                  <span style={{ flex: 1, marginRight: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name} <span style={{ color: T.textMute, fontSize: 11 }}>{p.code}</span></span>
                  <span style={{ color: T.primary, fontWeight: 800, whiteSpace: "nowrap" }}>{cartQtys[p.id] || 1} <span style={{ fontSize: 10, color: T.textSub }}>{p.unit}</span></span>
                </div>
              ))}
            </div>
            
            <div style={{ background: T.bg, padding: 14, borderRadius: 12, marginBottom: 16, border: `1px solid ${T.border}` }}>
              <select style={{ ...inpSt, marginBottom: 10 }} value={clientId} onChange={e => setClientId(e.target.value)}>
                <option value="">-- Избери клиент (опционално) --</option>
                {clients?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <textarea style={{ ...inpSt, height: 60, resize: "none", marginBottom: 0 }} placeholder="Бележки към доставката (напр. Остави до вратата)..." value={note} onChange={e => setNote(e.target.value)} />
            </div>

            <div style={{ borderTop: `2px solid ${T.border}`, paddingTop: 12, marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: T.textSub, fontWeight: 600, marginBottom: 8 }}>
                <span>Позиции:</span><span style={{ color: T.primary }}>{cartProducts.length}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontSize: 12, color: T.textSub, fontWeight: 600 }}>Отстъпка (%):</span>
                <input style={{ ...inpSt, marginBottom: 0, padding: "6px 10px", width: 80, textAlign: "right" }} type="number" min="0" max="100" placeholder="0" value={discount} onChange={e => setDiscount(e.target.value)} />
              </div>
              {total > 0 && (
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 20, fontWeight: 800, color: T.text, fontFamily: F }}>
                  <span>Общо:</span>
                  <div style={{ textAlign: "right" }}>
                     {(parseFloat(discount)>0) && <div style={{ fontSize: 12, textDecoration: "line-through", color: T.textMute, marginBottom: 2 }}>{fmt(total)} лв</div>}
                     <div style={{ color: T.primary }}>{fmt(total * (1 - (parseFloat(discount)||0)/100))} лв</div>
                  </div>
                </div>
              )}
            </div>

            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <input style={{ ...inpSt, marginBottom: 0 }} placeholder="Име на шаблон..." value={tplName} onChange={e => setTplName(e.target.value)} />
              <button disabled={!tplName} onClick={saveTpl} className="btn-hover" style={{ padding: "0 14px", background: T.bg, color: T.primary, border: `1px solid ${T.primary}44`, borderRadius: 12, fontFamily: F, fontSize: 12, fontWeight: 700, cursor: tplName ? "pointer" : "default", opacity: tplName ? 1 : 0.5, whiteSpace: "nowrap" }}>💾 Шаблон</button>
            </div>
          </>
        )}
        <button className="btn-hover" onClick={handleConfirm} disabled={cartProducts.length === 0} style={{ width: "100%", padding: "14px 0", background: cartProducts.length ? `linear-gradient(135deg,${T.primary},${T.primaryD})` : T.bg, color: cartProducts.length ? "#fff" : T.textMute, border: "none", borderRadius: 14, fontFamily: F, fontSize: 14, fontWeight: 700, cursor: cartProducts.length ? "pointer" : "default", boxShadow: cartProducts.length ? `0 4px 16px ${T.primary}44` : "none" }}>
          🖨 Потвърди и принтирай
        </button>
      </div>
    </div>
  );
}

// ─── Request View (Вътрешни Заявки) ───────────────────────────────────────────
function RequestView({ products, cart, setCart, cartQtys, setCartQtys, addToCart, removeFromCart, onConfirm }) {
  const T = useT();
  const isMobile = useIsMobile();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(null);
  const [qtyInput, setQtyInput] = useState("1");
  const [note, setNote] = useState("");
  const searchRef = useRef();
  const qtyRef = useRef();

  const cartProducts = cart.map(c => products.find(p => p.id === c.id)).filter(Boolean);
  const searchResults = search.trim() ? products.filter(p => fuzzyMatch(search.toLowerCase(), p.name) || p.code.toLowerCase().includes(search.toLowerCase())) : [];
  const selectProduct = (p) => { setSelected(p); setQtyInput(String(cartQtys[p.id] || 1)); setSearch(""); setTimeout(() => qtyRef.current?.focus(), 50); };
  const confirmQty = () => { if (!selected) return; addToCart(selected, Math.max(1, parseInt(qtyInput) || 1)); setSelected(null); setQtyInput("1"); setTimeout(() => searchRef.current?.focus(), 50); };
  const cancelSelect = () => { setSelected(null); setQtyInput("1"); setTimeout(() => searchRef.current?.focus(), 50); };

  const handleConfirm = () => onConfirm({ type: "request", note });
  const inpSt = { background: T.bg, border: `1.5px solid ${T.border}`, color: T.text, padding: "10px 14px", borderRadius: 12, fontFamily: F, fontSize: 13, width: "100%", outline: "none", marginBottom: 12 };

  return (
    <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 400px", gap: 20, alignItems: "start" }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: T.textSub, marginBottom: 14, letterSpacing: .3, fontFamily: F }}>ДОБАВЯНЕ КЪМ ЗАЯВКА</div>
        {!selected && (
          <div style={{ position: "relative", marginBottom: 16 }}>
            <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", fontSize: 16, color: T.textMute, zIndex: 1 }}>🔍</span>
            <input ref={searchRef} value={search} onChange={e => setSearch(e.target.value)} placeholder="Търси продукт..." autoFocus
              style={{ width: "100%", background: T.surface, border: `2px solid ${T.primary}`, color: T.text, padding: "14px 16px 14px 44px", borderRadius: 14, fontFamily: F, fontSize: 15, outline: "none", boxShadow: `0 4px 16px ${T.primary}22` }} />
            {searchResults.length > 0 && (
              <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: T.surface, border: `1px solid ${T.border}`, borderRadius: "0 0 14px 14px", zIndex: 50, maxHeight: 320, overflowY: "auto", boxShadow: T.shadowLg }}>
                {searchResults.map(p => (
                  <div key={p.id} onClick={() => selectProduct(p)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 16px", cursor: "pointer", borderBottom: `1px solid ${T.border}`, transition: "background .1s" }} onMouseEnter={e => e.currentTarget.style.background = T.bg} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <div style={{ background: "#EEF2FF", color: T.primary, borderRadius: 6, padding: "3px 8px", fontSize: 10, fontWeight: 800, flexShrink: 0 }}>{p.code}</div>
                    <div style={{ flex: 1, fontSize: 14, fontWeight: 600, color: T.text, fontFamily: F }}>{p.name}</div>
                    <div style={{ fontSize: 13, fontWeight: 800, color: p.qty === 0 ? T.red : T.green }}>{p.qty} {p.unit}</div>
                  </div>
                ))}
              </div>
            )}
            {search.trim() && searchResults.length === 0 && <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: T.surface, border: `1px solid ${T.border}`, borderRadius: "0 0 14px 14px", padding: "16px", color: T.textMute, fontSize: 14, fontFamily: F, textAlign: "center" }}>Няма резултати 🔍</div>}
          </div>
        )}
        {selected && (
          <div style={{ background: T.surface, border: `2px solid ${T.primary}`, borderRadius: 16, padding: 22, marginBottom: 16, boxShadow: `0 4px 20px ${T.primary}22` }}>
            <div style={{ background: "#EEF2FF", color: T.primary, borderRadius: 8, padding: "4px 10px", fontSize: 10, fontWeight: 800, display: "inline-block", marginBottom: 6 }}>{selected.code}</div>
            <div style={{ fontSize: 17, fontWeight: 800, color: T.text, marginBottom: 4, fontFamily: F }}>{selected.name}</div>
            <div style={{ fontSize: 13, color: T.green, fontWeight: 600, marginBottom: 20, fontFamily: F }}>✅ Налично: {selected.qty} {selected.unit}</div>
            <label style={{ fontSize: 12, fontWeight: 700, color: T.textSub, display: "block", marginBottom: 10, letterSpacing: .3, fontFamily: F }}>ВЪВЕДИ КОЛИЧЕСТВО</label>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <button onClick={() => setQtyInput(v => String(Math.max(1, (parseInt(v) || 1) - 1)))} style={{ width: 48, height: 52, background: T.bg, border: `1.5px solid ${T.border}`, color: T.text, borderRadius: 12, cursor: "pointer", fontSize: 22, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>−</button>
              <input ref={qtyRef} type="number" min="1" max={selected.qty} value={qtyInput} onChange={e => setQtyInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter") confirmQty(); if (e.key === "Escape") cancelSelect(); }} style={{ flex: 1, background: T.bg, border: `2px solid ${T.primary}`, color: T.primary, padding: "12px", borderRadius: 12, fontFamily: F, fontSize: 28, fontWeight: 800, outline: "none", textAlign: "center" }} />
              <button onClick={() => setQtyInput(v => String((parseInt(v) || 1) + 1))} style={{ width: 48, height: 52, background: T.bg, border: `1.5px solid ${T.border}`, color: T.text, borderRadius: 12, cursor: "pointer", fontSize: 22, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <button className="btn-hover" onClick={confirmQty} style={{ flex: 2, padding: "13px 0", background: `linear-gradient(135deg,${T.primary},${T.primaryD})`, color: "#fff", border: "none", borderRadius: 12, fontFamily: F, fontSize: 14, fontWeight: 700, cursor: "pointer", boxShadow: `0 4px 12px ${T.primary}44` }}>Добави</button>
              <button onClick={cancelSelect} style={{ flex: 1, padding: "13px 0", background: T.bg, color: T.textSub, border: `1px solid ${T.border}`, borderRadius: 12, fontFamily: F, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Отказ</button>
            </div>
          </div>
        )}
        {cartProducts.length > 0 && !selected && (
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: T.textSub, marginBottom: 10, letterSpacing: .3, fontFamily: F }}>ДОБАВЕНИ ПРОДУКТИ</div>
            {cartProducts.map(p => (
              <div key={p.id} className="card-hover" style={{ display: "flex", alignItems: "center", gap: 10, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: "11px 14px", marginBottom: 8, boxShadow: T.shadow }}>
                <div style={{ background: "#EEF2FF", color: T.primary, borderRadius: 6, padding: "3px 7px", fontSize: 10, fontWeight: 800, flexShrink: 0 }}>{p.code}</div>
                <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: T.text, fontFamily: F }}>{p.name}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <button onClick={() => setCartQtys(q => ({ ...q, [p.id]: Math.max(1, (q[p.id] || 1) - 1) }))} style={{ width: 26, height: 26, background: T.bg, border: `1px solid ${T.border}`, color: T.text, borderRadius: 7, cursor: "pointer", fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>−</button>
                  <span style={{ fontSize: 15, fontWeight: 800, color: T.primary, minWidth: 28, textAlign: "center" }}>{cartQtys[p.id] || 1}</span>
                  <span style={{ fontSize: 11, color: T.textSub, fontWeight: 500 }}>{p.unit}</span>
                  <button onClick={() => setCartQtys(q => ({ ...q, [p.id]: Math.min(p.qty, (q[p.id] || 1) + 1) }))} style={{ width: 26, height: 26, background: T.bg, border: `1px solid ${T.border}`, color: T.text, borderRadius: 7, cursor: "pointer", fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
                </div>
                <button onClick={() => removeFromCart(p.id)} style={{ background: "#FEF2F2", border: "none", color: T.red, cursor: "pointer", fontSize: 13, padding: "4px 8px", borderRadius: 7, fontWeight: 700 }}>✕</button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 20, padding: 22, position: isMobile ? "relative" : "sticky", top: 76, boxShadow: T.shadowLg }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: T.text, marginBottom: 16, fontFamily: F }}>📦 Вътрешна заявка</div>
        {cartProducts.length === 0 ? (
          <div style={{ color: T.textMute, textAlign: "center", padding: "28px 0", fontSize: 14, fontWeight: 500, fontFamily: F }}><div style={{ fontSize: 36, marginBottom: 8 }}>📋</div>Търси и добави</div>
        ) : (
          <>
            <div style={{ maxHeight: "30vh", overflowY: "auto", marginBottom: 16 }}>
              {cartProducts.map(p => (
                <div key={p.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 8, color: T.text, fontWeight: 500, fontFamily: F }}>
                  <span style={{ flex: 1, marginRight: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name} <span style={{ color: T.textMute, fontSize: 11 }}>{p.code}</span></span>
                  <span style={{ color: T.primary, fontWeight: 800, whiteSpace: "nowrap" }}>{cartQtys[p.id] || 1} <span style={{ fontSize: 10, color: T.textSub }}>{p.unit}</span></span>
                </div>
              ))}
            </div>
            <textarea style={{ ...inpSt, height: 60, resize: "none", marginBottom: 16 }} placeholder="Цел / Обект на заявката..." value={note} onChange={e => setNote(e.target.value)} />
            <div style={{ borderTop: `2px solid ${T.border}`, paddingTop: 12, marginBottom: 16, display: "flex", justifyContent: "space-between", fontSize: 12, color: T.textSub, fontWeight: 600 }}>
              <span>Позиции:</span><span style={{ color: T.primary }}>{cartProducts.length}</span>
            </div>
          </>
        )}
        <button className="btn-hover" onClick={handleConfirm} disabled={cartProducts.length === 0} style={{ width: "100%", padding: "14px 0", background: cartProducts.length ? `linear-gradient(135deg,${T.primary},${T.primaryD})` : T.bg, color: cartProducts.length ? "#fff" : T.textMute, border: "none", borderRadius: 14, fontFamily: F, fontSize: 14, fontWeight: 700, cursor: cartProducts.length ? "pointer" : "default", boxShadow: cartProducts.length ? `0 4px 16px ${T.primary}44` : "none" }}>Изпрати Заявка</button>
      </div>
    </div>
  );
}

// ─── History View ─────────────────────────────────────────────────────────────
function HistoryView({ deliveries, onViewReceipt, currentUser }) {
  const T = useT();
  const isOwnerOrManager = currentUser.role === "owner" || currentUser.role === "manager";
  const [search, setSearch] = useState("");
  const [dateFilter, setDateFilter] = useState("all");
  const [viewMode, setViewMode] = useState("list"); // list or calendar
  const [workerFilter, setWorkerFilter] = useState(isOwnerOrManager ? "all" : currentUser.id);
  const workers = useMemo(() => { const m = {}; deliveries.forEach(d => { if (!m[d.userId]) m[d.userId] = d.userName; }); return Object.entries(m); }, [deliveries]);
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    const now = new Date();
    return deliveries.filter(d => {
      const ms = !q || d.deliveryId?.toLowerCase().includes(q) || d.userName.toLowerCase().includes(q) || d.items.some(i => i.name.toLowerCase().includes(q));
      const mw = workerFilter === "all" || d.userId === workerFilter;
      const diff = (now - new Date(d.date)) / 86400000;
      const md = dateFilter === "all" || (dateFilter === "today" && d.date.startsWith(todayStr())) || (dateFilter === "7d" && diff <= 7) || (dateFilter === "30d" && diff <= 30);
      return ms && mw && md;
    }).sort((a, b) => new Date(b.date) - new Date(a.date));
  }, [deliveries, search, dateFilter, workerFilter]);
  const totalRevenue = filtered.reduce((s, d) => s + d.items.reduce((ss, i) => ss + (i.price || 0) * i.qty, 0), 0);
  const totalProfit = filtered.reduce((s, d) => s + d.items.reduce((ss, i) => ss + ((i.price || 0) - (i.costPrice || 0)) * i.qty, 0), 0);
  const selSt = { background: T.surface, border: `1.5px solid ${T.border}`, color: T.text, padding: "9px 12px", borderRadius: 10, fontFamily: F, fontSize: 13, fontWeight: 600, outline: "none", cursor: "pointer" };
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14, marginBottom: 20 }} className="grid-mobile-1">
        {[
          { label: "ДОСТАВКИ", value: filtered.length, unit: "бр.", color: T.primary, bg: "#EEF2FF", icon: "🚚" },
          { label: "ОБЩ ПРИХОД", value: `${fmt(totalRevenue)}`, unit: "лв", color: T.text, bg: T.surface, icon: "💰" },
          { label: "ОБЩА ПЕЧАЛБА", value: `${fmt(totalProfit)}`, unit: "лв", color: T.green, bg: "#ECFDF5", icon: "📈" },
        ].map(({ label, value, unit, color, bg, icon }) => (
          <div key={label} style={{ background: bg, borderRadius: 16, padding: "16px 20px", border: `1px solid ${T.border}`, boxShadow: T.shadow }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: T.textSub, letterSpacing: .5, marginBottom: 6, fontFamily: F }}>{icon} {label}</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
              <span style={{ fontSize: 26, fontWeight: 800, color, fontFamily: F }}>{value}</span>
              <span style={{ fontSize: 12, color: T.textSub, fontWeight: 600 }}>{unit}</span>
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ flex: 1, position: "relative", minWidth: 200 }}>
          <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", fontSize: 14, color: T.textMute }}>🔍</span>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Търси..."
            style={{ width: "100%", background: T.surface, border: `1.5px solid ${T.border}`, color: T.text, padding: "9px 12px 9px 36px", borderRadius: 10, fontFamily: F, fontSize: 13, outline: "none" }}
            onFocus={e => e.target.style.borderColor = T.primary} onBlur={e => e.target.style.borderColor = T.border} />
        </div>
        <select style={selSt} value={dateFilter} onChange={e => setDateFilter(e.target.value)}>
          <option value="all">📅 Всички</option><option value="today">Днес</option><option value="7d">7 дни</option><option value="30d">30 дни</option>
        </select>
        <select disabled={!isOwnerOrManager} style={{ ...selSt, opacity: isOwnerOrManager ? 1 : 0.6 }} value={workerFilter} onChange={e => setWorkerFilter(e.target.value)}>
          {isOwnerOrManager && <option value="all">👥 Всички</option>}
          <option value={currentUser.id}>👤 Моите</option>
          {isOwnerOrManager && workers.filter(([id]) => id !== currentUser.id).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <div style={{ background: T.surface, border: `1.5px solid ${T.border}`, borderRadius: 10, display: "flex", overflow: "hidden" }}>
          <button onClick={() => setViewMode("list")} style={{ padding: "8px 12px", background: viewMode === "list" ? T.primary : "transparent", color: viewMode === "list" ? "#fff" : T.textSub, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 700 }}>☰</button>
          <button onClick={() => setViewMode("calendar")} style={{ padding: "8px 12px", background: viewMode === "calendar" ? T.primary : "transparent", color: viewMode === "calendar" ? "#fff" : T.textSub, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 700 }}>📅</button>
        </div>
      </div>
      {viewMode === "list" ? (
        <div style={{ background: T.surface, borderRadius: 16, border: `1px solid ${T.border}`, overflow: "auto", boxShadow: T.shadow }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 700 }}>
          <thead>
            <tr style={{ background: T.bg }}>
              {[["#","left"],["ДАТА","left"],["РАБОТНИК","left"],["ПРОДУКТИ","left"],["СТОЙНОСТ","right"],["ПЕЧАЛБА","right"],["","right"]].map(([h,a]) => (
                <th key={h} style={{ padding: "12px 16px", fontSize: 10, fontWeight: 700, color: T.textSub, letterSpacing: .5, textAlign: a, fontFamily: F, borderBottom: `1px solid ${T.border}` }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={7} style={{ padding: "48px", textAlign: "center", color: T.textMute, fontFamily: F, fontSize: 14 }}><div style={{ fontSize: 36, marginBottom: 10 }}>📭</div>Няма доставки</td></tr>
            ) : filtered.map(d => {
              const rev = d.items.reduce((s, i) => s + (i.price || 0) * i.qty, 0);
              const prof = d.items.reduce((s, i) => s + ((i.price || 0) - (i.costPrice || 0)) * i.qty, 0);
              return (
                <tr key={d.id} className="trow" style={{ borderBottom: `1px solid ${T.border}` }}>
                  <td style={{ padding: "12px 16px" }}><div style={{ background: "#EEF2FF", color: T.primary, borderRadius: 6, padding: "3px 8px", fontSize: 10, fontWeight: 800, display: "inline-block", fontFamily: F }}>{d.deliveryId}</div></td>
                  <td style={{ padding: "12px 16px", fontSize: 13, color: T.text, fontFamily: F, fontWeight: 500, whiteSpace: "nowrap" }}>{fmtDate(d.date)}</td>
                  <td style={{ padding: "12px 16px", fontSize: 13, fontWeight: 600, color: T.text, fontFamily: F }}><span>👤 {d.userName}</span></td>
                  <td style={{ padding: "12px 16px", fontSize: 13, fontWeight: 600, color: T.textSub, fontFamily: F }}>{d.items.length} позиц.</td>
                  <td style={{ padding: "12px 16px", textAlign: "right", fontSize: 14, fontWeight: 800, color: T.text, fontFamily: F }}>{rev > 0 ? `${fmt(rev)} лв` : "—"}</td>
                  <td style={{ padding: "12px 16px", textAlign: "right", fontSize: 14, fontWeight: 800, color: prof > 0 ? T.green : T.textMute, fontFamily: F }}>{prof > 0 ? `+${fmt(prof)} лв` : "—"}</td>
                  <td style={{ padding: "12px 16px", textAlign: "right" }}>
                    <button onClick={() => onViewReceipt(d)} className="btn-hover" style={{ padding: "6px 12px", background: "#EEF2FF", color: T.primary, border: "none", borderRadius: 8, cursor: "pointer", fontFamily: F, fontSize: 12, fontWeight: 700 }}>Преглед →</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      ) : (
        <CalendarView deliveries={filtered} onPreview={onViewReceipt} />
      )}
    </div>
  );
}

function CalendarView({ deliveries, onPreview }) {
  const T = useT();
  const [curr, setCurr] = useState(new Date());
  const month = curr.getMonth(), year = curr.getFullYear();
  const first = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const grid = [];
  const startOffset = first === 0 ? 6 : first - 1; 
  for (let i = 0; i < startOffset; i++) grid.push(null);
  for (let i = 1; i <= daysInMonth; i++) grid.push(i);

  const delivMap = {};
  deliveries.forEach(d => {
    const dt = new Date(d.date);
    if (dt.getMonth() === month && dt.getFullYear() === year) {
      const day = dt.getDate();
      if (!delivMap[day]) delivMap[day] = [];
      delivMap[day].push(d);
    }
  });

  const [selectedDay, setSelectedDay] = useState(null);

  return (
    <div style={{ background: T.surface, borderRadius: 16, padding: "20px", border: `1px solid ${T.border}`, boxShadow: T.shadow }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <button onClick={() => setCurr(new Date(year, month - 1))} style={{ background: T.bg, border: `1px solid ${T.border}`, color: T.text, padding: "6px 12px", borderRadius: 8, cursor: "pointer" }}>←</button>
        <div style={{ fontWeight: 800, fontSize: 16, color: T.text }}>{new Date(year, month).toLocaleDateString("bg-BG", { month: "long", year: "numeric" }).toUpperCase()}</div>
        <button onClick={() => setCurr(new Date(year, month + 1))} style={{ background: T.bg, border: `1px solid ${T.border}`, color: T.text, padding: "6px 12px", borderRadius: 8, cursor: "pointer" }}>→</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 8 }}>
        {["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"].map(d => <div key={d} style={{ textAlign: "center", fontSize: 11, fontWeight: 700, color: T.textMute, paddingBottom: 8 }}>{d}</div>)}
        {grid.map((day, i) => {
          const ds = day ? delivMap[day] || [] : [];
          return (
            <div key={i} onClick={() => day && setSelectedDay(day === selectedDay ? null : day)} style={{
              height: 80, border: `1px solid ${day ? T.border : "transparent"}`, borderRadius: 12, padding: 6, cursor: day ? "pointer" : "default",
              background: day === selectedDay ? `${T.primary}15` : T.surface, position: "relative"
            }}>
              {day && <div style={{ fontSize: 12, fontWeight: 700, color: T.textSub }}>{day}</div>}
              {ds.length > 0 && (
                <div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 2 }}>
                  <div style={{ fontSize: 10, background: T.primary, color: "#fff", padding: "2px 4px", borderRadius: 4, textAlign: "center", fontWeight: 700 }}>{ds.length} дост.</div>
                  {ds.length === 1 && <div style={{ fontSize: 9, color: T.textMute, overflow: "hidden", whiteSpace: "nowrap" }}>{ds[0].userName}</div>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {selectedDay && (
        <div style={{ marginTop: 20, borderTop: `1px solid ${T.border}`, paddingTop: 16 }}>
          <div style={{ fontWeight: 800, fontSize: 14, color: T.text, marginBottom: 12 }}>Доставки за {selectedDay} {new Date(year, month).toLocaleDateString("bg-BG", { month: "long" })}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {(delivMap[selectedDay] || []).map(d => (
              <div key={d.id} style={{ display: "flex", justifyContent: "space-between", background: T.bg, padding: "10px 14px", borderRadius: 10 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13, color: T.text }}>#{d.deliveryId} · {d.userName}</div>
                  <div style={{ fontSize: 11, color: T.textSub }}>{new Date(d.date).toLocaleTimeString("bg-BG", { hour: "2-digit", minute: "2-digit" })}</div>
                </div>
                <button onClick={() => onPreview(d)} style={{ background: T.primary, color: "#fff", border: "none", borderRadius: 6, padding: "4px 8px", fontSize: 11, cursor: "pointer", fontWeight: 700 }}>👁</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Stats View ───────────────────────────────────────────────────────────────
function StatsView({ deliveries, products }) {
  const T = useT();
  const [range, setRange] = useState("30d");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  const filteredData = useMemo(() => {
    let rs, re;
    const now = new Date();
    if (range === "custom") {
      rs = customFrom ? new Date(customFrom) : new Date("2000-01-01");
      re = customTo ? new Date(customTo + "T23:59:59") : new Date();
    } else {
      re = now; rs = new Date(now); rs.setDate(rs.getDate() - (range === "7d" ? 7 : range === "14d" ? 14 : 30));
    }
    const dur = re.getTime() - rs.getTime();
    const prevRs = new Date(rs.getTime() - dur);
    const prevRe = new Date(rs.getTime());
    const curr = deliveries.filter(d => { const dt = new Date(d.date); return dt >= rs && dt <= re; });
    const prev = deliveries.filter(d => { const dt = new Date(d.date); return dt >= prevRs && dt < prevRe; });
    return { curr, prev, durDays: Math.max(1, Math.round(dur / 86400000)) };
  }, [deliveries, range, customFrom, customTo]);

  const { curr, prev, durDays } = filteredData;
  const calcDeliv = (list) => {
    let r = 0, p = 0;
    list.forEach(d => d.items.forEach(i => { r += (i.price || 0) * i.qty; p += ((i.price || 0) - (i.costPrice || 0)) * i.qty; }));
    return { r, p, c: list.length };
  };
  const cStat = calcDeliv(curr);
  const pStat = calcDeliv(prev);

  const chartData = useMemo(() => {
    const map = {}; const end = range === "custom" && customTo ? new Date(customTo) : new Date();
    if (durDays <= 31) {
      for (let i = durDays - 1; i >= 0; i--) { const d = new Date(end); d.setDate(d.getDate() - i); const k = d.toISOString().slice(0, 10); map[k] = { date: fmtShortDate(k + "T12:00:00"), revenue: 0, profit: 0, count: 0 }; }
    }
    curr.forEach(d => { const k = d.date.slice(0, 10); if (!map[k]) map[k] = { date: fmtShortDate(d.date), revenue: 0, profit: 0, count: 0 }; map[k].count++; d.items.forEach(i => { map[k].revenue += (i.price || 0) * i.qty; map[k].profit += ((i.price || 0) - (i.costPrice || 0)) * i.qty; }); });
    return Object.values(map).sort((a, b) => a.date.localeCompare(b.date)).map(v => ({ ...v, revenue: +v.revenue.toFixed(2), profit: +v.profit.toFixed(2) }));
  }, [curr, durDays, range, customTo]);

  const topProducts = useMemo(() => {
    const m = {}; curr.forEach(d => d.items.forEach(i => { if (!m[i.name]) m[i.name] = { name: i.name, qty: 0, revenue: 0 }; m[i.name].qty += i.qty; m[i.name].revenue += +(((i.price || 0) * i.qty).toFixed(2)); }));
    return Object.values(m).sort((a, b) => b.qty - a.qty).slice(0, 6);
  }, [curr]);

  const workerStats = useMemo(() => {
    const m = {}; curr.forEach(d => { if (!m[d.userName]) m[d.userName] = { name: d.userName, deliveries: 0, profit: 0, revenue: 0 }; m[d.userName].deliveries++; d.items.forEach(i => { m[d.userName].revenue += (i.price || 0) * i.qty; m[d.userName].profit += ((i.price || 0) - (i.costPrice || 0)) * i.qty; }); });
    return Object.values(m).sort((a, b) => b.profit - a.profit).map(w => ({ ...w, profit: +w.profit.toFixed(2), revenue: +w.revenue.toFixed(2) }));
  }, [curr]);

  const abcAnalysis = useMemo(() => {
    const m = {}; curr.forEach(d => d.items.forEach(i => { if (!m[i.id]) m[i.id] = { id: i.id, name: i.name, code: i.code, revenue: 0, qty: 0 }; m[i.id].revenue += (i.price || 0) * i.qty; m[i.id].qty += i.qty; }));
    const sorted = Object.values(m).sort((a, b) => b.revenue - a.revenue);
    const totalRev = sorted.reduce((s, x) => s + x.revenue, 0);
    let run = 0;
    return sorted.map(x => { run += x.revenue; const pct = (run / totalRev) * 100; const cls = pct <= 80 ? "A" : pct <= 95 ? "B" : "C"; return { ...x, cls, pct: (x.revenue / totalRev) * 100 }; }).filter(x => x.revenue > 0);
  }, [curr]);

  const exportCSV = () => {
    const rows = [["ID", "Date", "Worker", "Type", "Note", "Product", "Qty", "Price", "Cost", "Total", "Profit"]];
    curr.forEach(d => d.items.forEach(i => rows.push([d.deliveryId, d.date, d.userName, d.type||"delivery", `"${d.note||""}"`, `"${i.name}"`, i.qty, i.price||0, i.costPrice||0, (i.price||0)*i.qty, ((i.price||0)-(i.costPrice||0))*i.qty])));
    const blob = new Blob(["\uFEFF" + rows.map(r => r.join(",")).join("\n")], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `Справка_${range}.csv`; a.click();
  };

  const margin = cStat.r > 0 ? (cStat.p / cStat.r * 100).toFixed(1) : "0.0";
  const trend = (cur, prv, isCount) => { const diff = cur - prv; const pct = prv ? (diff / prv) * 100 : 0; return diff === 0 || !prv ? null : <div style={{ fontSize: 11, fontWeight: 700, color: diff > 0 ? T.green : T.red, marginTop: 4 }}>{diff > 0 ? "▲" : "▼"} {Math.abs(pct).toFixed(1)}% ({diff > 0 ? "+" : ""}{isCount ? diff : fmt(diff)}) спрямо предх.</div>; };
  const ttSt = { background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, fontFamily: F, fontSize: 12, padding: "8px 12px" };
  const rangeBtnSt = (active) => ({ padding: "6px 14px", borderRadius: 8, border: `1px solid ${active ? T.primary : T.border}`, background: active ? T.primary : T.surface, color: active ? "#fff" : T.textSub, cursor: "pointer", fontFamily: F, fontSize: 12, fontWeight: 700 });

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", marginBottom: 16, gap: 14 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: T.textSub, marginRight: 8, fontFamily: F }}>ПЕРИОД:</div>
          {[["7d", "7 дни"], ["14d", "14 дни"], ["30d", "30 дни"], ["custom", "Произволен"]].map(([v, l]) => <button key={v} onClick={() => setRange(v)} style={rangeBtnSt(range === v)}>{l}</button>)}
          {range === "custom" && (
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginLeft: 8 }}>
              <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} style={{ padding: "5px 10px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 12, outline: "none" }} />
              <span style={{ color: T.textMute }}>-</span>
              <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} style={{ padding: "5px 10px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 12, outline: "none" }} />
            </div>
          )}
        </div>
        <button className="btn-hover" onClick={exportCSV} style={{ padding: "6px 14px", background: "#ECFDF5", border: "1px solid #10B981", color: "#10B981", borderRadius: 8, cursor: "pointer", fontFamily: F, fontSize: 12, fontWeight: 700 }}>📥 Експорт CSV</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14, marginBottom: 24 }}>
        {[{ l: "ДОСТАВКИ", v: cStat.c, u: "бр.", c: T.primary, bg: "#EEF2FF", tr: trend(cStat.c, pStat.c, true) }, { l: "ОБЩ ПРИХОД", v: fmt(cStat.r), u: "лв", c: T.text, bg: T.surface, tr: trend(cStat.r, pStat.r, false) }, { l: "ОБЩА ПЕЧАЛБА", v: fmt(cStat.p), u: "лв", c: T.green, bg: "#ECFDF5", tr: trend(cStat.p, pStat.p, false) }, { l: "СРЕДЕН МАРЖ", v: margin, u: "%", c: T.orange, bg: "#FFFBEB", tr: <div style={{ fontSize: 11, color: T.textSub, marginTop: 4 }}>Спрямо оборот</div> }].map(({ l, v, u, c, bg, tr }) => (
          <div key={l} style={{ background: bg, borderRadius: 16, padding: "16px 20px", border: `1px solid ${T.border}`, boxShadow: T.shadow }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: T.textSub, letterSpacing: .5, marginBottom: 6, fontFamily: F }}>{l}</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
              <span style={{ fontSize: 26, fontWeight: 800, color: c, fontFamily: F }}>{v}</span>
              <span style={{ fontSize: 12, color: T.textSub, fontWeight: 600 }}>{u}</span>
            </div>
            {tr}
          </div>
        ))}
      </div>

      <div style={{ background: T.surface, borderRadius: 16, padding: "24px 8px 16px", border: `1px solid ${T.border}`, marginBottom: 24, boxShadow: T.shadow }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: T.text, marginBottom: 14, paddingLeft: 16, fontFamily: F }}>📈 Детайлен тренд (Приход и Печалба)</div>
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={chartData} margin={{ top: 5, right: 24, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={T.border} />
            <XAxis dataKey="date" tick={{ fontSize: 11, fontFamily: F, fill: T.textMute }} />
            <YAxis tick={{ fontSize: 11, fontFamily: F, fill: T.textMute }} width={60} tickFormatter={v => `${v} лв`} />
            <Tooltip contentStyle={ttSt} formatter={(v, n) => [`${fmt(v)} лв`, n === "revenue" ? "Приход" : "Печалба"]} />
            <Legend formatter={v => v === "revenue" ? "Приход" : "Печалба"} wrapperStyle={{ fontFamily: F, fontSize: 12, paddingTop: 8 }} />
            <Line type="monotone" dataKey="revenue" stroke={T.primary} strokeWidth={2.5} dot={false} activeDot={{ r: 6 }} />
            <Line type="monotone" dataKey="profit" stroke={T.green} strokeWidth={2.5} dot={false} activeDot={{ r: 6 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }} className="grid-mobile-1">
        <div>
          <div style={{ fontSize: 15, fontWeight: 800, color: T.text, marginBottom: 14, fontFamily: F }}>🏆 Топ 6 Продукти (по обем)</div>
          <div style={{ background: T.surface, borderRadius: 16, padding: "24px 8px 16px", border: `1px solid ${T.border}`, boxShadow: T.shadow, height: 260 }}>
            {topProducts.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={topProducts} margin={{ top: 5, right: 10, left: -20, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 10, fontFamily: F, fill: T.textMute }} tickFormatter={v => v.substring(0, 10)} />
                  <YAxis tick={{ fontSize: 10, fontFamily: F, fill: T.textMute }} />
                  <Tooltip contentStyle={ttSt} />
                  <Bar dataKey="qty" fill={T.primary} radius={[6, 6, 0, 0]} name="Брой продадени" />
                </BarChart>
              </ResponsiveContainer>
            ) : <div style={{ padding: 40, textAlign: "center", color: T.textMute, fontSize: 13, fontFamily: F }}>Няма данни</div>}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800, color: T.text, marginBottom: 14, fontFamily: F }}>👥 Печалба по работник</div>
          <div style={{ background: T.surface, borderRadius: 16, padding: "24px 8px 16px", border: `1px solid ${T.border}`, boxShadow: T.shadow, height: 260 }}>
            {workerStats.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={workerStats} margin={{ top: 5, right: 10, left: -10, bottom: 5 }} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke={T.border} horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 10, fontFamily: F, fill: T.textMute }} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fontFamily: F, fill: T.text, fontWeight: 600 }} width={80} />
                  <Tooltip contentStyle={ttSt} formatter={v => `${fmt(v)} лв`} />
                  <Bar dataKey="profit" fill={T.green} radius={[0, 6, 6, 0]} name="Печалба" />
                </BarChart>
              </ResponsiveContainer>
            ) : <div style={{ padding: 40, textAlign: "center", color: T.textMute, fontSize: 13, fontFamily: F }}>Няма данни</div>}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 24, background: T.surface, borderRadius: 16, border: `1px solid ${T.border}`, boxShadow: T.shadow, padding: 20 }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: T.text, marginBottom: 6, fontFamily: F }}>📊 ABC Анализ на продуктите</div>
        <div style={{ fontSize: 12, color: T.textSub, marginBottom: 16, fontFamily: F }}>Групиране на база генериран приход (A: топ 80%, B: следващи 15%, C: последни 5%). Този анализ помага да идентифицирате кои продукти са жизненоважни за бизнеса ви.</div>
        {abcAnalysis.length > 0 ? (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 600 }}>
              <thead>
                <tr>
                  <th style={{ padding: "10px", textAlign: "left", fontSize: 11, color: T.textMute, borderBottom: `2px solid ${T.border}` }}>КЛАС</th>
                  <th style={{ padding: "10px", textAlign: "left", fontSize: 11, color: T.textMute, borderBottom: `2px solid ${T.border}` }}>ПРОДУКТ</th>
                  <th style={{ padding: "10px", textAlign: "right", fontSize: 11, color: T.textMute, borderBottom: `2px solid ${T.border}` }}>РЕАЛИЗАЦИЯ</th>
                  <th style={{ padding: "10px", textAlign: "right", fontSize: 11, color: T.textMute, borderBottom: `2px solid ${T.border}` }}>ПРИХОД</th>
                  <th style={{ padding: "10px", textAlign: "right", fontSize: 11, color: T.textMute, borderBottom: `2px solid ${T.border}` }}>% ОТ ОБЩОТО</th>
                </tr>
              </thead>
              <tbody>
                {abcAnalysis.map(a => (
                  <tr key={a.id} style={{ borderBottom: `1px solid ${T.border}` }}>
                    <td style={{ padding: "10px" }}><div style={{ background: a.cls === "A" ? "#ECFDF5" : a.cls === "B" ? "#FFFBEB" : "#FEF2F2", color: a.cls === "A" ? T.green : a.cls === "B" ? T.orange : T.red, width: 24, height: 24, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 12, fontFamily: F }}>{a.cls}</div></td>
                    <td style={{ padding: "10px", fontSize: 13, fontWeight: 600, color: T.text, fontFamily: F }}>{a.name} <span style={{ color: T.textMute, fontSize: 11, fontWeight: 500 }}>{a.code}</span></td>
                    <td style={{ padding: "10px", textAlign: "right", fontSize: 13, color: T.text, fontFamily: F }}>{a.qty}</td>
                    <td style={{ padding: "10px", textAlign: "right", fontSize: 13, fontWeight: 700, color: T.primary, fontFamily: F }}>{fmt(a.revenue)} лв</td>
                    <td style={{ padding: "10px", textAlign: "right", fontSize: 13, color: T.textSub, fontFamily: F }}>{a.pct.toFixed(2)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div style={{ padding: 20, textAlign: "center", color: T.textMute, fontSize: 13, fontFamily: F }}>Няма продажби за избрания период.</div>}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN APP
// ══════════════════════════════════════════════════════════════════════════════
export default function WarehouseApp() {
  const [darkMode, setDarkMode] = useState(() => { try { return localStorage.getItem(K.theme) === "dark"; } catch { return false; } });
  const theme = darkMode ? DARK : LIGHT;
  useEffect(() => { try { localStorage.setItem(K.theme, darkMode ? "dark" : "light"); } catch {} }, [darkMode]);

  // Default Supabase Config from user
  useEffect(() => {
    const current = JSON.parse(localStorage.getItem(K.settings) || "{}");
    if (!current.supabaseUrl || !current.supabaseKey) {
      const updated = { 
        ...current, 
        supabaseUrl: "https://zbeydsbzuodgscnfdpuw.supabase.co", 
        supabaseKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpiZXlkc2J6dW9kZ3NjbmZkcHV3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQzODE5NDcsImV4cCI6MjA4OTk1Nzk0N30.g9xhnHQHyhW1KNhVsL9s5F8qfrw3opKcTYfK7LJssMw" 
      };
      localStorage.setItem(K.settings, JSON.stringify(updated));
    }
  }, []);

  const [currentUser, setCurrentUser] = useState(null);
  const [products, setProducts] = useState([]);
  const [deliveries, setDeliveries] = useState([]);
  const [view, setView] = useState("dashboard");
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState([]);
  const [cartQtys, setCartQtys] = useState({});
  const [receipt, setReceipt] = useState(null);
  const [toast, setToast] = useState(null);
  const [editProduct, setEditProduct] = useState(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showWorkers, setShowWorkers] = useState(false);
  const [alertMode, setAlertMode] = useState(null);
  const [showReport, setShowReport] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showWaste, setShowWaste] = useState(false);
  const [showStockTake, setShowStockTake] = useState(false);
  const [clients, setClients] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [showClients, setShowClients] = useState(false);
  const [showSuppliers, setShowSuppliers] = useState(false);
  const [lastSync, setLastSync] = useState(Date.now());
  const [priceLoading, setPriceLoading] = useState(false);
  const [showRecap, setShowRecap] = useState(false);
  const [confirmAction, setConfirmAction] = useState(null);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [supabaseLoaded, setSupabaseLoaded] = useState(false);

  useEffect(() => {
    if (window.supabase) { setSupabaseLoaded(true); return; }
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
    script.async = true;
    script.onload = () => setSupabaseLoaded(true);
    document.body.appendChild(script);
  }, []);

  useEffect(() => {
    sget("onboarding-done").then(v => { if (!v) setShowOnboarding(true); });
  }, []);

  const finishOnboarding = async () => { setShowOnboarding(false); await sset("onboarding-done", true); };

  const migrateToSupabase = async () => {
    const sb = getSupabase();
    if (!sb) return showToast("Supabase не е конфигуриран", "error");
    showToast("Миграцията започна...", "info");
    try {
      const keys = Object.values(K).concat(["onboarding-done"]);
      for (const k of keys) {
        const v = JSON.parse(localStorage.getItem(k));
        if (v) await sb.from("app_data").upsert({ key: k, value: v }, { onConflict: "key" });
      }
      showToast("Данните са качени успешно! 🎉", "success");
      loadAll();
    } catch (e) { showToast("Грешка при миграцията", "error"); }
  };
  window._migrate = migrateToSupabase;


  const [settings, setSettings] = useState({ telegramToken: "", telegramChat: "" });
  const [showSettings, setShowSettings] = useState(false);
  const [isOffline, setIsOffline] = useState(typeof navigator !== "undefined" && !navigator.onLine);

  const pollRef = useRef();
  const priceFetchedRef = useRef(false);
  const reportShownRef = useRef(false);
  const prevAlertKeyRef = useRef("");
  const notifRef = useRef(null);
  const recapShownRef = useRef(false);
  const lastStateRef = useRef(null);

  const isMobile = useIsMobile();
  const isOwner = currentUser?.role === "owner";
  const canEdit = canDo(currentUser, "edit_products") || isOwner;
  const showToast = useCallback((msg, type = "info", undoable = false) => setToast({ msg, type, undoable }), []);

  const handleUndo = async () => {
    if (!lastStateRef.current) return;
    const { products: p, deliveries: d, clients: c, waste: w, stocktakes: st } = lastStateRef.current;
    if (p) { setProducts(p); await sset(K.products, p); }
    if (d) { setDeliveries(d); await sset(K.deliveries, d); }
    if (c) { setClients(c); await sset(K.clients, c); }
    if (w) await sset(K.waste, w);
    if (st) await sset(K.stocktakes, st);
    lastStateRef.current = null;
    setToast(null);
    showToast("Действието бе отменено ✓", "info");
  };

  const saveState = () => { lastStateRef.current = { products: [...products], deliveries: [...deliveries] }; };

  useEffect(() => {
    const handler = (e) => {
      const isInput = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName);
      if (e.altKey && e.key >= "1" && e.key <= "6") {
        const idx = parseInt(e.key) - 1;
        const v = [
          {id:"dashboard"}, {id:"inventory"}, 
          {id: currentUser?.role === "worker" ? "request" : "delivery"},
          {id:"history"}, {id:"stats"}
        ][idx];
        if (v) setView(v.id);
      }
      if (e.ctrlKey && e.key === "f") {
        e.preventDefault(); setView("inventory");
        setTimeout(() => document.getElementById("search-input")?.focus(), 50);
      }
      if (e.key === "Escape") {
        setShowAddModal(false); setEditProduct(null); setReceipt(null); setShowWorkers(false);
        setAlertMode(null); setShowReport(false); setShowNotifications(false); setShowWaste(false);
        setShowStockTake(false); setShowClients(false); setShowSuppliers(false); setShowSettings(false);
        setConfirmAction(null);
      }
      if (e.ctrlKey && e.key === "z" && !isInput) { e.preventDefault(); handleUndo(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setView, currentUser]);

  const loadAll = useCallback(async () => {
    const [p, d, c, s, t, set] = await Promise.all([sget(K.products), sget(K.deliveries), sget(K.clients), sget(K.suppliers), sget(K.templates), sget(K.settings)]);
    if (p) { const migrated = p.map(pr => ({ ...pr, category: pr.category || "other" })); setProducts(migrated); }
    else { await sset(K.products, SEED_PRODUCTS); setProducts(SEED_PRODUCTS); }
    if (d) setDeliveries(d);
    if (c) setClients(c);
    if (s) setSuppliers(s);
    if (t) setTemplates(t);
    if (set) setSettings(set);
    setLastSync(Date.now());
  }, []);

  useEffect(() => {
    if (!products.length) return;
    const alertKey = products.filter(p => p.qty === 0 || p.qty <= p.minQty).map(p => `${p.id}:${p.qty}`).join("|");
    if (prevAlertKeyRef.current && alertKey !== prevAlertKeyRef.current) {
      const prev = new Set(prevAlertKeyRef.current.split("|").map(x => x.split(":")[0]));
      const curr = new Set(alertKey.split("|").map(x => x.split(":")[0]));
      const newAlerts = [...curr].filter(id => !prev.has(id)).length;
      if (newAlerts > 0) showToast(`⚠️ ${newAlerts} нов(и) продукт(и) с нисък запас!`, "error");
    }
    prevAlertKeyRef.current = alertKey;
  }, [products, showToast]);

  useEffect(() => {
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => { window.removeEventListener("online", handleOnline); window.removeEventListener("offline", handleOffline); };
  }, []);

  useEffect(() => {
    const handler = (e) => { if (notifRef.current && !notifRef.current.contains(e.target)) setShowNotifications(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    if (!currentUser) return;
    loadAll();
    pollRef.current = setInterval(loadAll, 5000);
    return () => clearInterval(pollRef.current);
  }, [currentUser, loadAll]);

  useEffect(() => {
    if (!priceFetchedRef.current && products.length > 0 && products.every(p => !p.price)) {
      priceFetchedRef.current = true;
      refreshPricesWithList(products);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products]);

  useEffect(() => {
    if (currentUser && products.length > 0 && deliveries && !recapShownRef.current) {
      recapShownRef.current = true;
      setShowRecap(true);
    }
  }, [currentUser, products, deliveries]);

  useEffect(() => {
    if (!isOwner) return;
    const interval = setInterval(() => {
      const now = new Date();
      if (now.getHours() === 16 && now.getMinutes() === 0 && !reportShownRef.current) { reportShownRef.current = true; setShowReport(true); }
    }, 30000);
    return () => clearInterval(interval);
  }, [isOwner]);

  const handleEmailDigest = () => {
    const last7 = deliveries.filter(d => (Date.now() - new Date(d.date)) / 86400000 <= 7);
    const byWorker = {};
    last7.forEach(d => { if (!byWorker[d.userId]) byWorker[d.userId] = { name: d.userName, deliveries: 0, revenue: 0, profit: 0 }; byWorker[d.userId].deliveries++; d.items.forEach(i => { byWorker[d.userId].revenue += (i.price || 0) * i.qty; byWorker[d.userId].profit += ((i.price || 0) - (i.costPrice || 0)) * i.qty; }); });
    const total = { revenue: 0, profit: 0 };
    last7.forEach(d => d.items.forEach(i => { total.revenue += (i.price || 0) * i.qty; total.profit += ((i.price || 0) - (i.costPrice || 0)) * i.qty; }));
    const lines = Object.values(byWorker).map(w => `${w.name}: ${w.deliveries} дост. | ${fmt(w.revenue)} лв | печ. ${fmt(w.profit)} лв`).join("\n");
    const emailContent = `Склад PRO - Седмичен Отчет\n\nДоставки (7 дни): ${last7.length}\nПриход: ${fmt(total.revenue)} лв\nПечалба: ${fmt(total.profit)} лв\n\nПО РАБОТНИЦИ:\n${lines || "Няма данни"}\n\nАвтоматично генериран от Склад PRO.`;
    window.open(`mailto:?subject=${encodeURIComponent("Склад PRO Седмичен Отчет")}&body=${encodeURIComponent(emailContent)}`);
  };

  const saveProducts = async (updated) => { await sset(K.products, updated); setLastSync(Date.now()); };

  const refreshPricesWithList = async (list) => {
    setPriceLoading(true); showToast("Зареждане на AI цени...", "info");
    try {
      const prices = await fetchPricesAI(list);
      const updated = list.map((p, i) => ({ ...p, price: typeof prices.sell?.[i] === "number" && prices.sell[i] > 0 ? prices.sell[i] : p.price, costPrice: typeof prices.cost?.[i] === "number" && prices.cost[i] > 0 ? prices.cost[i] : p.costPrice }));
      setProducts(updated); await saveProducts(updated); showToast("Цените са обновени ✓", "success");
    } catch { showToast("Грешка при зареждане на цени", "error"); }
    setPriceLoading(false);
  };

  const updateQty = async (id, delta) => {
    if (!canEdit) return;
    const updated = products.map(p => p.id === id ? { ...p, qty: Math.max(0, p.qty + delta) } : p);
    setProducts(updated); await saveProducts(updated);
  };

  const deleteProduct = (id) => {
    if (!canEdit) return;
    setConfirmAction({ title: "🗑 Изтриване на продукт", message: "Сигурни ли сте, че искате да изтриете този продукт? Действието е необратимо.", danger: true,
      onConfirm: async () => {
        saveState();
        const updated = products.filter(p => p.id !== id);
        setProducts(updated); await saveProducts(updated);
        showToast("Продуктът е изтрит", "info", true);
        setConfirmAction(null);
      }
    });
  };

  const saveProduct = async (form) => {
    if (!canEdit) return;
    const updated = editProduct?.id ? products.map(p => p.id === editProduct.id ? { ...p, ...form } : p) : [...products, { ...form, id: generateId() }];
    setProducts(updated); await saveProducts(updated);
    showToast(editProduct?.id ? "Продуктът е обновен ✓" : "Продуктът е добавен ✓", "success");
    setEditProduct(null); setShowAddModal(false);
  };

  const handleWaste = async (form) => {
    const p = products.find(x => x.id === form.productId);
    if (!p) return;
    const qty = parseFloat(form.qty);
    const updated = products.map(x => x.id === p.id ? { ...x, qty: Math.max(0, x.qty - qty) } : x);
    setProducts(updated); await saveProducts(updated);
    const wasteLog = { id: generateId(), date: new Date().toISOString(), productId: p.id, productName: p.name, qty, reason: form.reason, note: form.note, costValue: qty * (p.costPrice || 0) };
    const w = await sget(K.waste) || []; await sset(K.waste, [...w, wasteLog]);
    showToast(`Отписани ${qty} ${p.unit} ${p.name}`, "info");
    setShowWaste(false);
  };

  const handleStockTake = async (diffs) => {
    if (!diffs.length) { setShowStockTake(false); return; }
    const updated = [...products];
    const takeLog = { id: generateId(), date: new Date().toISOString(), diffs: [] };
    diffs.forEach(d => {
      const idx = updated.findIndex(x => x.id === d.productId);
      if (idx > -1) { updated[idx] = { ...updated[idx], qty: d.newQty }; takeLog.diffs.push(d); }
    });
    setProducts(updated); await saveProducts(updated);
    const st = await sget(K.stocktakes) || []; await sset(K.stocktakes, [...st, takeLog]);
    showToast(`Инвентаризация завършена! Променени ${diffs.length} продукта`, "success");
    setShowStockTake(false);
  };

  const addToCart = (product, qty) => {
    setCart(c => c.find(x => x.id === product.id) ? c : [...c, product]);
    setCartQtys(q => ({ ...q, [product.id]: qty }));
  };
  const removeFromCart = (id) => { setCart(c => c.filter(x => x.id !== id)); setCartQtys(q => { const n = { ...q }; delete n[id]; return n; }); };

  const confirmDelivery = async (meta = {}) => {
    if (!cart.length) return showToast("Добавете продукти!", "error");
    const items = cart.map(p => ({ ...products.find(x => x.id === p.id), qty: cartQtys[p.id] || 1 }));
    for (const item of items) { const prod = products.find(p => p.id === item.id); if (item.qty > prod.qty) return showToast(`Недостатъчно: ${prod.name}`, "error"); }
    const updated = products.map(p => { const item = items.find(i => i.id === p.id); return item ? { ...p, qty: Math.max(0, p.qty - item.qty) } : p; });
    
    if (meta.discountPct > 0) {
      const mult = 1 - (meta.discountPct / 100);
      items.forEach(i => { i.price = +( (i.price || 0) * mult ).toFixed(2); });
    }

    const deliveryId = generateId();
    const clientName = meta.clientId ? clients.find(c => c.id === meta.clientId)?.name : "";
    const newDelivery = { id: deliveryId, deliveryId, userId: currentUser.id, userName: currentUser.name, date: new Date().toISOString(), items, ...meta, clientName };
    const updatedDeliveries = [...(deliveries || []), newDelivery];
    setProducts(updated); await saveProducts(updated);
    setDeliveries(updatedDeliveries); await sset(K.deliveries, updatedDeliveries);

    if (settings?.telegramToken && settings?.telegramChat && !isOffline) {
      const toAlert = updated.filter(p => p.qty <= p.minQty && products.find(op => op.id === p.id)?.qty > p.minQty);
      toAlert.forEach(p => {
        const text = `⚠️ Нисък запас!\n\nПродукт: ${p.name}\nКод: ${p.code}\nОставащи: ${p.qty} ${p.unit}\nМинимум: ${p.minQty} ${p.unit}`;
        fetch(`https://api.telegram.org/bot${settings.telegramToken}/sendMessage?chat_id=${settings.telegramChat}&text=${encodeURIComponent(text)}`).catch(()=>console.log("Telegram alert failed"));
      });
    }

    setReceipt({ ...newDelivery }); setCart([]); setCartQtys({});
    showToast(`Доставка #${deliveryId} завършена`, "success", true);
  };

  const handlePrint = (r) => {
    const rec = r || receipt; if (!rec) return;
    const isReq = rec.type === "request";
    const total = rec.items.reduce((s, i) => s + (i.price || 0) * i.qty, 0);
    const lines = rec.items.map(i => `${(i.code || "").padEnd(8)} ${i.name.substring(0, 20).padEnd(20)} ${String(i.qty).padStart(4)} ${(i.unit || "").padEnd(4)} ${(i.price > 0 && !isReq) ? fmt(i.price * i.qty) + " лв" : "  —"}`).join("\n");
    const gpsStr = rec.location ? `GPS      : ${rec.location.lat.toFixed(4)}, ${rec.location.lng.toFixed(4)}\n` : "";
    const clientStr = rec.clientName ? `Клиент   : ${rec.clientName}\n` : "";
    const noteStr = rec.note ? `Бележка  : ${rec.note}\n` : "";
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=DELIVERY_${rec.deliveryId}`;
    const title = isReq ? "ВЪТРЕШНА ЗАЯВКА" : "СКЛАДОВА РАЗПИСКА";
    const totLine = isReq ? "" : `--------------------------------\nОБЩО     : ${total > 0 ? fmt(total) + " лв" : "—"}\n`;
    const content = `================================\n      ${title}\n================================\nНомер    : #${rec.deliveryId}\nОтговорен: ${rec.userName}\nДата     : ${fmtDate(rec.date)}\n${clientStr}${gpsStr}${noteStr}--------------------------------\n${lines}\n${totLine}================================\n<div style="text-align:center;margin-top:16px"><img src="${qrUrl}" alt="QR" style="width:100px;height:100px;border-radius:10px" /></div>`;
    const w = window.open("", "_blank", "width=440,height=750");
    w.document.write(`<pre style="font-family:monospace;font-size:13px;padding:24px;line-height:1.6;margin:0">${content}</pre>`);
    w.document.close(); w.print();
  };

  const handlePrintReport = () => {
    const todayD = deliveries.filter(d => d.date.startsWith(todayStr()));
    const byWorker = {};
    todayD.forEach(d => { if (!byWorker[d.userId]) byWorker[d.userId] = { name: d.userName, deliveries: 0, revenue: 0, profit: 0 }; byWorker[d.userId].deliveries++; d.items.forEach(i => { byWorker[d.userId].revenue += (i.price || 0) * i.qty; byWorker[d.userId].profit += ((i.price || 0) - (i.costPrice || 0)) * i.qty; }); });
    const total = { revenue: 0, profit: 0 };
    const lines = Object.values(byWorker).map(w => { total.revenue += w.revenue; total.profit += w.profit; return `${w.name.padEnd(20)} ${String(w.deliveries).padStart(4)} дост.  ${fmt(w.revenue).padStart(8)} лв  печалба: ${fmt(w.profit)} лв`; }).join("\n");
    const content = `================================\n       ДНЕВЕН ОТЧЕТ\n================================\nДата: ${new Date().toLocaleDateString("bg-BG")}\n--------------------------------\n${lines || "Няма доставки"}\n--------------------------------\nОБЩ ПРИХОД  : ${fmt(total.revenue)} лв\nОБЩА ПЕЧАЛБА: ${fmt(total.profit)} лв\n================================`;
    const w = window.open("", "_blank", "width=500,height=500");
    w.document.write(`<pre style="font-family:monospace;font-size:13px;padding:24px;line-height:1.8">${content}</pre>`);
    w.document.close(); w.print();
  };

  const filtered = products.filter(p => { const q = search.toLowerCase(); return !q || fuzzyMatch(q, p.name) || p.code.toLowerCase().includes(q); });
  const alertCount = products.filter(p => p.qty === 0 || p.qty <= p.minQty).length;

  const VIEWS = [
    { id: "dashboard", label: "🏠 Начало", short: "🏠" },
    { id: "inventory", label: "📦 Инвентар", short: "📦" },
    ...(currentUser?.role === "worker" ? [{ id: "request", label: "🛒 Заявка", short: "🛒" }] : [{ id: "delivery", label: "🚚 Доставка", short: "🚚" }]),
    { id: "history", label: "📋 История", short: "📋" },
    ...(canDo(currentUser, "view_stats") || isOwner ? [{ id: "stats", label: "📈 Статистики", short: "📈" }] : []),
  ];

  const handleLogin = (user) => { setCurrentUser(user); recapShownRef.current = false; };

  if (!currentUser) return (
    <ThemeCtx.Provider value={theme}>
      <style>{getCSS(theme)}</style>
      <LoginScreen onLogin={handleLogin} darkMode={darkMode} setDarkMode={setDarkMode} />
    </ThemeCtx.Provider>
  );

  return (
    <ThemeCtx.Provider value={theme}>
      <style>{getCSS(theme)}</style>
      <div style={{ minHeight: "100vh", background: theme.bg, fontFamily: F, color: theme.text }}>
        <header style={{ background: theme.surface, borderBottom: `1px solid ${theme.border}`, padding: "0 20px", display: "flex", alignItems: "center", gap: 8, height: 60, position: "sticky", top: 0, zIndex: 100, boxShadow: "0 1px 8px rgba(0,0,0,.06)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginRight: 8 }}>
            <div style={{ width: 32, height: 32, background: `linear-gradient(135deg,${theme.primary},${theme.primaryD})`, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, color: "#fff", fontWeight: 800 }}>⬡</div>
            <div style={{ fontSize: 15, fontWeight: 800, color: theme.text, letterSpacing: .3 }} className={isMobile ? "hide-mobile" : ""}>Склад PRO</div>
          </div>
          {!isMobile && VIEWS.map(v => (
            <button key={v.id} className="btn-hover" onClick={() => setView(v.id)} style={{
              padding: "7px 14px", background: view === v.id ? `linear-gradient(135deg,${theme.primary},${theme.primaryD})` : "transparent",
              color: view === v.id ? "#fff" : theme.textSub, border: view === v.id ? "none" : `1px solid ${theme.border}`,
              borderRadius: 10, cursor: "pointer", fontFamily: F, fontSize: 13, fontWeight: 700, boxShadow: view === v.id ? `0 4px 12px ${theme.primary}44` : "none", position: "relative",
            }}>
              {v.label}
              {v.id === "delivery" && cart.length > 0 && (
                <span style={{ position: "absolute", top: -6, right: -6, background: theme.red, color: "#fff", borderRadius: "50%", width: 18, height: 18, fontSize: 10, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800 }}>{cart.length}</span>
              )}
            </button>
          ))}
          {!isMobile && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, background: theme.bg, borderRadius: 10, padding: "6px 10px", border: `1px solid ${theme.border}` }}>
              <span style={{ fontSize: 14 }}>{isOwner ? "👑" : currentUser.role === "manager" ? "🔑" : "👤"}</span>
              <span style={{ fontSize: 13, color: theme.text, fontWeight: 700 }}>{currentUser.name}</span>
            </div>
          )}
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={() => setDarkMode(d => !d)} className="btn-hover" style={{ padding: "7px 11px", background: theme.bg, border: `1px solid ${theme.border}`, borderRadius: 10, cursor: "pointer", fontSize: 16 }}>{darkMode ? "☀️" : "🌙"}</button>
            <div ref={notifRef} style={{ position: "relative" }}>
              <button onClick={() => setShowNotifications(v => !v)} className="btn-hover" style={{ position: "relative", padding: "7px 11px", background: alertCount > 0 ? "#FFF1F2" : theme.bg, border: `1px solid ${alertCount > 0 ? "#FECACA" : theme.border}`, borderRadius: 10, cursor: "pointer", fontSize: 16 }}>
                <span className={alertCount > 0 ? "bell-shake" : ""}>🔔</span>
                {alertCount > 0 && <span style={{ position: "absolute", top: -5, right: -5, background: theme.red, color: "#fff", borderRadius: "50%", width: 17, height: 17, fontSize: 10, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800 }}>{alertCount}</span>}
              </button>
              {showNotifications && <NotificationPanel products={products} onClose={() => setShowNotifications(false)} />}
            </div>
            {!isMobile && isOwner && (
              <>
                <button className="btn-hover" onClick={() => setShowReport(true)} style={{ padding: "7px 14px", background: "#ECFDF5", border: "1px solid #A7F3D0", borderRadius: 10, cursor: "pointer", fontFamily: F, fontSize: 12, color: "#065F46", fontWeight: 700 }}>📊 Отчет</button>
                <button className="btn-hover" onClick={handleEmailDigest} style={{ padding: "7px 14px", background: "#EFF6FF", border: "1px solid #BFDBFE", borderRadius: 10, cursor: "pointer", fontFamily: F, fontSize: 12, color: "#1D4ED8", fontWeight: 700 }}>✉️ Email</button>
                <button className="btn-hover" onClick={() => setShowSettings(true)} style={{ padding: "7px 14px", background: theme.bg, border: `1px solid ${theme.border}`, borderRadius: 10, cursor: "pointer", fontFamily: F, fontSize: 12, color: theme.textSub, fontWeight: 600 }}>⚙️</button>
                <button className="btn-hover" onClick={() => setShowClients(true)} style={{ padding: "7px 14px", background: theme.bg, border: `1px solid ${theme.border}`, borderRadius: 10, cursor: "pointer", fontFamily: F, fontSize: 12, color: theme.textSub, fontWeight: 600 }}>🤝</button>
                <button className="btn-hover" onClick={() => setShowSuppliers(true)} style={{ padding: "7px 14px", background: theme.bg, border: `1px solid ${theme.border}`, borderRadius: 10, cursor: "pointer", fontFamily: F, fontSize: 12, color: theme.textSub, fontWeight: 600 }}>🏭</button>
                <button className="btn-hover" onClick={() => setShowWorkers(true)} style={{ padding: "7px 14px", background: theme.bg, border: `1px solid ${theme.border}`, borderRadius: 10, cursor: "pointer", fontFamily: F, fontSize: 12, color: theme.textSub, fontWeight: 600 }}>👥</button>
              </>
            )}
            {!isMobile && <button className="btn-hover" onClick={() => setCurrentUser(null)} style={{ padding: "7px 14px", background: theme.bg, border: `1px solid ${theme.border}`, borderRadius: 10, cursor: "pointer", fontFamily: F, fontSize: 12, color: theme.textSub, fontWeight: 600 }}>Изход</button>}
            {isMobile && <button onClick={() => setMobileMenu(v => !v)} style={{ padding: "7px 11px", background: theme.bg, border: `1px solid ${theme.border}`, borderRadius: 10, cursor: "pointer", fontSize: 16 }}>☰</button>}
            {!isMobile && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: theme.textMute, fontWeight: 500, whiteSpace: "nowrap" }}>
                {isOffline ? <span style={{ color: theme.red, fontWeight: 700 }}>🔴 Офлайн</span> : <span style={{ color: theme.green }}>🟢 Онлайн</span>}
                <div>🔄 {new Date(lastSync).toLocaleTimeString("bg-BG")}</div>
              </div>
            )}
          </div>
        </header>
        {isMobile && mobileMenu && (
          <div className="slide-down" style={{ background: theme.surface, borderBottom: `1px solid ${theme.border}`, padding: "12px 20px", display: "flex", flexDirection: "column", gap: 8 }}>
            {VIEWS.map(v => (
              <button key={v.id} onClick={() => { setView(v.id); setMobileMenu(false); }} style={{ padding: "10px 16px", background: view === v.id ? `${theme.primary}15` : "transparent", color: view === v.id ? theme.primary : theme.text, border: "none", borderRadius: 10, cursor: "pointer", fontFamily: F, fontSize: 14, fontWeight: 700, textAlign: "left" }}>{v.label}</button>
            ))}
            <div style={{ borderTop: `1px solid ${theme.border}`, paddingTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
              <div style={{ fontSize: 13, color: theme.text, fontWeight: 700, padding: "6px 0" }}>{isOwner ? "👑" : "👤"} {currentUser.name}</div>
              {isOwner && <button onClick={() => { setShowReport(true); setMobileMenu(false); }} style={{ padding: "6px 12px", background: "#ECFDF5", border: "1px solid #A7F3D0", borderRadius: 8, cursor: "pointer", fontFamily: F, fontSize: 12, color: "#065F46", fontWeight: 700 }}>📊</button>}
              {isOwner && <button onClick={() => { setShowWorkers(true); setMobileMenu(false); }} style={{ padding: "6px 12px", background: theme.bg, border: `1px solid ${theme.border}`, borderRadius: 8, cursor: "pointer", fontFamily: F, fontSize: 12, color: theme.textSub, fontWeight: 600 }}>👥</button>}
              <button onClick={() => setCurrentUser(null)} style={{ padding: "6px 12px", background: theme.bg, border: `1px solid ${theme.border}`, borderRadius: 8, cursor: "pointer", fontFamily: F, fontSize: 12, color: theme.textSub, fontWeight: 600 }}>Изход</button>
            </div>
          </div>
        )}
        <main style={{ padding: "20px", maxWidth: 1280, margin: "0 auto" }}>
          {view === "dashboard" && <DashboardView products={products} deliveries={deliveries} onNavigate={setView} />}
          {view === "inventory" && (
            <InventoryView products={filtered} allProducts={products} search={search} setSearch={setSearch} isOwner={canEdit}
              onAdd={() => { setEditProduct(null); setShowAddModal(true); }} onEdit={p => setEditProduct(p)} onDelete={deleteProduct}
              onQtyChange={updateQty} priceLoading={priceLoading} onAlertMode={setAlertMode} onRefreshPrices={() => refreshPricesWithList(products)}
              onStockTake={() => setShowStockTake(true)} onWaste={() => setShowWaste(true)} onCompare={() => setShowCompare(true)} deliveries={deliveries} />
          )}
          {view === "request" && <RequestView products={products} cart={cart} setCart={setCart} cartQtys={cartQtys} setCartQtys={setCartQtys} addToCart={addToCart} removeFromCart={removeFromCart} onConfirm={confirmDelivery} />}
          {view === "delivery" && <DeliveryView products={products} cart={cart} setCart={setCart} cartQtys={cartQtys} setCartQtys={setCartQtys} addToCart={addToCart} removeFromCart={removeFromCart} onConfirm={confirmDelivery} clients={clients} templates={templates} onSaveTemplate={async t => { const up = [...templates, t]; setTemplates(up); await sset(K.templates, up); showToast("Шаблонът е запазен", "success"); }} />}
          {view === "history" && <HistoryView deliveries={deliveries} onViewReceipt={r => setReceipt(r)} currentUser={currentUser} />}
          {view === "stats" && (canDo(currentUser, "view_stats") || isOwner) && <StatsView deliveries={deliveries} products={products} />}
        </main>
      </div>

      {(showAddModal || editProduct) && canEdit && <ProductModal product={editProduct || null} deliveries={deliveries} onSave={saveProduct} onClose={() => { setShowAddModal(false); setEditProduct(null); }} />}
      <ReceiptModal receipt={receipt} onClose={() => setReceipt(null)} onPrint={() => handlePrint(receipt)} />
      {alertMode && <StockAlertModal products={products} mode={alertMode} onClose={() => setAlertMode(null)} />}
      {showWaste && isOwner && <WasteModal products={products} onSave={handleWaste} onClose={() => setShowWaste(false)} />}
      {showCompare && isOwner && <CompareModal products={products} onClose={() => setShowCompare(false)} />}
      {showStockTake && isOwner && <StockTakeModal products={products} onSave={handleStockTake} onClose={() => setShowStockTake(false)} />}
      {showSettings && isOwner && <SettingsModal settings={settings} onSave={async s => { setSettings(s); await sset(K.settings, s); setShowSettings(false); showToast("Настройките са запазени ✓", "success"); }} onClose={() => setShowSettings(false)} />}
      {showClients && isOwner && <ContactBrowserModal type="client" contacts={clients} onSave={async c => { const up = clients.find(x=>x.id===c.id) ? clients.map(x=>x.id===c.id?c:x) : [...clients, c]; setClients(up); await sset(K.clients, up); }} onDelete={async id => { const up = clients.filter(x=>x.id!==id); setClients(up); await sset(K.clients, up); }} onClose={() => setShowClients(false)} />}
      {showSuppliers && isOwner && <ContactBrowserModal type="supplier" contacts={suppliers} onSave={async s => { const up = suppliers.find(x=>x.id===s.id) ? suppliers.map(x=>x.id===s.id?s:x) : [...suppliers, s]; setSuppliers(up); await sset(K.suppliers, up); }} onDelete={async id => { const up = suppliers.filter(x=>x.id!==id); setSuppliers(up); await sset(K.suppliers, up); }} onClose={() => setShowSuppliers(false)} />}
      {showWorkers && isOwner && <ManageWorkersModal onClose={() => setShowWorkers(false)} />}
      {showReport && isOwner && <DailyReportModal deliveries={deliveries} onClose={() => setShowReport(false)} onPrint={handlePrintReport} />}
      {showRecap && <LoginRecapModal currentUser={currentUser} deliveries={deliveries} products={products} onClose={() => setShowRecap(false)} />}
      {confirmAction && <ConfirmModal title={confirmAction.title} message={confirmAction.message} danger={confirmAction.danger} onConfirm={confirmAction.onConfirm} onCancel={() => setConfirmAction(null)} />}
      {toast && <Toast msg={toast.msg} type={toast.type} undoable={toast.undoable} onUndo={handleUndo} onClose={() => setToast(null)} />}
      {isMobile && !showAddModal && !editProduct && !receipt && <QuickActionsFAB onAction={a => {
        if (a === "add") setShowAddModal(true);
        if (a === "delivery") setView("delivery");
        if (a === "search") { setView("inventory"); setTimeout(() => document.getElementById("search-input")?.focus(), 100); }
      }} />}
      {showOnboarding && <OnboardingModal onClose={finishOnboarding} />}
    </ThemeCtx.Provider>
  );
}