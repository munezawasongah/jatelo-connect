import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../i18n.js';
import { getToken, actingTenant } from '../api.js';

// ───────── Icons (stroke, 18px) ─────────
const P = {
  home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  live: 'M5 12a7 7 0 0 1 14 0M8.5 12a3.5 3.5 0 0 1 7 0M12 12v.01M2 12a10 10 0 0 1 20 0',
  router: 'M3 14h18v6H3zM7 17h.01M11 17h.01M8 10a6 6 0 0 1 8 0M5.5 7.5a9.5 9.5 0 0 1 13 0',
  ticket: 'M4 7h16v3a2 2 0 0 0 0 4v3H4v-3a2 2 0 0 0 0-4zM10 7v10',
  box: 'M4 8l8-4 8 4v8l-8 4-8-4zM4 8l8 4 8-4M12 12v8',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M17 4a4 4 0 0 1 0 7M22 21a6 6 0 0 0-4-5.6',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  store: 'M4 10v10h16V10M3 10l2-6h14l2 6zM9 20v-6h6v6',
  wallet: 'M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7l13-4v4M17 14h.01',
  inbox: 'M3 13h5l1 3h6l1-3h5M5 5h14l2 8v6H3v-6z',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  cog: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  building: 'M4 21V5l8-3 8 3v16M9 21v-5h6v5M8 9h.01M12 9h.01M16 9h.01M8 13h.01M12 13h.01M16 13h.01',
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'M6 6l12 12M18 6L6 18',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  plus: 'M12 5v14M5 12h14',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  print: 'M6 9V3h12v6M6 18H4v-7h16v7h-2M8 14h8v7H8z',
  download: 'M12 3v12M7 10l5 5 5-5M4 21h16',
  power: 'M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
};
export function Icon({ name, size = 18 }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={P[name]} />
    </svg>
  );
}

