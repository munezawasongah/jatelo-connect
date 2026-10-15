import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../i18n.js';
import { useAuth } from '../App.jsx';
import { get, post, qs, download } from '../api.js';
import { money, minutes, bytes, dateTime, date, speed } from '../format.js';
import { PageHead, Empty, Modal, Drawer, Field, useForm, useSubmit, Status, Pager, Icon, useToast } from '../components/ui.jsx';

/** A4 sheet of 40 cut-out vouchers; only visible when printing. */
function PrintSheet({ data, onDone }) {
  const { t, lang } = useI18n();
  useEffect(() => {
    const id = setTimeout(() => { window.print(); onDone(); }, 200);
    return () => clearTimeout(id);
  }, [onDone]);
  const b = data.batch;
  const desc = [minutes(b.duration_minutes, lang), b.data_limit_mb ? `${b.data_limit_mb >= 1024 ? `${+(b.data_limit_mb / 1024).toFixed(1)} Go` : `${b.data_limit_mb} Mo`}` : null, b.rate_down_kbps ? speed(b.rate_down_kbps) : null].filter((x) => x && x !== '—').join(', ');
  return createPortal(
    <div className="sheet">
      {data.vouchers.filter((v) => v.status === 'unused').map((v) => (
        <div className="v" key={v.code}>
          <b>{data.brand || 'WiFi'}</b>
          <div className="c">{v.code}</div>
          <div>{b.package_name}, {desc}. {money(b.price)}</div>
          <small>{t('voucher_instructions')}</small>
        </div>
      ))}
    </div>,
    document.body,
  );
}

function BatchForm({ onClose, onDone }) {
  const { t } = useI18n();
  const { me } = useAuth();
  const pk = useQuery({ queryKey: ['packages'], queryFn: () => get('/packages') });
  const ag = useQuery({ queryKey: ['agents'], queryFn: () => get('/agents') });
  const [v, , bind] = useForm({ package_id: '', quantity: 40, agent_id: '', charge_agent: false, note: '' });
  const { run, busy, errors } = useSubmit();
  const pkgs = (pk.data?.packages || []).filter((p) => p.active && !p.is_trial);
  const p = pkgs.find((x) => x.id === v.package_id);
  return (
    <Modal title={t('new_batch')} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>{t('cancel')}</button><button className="btn primary" form="batch" disabled={busy}>{t('new_batch')}</button>
    </>}>
      <form id="batch" className="form-grid" onSubmit={async (e) => {
        e.preventDefault();
        const r = await run(() => post('/vouchers/batches', { package_id: v.package_id, quantity: Number(v.quantity), agent_id: v.agent_id || null, charge_agent: v.charge_agent, note: v.note || null }));
        if (r) onDone(r.batch);
      }}>
        <Field label={t('package')} full error={errors.package_id}>
          <select className="in" required {...bind('package_id')}>
            <option value="">—</option>
            {pkgs.map((x) => <option key={x.id} value={x.id}>{x.name} ({money(x.price, me.tenant?.currency)})</option>)}
          </select>
        </Field>
        <Field label={t('quantity')} hint={t('print_sheet') + ': 40 / A4'} error={errors.quantity}><input className="in" type="number" min="1" max="5000" required {...bind('quantity')} /></Field>
        <Field label={t('agent')} optional>
          <select className="in" {...bind('agent_id')}>
            <option value="">—</option>
            {(ag.data?.agents || []).filter((a) => a.active).map((a) => <option key={a.id} value={a.id}>{a.name} ({money(a.balance, me.tenant?.currency)})</option>)}
          </select>
        </Field>
        {v.agent_id && <label className="check full"><input type="checkbox" {...bind('charge_agent', 'checkbox')} />{t('charge_agent')}</label>}
        <Field label={t('notes')} optional full><input className="in" {...bind('note')} /></Field>
        {p && <p className="full muted" style={{ margin: 0 }}>{t('total')}: <b>{money(p.price * Number(v.quantity || 0), me.tenant?.currency)}</b></p>}
      </form>
    </Modal>
  );
}

