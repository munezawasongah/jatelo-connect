import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../i18n.js';
import { useAuth } from '../App.jsx';
import { get, post, patch, qs } from '../api.js';
import { money, date, dateTime, bytes, duration, speed, daysUntil } from '../format.js';
import { PageHead, Empty, Modal, Drawer, Field, useForm, useSubmit, Status, Pager, Icon, Seg, ConfirmButton, CopyButton } from '../components/ui.jsx';

export function SubscriberForm({ onClose, onSaved, prefill }) {
  const { t, lang } = useI18n();
  const { me } = useAuth();
  const plans = useQuery({ queryKey: ['plans'], queryFn: () => get('/plans') });
  const routers = useQuery({ queryKey: ['routers'], queryFn: () => get('/routers') });
  const [mode, setMode] = useState(prefill?.customer_id ? 'existing' : 'new');
  const [v, , bind] = useForm({
    name: '', phone: '', address: '', customer_id: '', plan_id: '', router_id: '', username: '', password: '', static_ip: '',
    activation: 'paid_cash', periods: 1, grace_days: 0, send_sms: true, ...prefill,
  });
  const customers = useQuery({ queryKey: ['customers', 'all'], queryFn: () => get('/customers?limit=500'), enabled: mode === 'existing' });
  const { run, busy, errors } = useSubmit();
  const plan = (plans.data?.plans || []).find((p) => p.id === v.plan_id);
  const submit = async (e) => {
    e.preventDefault();
    const body = {
      plan_id: v.plan_id, router_id: v.router_id || null, username: v.username || undefined, password: v.password || undefined,
      static_ip: v.static_ip || null, activation: v.activation, periods: Number(v.periods || 1), grace_days: Number(v.grace_days || 0),
      send_sms: v.send_sms,
      ...(mode === 'existing' ? { customer_id: v.customer_id } : { customer: { name: v.name, phone: v.phone, address: v.address || undefined, language: lang } }),
    };
    const r = await run(() => post('/subscriptions', body));
    if (r) onSaved(r.subscription);
  };
  return (
    <Modal title={t('add_subscriber')} wide onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>{t('cancel')}</button><button className="btn primary" form="sub" disabled={busy}>{t('save')}</button>
    </>}>
      <form id="sub" className="form-grid" onSubmit={submit}>
        <div className="full"><Seg value={mode} onChange={setMode} options={[['new', t('new_customer')], ['existing', t('existing_customer')]]} /></div>
        {mode === 'new' ? (
          <>
            <Field label={t('name')} error={errors['customer.name']}><input className="in" required {...bind('name')} /></Field>
            <Field label={t('phone')} error={errors['customer.phone']}><input className="in" type="tel" required {...bind('phone')} /></Field>
            <Field label={t('address')} optional full><input className="in" {...bind('address')} /></Field>
          </>
        ) : (
          <Field label={t('customer')} full error={errors.customer_id}>
            <select className="in" required {...bind('customer_id')}>
              <option value="">—</option>
              {(customers.data?.customers || []).map((c) => <option key={c.id} value={c.id}>{c.name || c.phone} {c.phone ? `(${c.phone})` : ''}</option>)}
            </select>
          </Field>
        )}
        <Field label={t('plan')} error={errors.plan_id}>
          <select className="in" required {...bind('plan_id')}>
            <option value="">—</option>
            {(plans.data?.plans || []).filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name} ({money(p.price, me.tenant?.currency)})</option>)}
          </select>
        </Field>
        <Field label={t('router')} optional>
          <select className="in" {...bind('router_id')}>
            <option value="">{t('all')}</option>
            {(routers.data?.routers || []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </Field>
        <Field label={t('username')} optional error={errors.username}><input className="in mono" {...bind('username')} placeholder="jean.ndayishimiye" /></Field>
        <Field label={t('pppoe_password')} optional error={errors.password}><input className="in mono" {...bind('password')} /></Field>
        <Field label={t('static_ip')} optional error={errors.static_ip}><input className="in mono" {...bind('static_ip')} /></Field>
        <Field label={t('grace_days')}><input className="in" type="number" min="0" max="30" {...bind('grace_days')} /></Field>
        <Field label={t('activation')} full>
          <select className="in" {...bind('activation')}>
            <option value="paid_cash">{t('act_paid_cash')}</option>
            <option value="free_period">{t('act_free_period')}</option>
            <option value="await_payment">{t('act_await_payment')}</option>
          </select>
        </Field>
        {v.activation !== 'await_payment' && <Field label={t('periods')}><input className="in" type="number" min="1" max="24" {...bind('periods')} /></Field>}
        {v.activation === 'paid_cash' && plan && <p className="muted" style={{ alignSelf: 'end', margin: '0 0 10px' }}>{t('total')}: <b>{money(plan.price * Number(v.periods || 1), me.tenant?.currency)}</b></p>}
        <label className="check full"><input type="checkbox" {...bind('send_sms', 'checkbox')} />{t('send_sms')}</label>
      </form>
    </Modal>
  );
}

