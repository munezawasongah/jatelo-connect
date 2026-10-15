import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../i18n.js';
import { useAuth } from '../App.jsx';
import { get, post, patch, put, del } from '../api.js';
import { money, date, dateTime, ago } from '../format.js';
import { PageHead, Empty, Modal, Field, useForm, useSubmit, Status, CopyButton, ConfirmButton, Icon, useToast } from '../components/ui.jsx';

const TABS = ['business', 'portal', 'payments', 'sms', 'staff', 'billing', 'audit'];
const TAB_LABEL = { business: 'business', portal: 'portal_branding', payments: 'payments_setup', sms: 'sms_setup', staff: 'staff', billing: 'billing', audit: 'audit' };

export default function Settings() {
  const { t } = useI18n();
  const { me } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'business';
  const isOwner = ['owner', 'platform_admin'].includes(me.user.role);
  const allowed = TABS.filter((x) => (x === 'staff' ? ['owner', 'manager', 'platform_admin'].includes(me.user.role) : true));
  return (
    <>
      <PageHead title={t('settings_title')} />
      <div className="tabs" role="tablist">
        {allowed.map((k) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setParams({ tab: k })}>{t(TAB_LABEL[k])}</button>)}
      </div>
      {tab === 'business' && <Business />}
      {tab === 'portal' && <Portal />}
      {tab === 'payments' && <Wallets />}
      {tab === 'sms' && <Gateways />}
      {tab === 'staff' && <Staff canEdit={isOwner} />}
      {tab === 'billing' && <Billing />}
      {tab === 'audit' && <Audit />}
    </>
  );
}

function Business() {
  const { t } = useI18n();
  const { reload } = useAuth();
  const qc = useQueryClient();
  const d = useQuery({ queryKey: ['settings'], queryFn: () => get('/settings') });
  const [v, setV, bind] = useForm(null);
  useEffect(() => {
    if (d.data && !v) {
      const a = d.data.account;
      setV({ name: a.name, phone: a.phone || '', email: a.email || '', language: a.language, reminders: (a.settings?.reminders?.days_before || [3, 1]).join(', ') });
    }
  }, [d.data, v, setV]);
  const { run, busy, errors } = useSubmit();
  if (!v) return <Empty title={t('loading')} />;
  return (
    <section className="panel"><div className="body">
      <form className="form-grid" onSubmit={async (e) => {
        e.preventDefault();
        const days = v.reminders.split(/[\s,;]+/).map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x <= 14).slice(0, 4);
        if (await run(() => patch('/settings', { name: v.name, phone: v.phone || null, email: v.email || null, language: v.language, settings: { reminders: { days_before: days } } }))) {
          qc.invalidateQueries({ queryKey: ['settings'] }); reload();
        }
      }}>
        <Field label={t('business_name')} error={errors.name}><input className="in" required {...bind('name')} /></Field>
        <Field label={t('phone')} error={errors.phone} hint={t('support_phone')}><input className="in" type="tel" {...bind('phone')} /></Field>
        <Field label={t('email')} error={errors.email}><input className="in" type="email" {...bind('email')} /></Field>
        <Field label={t('language')} hint="SMS">
          <select className="in" {...bind('language')}><option value="fr">Français</option><option value="rn">Kirundi</option><option value="en">English</option></select>
        </Field>
        <Field label={t('reminders_days')} hint="3, 1"><input className="in" {...bind('reminders')} /></Field>
        <div className="full"><button className="btn primary" disabled={busy}>{t('save')}</button></div>
      </form>
    </div></section>
  );
}