// ───────── Toasts ─────────
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((text, kind = 'ok') => {
    const id = Math.random();
    setItems((x) => [...x, { id, text, kind }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((i) => <div key={i.id} className={`toast ${i.kind === 'bad' ? 'bad' : ''}`}>{i.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

// ───────── Dialogs ─────────
function useEscape(onClose) {
  useEffect(() => {
    const f = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, [onClose]);
}

export function Modal({ title, onClose, children, footer, wide }) {
  useEscape(onClose);
  const { t } = useI18n();
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`dialog ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header><h2>{title}</h2><button className="btn quiet" onClick={onClose} aria-label={t('close')}><Icon name="close" /></button></header>
        <div className="body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

export function Drawer({ title, onClose, children, actions }) {
  useEscape(onClose);
  const { t } = useI18n();
  return (
    <>
      <div className="overlay" onMouseDown={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={title}>
        <header><h2>{title}</h2><div className="row">{actions}<button className="btn quiet" onClick={onClose} aria-label={t('close')}><Icon name="close" /></button></div></header>
        <div className="body">{children}</div>
      </aside>
    </>
  );
}

/** Button that asks for confirmation in a small dialog before running. */
export function ConfirmButton({ question, onConfirm, children, className = 'btn', danger }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { t } = useI18n();
  return (
    <>
      <button className={className} onClick={() => setOpen(true)} type="button">{children}</button>
      {open && (
        <Modal title={t('confirm')} onClose={() => setOpen(false)} footer={<>
          <button className="btn" onClick={() => setOpen(false)}>{t('cancel')}</button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} disabled={busy}
            onClick={async () => { setBusy(true); try { await onConfirm(); setOpen(false); } finally { setBusy(false); } }}>{children}</button>
        </>}>
          <p style={{ margin: 0 }}>{question}</p>
        </Modal>
      )}
    </>
  );
}

// ───────── Form bits ─────────
export function Field({ label, hint, error, children, full, optional }) {
  const { t } = useI18n();
  return (
    <label className={`field ${full ? 'full' : ''}`}>
      <span>{label}{optional && <em> ({t('optional')})</em>}</span>
      {children}
      {hint && <small>{hint}</small>}
      {error && <span className="err">{error}</span>}
    </label>
  );
}

/** Small helper to manage a form object. */
export function useForm(initial) {
  const [v, setV] = useState(initial);
  const bind = (k, type) => ({
    value: type === 'checkbox' ? undefined : (v[k] ?? ''),
    checked: type === 'checkbox' ? Boolean(v[k]) : undefined,
    onChange: (e) => setV((x) => ({ ...x, [k]: type === 'checkbox' ? e.target.checked : e.target.value })),
  });
  return [v, setV, bind];
}

/** Turns an ApiError into field errors + a toast message. */
export function useSubmit() {
  const toast = useToast();
  const { t } = useI18n();
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const run = async (fn, okText) => {
    setBusy(true); setErrors({});
    try {
      const r = await fn();
      if (okText !== false) toast(okText || t('saved'));
      return r;
    } catch (e) {
      if (e.details && typeof e.details === 'object') setErrors(e.details);
      toast(e.message || t('error'), 'bad');
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { run, errors, busy };
}

// ───────── Display bits ─────────
const TONE = {
  online: 'good', active: 'good', success: 'good', installed: 'good', unused: 'idle', new: 'warn',
  pending: 'idle', trial: 'warn', contacted: 'warn', read_only: 'warn',
  offline: 'bad', expired: 'bad', failed: 'bad', suspended: 'bad', exhausted: 'bad', disabled: 'idle', cancelled: 'idle',
  rejected: 'idle', closed: 'idle', refunded: 'idle',
};
export function Status({ value }) {
  const { t } = useI18n();
  return <span className={`st ${TONE[value] || ''}`}>{t(`st_${value}`)}</span>;
}

export function Empty({ title, children, action }) {
  return <div className="empty"><b>{title}</b>{children && <div>{children}</div>}{action && <div style={{ marginTop: 12 }}>{action}</div>}</div>;
}

export function PageHead({ title, sub, children }) {
  return <div className="page-head"><div><h1>{title}</h1>{sub && <p>{sub}</p>}</div><div className="row">{children}</div></div>;
}

export function Pager({ offset, limit, total, onChange }) {
  const { t } = useI18n();
  if (!total || total <= limit) return null;
  return (
    <div className="pager">
      <span>{offset + 1}–{Math.min(offset + limit, total)} {t('of')} {total}</span>
      <div className="row">
        <button className="btn small" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>{t('previous')}</button>
        <button className="btn small" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>{t('next')}</button>
      </div>
    </div>
  );
}

export function CopyButton({ text, label }) {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  return (
    <button className="btn small" type="button" onClick={async () => {
      try { await navigator.clipboard.writeText(text); } catch { const ta = document.createElement('textarea'); ta.value = text; document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
      setDone(true); setTimeout(() => setDone(false), 1500);
    }}><Icon name="copy" size={15} />{done ? t('copied') : (label || t('copy'))}</button>
  );
}

export function Seg({ value, options, onChange }) {
  return (
    <div className="seg" role="group">
      {options.map(([v, label]) => <button key={v} type="button" aria-pressed={String(value === v)} onClick={() => onChange(v)}>{label}</button>)}
    </div>
  );
}

// ───────── Live events (Server-Sent Events) ─────────
const MAP = {
  payment: [['dashboard'], ['payments'], ['vouchers'], ['subscriptions']],
  session: [['dashboard'], ['sessions'], ['routers']],
  router: [['dashboard'], ['routers']],
  alert: [['dashboard'], ['alerts']],
  request: [['dashboard'], ['requests']],
};
const LiveCtx = createContext({ last: null });
export const useLive = () => useContext(LiveCtx);

export function LiveProvider({ children, enabled }) {
  const qc = useQueryClient();
  const [last, setLast] = useState(null);
  const timer = useRef({});
  useEffect(() => {
    if (!enabled) return undefined;
    let es, retry;
    const open = () => {
      const tok = getToken();
      if (!tok) { retry = setTimeout(open, 2000); return; }
      const tenant = actingTenant.get();
      es = new EventSource(`/api/events?access_token=${encodeURIComponent(tok)}${tenant ? `&tenant=${tenant}` : ''}`);
      for (const type of Object.keys(MAP)) {
        es.addEventListener(type, () => {
          setLast({ type, at: Date.now() });
          // Coalesce bursts (a router reconnecting 40 users) into one refetch per type
          clearTimeout(timer.current[type]);
          timer.current[type] = setTimeout(() => MAP[type].forEach((k) => qc.invalidateQueries({ queryKey: k })), 400);
        });
      }
      es.onerror = () => { es.close(); retry = setTimeout(open, 5000); };
    };
    open();
    return () => { es?.close(); clearTimeout(retry); };
  }, [enabled, qc]);
  return <LiveCtx.Provider value={{ last }}>{children}</LiveCtx.Provider>;
}
