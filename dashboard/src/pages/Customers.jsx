import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../i18n.js';
import { useAuth } from '../App.jsx';
import { get, patch, qs } from '../api.js';
import { money, date, dateTime } from '../format.js';
import { PageHead, Empty, Drawer, Field, useForm, useSubmit, Status, Pager } from '../components/ui.jsx';

function CustomerDrawer({ id, onClose }) {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const d = useQuery({ queryKey: ['customers', id], queryFn: () => get(`/customers/${id}`) });
  const c = d.data?.customer;
  const [v, setV, bind] = useForm({});
  const { run, busy, errors } = useSubmit();
  if (!c) return <Drawer title={t('loading')} onClose={onClose}><p>{t('loading')}</p></Drawer>;
  const val = { name: c.name || '', phone: c.phone || '', address: c.address || '', notes: c.notes || '', ...v };
  return (
    <Drawer title={c.name || c.phone} onClose={onClose}>
      <form className="form-grid" onSubmit={async (e) => {
        e.preventDefault();
        if (await run(() => patch(`/customers/${id}`, { name: val.name || null, phone: val.phone || null, address: val.address || null, notes: val.notes || null }))) {
          setV({}); qc.invalidateQueries({ queryKey: ['customers'] });
        }
      }}>
        <Field label={t('name')} error={errors.name}><input className="in" {...bind('name')} value={val.name} /></Field>
        <Field label={t('phone')} error={errors.phone}><input className="in" type="tel" {...bind('phone')} value={val.phone} /></Field>
        <Field label={t('address')} full><input className="in" {...bind('address')} value={val.address} /></Field>
        <Field label={t('notes')} full><textarea className="in" rows="2" {...bind('notes')} value={val.notes} /></Field>
        <div className="full"><button className="btn primary" disabled={busy || !Object.keys(v).length}>{t('save')}</button></div>
      </form>
      <h3 style={{ margin: '24px 0 8px', fontSize: 15 }}>{t('nav_subscribers')}</h3>
      {!d.data.subscriptions.length ? <p className="muted">{t('none')}</p> : (
        <table className="tbl"><tbody>{d.data.subscriptions.map((s) => (
          <tr key={s.id}><td className="mono">{s.username}</td><td>{s.plan_name}</td><td><Status value={s.status} /></td><td className="n">{date(s.expires_at, lang)}</td></tr>
        ))}</tbody></table>
      )}
      <h3 style={{ margin: '24px 0 8px', fontSize: 15 }}>{t('vouchers_bought')}</h3>
      {!d.data.vouchers.length ? <p className="muted">{t('none')}</p> : (
        <table className="tbl"><tbody>{d.data.vouchers.map((v2) => (
          <tr key={v2.id}><td className="code-text">{v2.code}</td><td>{v2.package_name}</td><td><Status value={v2.status} /></td><td className="n">{date(v2.created_at, lang)}</td></tr>
        ))}</tbody></table>
      )}
      <h3 style={{ margin: '24px 0 8px', fontSize: 15 }}>{t('nav_payments')}</h3>
      {!d.data.payments.length ? <p className="muted">{t('none')}</p> : (
        <table className="tbl"><tbody>{d.data.payments.map((p) => (
          <tr key={p.id}><td>{dateTime(p.created_at, lang)}<span className="sub">{t(`p_${p.purpose}`)} — {t(`ch_${p.channel}`)}</span></td><td><Status value={p.status} /></td><td className="n">{money(p.amount)}</td></tr>
        ))}</tbody></table>
      )}
    </Drawer>
  );
}

export default function Customers() {
  const { t, lang } = useI18n();
  const { me } = useAuth();
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState(null);
  const limit = 50;
  const list = useQuery({ queryKey: ['customers', q, offset], queryFn: () => get(`/customers${qs({ q, limit, offset })}`) });
  return (
    <>
      <PageHead title={t('customers_title')} sub={list.data ? String(list.data.total) : ''} />
      <div className="toolbar"><input className="in" type="search" placeholder={t('search')} value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} /></div>
      <section className="panel table-wrap">
        {!list.data?.customers?.length ? <Empty title={list.isLoading ? t('loading') : t('none')} /> : (
          <>
            <table className="tbl">
              <thead><tr><th>{t('name')}</th><th>{t('phone')}</th><th className="n">{t('nav_subscribers')}</th><th className="n">{t('vouchers_bought')}</th><th className="n">{t('total_paid')}</th><th className="n">{t('created')}</th></tr></thead>
              <tbody>
                {list.data.customers.map((c) => (
                  <tr key={c.id} className="click" onClick={() => setOpen(c.id)}>
                    <td><b>{c.name || '—'}</b><span className="sub">{c.address}</span></td>
                    <td>{c.phone}</td>
                    <td className="n">{c.subscriptions}</td>
                    <td className="n">{c.vouchers}</td>
                    <td className="n">{money(c.total_paid, me.tenant?.currency)}</td>
                    <td className="n">{date(c.created_at, lang)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager offset={offset} limit={limit} total={list.data.total} onChange={setOffset} />
          </>
        )}
      </section>
      {open && <CustomerDrawer id={open} onClose={() => setOpen(null)} />}
    </>
  );
}
