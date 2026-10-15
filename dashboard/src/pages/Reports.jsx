import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useI18n } from '../i18n.js';
import { useAuth } from '../App.jsx';
import { get, qs, download } from '../api.js';
import { money, num, bytes } from '../format.js';
import { PageHead, Empty, Field, Icon } from '../components/ui.jsx';

const iso = (d) => d.toISOString().slice(0, 10);

export default function Reports() {
  const { t, lang } = useI18n();
  const { me } = useAuth();
  const cur = me.tenant?.currency;
  const now = new Date();
  const [from, setFrom] = useState(iso(new Date(now.getFullYear(), now.getMonth(), 1)));
  const [to, setTo] = useState(iso(now));
  const [tab, setTab] = useState('revenue');
  const [group, setGroup] = useState('day');
  // "to" is inclusive for people; the API takes an exclusive end
  const range = { from: new Date(`${from}T00:00:00`).toISOString(), to: new Date(new Date(`${to}T00:00:00`).getTime() + 86400000).toISOString() };
  const rev = useQuery({ queryKey: ['reports', 'revenue', from, to, group], queryFn: () => get(`/reports/revenue${qs({ ...range, group })}`), enabled: tab === 'revenue' });
  const subs = useQuery({ queryKey: ['reports', 'subs', from, to], queryFn: () => get(`/reports/subscribers${qs(range)}`), enabled: tab === 'subscribers' });
  const usage = useQuery({ queryKey: ['reports', 'usage', from, to], queryFn: () => get(`/reports/usage${qs(range)}`), enabled: tab === 'usage' });
  const agents = useQuery({ queryKey: ['reports', 'agents', from, to], queryFn: () => get(`/reports/agents${qs(range)}`), enabled: tab === 'agents' });
  const gLabel = (k) => {
    if (group === 'day') return new Date(`${k}T12:00:00`).toLocaleDateString(lang === 'en' ? 'en-GB' : 'fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
    if (group === 'purpose') return t(`p_${k}`);
    if (group === 'channel') { const [c, w] = String(k).split(':'); return t(`ch_${w || c}`); }
    return k;
  };
  return (
    <>
      <PageHead title={t('reports_title')}>
        <Field label={t('from')}><input className="in" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label={t('to')}><input className="in" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
      </PageHead>
      <div className="tabs" role="tablist">
        {[['revenue', t('revenue')], ['subscribers', t('subscriber_movement')], ['usage', t('usage')], ['agents', t('agent_sales')]].map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {tab === 'revenue' && (
        <section className="panel">
          <header>
            <h2>{t('total')}: {money(rev.data?.total || 0, cur)}</h2>
            <div className="row">
              <select className="in" style={{ width: 'auto' }} value={group} onChange={(e) => setGroup(e.target.value)} aria-label={t('group_by')}>
                {['day', 'channel', 'purpose', 'package', 'site', 'agent'].map((g) => <option key={g} value={g}>{t('group_by')}: {t(`g_${g}`)}</option>)}
              </select>
              <button className="btn" onClick={() => download(`/reports/revenue${qs({ ...range, group, format: 'csv' })}`, `revenue-${group}-${from}-${to}.csv`)}><Icon name="download" />{t('export_csv')}</button>
            </div>
          </header>
          <div className="body flush table-wrap">
            {!rev.data?.rows?.length ? <Empty title={rev.isLoading ? t('loading') : t('none')} /> : (
              <table className="tbl">
                <thead><tr><th>{t(`g_${group}`)}</th><th className="n">{t('nav_payments')}</th><th className="n">{t('amount')}</th><th className="n">%</th></tr></thead>
                <tbody>{rev.data.rows.map((r) => (
                  <tr key={r.key}><td>{gLabel(r.key)}</td><td className="n">{r.payments}</td><td className="n"><b>{money(r.amount, cur)}</b></td>
                    <td className="n muted">{rev.data.total ? Math.round((100 * r.amount) / rev.data.total) : 0}%</td></tr>
                ))}</tbody>
              </table>
            )}
          </div>
        </section>
      )}

      {tab === 'subscribers' && subs.data && (
        <div className="facts" style={{ gridTemplateColumns: 'repeat(5, minmax(0,1fr))' }}>
          <div><b>{subs.data.new}</b><span>{t('new_subs')}</span></div>
          <div><b>{subs.data.renewed}</b><span>{t('renewed')}</span></div>
          <div className={subs.data.lapsed ? 'attn' : ''}><b>{subs.data.lapsed}</b><span>{t('lapsed')}</span></div>
          <div><b>{subs.data.active}</b><span>{t('st_active')}</span></div>
          <div><b>{money(subs.data.arpu, cur)}</b><span>{t('arpu')}</span></div>
        </div>
      )}

      {tab === 'usage' && (
        <div className="grid-halves">
          <section className="panel">
            <header><h2>{t('usage')}</h2></header>
            <div className="body flush table-wrap">
              {!usage.data?.days?.length ? <Empty title={usage.isLoading ? t('loading') : t('none')} /> : (
                <table className="tbl"><thead><tr><th>{t('date')}</th><th className="n">{t('sessions')}</th><th className="n">{t('data')}</th></tr></thead>
                  <tbody>{usage.data.days.map((d) => <tr key={d.day}><td>{d.day}</td><td className="n">{num(d.sessions)}</td><td className="n">{bytes(d.bytes, lang)}</td></tr>)}</tbody></table>
              )}
            </div>
          </section>
          <section className="panel">
            <header><h2>{t('top_users')}</h2></header>
            <div className="body flush table-wrap">
              {!usage.data?.top?.length ? <Empty title={t('none')} /> : (
                <table className="tbl"><tbody>{usage.data.top.map((u) => (
                  <tr key={u.username + u.type}><td className="mono">{u.username}<span className="sub">{t(u.type)}</span></td><td className="n">{u.sessions}</td><td className="n"><b>{bytes(u.bytes, lang)}</b></td></tr>
                ))}</tbody></table>
              )}
            </div>
          </section>
        </div>
      )}

      {tab === 'agents' && (
        <section className="panel table-wrap">
          {!agents.data?.rows?.length ? <Empty title={agents.isLoading ? t('loading') : t('none')} /> : (
            <table className="tbl">
              <thead><tr><th>{t('agent')}</th><th className="n">{t('vouchers_title')}</th><th className="n">{t('used_count')}</th><th className="n">{t('face_value')}</th><th className="n">{t('paid_to_you')}</th></tr></thead>
              <tbody>{agents.data.rows.map((a) => (
                <tr key={a.id}><td><b>{a.name}</b></td><td className="n">{a.vouchers}</td><td className="n">{a.used}</td><td className="n">{money(a.face_value, cur)}</td><td className="n"><b>{money(a.paid_to_operator, cur)}</b></td></tr>
              ))}</tbody>
            </table>
          )}
        </section>
      )}
    </>
  );
}