function SellForm({ onClose }) {
  const { t } = useI18n();
  const { me } = useAuth();
  const qc = useQueryClient();
  const pk = useQuery({ queryKey: ['packages'], queryFn: () => get('/packages') });
  const [v, , bind] = useForm({ package_id: '', phone: '' });
  const [sold, setSold] = useState(null);
  const { run, busy, errors } = useSubmit();
  return (
    <Modal title={sold ? t('code_sold') : t('sell_one')} onClose={onClose} footer={sold
      ? <button className="btn primary" onClick={onClose}>{t('close')}</button>
      : <><button className="btn" onClick={onClose}>{t('cancel')}</button><button className="btn primary" form="sell" disabled={busy}>{t('sell_one')}</button></>}>
      {sold ? (
        <div className="stack">
          <div className="bigcode code-text">{sold.code}</div>
          <p style={{ textAlign: 'center', margin: 0 }}>{sold.package_name} — {sold.description}</p>
          <p className="muted" style={{ textAlign: 'center', margin: 0 }}>{t('give_code')}</p>
        </div>
      ) : (
        <form id="sell" className="stack" onSubmit={async (e) => {
          e.preventDefault();
          const r = await run(() => post('/vouchers/sell', { package_id: v.package_id, phone: v.phone || undefined }), false);
          if (r) { setSold(r.voucher); qc.invalidateQueries({ queryKey: ['vouchers'] }); qc.invalidateQueries({ queryKey: ['dashboard'] }); }
        }}>
          <Field label={t('package')} error={errors.package_id}>
            <select className="in" required {...bind('package_id')}>
              <option value="">—</option>
              {(pk.data?.packages || []).filter((x) => x.active && !x.is_trial).map((x) => <option key={x.id} value={x.id}>{x.name} ({money(x.price, me.tenant?.currency)})</option>)}
            </select>
          </Field>
          <Field label={t('buyer_phone')} optional error={errors.phone}><input className="in" type="tel" {...bind('phone')} /></Field>
        </form>
      )}
    </Modal>
  );
}

function VoucherDrawer({ v, onClose, onChanged }) {
  const { t, lang } = useI18n();
  const [mins, setMins] = useState(60);
  const { run, busy } = useSubmit();
  const act = async (path, body) => { if (await run(() => post(`/vouchers/${v.id}/${path}`, body))) onChanged(); };
  const left = v.data_limit_mb ? Math.max(0, v.data_limit_mb * 1048576 - v.bytes_used) : null;
  return (
    <Drawer title={v.code} onClose={onClose}>
      <dl className="kv">
        <dt>{t('status')}</dt><dd><Status value={v.status} /> {v.online && <span className="tag">{t('online')}</span>}</dd>
        <dt>{t('package')}</dt><dd>{v.package_name}</dd>
        <dt>{t('price')}</dt><dd>{money(v.price)}</dd>
        <dt>{t('source')}</dt><dd>{t(`src_${v.source}`)}{v.agent_name ? ` (${v.agent_name})` : ''}</dd>
        <dt>{t('customer')}</dt><dd>{v.customer_phone || '—'}</dd>
        <dt>{t('created')}</dt><dd>{dateTime(v.created_at, lang)}</dd>
        <dt>{t('st_active')}</dt><dd>{dateTime(v.activated_at, lang)}</dd>
        <dt>{t('expires')}</dt><dd>{dateTime(v.expires_at, lang)}</dd>
        <dt>{t('used')}</dt><dd>{bytes(v.bytes_used, lang)}{left != null && <span className="muted"> ({bytes(left, lang)} {t('unused').toLowerCase()})</span>}</dd>
        <dt>{t('device')}</dt><dd className="mono">{v.device_macs?.length ? v.device_macs.join(', ') : '—'} <span className="muted">({v.device_macs?.length || 0}/{v.device_limit})</span></dd>
      </dl>
      <div className="stack" style={{ marginTop: 20 }}>
        <div className="row">
          {v.status === 'disabled'
            ? <button className="btn" disabled={busy} onClick={() => act('enable')}>{t('enable')}</button>
            : <button className="btn danger" disabled={busy} onClick={() => act('disable')}>{t('disable')}</button>}
          {v.device_macs?.length > 0 && <button className="btn" disabled={busy} onClick={() => act('reset-devices')}>{t('reset_devices')}</button>}
        </div>
        {['unused', 'active', 'expired'].includes(v.status) && v.duration_minutes && (
          <form className="row" onSubmit={(e) => { e.preventDefault(); act('extend', { minutes: Number(mins) }); }}>
            <input className="in" type="number" min="1" style={{ width: 110 }} value={mins} onChange={(e) => setMins(e.target.value)} aria-label={t('minutes')} />
            <span className="muted">{t('minutes')}</span>
            <button className="btn" disabled={busy}>{t('extend')}</button>
          </form>
        )}
      </div>
    </Drawer>
  );
}