function RenewForm({ sub, onClose, onDone }) {
  const { t } = useI18n();
  const { me } = useAuth();
  const [v, , bind] = useForm({ periods: 1, channel: 'cash', note: '', send_sms: true });
  const { run, busy } = useSubmit();
  return (
    <Modal title={t('renew_title', { user: sub.customer_name || sub.username })} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>{t('cancel')}</button><button className="btn primary" form="renew" disabled={busy}>{t('renew')}</button>
    </>}>
      <form id="renew" className="form-grid" onSubmit={async (e) => { e.preventDefault(); if (await run(() => post(`/subscriptions/${sub.id}/renew`, { ...v, periods: Number(v.periods) }))) onDone(); }}>
        <Field label={t('periods')}><input className="in" type="number" min="1" max="24" {...bind('periods')} /></Field>
        <Field label={t('channel')}>
          <select className="in" {...bind('channel')}><option value="cash">{t('ch_cash')}</option><option value="manual">{t('ch_manual')}</option></select>
        </Field>
        <Field label={t('notes')} optional full><input className="in" {...bind('note')} /></Field>
        <label className="check full"><input type="checkbox" {...bind('send_sms', 'checkbox')} />{t('send_sms')}</label>
        <p className="full" style={{ margin: 0 }}>{t('total')}: <b>{money(sub.plan_price * Number(v.periods || 1), me.tenant?.currency)}</b></p>
      </form>
    </Modal>
  );
}

