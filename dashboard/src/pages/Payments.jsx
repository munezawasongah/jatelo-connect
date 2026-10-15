import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../i18n.js';
import { useAuth } from '../App.jsx';
import { get, post, qs } from '../api.js';
import { money, dateTime } from '../format.js';
import { PageHead, Empty, Modal, Field, useForm, useSubmit, Status, Pager, Seg, ConfirmButton } from '../components/ui.jsx';

function ConfirmPayment({ p, onClose, onDone }) {
  const { t } = useI18n();
  const { me } = useAuth();
  const [v, , bind] = useForm({ txn_id: '', reason: '' });
  const [code, setCode] = useState(null);
  const { run, busy, errors } = useSubmit();
  const canManual = ['owner', 'manager', 'platform_admin'].includes(me.user.role);
  return (
    <Modal title={code ? t('code_sold') : `${t('confirm_payment')}: ${p.reference}`} onClose={code ? onDone : onClose} footer={code
      ? <button className="btn primary" onClick={onDone}>{t('close')}</button>
      : <><button className="btn" onClick={onClose}>{t('cancel')}</button><button className="btn primary" form="confirm-pay" disabled={busy}>{t('confirm')}</button></>}>
      {code ? <div className="bigcode code-text">{code}</div> : (
        <form id="confirm-pay" className="stack" onSubmit={async (e) => {
          e.preventDefault();
          const r = await run(() => post(`/payments/${p.id}/confirm`, v.txn_id ? { txn_id: v.txn_id } : { reason: v.reason }));
          if (r) { if (r.voucher?.code) setCode(r.voucher.code); else onDone(); }
        }}>
          <p style={{ margin: 0 }}>{money(p.amount, me.tenant?.currency)} — {p.phone} — {p.item_name}</p>
          <Field label={t('txn_id')} error={errors.txn_id}><input className="in mono" {...bind('txn_id')} autoFocus /></Field>
          {canManual && <Field label={t('manual_reason')} optional error={errors.reason}><input className="in" {...bind('reason')} disabled={Boolean(v.txn_id)} /></Field>}
        </form>
      )}
    </Modal>
  );
}

export default function Payments() {
  const { t, lang } = useI18n();
  const { me } = useAuth();
  const cur = me.tenant?.currency;
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'payments';
  const status = params.get('status') || '';
  const purpose = params.get('purpose') || '';
  const [unmatched, setUnmatched] = useState(true);
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const [confirm, setConfirm] = useState(null);
  const limit = 50;
  const list = useQuery({ queryKey: ['payments', status, purpose, q, offset], queryFn: () => get(`/payments${qs({ status, purpose, q, limit, offset })}`), enabled: tab === 'payments' });
  const sms = useQuery({ queryKey: ['payments', 'sms', unmatched], queryFn: () => get(`/payments/inbound-sms${qs({ unmatched: unmatched ? 'true' : '' })}`), enabled: tab === 'sms' });
  const set = (k, v) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p, { replace: true }); setOffset(0); };
  const refresh = () => { qc.invalidateQueries({ queryKey: ['payments'] }); qc.invalidateQueries({ queryKey: ['dashboard'] }); };

  return (
    <>
      <PageHead title={t('payments_title')} sub={tab === 'payments' && list.data ? `${t('collected')}: ${money(list.data.collected, cur)}` : ''} />
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'payments'} onClick={() => set('tab', '')}>{t('payments_title')}</button>
        <button role="tab" aria-selected={tab === 'sms'} onClick={() => set('tab', 'sms')}>{t('inbound_sms')}</button>
      </div>
      {tab === 'payments' ? (
        <>
          <div className="toolbar">
            <Seg value={status} onChange={(v) => set('status', v)} options={[['', t('all')], ['success', t('st_success')], ['pending', t('st_pending')], ['expired', t('st_expired')], ['failed', t('st_failed')]]} />
            <select className="in" value={purpose} onChange={(e) => set('purpose', e.target.value)} aria-label={t('type')}>
              <option value="">{t('type')}: {t('all')}</option>
              {['hotspot', 'subscription', 'agent_topup'].map((p) => <option key={p} value={p}>{t(`p_${p}`)}</option>)}
            </select>
            <input className="in" type="search" placeholder={`${t('search')} (${t('reference').toLowerCase()}, ${t('phone_short')})`} value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} />
          </div>
          <section className="panel table-wrap">
            {!list.data?.payments?.length ? <Empty title={list.isLoading ? t('loading') : t('none')} /> : (
              <>
                <table className="tbl">
                  <thead><tr><th>{t('date')}</th><th>{t('details')}</th><th>{t('customer')}</th><th>{t('channel')}</th><th>{t('status')}</th><th className="n">{t('amount')}</th><th /></tr></thead>
                  <tbody>{list.data.payments.map((p) => (
                    <tr key={p.id}>
                      <td>{dateTime(p.confirmed_at || p.created_at, lang)}<span className="sub mono">{p.reference}</span></td>
                      <td>{p.item_name || t(`p_${p.purpose}`)}<span className="sub">{t(`p_${p.purpose}`)}</span></td>
                      <td>{p.customer_name || p.phone || '—'}<span className="sub">{p.customer_name ? p.phone : ''}</span></td>
                      <td>{t(`ch_${p.wallet || p.channel}`)}<span className="sub mono">{p.external_ref || p.recorded_by_name || ''}</span></td>
                      <td><Status value={p.status} /></td>
                      <td className="n"><b>{money(p.amount, cur)}</b></td>
                      <td className="act">
                        {['pending', 'expired'].includes(p.status) && <>
                          <button className="btn small primary" onClick={() => setConfirm(p)}>{t('confirm')}</button>{' '}
                          <ConfirmButton className="btn small" question={`${t('cancel')} ${p.reference} ?`} onConfirm={async () => { await post(`/payments/${p.id}/cancel`); refresh(); }}>{t('cancel')}</ConfirmButton>
                        </>}
                      </td>
                    </tr>
                  ))}</tbody>
                </table>
                <Pager offset={offset} limit={limit} total={list.data.total} onChange={setOffset} />
              </>
            )}
          </section>
        </>
      ) : (
        <>
          <div className="toolbar"><label className="check"><input type="checkbox" checked={unmatched} onChange={(e) => setUnmatched(e.target.checked)} />{t('unmatched_only')}</label></div>
          <section className="panel table-wrap">
            {!sms.data?.messages?.length ? <Empty title={sms.isLoading ? t('loading') : t('none')} /> : (
              <table className="tbl">
                <thead><tr><th>{t('date')}</th><th>SMS</th><th>{t('txn_id')}</th><th>{t('phone')}</th><th className="n">{t('amount')}</th><th>{t('matched_to')}</th></tr></thead>
                <tbody>{sms.data.messages.map((m) => (
                  <tr key={m.id}>
                    <td>{dateTime(m.received_at, lang)}<span className="sub">{m.sender}</span></td>
                    <td style={{ maxWidth: 380 }} className="small">{m.body}</td>
                    <td className="mono">{m.parsed_txn_id || '—'}</td>
                    <td>{m.parsed_phone || '—'}<span className="sub">{m.parsed_name}</span></td>
                    <td className="n">{m.parsed_amount ? money(m.parsed_amount, cur) : '—'}</td>
                    <td className="mono">{m.matched_reference || '—'}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </section>
        </>
      )}
      {confirm && <ConfirmPayment p={confirm} onClose={() => setConfirm(null)} onDone={() => { setConfirm(null); refresh(); }} />}
    </>
  );
}
