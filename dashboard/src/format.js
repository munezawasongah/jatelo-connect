// Number, money, size, time formatting (French grouping is the norm in Burundi).

export const money = (n, cur = 'BIF') =>
  `${Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} ${cur}`;

export const num = (n) => Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

export function bytes(b, lang = 'fr') {
  const u = lang === 'en' ? ['B', 'KB', 'MB', 'GB', 'TB'] : ['o', 'Ko', 'Mo', 'Go', 'To'];
  let v = Number(b) || 0, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

export function bps(v) {
  const n = Number(v) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} Gbps`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} Mbps`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} kbps`;
  return `${n} bps`;
}

export const speed = (kbps) => (kbps ? (kbps >= 1024 ? `${+(kbps / 1024).toFixed(1)} Mbps` : `${kbps} kbps`) : '—');

export function minutes(m, lang = 'fr') {
  if (m == null) return '—';
  if (m < 60) return `${m} min`;
  if (m < 1440) return `${+(m / 60).toFixed(1)} h`;
  const d = +(m / 1440).toFixed(1);
  return `${d} ${lang === 'en' ? (d === 1 ? 'day' : 'days') : lang === 'rn' ? (d === 1 ? 'umusi' : 'imisi') : (d === 1 ? 'jour' : 'jours')}`;
}

export function duration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}j ${h}h`;
  if (h) return `${h}h ${String(m).padStart(2, '0')}`;
  return `${m} min`;
}

const locale = (lang) => (lang === 'en' ? 'en-GB' : 'fr-FR');
export const date = (d, lang) => (d ? new Date(d).toLocaleDateString(locale(lang), { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const dateTime = (d, lang) => (d ? new Date(d).toLocaleString(locale(lang), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
export const time = (d, lang) => (d ? new Date(d).toLocaleTimeString(locale(lang), { hour: '2-digit', minute: '2-digit' }) : '—');

/** "3 min ago" style, short. */
export function ago(d, lang = 'fr') {
  if (!d) return '—';
  const s = Math.round((Date.now() - new Date(d)) / 1000);
  const [now, m, h, dd] = lang === 'en' ? ['just now', 'min ago', 'h ago', 'd ago'] : ['à l’instant', 'min', 'h', 'j'];
  const pre = lang === 'en' ? '' : 'il y a ';
  if (s < 60) return now;
  if (s < 3600) return `${pre}${Math.floor(s / 60)} ${m}`;
  if (s < 86400) return `${pre}${Math.floor(s / 3600)} ${h}`;
  return `${pre}${Math.floor(s / 86400)} ${dd}`;
}

export const daysUntil = (d) => Math.ceil((new Date(d) - Date.now()) / 86400000);