export default function Vouchers() {
  const { t, lang } = useI18n();
  const { me } = useAuth();
  const cur = me.tenant?.currency;
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'codes';
  const status = params.get('status') || '';
  const packageId = params.get('package_id') || '';
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const [modal, setModal] = useState(null);
  const [open, setOpen] = useState(null);
  const [printing, setPrinting] = useState(null);
  const limit = 50;
  const pk = useQuery({ queryKey: ['packages'], queryFn: () => get('/packages') });
  const list = useQuery({ queryKey: ['vouchers', status, packageId, q, offset], queryFn: () => get(`/vouchers${qs({ status, package_id: packageId, q, limit, offset })}`), enabled: tab === 'codes' });
  const batches = useQuery({ queryKey: ['vouchers', 'batches'], queryFn: () => get('/vouchers/batches'), enabled: tab === 'batches' });
  const set = (k, v) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p, { replace: true }); setOffset(0); };
  const refresh = () => qc.invalidateQueries({ queryKey: ['vouchers'] });
  const printBatch = async (id) => {
    try { setPrinting(await get(`/vouchers/batches/${id}/export`)); } catch (e) { toast(e.message, 'bad'); }
  };

  return (
    <>
      <PageHead title={t('vouchers_title')}>
        <button className="btn" onClick={() => setModal('sell')}>{t('sell_one')}</button>
        <button className="btn primary" onClick={() => setModal('batch')}><Icon name="plus" />{t('new_batch')}</button>
      </PageHead>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'codes'} onClick={() => set('tab', '')}>{t('vouchers_title')}</button>
        <button role="tab" aria-selected={tab === 'batches'} onClick={() => set('tab', 'batches')}>{t('batches')}</button>
      </div>

      {tab === 'codes' ? (
        <>
          <div className="toolbar">
            <select className="in" value={status} onChange={(e) => set('status', e.target.value)} aria-label={t('status')}>
              <option value="">{t('status')}: {t('all')}</option>
              {['unused', 'active', 'expired', 'exhausted', 'disabled'].map((s) => <option key={s} value={s}>{t(`st_${s}`)}</option>)}
            </select>
            <select className="in" value={packageId} onChange={(e) => set('package_id', e.target.value)} aria-label={t('package')}>
              <option value="">{t('package')}: {t('all')}</option>
              {(pk.data?.packages || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <input className="in" type="search" placeholder={`${t('search')} (code, ${t('phone_short')})`} value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} />
          </div>
          <section className="panel table-wrap">
            {!list.data?.vouchers?.length ? <Empty title={list.isLoading ? t('loading') : t('none')} /> : (
              <>
                <table className="tbl">
                  <thead><tr><th>Code</th><th>{t('package')}</th><th>{t('status')}</th><th>{t('source')}</th><th>{t('expires')}</th><th className="n">{t('used')}</th><th className="n">{t('price')}</th></tr></thead>
                  <tbody>
                    {list.data.vouchers.map((v) => (
                      <tr key={v.id} className="click" onClick={() => setOpen(v)}>
                        <td><span className="code-text">{v.code}</span>{v.online && <span className="tag" style={{ marginLeft: 8 }}>{t('online')}</span>}<span className="sub">{v.customer_phone || v.agent_name || ''}</span></td>
                        <td>{v.package_name}</td>
                        <td><Status value={v.status} /></td>
                        <td className="muted">{t(`src_${v.source}`)}</td>
                        <td>{v.expires_at ? dateTime(v.expires_at, lang) : '—'}</td>
                        <td className="n">{v.bytes_used ? bytes(v.bytes_used, lang) : '—'}</td>
                        <td className="n">{money(v.price, cur)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <Pager offset={offset} limit={limit} total={list.data.total} onChange={setOffset} />
              </>
            )}
          </section>
        </>
      ) : (
        <section className="panel table-wrap">
          {!batches.data?.batches?.length ? <Empty title={batches.isLoading ? t('loading') : t('none')} /> : (
            <table className="tbl">
              <thead><tr><th>{t('date')}</th><th>{t('package')}</th><th>{t('agent')}</th><th className="n">{t('quantity')}</th><th className="n">{t('unused')}</th><th className="n">{t('price')}</th><th /></tr></thead>
              <tbody>
                {batches.data.batches.map((b) => (
                  <tr key={b.id}>
                    <td>{date(b.created_at, lang)}<span className="sub">{b.created_by_name}{b.note ? ` — ${b.note}` : ''}</span></td>
                    <td>{b.package_name}</td>
                    <td>{b.agent_name || '—'}</td>
                    <td className="n">{b.quantity}</td>
                    <td className="n">{b.unused}</td>
                    <td className="n">{money(b.unit_price, cur)}</td>
                    <td className="act">
                      <button className="btn small" onClick={() => printBatch(b.id)} disabled={!b.unused}><Icon name="print" size={15} />{t('print')}</button>{' '}
                      <button className="btn small" onClick={() => download(`/vouchers/batches/${b.id}/export?format=csv`, `codes-${b.id.slice(0, 8)}.csv`)}><Icon name="download" size={15} />CSV</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {modal === 'batch' && <BatchForm onClose={() => setModal(null)} onDone={(b) => { setModal(null); refresh(); set('tab', 'batches'); printBatch(b.id); }} />}
      {modal === 'sell' && <SellForm onClose={() => setModal(null)} />}
      {open && <VoucherDrawer v={open} onClose={() => setOpen(null)} onChanged={async () => { await refresh(); setOpen(null); }} />}
      {printing && <PrintSheet data={printing} onDone={() => setPrinting(null)} />}
    </>
  );
}