function Portal() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const sites = useQuery({ queryKey: ['sites'], queryFn: () => get('/sites') });
  const routers = useQuery({ queryKey: ['routers'], queryFn: () => get('/routers') });
  const account = useQuery({ queryKey: ['settings'], queryFn: () => get('/settings') });
  const [siteId, setSiteId] = useState(null);
  const site = (sites.data?.sites || []).find((s) => s.id === siteId) || sites.data?.sites?.[0];
  const [v, setV, bind] = useForm(null);
  useEffect(() => {
    if (site) {
      const p = site.portal || {};
      setV({ name: site.name, address: site.address || '', brand: p.brand || '', primary_color: p.primary_color || '#0E7C66', logo_url: p.logo_url || '',
        default_language: p.default_language || 'fr', trial_enabled: p.trial_enabled !== false, support_phone: p.support_phone || '',
        welcome_fr: p.welcome?.fr || '', welcome_rn: p.welcome?.rn || '', welcome_en: p.welcome?.en || '' });
    }
  }, [site?.id, setV]); // eslint-disable-line react-hooks/exhaustive-deps
  const { run, busy, errors } = useSubmit();
  if (!site || !v) return <Empty title={t('loading')} />;
  const portal = account.data?.portal_url;
  const firstRouter = (routers.data?.routers || []).find((r) => r.site_id === site.id) || routers.data?.routers?.[0];
  return (
    <div className="grid-2">
      <section className="panel"><div className="body">
        {(sites.data?.sites || []).length > 1 && (
          <Field label={t('site')}><select className="in" value={site.id} onChange={(e) => setSiteId(e.target.value)}>{sites.data.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        )}
        <form className="form-grid" style={{ marginTop: 12 }} onSubmit={async (e) => {
          e.preventDefault();
          const body = { name: v.name, address: v.address || null, portal: {
            brand: v.brand, primary_color: v.primary_color, logo_url: v.logo_url || null, default_language: v.default_language,
            trial_enabled: v.trial_enabled, support_phone: v.support_phone || null, welcome: { fr: v.welcome_fr, rn: v.welcome_rn, en: v.welcome_en },
          } };
          if (await run(() => patch(`/sites/${site.id}`, body))) qc.invalidateQueries({ queryKey: ['sites'] });
        }}>
          <Field label={t('brand')} error={errors['portal.brand']}><input className="in" {...bind('brand')} /></Field>
          <Field label={t('primary_color')}><div className="row"><input type="color" {...bind('primary_color')} style={{ width: 44, height: 38, border: 0, background: 'none' }} /><input className="in mono" {...bind('primary_color')} style={{ flex: 1 }} /></div></Field>
          <Field label={t('logo_url')} optional full error={errors['portal.logo_url']}><input className="in" type="url" {...bind('logo_url')} /></Field>
          <Field label={t('support_phone')} optional><input className="in" type="tel" {...bind('support_phone')} /></Field>
          <Field label={t('default_language')}>
            <select className="in" {...bind('default_language')}><option value="fr">Français</option><option value="rn">Kirundi</option><option value="en">English</option></select>
          </Field>
          <Field label={`${t('welcome_text')} (FR)`} optional full><input className="in" maxLength={300} {...bind('welcome_fr')} /></Field>
          <Field label={`${t('welcome_text')} (RN)`} optional full><input className="in" maxLength={300} {...bind('welcome_rn')} /></Field>
          <Field label={`${t('welcome_text')} (EN)`} optional full><input className="in" maxLength={300} {...bind('welcome_en')} /></Field>
          <label className="check full"><input type="checkbox" {...bind('trial_enabled', 'checkbox')} />{t('trial_enabled')}</label>
          <div className="full"><button className="btn primary" disabled={busy}>{t('save')}</button></div>
        </form>
      </div></section>
      <section className="panel">
        <header><h2>{t('portal_link')}</h2></header>
        <div className="body stack">
          {firstRouter && portal ? (
            <>
              <div className="row"><a href={`${portal}/h/${firstRouter.id}`} target="_blank" rel="noreferrer" className="mono small" style={{ overflowWrap: 'anywhere' }}>{portal}/h/{firstRouter.id}</a></div>
              <a className="btn" href={`${portal}/h/${firstRouter.id}`} target="_blank" rel="noreferrer">{t('open')}</a>
            </>
          ) : <p className="muted" style={{ margin: 0 }}>{t('setup_router')}</p>}
          {account.data && (
            <>
              <h3 style={{ fontSize: 15, margin: '8px 0 0' }}>{t('join_link')}</h3>
              <div className="row"><span className="mono small" style={{ overflowWrap: 'anywhere' }}>{portal}/join/{account.data.account.slug}</span><CopyButton text={`${portal}/join/${account.data.account.slug}`} /></div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function WalletForm({ wallet, current, onSaved }) {
  const { t } = useI18n();
  const [v, , bind] = useForm({ merchant_number: current?.merchant_number || '', merchant_name: current?.merchant_name || '', active: current ? current.active : true });
  const { run, busy, errors } = useSubmit();
  return (
    <section className="panel">
      <header><h2>{wallet === 'lumicash' ? 'Lumicash' : 'EcoCash'}</h2>{current && <Status value={current.active ? 'active' : 'disabled'} />}</header>
      <div className="body">
        <form className="stack" onSubmit={async (e) => { e.preventDefault(); if (await run(() => put(`/payment-channels/${wallet}`, { ...v, merchant_name: v.merchant_name || null }))) onSaved(); }}>
          <Field label={t('merchant_number')} error={errors.merchant_number}><input className="in mono" required {...bind('merchant_number')} /></Field>
          <Field label={t('merchant_name')} optional><input className="in" {...bind('merchant_name')} /></Field>
          <label className="check"><input type="checkbox" {...bind('active', 'checkbox')} />{t('st_active')}</label>
          <button className="btn primary" disabled={busy}>{t('save')}</button>
        </form>
      </div>
    </section>
  );
}

function Wallets() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const d = useQuery({ queryKey: ['payment-channels'], queryFn: () => get('/payment-channels') });
  if (!d.data) return <Empty title={t('loading')} />;
  const find = (w) => d.data.channels.find((c) => c.wallet === w);
  const saved = () => { qc.invalidateQueries({ queryKey: ['payment-channels'] }); qc.invalidateQueries({ queryKey: ['dashboard'] }); };
  return (
    <>
      <p className="muted" style={{ marginTop: 0, maxWidth: '72ch' }}>{t('wallet_help')}</p>
      <div className="grid-halves">
        <WalletForm wallet="lumicash" current={find('lumicash')} onSaved={saved} />
        <WalletForm wallet="ecocash" current={find('ecocash')} onSaved={saved} />
      </div>
    </>
  );
}

function Gateways() {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const d = useQuery({ queryKey: ['sms-gateways'], queryFn: () => get('/sms-gateways') });
  const [adding, setAdding] = useState(false);
  const [webhook, setWebhook] = useState(null);
  const [v, , bind] = useForm({ name: '', phone: '', base_url: 'https://api.sms-gate.app/3rdparty/v1', username: '', password: '' });
  const { run, busy, errors } = useSubmit();
  const reload = () => { qc.invalidateQueries({ queryKey: ['sms-gateways'] }); qc.invalidateQueries({ queryKey: ['dashboard'] }); };
  return (
    <>
      <div className="spread" style={{ marginBottom: 12 }}>
        <p className="muted" style={{ margin: 0, maxWidth: '72ch' }}>{t('gateway_steps')}</p>
        <button className="btn primary" onClick={() => setAdding(true)}><Icon name="plus" />{t('add_gateway')}</button>
      </div>
      <section className="panel table-wrap">
        {!d.data?.gateways?.length ? <Empty title={d.isLoading ? t('loading') : t('none')} /> : (
          <table className="tbl">
            <thead><tr><th>{t('name')}</th><th>{t('phone')}</th><th>{t('last_sms')}</th><th>{t('status')}</th><th /></tr></thead>
            <tbody>{d.data.gateways.map((g) => (
              <tr key={g.id}>
                <td><b>{g.name}</b><span className="sub">{g.username}</span></td>
                <td>{g.phone || '—'}</td>
                <td>{g.last_sms_at ? ago(g.last_sms_at, lang) : '—'}</td>
                <td><Status value={g.active ? 'active' : 'disabled'} /></td>
                <td className="act">
                  <button className="btn small" onClick={async () => { const r = await run(() => post(`/sms-gateways/${g.id}/test`), false); if (r) toast(t('test_sent', { to: r.to })); }}>{t('send_test')}</button>{' '}
                  <ConfirmButton className="btn small danger" danger question={`${t('delete')} ${g.name} ?`} onConfirm={async () => { await del(`/sms-gateways/${g.id}`); reload(); }}>{t('delete')}</ConfirmButton>
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>
      {adding && (
        <Modal title={webhook ? t('webhook_url') : t('add_gateway')} onClose={() => { setAdding(false); setWebhook(null); }} footer={webhook
          ? <button className="btn primary" onClick={() => { setAdding(false); setWebhook(null); }}>{t('close')}</button>
          : <><button className="btn" onClick={() => setAdding(false)}>{t('cancel')}</button><button className="btn primary" form="gw" disabled={busy}>{t('save')}</button></>}>
          {webhook ? (
            <div className="stack">
              <div className="codebox" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{webhook}</div>
              <CopyButton text={webhook} />
              <div className="banner warn" style={{ margin: 0 }}>{t('webhook_once')}</div>
            </div>
          ) : (
            <form id="gw" className="form-grid" onSubmit={async (e) => {
              e.preventDefault();
              const r = await run(() => post('/sms-gateways', { ...v, phone: v.phone || null }), false);
              if (r) { setWebhook(r.webhook_url); reload(); }
            }}>
              <Field label={t('name')} error={errors.name}><input className="in" required {...bind('name')} placeholder="Téléphone marchand" /></Field>
              <Field label={t('phone')} optional error={errors.phone}><input className="in" type="tel" {...bind('phone')} /></Field>
              <Field label={t('gw_username')} error={errors.username}><input className="in mono" required {...bind('username')} /></Field>
              <Field label={t('gw_password')} error={errors.password}><input className="in mono" required {...bind('password')} /></Field>
              <Field label="API" full hint="sms-gate.app Cloud"><input className="in mono" {...bind('base_url')} /></Field>
            </form>
          )}
        </Modal>
      )}
    </>
  );
}

function Staff({ canEdit }) {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const d = useQuery({ queryKey: ['staff'], queryFn: () => get('/staff') });
  const [adding, setAdding] = useState(false);
  const [v, , bind] = useForm({ name: '', phone: '', email: '', role: 'cashier', password: '' });
  const { run, busy, errors } = useSubmit();
  const reload = () => qc.invalidateQueries({ queryKey: ['staff'] });
  return (
    <>
      {canEdit && <div className="toolbar"><button className="btn primary" onClick={() => setAdding(true)}><Icon name="plus" />{t('add_staff')}</button></div>}
      <section className="panel table-wrap">
        {!d.data?.staff?.length ? <Empty title={t('loading')} /> : (
          <table className="tbl">
            <thead><tr><th>{t('name')}</th><th>{t('role')}</th><th>{t('last_login')}</th><th>{t('status')}</th></tr></thead>
            <tbody>{d.data.staff.map((u) => (
              <tr key={u.id}>
                <td><b>{u.name}</b><span className="sub">{u.email || u.phone}</span></td>
                <td>{canEdit && u.role !== 'owner'
                  ? <select className="in" style={{ width: 'auto' }} value={u.role} onChange={async (e) => { if (await run(() => patch(`/staff/${u.id}`, { role: e.target.value }))) reload(); }}>
                      {['manager', 'technician', 'cashier', 'owner'].map((r) => <option key={r} value={r}>{t(`r_${r}`)}</option>)}
                    </select>
                  : t(`r_${u.role}`)}</td>
                <td>{u.last_login_at ? ago(u.last_login_at, lang) : '—'}</td>
                <td>{canEdit && u.role !== 'owner'
                  ? <button className="btn small" onClick={async () => { if (await run(() => patch(`/staff/${u.id}`, { status: u.status === 'active' ? 'disabled' : 'active' }))) reload(); }}>
                      <Status value={u.status === 'active' ? 'active' : 'disabled'} /></button>
                  : <Status value={u.status === 'active' ? 'active' : 'disabled'} />}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>
      {adding && (
        <Modal title={t('add_staff')} onClose={() => setAdding(false)} footer={<>
          <button className="btn" onClick={() => setAdding(false)}>{t('cancel')}</button><button className="btn primary" form="staff" disabled={busy}>{t('save')}</button>
        </>}>
          <form id="staff" className="form-grid" onSubmit={async (e) => {
            e.preventDefault();
            if (await run(() => post('/staff', { ...v, email: v.email || null, phone: v.phone || null, language: lang }))) { setAdding(false); reload(); }
          }}>
            <Field label={t('name')} error={errors.name}><input className="in" required {...bind('name')} /></Field>
            <Field label={t('role')}>
              <select className="in" {...bind('role')}>{['manager', 'technician', 'cashier'].map((r) => <option key={r} value={r}>{t(`r_${r}`)}</option>)}</select>
            </Field>
            <Field label={t('phone')} error={errors.phone}><input className="in" type="tel" {...bind('phone')} /></Field>
            <Field label={t('email')} optional error={errors.email}><input className="in" type="email" {...bind('email')} /></Field>
            <Field label={t('password')} full error={errors.password}><input className="in" type="password" minLength={8} required autoComplete="new-password" {...bind('password')} /></Field>
          </form>
        </Modal>
      )}
    </>
  );
}

function Billing() {
  const { t, lang } = useI18n();
  const { me } = useAuth();
  const d = useQuery({ queryKey: ['settings', 'billing'], queryFn: () => get('/settings/billing') });
  const a = useQuery({ queryKey: ['settings'], queryFn: () => get('/settings') });
  const acc = a.data?.account;
  return (
    <div className="grid-2">
      <section className="panel table-wrap">
        {!d.data?.billing?.length ? <Empty title={t('none')} /> : (
          <table className="tbl">
            <thead><tr><th>{t('date')}</th><th>{t('tier')}</th><th className="n">{t('months')}</th><th>{t('paid_until')}</th><th className="n">{t('amount')}</th></tr></thead>
            <tbody>{d.data.billing.map((b) => <tr key={b.created_at}><td>{date(b.created_at, lang)}</td><td>{b.tier}</td><td className="n">{b.months}</td><td>{date(b.paid_until, lang)}</td><td className="n">{money(b.amount)}</td></tr>)}</tbody>
          </table>
        )}
      </section>
      {acc && (
        <section className="panel"><div className="body">
          <dl className="kv">
            <dt>{t('tier')}</dt><dd>{acc.tier}</dd>
            <dt>{t('status')}</dt><dd><Status value={acc.status} /></dd>
            {acc.trial_ends_at && acc.status === 'trial' && <><dt>{t('st_trial')}</dt><dd>{date(acc.trial_ends_at, lang)}</dd></>}
            <dt>{t('paid_until')}</dt><dd>{acc.paid_until ? date(acc.paid_until, lang) : '—'}</dd>
            <dt>{t('nav_routers')}</dt><dd>{acc.max_routers}</dd>
          </dl>
          <p className="muted small" style={{ marginBottom: 0 }}>{t('renew_contact')} {me.tenant?.name}</p>
        </div></section>
      )}
    </div>
  );
}

function Audit() {
  const { t, lang } = useI18n();
  const d = useQuery({ queryKey: ['audit'], queryFn: () => get('/audit?limit=200') });
  return (
    <section className="panel table-wrap">
      {!d.data?.entries?.length ? <Empty title={d.isLoading ? t('loading') : t('none')} /> : (
        <table className="tbl">
          <thead><tr><th>{t('date')}</th><th>{t('name')}</th><th>{t('actions')}</th><th>{t('details')}</th></tr></thead>
          <tbody>{d.data.entries.map((e) => (
            <tr key={e.id}><td>{dateTime(e.created_at, lang)}</td><td>{e.user_name || 'Jatelo'}<span className="sub mono">{e.ip}</span></td>
              <td className="mono">{e.action}</td><td className="small muted" style={{ maxWidth: 420, overflowWrap: 'anywhere' }}>{e.data ? JSON.stringify(e.data) : ''}</td></tr>
          ))}</tbody>
        </table>
      )}
    </section>
  );
}
