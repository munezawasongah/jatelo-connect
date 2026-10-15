import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../i18n.js';
import { useAuth } from '../App.jsx';
import { get, post, patch, qs } from '../api.js';
import { money, num, date, ago } from '../format.js';
import { PageHead, Empty, Modal, Field, useForm, useSubmit, Status } from '../components/ui.jsx';

function RecordPayment({ tenant, tiers, onClose, onDone }) {
  const { t } = useI18n();
  const [v, , bind] = useForm({ tier: tenant.tier === 'trial' ? 'starter' : tenant.tier, months: 1, amount: '', reference: '' });
  const { run, busy, errors } = useSubmit();
  const suggested = (tiers[v.tier]?.price || 0) * Number(v.months || 1);
  return (
    <Modal title={`${t('record_payment')}: ${tenant.name}`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>{t('cancel')}</button><button className="btn primary" form="bill" disabled={busy}>{t('save')}</button>
    </>}>
      <form id="bill" className="form-grid" onSubmit={async (e) => {
        e.preventDefault();
        if (await run(() => post(`/admin/tenants/${tenant.id}/billing`, { tier: v.tier, months: Number(v.months), amount: Number(v.amount || suggested), reference: v.reference || undefined }))) onDone();
      }}>
        <Field label={t('tier')}>
          <select className="in" {...bind('tier')}>{['starter', 'business', 'isp', 'enterprise'].map((x) => <option key={x} value={x}>{x} {tiers[x]?.price ? `(${money(tiers[x].price)})` : ''}</option>)}</select>
        </Field>
        <Field label={t('months')}><input className="in" type="number" min="1" max="24" {...bind('months')} /></Field>
        <Field label={t('amount')} error={errors.amount}><input className="in" type="number" min="0" placeholder={String(suggested)} {...bind('amount')} /></Field>
        <Field label={t('reference')} optional><input className="in mono" {...bind('reference')} /></Field>
      </form>
    </Modal>
  );
}

export default function Admin() {
  const { t, lang } = useI18n();
  const { actAs } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [billing, setBilling] = useState(null);
  const stats = useQuery({ queryKey: ['admin', 'stats'], queryFn: () => get('/admin/stats') });
  const list = useQuery({ queryKey: ['admin', 'tenants', q, status], queryFn: () => get(`/admin/tenants${qs({ q, status, limit: 200 })}`) });
  const { run } = useSubmit();
  const s = stats.data || {};
  const reload = () => qc.invalidateQueries({ queryKey: ['admin'] });
  return (
    <>
      <PageHead title={t('operators')} />
      <div className="facts">
        <div><b>{num(Object.values(s.tenants || {}).reduce((a, b) => a + b, 0))}</b><span>{t('operators')} ({num(s.tenants?.active || 0)} {t('st_active').toLowerCase()})</span></div>
        <div><b>{num(s.routers_online)}/{num(s.routers)}</b><span>{t('routers')}</span></div>
        <div><b>{num(s.sessions_online)}</b><span>{t('online_now')}</span></div>
        <div className={s.sms_stuck || s.sms_failed_24h ? 'attn' : ''}><b>{money(s.gmv_30d || 0)}</b><span>{t('gmv')}</span></div>
      </div>
      <div className="toolbar">
        <select className="in" value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('status')}>
          <option value="">{t('status')}: {t('all')}</option>
          {['trial', 'active', 'read_only', 'suspended', 'closed'].map((x) => <option key={x} value={x}>{t(`st_${x}`)}</option>)}
        </select>
        <input className="in" type="search" placeholder={t('search')} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <section className="panel table-wrap">
        {!list.data?.tenants?.length ? <Empty title={list.isLoading ? t('loading') : t('none')} /> : (
          <table className="tbl">
            <thead><tr><th>{t('name')}</th><th>{t('status')}</th><th>{t('tier')}</th><th>{t('paid_until')}</th><th className="n">{t('routers')}</th><th className="n">{t('nav_subscribers')}</th><th className="n">{t('gmv')}</th><th /></tr></thead>
            <tbody>{list.data.tenants.map((x) => (
              <tr key={x.id}>
                <td><b>{x.name}</b><span className="sub">{x.phone} — {x.last_login_at ? ago(x.last_login_at, lang) : '—'}</span></td>
                <td>
                  <select className="in" style={{ width: 'auto' }} value={x.status} onChange={async (e) => { if (await run(() => patch(`/admin/tenants/${x.id}`, { status: e.target.value }))) reload(); }}>
                    {['trial', 'active', 'read_only', 'suspended', 'closed'].map((st) => <option key={st} value={st}>{t(`st_${st}`)}</option>)}
                  </select>
                </td>
                <td>{x.tier}</td>
                <td>{x.paid_until ? date(x.paid_until, lang) : (x.trial_ends_at ? `${t('st_trial')}: ${date(x.trial_ends_at, lang)}` : '—')}</td>
                <td className="n">{x.routers_online}/{x.routers}</td>
                <td className="n">{x.subscribers}</td>
                <td className="n">{money(x.gmv_30d)}</td>
                <td className="act">
                  <button className="btn small" onClick={() => setBilling(x)}>{t('record_payment')}</button>{' '}
                  <button className="btn small primary" onClick={async () => { await actAs(x.id); nav('/'); }}>{t('act_as')}</button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>
      {billing && <RecordPayment tenant={billing} tiers={list.data?.tiers || {}} onClose={() => setBilling(null)} onDone={() => { setBilling(null); reload(); }} />}
    </>
  );
}
