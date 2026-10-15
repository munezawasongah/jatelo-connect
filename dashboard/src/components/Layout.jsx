import { useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useI18n } from '../i18n.js';
import { useAuth } from '../App.jsx';
import { get, actingTenant } from '../api.js';
import { daysUntil } from '../format.js';
import { Icon } from './ui.jsx';

const NAV = [
  ['/', 'home', 'nav_home'],
  ['/sessions', 'live', 'nav_sessions'],
  ['/routers', 'router', 'nav_routers'],
  ['/vouchers', 'ticket', 'nav_vouchers'],
  ['/subscribers', 'users', 'nav_subscribers'],
  ['/packages', 'box', 'nav_packages'],
  ['/customers', 'user', 'nav_customers'],
  ['/agents', 'store', 'nav_agents'],
  ['/payments', 'wallet', 'nav_payments', 'sms_unmatched'],
  ['/requests', 'inbox', 'nav_requests', 'requests_new'],
  ['/reports', 'chart', 'nav_reports'],
  ['/settings', 'cog', 'nav_settings'],
];
const TABS = ['/', '/sessions', '/vouchers', '/subscribers'];

export default function Layout({ children }) {
  const { t, lang, setLang } = useI18n();
  const { me, signOut, actAs } = useAuth();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const nav = useNavigate();
  const role = me.user.role;
  const isAdmin = role === 'platform_admin';
  const acting = isAdmin && actingTenant.get();
  const tenantArea = role !== 'agent' && (!isAdmin || acting);

  const summary = useQuery({ queryKey: ['dashboard', 'summary'], queryFn: () => get('/dashboard/summary'), enabled: Boolean(tenantArea) });
  const account = useQuery({ queryKey: ['settings'], queryFn: () => get('/settings'), enabled: Boolean(acting) });
  const k = summary.data?.kpis || {};
  const tenant = me.tenant;

  const items = role === 'agent' ? [['/', 'home', 'nav_agent_home']] : (isAdmin && !acting ? [['/', 'building', 'nav_admin']] : NAV);

  return (
    <div className="shell">
      <nav className={`rail ${open ? 'open' : ''}`} aria-label="Navigation">
        <div className="spread">
          <a className="wordmark" href="/" onClick={(e) => { e.preventDefault(); nav('/'); setOpen(false); }}>
            <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#1D5C7A" /><circle cx="16" cy="21" r="3" fill="#E3A21A" /><path d="M8 14a11 11 0 0 1 16 0M11 17a7 7 0 0 1 10 0" stroke="#fff" strokeWidth="2.5" fill="none" strokeLinecap="round" /></svg>
            <span><b>Jatelo Connect</b><small>{acting ? account.data?.account?.name : (tenant?.name || (isAdmin ? t('platform') : ''))}</small></span>
          </a>
          {open && <button className="btn quiet" style={{ color: '#fff' }} onClick={() => setOpen(false)} aria-label={t('close')}><Icon name="close" /></button>}
        </div>
        {items.map(([to, icon, label, countKey]) => (
          <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `nav ${isActive ? 'active' : ''}`} onClick={() => setOpen(false)}>
            <Icon name={icon} /><span>{t(label)}</span>
            {countKey && k[countKey] > 0 && <span className="count">{k[countKey]}</span>}
          </NavLink>
        ))}
        {isAdmin && acting && (
          <NavLink to="/admin" className="nav" onClick={() => setOpen(false)}><Icon name="building" /><span>{t('nav_admin')}</span></NavLink>
        )}
        <div className="gap" />
        <div className="who">
          <b>{me.user.name}</b>
          {t(`r_${role === 'platform_admin' ? 'owner' : role}`)}
          <div>
            <select aria-label={t('language')} value={lang} onChange={(e) => setLang(e.target.value)}>
              <option value="fr">Français</option><option value="rn">Kirundi</option><option value="en">English</option>
            </select>
          </div>
          <button onClick={signOut}>{t('sign_out')}</button>
        </div>
      </nav>

      <div style={{ minWidth: 0 }}>
        <div className="topbar">
          <b>Jatelo Connect</b>
          <button onClick={() => setOpen(true)} aria-label={t('nav_more')}><Icon name="menu" size={22} /></button>
        </div>
        <main className="page">
          {acting && (
            <div className="banner info">
              {t('acting_as', { name: account.data?.account?.name || '…' })}
              <button className="btn small" onClick={async () => { await actAs(null); nav('/'); }}>{t('stop_acting')}</button>
            </div>
          )}
          {tenant?.status === 'trial' && tenant.trial_ends_at && (
            <div className="banner info">{t('trial_left', { n: Math.max(0, daysUntil(tenant.trial_ends_at)) })}</div>
          )}
          {tenant?.status === 'read_only' && <div className="banner warn">{t('read_only')} {t('renew_contact')}</div>}
          {tenant?.status === 'suspended' && <div className="banner bad">{t('suspended')} {t('renew_contact')}</div>}
          {children}
        </main>
        {tenantArea && (
          <nav className="tabbar" aria-label="Navigation">
            {TABS.map((to) => {
              const [, icon, label] = NAV.find((n) => n[0] === to);
              return <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}><Icon name={icon} size={20} />{t(label)}</NavLink>;
            })}
            <a href="#more" className={TABS.includes(loc.pathname) ? '' : 'active'} onClick={(e) => { e.preventDefault(); setOpen(true); }}><Icon name="more" size={20} />{t('nav_more')}</a>
          </nav>
        )}
      </div>
    </div>
  );
}