function SubscriberDrawer({ id, onClose }) {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const d = useQuery({ queryKey: ['subscriptions', id], queryFn: () => get(`/subscriptions/${id}`) });
  const plans = useQuery({ queryKey: ['plans'], queryFn: () => get('/plans') });
  const [renew, setRenew] = useState(false);
  const { run, busy } = useSubmit();
  const s = d.data?.subscription;
  const reload = () => { qc.invalidateQueries({ queryKey: ['subscriptions'] }); qc.invalidateQueries({ queryKey: ['dashboard'] }); };
  const act = async (a) => { if (await run(() => post(`/subscriptions/${id}/${a}`))) reload(); };
  if (!s) return <Drawer title={t('loading')} onClose={onClose}><p>{t('loading')}</p></Drawer>;
  return (
    <Drawer title={s.customer_name || s.username} onClose={onClose}
      actions={['active', 'expired', 'pending'].includes(s.status) && <button className="btn primary" onClick={() => setRenew(true)}>{t('renew')}</button>}>
      <dl className="kv">
        <dt>{t('status')}</dt><dd><Status value={s.status} /> {s.session && <span className="tag">{t('online')}</span>}</dd>
        <dt>{t('plan')}</dt><dd>{s.plan_name} — {speed(s.rate_down_kbps)} — {money(s.plan_price)}</dd>
        <dt>{t('expires')}</dt><dd>{dateTime(s.expires_at, lang)}{s.expires_at && s.status === 'active' && <span className="muted"> ({daysUntil(s.expires_at)} j)</span>}</dd>
        <dt>{t('username')}</dt><dd className="mono">{s.username} <CopyButton text={s.username} /></dd>
        <dt>{t('pppoe_password')}</dt><dd className="mono">{s.password} <CopyButton text={s.password} /></dd>
        <dt>{t('phone')}</dt><dd>{s.customer_phone || '—'}</dd>
        <dt>{t('address')}</dt><dd>{s.customer_address || '—'}</dd>
        <dt>{t('router')}</dt><dd>{s.router_name || t('all')}</dd>
        {s.static_ip && <><dt>{t('static_ip')}</dt><dd className="mono">{s.static_ip}</dd></>}
        {s.session && <><dt>{t('ip')}</dt><dd className="mono">{s.session.ip} — {s.session.mac}</dd></>}
        <dt>{t('usage_period')}</dt><dd>{bytes(s.period_bytes, lang)}</dd>
      </dl>
      <div className="row" style={{ marginTop: 18 }}>
        <select className="in" style={{ width: 'auto' }} value={s.plan_id} disabled={busy} aria-label={t('change_plan')}
          onChange={async (e) => { if (await run(() => patch(`/subscriptions/${id}`, { plan_id: e.target.value }))) reload(); }}>
          {(plans.data?.plans || []).filter((p) => p.active || p.id === s.plan_id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {s.status === 'suspended'
          ? <button className="btn" disabled={busy} onClick={() => act('resume')}>{t('resume')}</button>
          : s.status !== 'cancelled' && <button className="btn" disabled={busy} onClick={() => act('suspend')}>{t('suspend')}</button>}
        {s.session && <button className="btn" disabled={busy} onClick={() => act('disconnect')}>{t('disconnect')}</button>}
        {s.status !== 'cancelled' && <ConfirmButton className="btn danger" danger question={t('cancel_sub_confirm', { user: s.username })} onConfirm={() => act('cancel')}>{t('cancel_sub')}</ConfirmButton>}
      </div>
      <h3 style={{ margin: '24px 0 8px', fontSize: 15 }}>{t('invoices')}</h3>
      {!d.data.invoices.length ? <p className="muted">{t('none')}</p> : (
        <table className="tbl"><tbody>
          {d.data.invoices.map((i) => <tr key={i.id}><td className="mono">{i.number}</td><td>{date(i.period_start, lang)} – {date(i.period_end, lang)}</td><td className="n">{money(i.amount)}</td></tr>)}
        </tbody></table>
      )}
      <h3 style={{ margin: '24px 0 8px', fontSize: 15 }}>{t('sessions')}</h3>
      {!d.data.sessions.length ? <p className="muted">{t('none')}</p> : (
        <table className="tbl"><tbody>
          {d.data.sessions.map((x) => (
            <tr key={x.acctstarttime}><td>{dateTime(x.acctstarttime, lang)}<span className="sub">{x.acctstoptime ? x.acctterminatecause : t('online')}</span></td>
              <td className="n">{duration(x.acctsessiontime)}</td><td className="n">{bytes(Number(x.acctinputoctets || 0) + Number(x.acctoutputoctets || 0), lang)}</td></tr>
          ))}
        </tbody></table>
      )}
      {renew && <RenewForm sub={s} onClose={() => setRenew(false)} onDone={() => { setRenew(false); reload(); }} />}
    </Drawer>
  );
}

export default function Subscribers() {
  const { t, lang } = useI18n();
  const { me } = useAuth();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') || '';
  const expiring = params.get('expiring_days') || '';
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState(params.get('open'));
  const limit = 50;
  const list = useQuery({
    queryKey: ['subscriptions', status, expiring, q, offset],
    queryFn: () => get(`/subscriptions${qs({ status, expiring_days: expiring, q, limit, offset })}`),
  });
  const set = (k, v) => { const p = new URLSearchParams(params); p.delete('status'); p.delete('expiring_days'); if (v) p.set(k, v); setParams(p, { replace: true }); setOffset(0); };
  const filter = expiring ? 'expiring' : status;
  return (
    <>
      <PageHead title={t('subscribers_title')} sub={list.data ? `${list.data.total}` : ''}>
        <button className="btn primary" onClick={() => setAdding(true)}><Icon name="plus" />{t('add_subscriber')}</button>
      </PageHead>
      <div className="toolbar">
        <Seg value={filter} onChange={(x) => (x === 'expiring' ? set('expiring_days', '7') : set('status', x))}
          options={[['', t('all')], ['active', t('st_active')], ['expiring', t('expiring_7')], ['expired', t('st_expired')], ['suspended', t('st_suspended')], ['pending', t('st_pending')]]} />
        <input className="in" type="search" placeholder={`${t('search')} (${t('name').toLowerCase()}, ${t('phone_short')}, ${t('username').toLowerCase()})`} value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} />
      </div>
      <section className="panel table-wrap">
        {!list.data?.subscriptions?.length ? <Empty title={list.isLoading ? t('loading') : t('none')} action={<button className="btn primary" onClick={() => setAdding(true)}>{t('add_subscriber')}</button>} /> : (
          <>
            <table className="tbl">
              <thead><tr><th>{t('customer')}</th><th>{t('username')}</th><th>{t('plan')}</th><th>{t('status')}</th><th>{t('expires')}</th><th className="n">{t('price')}</th></tr></thead>
              <tbody>
                {list.data.subscriptions.map((s) => (
                  <tr key={s.id} className="click" onClick={() => setOpen(s.id)}>
                    <td><b>{s.customer_name || '—'}</b><span className="sub">{s.customer_phone}</span></td>
                    <td className="mono">{s.username}{s.session && <span className="tag" style={{ marginLeft: 8 }}>{t('online')}</span>}</td>
                    <td>{s.plan_name}</td>
                    <td><Status value={s.status} /></td>
                    <td>{s.expires_at ? date(s.expires_at, lang) : '—'}</td>
                    <td className="n">{money(s.plan_price, me.tenant?.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager offset={offset} limit={limit} total={list.data.total} onChange={setOffset} />
          </>
        )}
      </section>
      {adding && <SubscriberForm onClose={() => setAdding(false)} onSaved={(s) => { setAdding(false); qc.invalidateQueries({ queryKey: ['subscriptions'] }); setOpen(s.id); }} />}
      {open && <SubscriberDrawer id={open} onClose={() => setOpen(null)} />}
    </>
  );
}
