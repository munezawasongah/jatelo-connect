import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useI18n } from '../i18n.js';
import { useAuth } from '../App.jsx';
import { get, post } from '../api.js';
import { money, num, date, ago, dateTime } from '../format.js';
import { Status, useLive, useSubmit, Empty } from '../components/ui.jsx';
import { RevenueChart } from '../components/charts.jsx';

export default function Home() {
  const { t, lang } = useI18n();
  const { me } = useAuth();
  const cur = me.tenant?.currency || 'BIF';
  const summary = useQuery({ queryKey: ['dashboard', 'summary'], queryFn: () => get('/dashboard/summary'), refetchInterval: 60_000 });
  const routers = useQuery({ queryKey: ['routers'], queryFn: () => get('/routers') });
  const revenue = useQuery({ queryKey: ['dashboard', 'revenue', 30], queryFn: () => get('/dashboard/revenue?days=30') });
  const { last } = useLive();
  const [beat, setBeat] = useState(false);
  const seen = useRef(null);
  useEffect(() => {
    if (last?.type === 'payment' && last.at !== seen.current) {
      seen.current = last.at; setBeat(true);
      const id = setTimeout(() => setBeat(false), 1300);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [last]);

  const s = summary.data;
  const k = s?.kpis || {};
  const list = routers.data?.routers || [];
  const needsSetup = s && (!k.routers_total || !k.channels || !k.gateways);

  return (
    <>
      <section className="pulse" aria-live="polite">
        <div>
          <div className="money-label"><span className={`live-dot ${beat ? 'beat' : ''}`} />{t('collected_today')}</div>
          <div className={`money ${beat ? 'flash' : ''}`}>{num(k.revenue_today)}<small>{cur}</small></div>
          <div className="sub">{t('vs_yesterday', { amount: money(k.revenue_yesterday, cur) })} — {t('this_month')} {money(k.revenue_month, cur)}</div>
        </div>
        <div className="side">
          <Link className="stat" to="/sessions?type=hotspot" style={{ color: '#fff', textDecoration: 'none' }}><b>{num(k.online_hotspot)}</b><span>{t('hotspot')} {t('online').toLowerCase()}</span></Link>
          <Link className="stat" to="/sessions?type=pppoe" style={{ color: '#fff', textDecoration: 'none' }}><b>{num(k.online_pppoe)}</b><span>{t('pppoe')} {t('online').toLowerCase()}</span></Link>
          <Link className="stat" to="/routers" style={{ color: '#fff', textDecoration: 'none' }}><b>{num(k.routers_online)}/{num(k.routers_total)}</b><span>{t('routers')}</span></Link>
        </div>
        <div className="lights">
          {list.length === 0 && <span className="light"><i />{t('no_routers_yet')}</span>}
          {list.map((r) => (
            <Link key={r.id} to={`/routers/${r.id}`} className={`light ${r.status}`} title={t(`st_${r.status}`)}>
              <i />{r.name}<span style={{ opacity: .7 }}>{r.status === 'online' ? ` ${r.hotspot_online + r.pppoe_online}` : ` (${t(`st_${r.status}`).toLowerCase()})`}</span>
            </Link>
          ))}
        </div>
      </section>

      <VerifyPhone />

      {needsSetup && (
        <section className="panel" style={{ marginBottom: 16 }}>
          <header><h2>{t('setup_title')}</h2></header>
          <div className="body">
            <ol className="steps">
              <SetupStep done={k.routers_total > 0} to="/routers">{t('setup_router')}</SetupStep>
              <SetupStep done={k.channels > 0} to="/settings?tab=payments">{t('setup_wallet')}</SetupStep>
              <SetupStep done={k.gateways > 0} to="/settings?tab=sms">{t('setup_gateway')}</SetupStep>
              <SetupStep done={false} to="/packages">{t('setup_packages')}</SetupStep>
            </ol>
          </div>
        </section>
      )}

      <div className="facts">
        <Link to="/vouchers?status=unused"><b>{num(k.vouchers_unused)}</b><span>{t('unused_codes')}</span></Link>
        <Link to="/payments?status=pending" className={k.payments_pending ? 'attn' : ''}><b>{num(k.payments_pending)}</b><span>{t('pending_payments')}</span></Link>
        <Link to="/payments?tab=sms" className={k.sms_unmatched ? 'attn' : ''}><b>{num(k.sms_unmatched)}</b><span>{t('unmatched_sms')}</span></Link>
        <Link to="/requests" className={k.requests_new ? 'attn' : ''}><b>{num(k.requests_new)}</b><span>{t('new_requests')}</span></Link>
      </div>

      <div className="grid-2">
        <section className="panel">
          <header><h2>{t('revenue_30')}</h2><Link className="btn quiet" to="/reports">{t('nav_reports')}</Link></header>
          <div className="body">
            {revenue.data && (
              <RevenueChart
                days={revenue.data.days}
                series={[
                  { key: 'hotspot', label: t('hotspot_sales'), color: 'var(--s1)' },
                  { key: 'agents', label: t('agent_topups'), color: 'var(--s2)' },
                  { key: 'subscription', label: t('subscriptions_paid'), color: 'var(--s3)' },
                ]}
                fmtMoney={(v) => money(v, cur)}
                fmtDay={(d, long) => new Date(`${d}T12:00:00`).toLocaleDateString(lang === 'en' ? 'en-GB' : 'fr-FR', long ? { weekday: 'short', day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short' })}
              />
            )}
          </div>
        </section>
        <div className="stack" style={{ minWidth: 0 }}>
          <section className="panel">
            <header><h2>{t('alerts')}</h2></header>
            <div className="body flush">
              {!s?.alerts?.length ? <Empty title={t('no_alerts')} /> : (
                <table className="tbl"><tbody>
                  {s.alerts.map((a) => (
                    <tr key={a.id}><td><span className={`st ${a.severity === 'critical' ? 'bad' : 'warn'}`}>{a.message}</span><span className="sub">{ago(a.created_at, lang)}</span></td></tr>
                  ))}
                </tbody></table>
              )}
            </div>
          </section>
          <section className="panel">
            <header><h2>{t('expiring')}</h2><Link className="btn quiet" to="/subscribers?expiring_days=7">{t('all')}</Link></header>
            <div className="body flush">
              {!s?.expiring?.length ? <Empty title={t('none_expiring')} /> : (
                <table className="tbl"><tbody>
                  {s.expiring.map((x) => (
                    <tr key={x.id}><td>{x.customer_name || x.username}<span className="sub">{x.plan_name}</span></td><td className="n">{date(x.expires_at, lang)}</td></tr>
                  ))}
                </tbody></table>
              )}
            </div>
          </section>
        </div>
      </div>

      <section className="panel" style={{ marginTop: 16 }}>
        <header><h2>{t('recent_payments')}</h2><Link className="btn quiet" to="/payments">{t('all')}</Link></header>
        <div className="body flush table-wrap">
          {!s?.recent_payments?.length ? <Empty title={t('none')} /> : (
            <table className="tbl">
              <thead><tr><th>{t('date')}</th><th>{t('details')}</th><th>{t('channel')}</th><th>{t('status')}</th><th className="n">{t('amount')}</th></tr></thead>
              <tbody>
                {s.recent_payments.map((p) => (
                  <tr key={p.id}>
                    <td className="nowrap">{dateTime(p.confirmed_at || p.created_at, lang)}</td>
                    <td>{p.item_name || t(`p_${p.purpose}`)}<span className="sub">{p.phone || p.reference}</span></td>
                    <td>{t(`ch_${p.wallet || p.channel}`)}</td>
                    <td><Status value={p.status} /></td>
                    <td className="n">{money(p.amount, cur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </>
  );
}

function SetupStep({ done, to, children }) {
  const { t } = useI18n();
  return <li>{done ? <span className="st good">{children} — {t('done')}</span> : <Link to={to}>{children}</Link>}</li>;
}

function VerifyPhone() {
  const { t } = useI18n();
  const { me, reload } = useAuth();
  const [code, setCode] = useState('');
  const { run, busy } = useSubmit();
  if (!me.tenant || me.user.phone_verified || me.user.role !== 'owner') return null;
  return (
    <div className="banner info">
      <span><b>{t('verify_phone')}.</b> {t('verify_phone_text')}</span>
      <form className="row" style={{ marginLeft: 'auto' }} onSubmit={async (e) => { e.preventDefault(); if (await run(() => post('/auth/verify-phone/confirm', { code }))) reload(); }}>
        <input className="in" style={{ width: 120 }} inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} aria-label={t('code')} />
        <button className="btn primary" disabled={busy}>{t('verify')}</button>
        <button className="btn quiet" type="button" onClick={() => run(() => post('/auth/verify-phone/send'))}>{t('resend')}</button>
      </form>
    </div>
  );
}
