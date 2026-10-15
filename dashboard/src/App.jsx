import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { I18nContext, makeT } from './i18n.js';
import { get, post, refresh, setToken, onAuthLost, actingTenant } from './api.js';
import { ToastProvider, LiveProvider } from './components/ui.jsx';
import Layout from './components/Layout.jsx';
import { Login, Signup, Reset } from './pages/Auth.jsx';
import Home from './pages/Home.jsx';
import Sessions from './pages/Sessions.jsx';
import Routers, { RouterDetail } from './pages/Routers.jsx';
import Packages from './pages/Packages.jsx';
import Vouchers from './pages/Vouchers.jsx';
import Subscribers from './pages/Subscribers.jsx';
import Customers from './pages/Customers.jsx';
import Agents, { AgentHome } from './pages/Agents.jsx';
import Payments from './pages/Payments.jsx';
import Requests from './pages/Requests.jsx';
import Reports from './pages/Reports.jsx';
import Settings from './pages/Settings.jsx';
import Admin from './pages/Admin.jsx';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

function getLang() {
  try { return localStorage.getItem('jc_dash_lang'); } catch { return null; }
}

export default function App() {
  const [me, setMe] = useState(undefined); // undefined = loading, null = signed out
  const [lang, setLangState] = useState(getLang() || 'fr');
  const qc = useQueryClient();

  const loadMe = useCallback(async () => {
    try { setMe(await get('/auth/me')); } catch { setMe(null); }
  }, []);

  useEffect(() => {
    refresh().then(loadMe).catch(() => setMe(null));
    return onAuthLost(() => setMe(null));
  }, [loadMe]);

  const setLang = useCallback((l) => { setLangState(l); try { localStorage.setItem('jc_dash_lang', l); } catch { /* private mode */ } }, []);
  const i18n = useMemo(() => ({ lang, setLang, t: makeT(lang) }), [lang, setLang]);

  const auth = useMemo(() => ({
    me,
    reload: loadMe,
    async signIn(session) {
      setToken(session.access_token);
      await loadMe();
    },
    async signOut() {
      await post('/auth/logout').catch(() => {});
      setToken(null);
      actingTenant.set(null);
      qc.clear();
      setMe(null);
    },
    async actAs(tenantId) {
      actingTenant.set(tenantId);
      qc.clear();
      await loadMe();
    },
  }), [me, loadMe, qc]);

  useEffect(() => { document.documentElement.lang = lang === 'rn' ? 'rn' : lang; }, [lang]);
  useEffect(() => { if (me?.user?.language && !getLang()) setLangState(me.user.language); }, [me]);

  return (
    <I18nContext.Provider value={i18n}>
      <AuthCtx.Provider value={auth}>
        <ToastProvider>
          {me === undefined ? <div className="empty">{i18n.t('loading')}</div> : <AppRoutes me={me} />}
        </ToastProvider>
      </AuthCtx.Provider>
    </I18nContext.Provider>
  );
}

function AppRoutes({ me }) {
  const loc = useLocation();
  if (!me) {
    return (
      <Routes>
        <Route path="/signup" element={<Signup />} />
        <Route path="/reset" element={<Reset />} />
        <Route path="*" element={loc.pathname === '/login' ? <Login /> : <Navigate to="/login" replace />} />
      </Routes>
    );
  }
  const role = me.user.role;
  const isAdmin = role === 'platform_admin';
  const hasTenant = Boolean(me.tenant) || (isAdmin && actingTenant.get());
  return (
    <LiveProvider enabled={Boolean(hasTenant) && role !== 'agent'}>
      <Layout>
        <Routes>
          {role === 'agent' && <Route path="*" element={<AgentHome />} />}
          {isAdmin && !hasTenant && <Route path="*" element={<Admin />} />}
          <Route path="/" element={<Home />} />
          <Route path="/sessions" element={<Sessions />} />
          <Route path="/routers" element={<Routers />} />
          <Route path="/routers/:id" element={<RouterDetail />} />
          <Route path="/packages" element={<Packages />} />
          <Route path="/vouchers" element={<Vouchers />} />
          <Route path="/subscribers" element={<Subscribers />} />
          <Route path="/customers" element={<Customers />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/payments" element={<Payments />} />
          <Route path="/requests" element={<Requests />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/settings" element={<Settings />} />
          {isAdmin && <Route path="/admin" element={<Admin />} />}
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </LiveProvider>
  );
}
