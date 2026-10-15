import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../i18n.js';
import { useAuth } from '../App.jsx';
import { get, post, patch } from '../api.js';
import { money, dateTime, minutes } from '../format.js';
import { PageHead, Empty, Modal, Drawer, Field, useForm, useSubmit, Status, Icon } from '../components/ui.jsx';

function AgentForm({ initial, onClose, onSaved }) {
  const { t } = useI18n();
  const [v, , bind] = useForm({ name: '', phone: '', location: '', discount_pct: 10, active: true, ...initial, password: '' });
  const { run, busy, errors } = useSubmit();
  return (
    <Modal title={initial?.id ? t('edit') : t('add_agent')} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>{t('cancel')}</button><button className="btn primary" form="agent" disabled={busy}>{t('save')}</button>
    </>}>
      <form id="agent" className="form-grid" onSubmit={async (e) => {
        e.preventDefault();
        const body = { name: v.name, phone: v.phone || null, location: v.location || null, discount_pct: Number(v.discount_pct), ...(v.password ? { password: v.password } : {}), ...(initial?.id ? { active: v.active } : {}) };
        if (await run(() => (initial?.id ? patch(`/agents/${initial.id}`, body) : post('/agents', body)))) onSaved();
      }}>
        <Field label={t('name')} error={errors.name}><input className="in" required {...bind('name')} placeholder="Boutique Kamenge" /></Field>
        <Field label={t('phone')} error={errors.phone}><input className="in" type="tel" {...bind('phone')} /></Field>
        <Field label={t('location')} optional><input className="in" {...bind('location')} /></Field>
        <Field label={t('discount')} error={errors.discount_pct}><input className="in" type="number" min="0" max="100" step="0.5" {...bind('discount_pct')} /></Field>
        <Field label={t('agent_login')} optional full error={errors.password}><input className="in" type="password" minLength={8} autoComplete="new-password" {...bind('password')} /></Field>
        {initial?.id && <label className="check full"><input type="checkbox" {...bind('active', 'checkbox')} />{t('st_active')}</label>}
      </form>
    </Modal>
  );
}

function AgentDrawer({ agent, onClose, onChanged }) {
  const { t, lang } = useI18n();
  const { me } = useAuth();
  const ledger = useQuery({ queryKey: ['agents', agent.id, 'ledger'], queryFn: () => get(`/agents/${agent.id}/ledger`) });
  const [amount, setAmount] = useState('');
  const [edit, setEdit] = useState(false);
  const { run, busy } = useSubmit();
  return (
    <Drawer title={agent.name} onClose={onClose} actions={<button className="btn" onClick={() => setEdit(true)}>{t('edit')}</button>}>
      <dl className="kv">
        <dt>{t('balance')}</dt><dd><b>{money(agent.balance, me.tenant?.currency)}</b></dd>
        <dt>{t('discount')}</dt><dd>{Number(agent.discount_pct)}%</dd>
        <dt>{t('phone')}</dt><dd>{agent.phone || '—'}</dd>
        <dt>{t('location')}</dt><dd>{agent.location || '—'}</dd>
        <dt>{t('has_login')}</dt><dd>{agent.has_login ? t('yes') : t('no')}</dd>
        <dt>{t('vouchers_title')}</dt><dd>{agent.vouchers_used}/{agent.vouchers_total} {t('used_count').toLowerCase()}</dd>
      </dl>
      <form className="row" style={{ marginTop: 18 }} onSubmit={async (e) => {
        e.preventDefault();
        if (await run(() => post(`/agents/${agent.id}/topup`, { amount: Number(amount) }))) { setAmount(''); onChanged(); ledger.refetch(); }
      }}>
        <input className="in" type="number" min="1" step="100" style={{ width: 160 }} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={t('amount')} aria-label={t('amount')} required />
        <button className="btn primary" disabled={busy}>{t('topup')}</button>
      </form>
      <h3 style={{ margin: '24px 0 8px', fontSize: 15 }}>{t('ledger')}</h3>
      {!ledger.data?.ledger?.length ? <p className="muted">{t('none')}</p> : (
        <table className="tbl"><tbody>{ledger.data.ledger.map((l) => (
          <tr key={l.id}><td>{dateTime(l.created_at, lang)}<span className="sub">{l.kind}{l.user_name ? ` — ${l.user_name}` : ''}</span></td>
            <td className="n" style={{ color: l.amount < 0 ? 'var(--bad)' : 'var(--ok)' }}>{l.amount > 0 ? '+' : ''}{money(l.amount)}</td>
            <td className="n muted">{money(l.balance_after)}</td></tr>
        ))}</tbody></table>
      )}
      {edit && <AgentForm initial={agent} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); onChanged(); }} />}
    </Drawer>
  );
}

