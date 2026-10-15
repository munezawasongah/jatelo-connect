// API client. The access token lives in memory; the refresh token is an httpOnly cookie
// the browser sends to /api/auth/refresh. A 401 triggers one silent refresh and a retry.

let accessToken = null;
let refreshing = null;
const listeners = new Set();

export const getToken = () => accessToken;
export function setToken(t) { accessToken = t; }
export const onAuthLost = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

// Support access: Jatelo staff can act on one operator (X-Tenant-Id)
export const actingTenant = {
  get: () => sessionStorage.getItem('jc_tenant'),
  set: (id) => (id ? sessionStorage.setItem('jc_tenant', id) : sessionStorage.removeItem('jc_tenant')),
};

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code;
    this.details = body?.error?.details;
  }
}

export async function refresh() {
  if (!refreshing) {
    refreshing = fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
      .then(async (r) => {
        if (!r.ok) throw new ApiError(r.status, await r.json().catch(() => null));
        const j = await r.json();
        accessToken = j.access_token;
        return j;
      })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

export async function api(path, { method = 'GET', body, raw = false, retry = true } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  const t = actingTenant.get();
  if (t) headers['x-tenant-id'] = t;
  const res = await fetch(`/api${path}`, {
    method, headers, credentials: 'include', body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && retry && !path.startsWith('/auth/')) {
    try {
      await refresh();
      return api(path, { method, body, raw, retry: false });
    } catch {
      accessToken = null;
      listeners.forEach((fn) => fn());
    }
  }
  if (raw) return res;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const get = (p) => api(p);
export const post = (p, body = {}) => api(p, { method: 'POST', body });
export const patch = (p, body) => api(p, { method: 'PATCH', body });
export const put = (p, body) => api(p, { method: 'PUT', body });
export const del = (p) => api(p, { method: 'DELETE' });

/** Download a CSV (or any file) the API returns, keeping auth headers. */
export async function download(path, filename) {
  const res = await api(path, { raw: true });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function qs(params) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, v);
  const str = s.toString();
  return str ? `?${str}` : '';
}