export default function Agents() {
  const { t } = useI18n();
  const { me } = useAuth();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['agents'], queryFn: () => get('/agents') });
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState(null);
  const rows = list.data?.agents || [];
  const current = open && rows.find((a) => a.id === open);
  const refresh = () => qc.invalidateQueries({ queryKey: ['agents'] });
  return (
    <>
      <PageHead title={t('agents_title')}><button className="btn primary" onClick={() => setAdding(true)}><Icon name="plus" />{t('add_agent')}</button></PageHead>
      <section className="panel table-wrap">
        {!rows.length ? <Empty title={list.isLoading ? t('loading') : t('none')} action={<button className="btn primary" onClick={() => setAdding(true)}>{t('add_agent')}</button>} /> : (
          <table className="tbl">
            <thead><tr><th>{t('name')}</th><th>{t('phone')}</th><th className="n">{t('discount')}</th><th className="n">{t('vouchers_title')}</th><th className="n">{t('balance')}</th><th>{t('status')}</th></tr></thead>
            <tbody>{rows.map((a) => (
              <tr key={a.id} className="click" onClick={() => setOpen(a.id)}>
                <td><b>{a.name}</b><span className="sub">{a.location}</span></td>
                <td>{a.phone || '—'}</td>
                <td className="n">{Number(a.discount_pct)}%</td>
                <td className="n">{a.vouchers_used}/{a.vouchers_total}</td>
                <td className="n"><b>{money(a.balance, me.tenant?.currency)}</b></td>
                <td><Status value={a.active ? 'active' : 'disabled'} /></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>
      {adding && <AgentForm onClose={() => setAdding(false)} onSaved={() => { setAdding(false); refresh(); }} />}
      {current && <AgentDrawer agent={current} onClose={() => setOpen(null)} onChanged={refresh} />}
    </>
  );
}

/** What a logged-in agent sees: balance, buy codes at their price, recent codes. */
export function AgentHome() {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const d = useQuery({ queryKey: ['agent'], queryFn: () => get('/agent') });
  const [buy, setBuy] = useState(null);
  const [qty, setQty] = useState(1);
  const [bought, setBought] = useState(null);
  const { run, busy } = useSubmit();
  if (!d.data) return <Empty title={d.isLoading ? t('loading') : t('none')} />;
  const a = d.data.agent;
  return (
    <>
      <section className="pulse">
        <div><div className="money-label">{t('my_balance')}</div><div className="money">{money(a.balance).replace(' BIF', '')}<small>BIF</small></div>
          <div className="sub">{t('discount')}: {a.discount_pct}%</div></div>
      </section>
      <section className="panel" style={{ marginBottom: 16 }}>
        <header><h2>{t('buy_codes')}</h2></header>
        <div className="body flush table-wrap">
          <table className="tbl">
            <thead><tr><th>{t('package')}</th><th className="n">{t('price')}</th><th className="n">{t('your_price')}</th><th /></tr></thead>
            <tbody>{d.data.packages.map((p) => (
              <tr key={p.id}><td><b>{p.name}</b><span className="sub">{minutes(p.duration_minutes, lang)}</span></td><td className="n muted">{money(p.price)}</td><td className="n"><b>{money(p.agent_price)}</b></td>
                <td className="act"><button className="btn small primary" onClick={() => { setBuy(p); setQty(1); }}>{t('buy_codes')}</button></td></tr>
            ))}</tbody>
          </table>
        </div>
      </section>
      <section className="panel">
        <header><h2>{t('recent_codes')}</h2></header>
        <div className="body flush table-wrap">
          {!d.data.recent.length ? <Empty title={t('none')} /> : (
            <table className="tbl"><tbody>{d.data.recent.map((v) => (
              <tr key={v.code}><td className="code-text">{v.code}</td><td>{v.package_name}</td><td><Status value={v.status} /></td><td className="n">{dateTime(v.created_at, lang)}</td></tr>
            ))}</tbody></table>
          )}
        </div>
      </section>
      {buy && (
        <Modal title={bought ? t('bought') : `${t('buy_codes')}: ${buy.name}`} onClose={() => { setBuy(null); setBought(null); }} footer={bought
          ? <button className="btn primary" onClick={() => { setBuy(null); setBought(null); }}>{t('close')}</button>
          : <button className="btn primary" disabled={busy} onClick={async () => {
            const r = await run(() => post('/agent/vouchers', { package_id: buy.id, quantity: Number(qty) }), false);
            if (r) { setBought(r); qc.invalidateQueries({ queryKey: ['agent'] }); }
          }}>{t('confirm')} — {money(buy.agent_price * Number(qty || 0))}</button>}>
          {bought ? (
            <div className="stack">
              {bought.vouchers.map((v) => <div key={v.code} className="bigcode code-text" style={{ fontSize: 26, padding: 10 }}>{v.code}</div>)}
              <p className="muted" style={{ margin: 0 }}>{t('balance')}: {money(bought.balance)}</p>
            </div>
          ) : (
            <Field label={t('quantity')}><input className="in" type="number" min="1" max="200" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
          )}
        </Modal>
      )}
    </>
  );
}
