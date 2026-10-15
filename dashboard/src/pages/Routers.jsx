import { Fragment, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../i18n.js';
import { get, post, patch, del } from '../api.js';
import { ago, bps, bytes, time, dateTime } from '../format.js';
import { PageHead, Status, Empty, Modal, Field, useForm, useSubmit, CopyButton, ConfirmButton, Seg, Icon, useToast } from '../components/ui.jsx';
import { TrafficChart } from '../components/charts.jsx';

const csv = (s) => String(s || '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

function RouterForm({ initial, onSaved, onClose, editing }) {
  const { t } = useI18n();
  const sites = useQuery({ queryKey: ['sites'], queryFn: () => get('/sites') });
  const [v, , bind] = useForm({
    vendor: 'mikrotik', name: '', site_id: '', hotspot_enabled: true, pppoe_enabled: true, hotspot_ports: '',
    hotspot_network: '10.5.50.0/24', pppoe_interface: '', pppoe_network: '10.10.0.0/16', wan_interface: 'ether1', public_ip: '', model: '',
    ...initial, hotspot_ports_text: undefined,
  });
  const { run, busy, errors } = useSubmit();
  const mk = v.vendor === 'mikrotik';
  const submit = async (e) => {
    e.preventDefault();
    const body = {
      name: v.name, site_id: v.site_id || null, model: v.model || null, hotspot_enabled: v.hotspot_enabled, pppoe_enabled: v.pppoe_enabled,
      ...(mk ? {
        hotspot_ports: csv(v.hotspot_ports), hotspot_network: v.hotspot_network, pppoe_interface: v.pppoe_interface || null,
        pppoe_network: v.pppoe_network, wan_interface: v.wan_interface,
      } : {}),
      ...(!editing ? { vendor: v.vendor, ...(mk ? {} : { public_ip: v.public_ip }) } : {}),
    };
    const r = await run(() => (editing ? patch(`/routers/${initial.id}`, body) : post('/routers', body)));
    if (r) onSaved(r.router);
  };
  return (
    <Modal title={editing ? t('edit') : t('add_router')} onClose={onClose} wide footer={<>
      <button className="btn" onClick={onClose}>{t('cancel')}</button>
      <button className="btn primary" form="router-form" disabled={busy}>{t('save')}</button>
    </>}>
      <form id="router-form" className="form-grid" onSubmit={submit}>
        {!editing && (
          <Field label={t('vendor')} full>
            <Seg value={v.vendor} onChange={(x) => bind('vendor').onChange({ target: { value: x } })}
              options={[['mikrotik', t('mikrotik')], ['ruijie', t('ruijie')], ['generic', t('generic')]]} />
          </Field>
        )}
        <Field label={t('router_name')} error={errors.name}><input className="in" required {...bind('name')} placeholder="Kinindo AP" /></Field>
        <Field label={t('site')}>
          <select className="in" {...bind('site_id')}>
            <option value="">—</option>
            {(sites.data?.sites || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        {!mk && !editing && <Field label={t('public_ip')} error={errors.public_ip}><input className="in mono" required {...bind('public_ip')} placeholder="41.79.x.x" /></Field>}
        <label className="check"><input type="checkbox" {...bind('hotspot_enabled', 'checkbox')} />{t('enable_hotspot')}</label>
        <label className="check"><input type="checkbox" {...bind('pppoe_enabled', 'checkbox')} />{t('enable_pppoe')}</label>
        {mk && (
          <>
            <Field label={t('wan_interface')} error={errors.wan_interface}><input className="in mono" {...bind('wan_interface')} /></Field>
            <Field label={t('hotspot_ports')} hint={t('hotspot_ports_hint')} error={errors.hotspot_ports}><input className="in mono" {...bind('hotspot_ports')} placeholder="ether3, ether4, wlan1" /></Field>
            <Field label={t('hotspot_network')} error={errors.hotspot_network}><input className="in mono" {...bind('hotspot_network')} /></Field>
            <Field label={t('pppoe_interface')} optional error={errors.pppoe_interface}><input className="in mono" {...bind('pppoe_interface')} placeholder="jc-hotspot" /></Field>
          </>
        )}
      </form>
    </Modal>
  );
}

/** Shows the MikroTik script (or the RADIUS settings) and waits for the router to come online. */
function SetupDialog({ router, onClose }) {
  const { t } = useI18n();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const status = useQuery({ queryKey: ['routers', router.id], queryFn: () => get(`/routers/${router.id}`), refetchInterval: 5000 });
  useEffect(() => { post(`/routers/${router.id}/setup`).then(setData).catch((e) => setErr(e.message)); }, [router.id]);
  const online = status.data?.router?.status === 'online';
  return (
    <Modal title={`${t('setup_script')}: ${router.name}`} onClose={onClose} wide footer={<button className="btn primary" onClick={onClose}>{t('close')}</button>}>
      {err && <div className="banner bad">{err}</div>}
      {!data && !err && <p>{t('loading')}</p>}
      {data?.script && (
        <div className="stack">
          <p style={{ margin: 0 }}>{t('script_steps')}</p>
          <div className="spread"><span className="small muted">{t('script_valid')}</span><CopyButton text={data.script} /></div>
          <div className="codebox">{data.script}</div>
        </div>
      )}
      {data?.settings && (
        <div className="stack">
          <p style={{ margin: 0 }}>{t('radius_settings')}</p>
          <dl className="kv">
            {Object.entries(data.settings).map(([k, val]) => (
              <Fragment key={k}><dt className="mono">{k}</dt><dd className="mono">{Array.isArray(val) ? val.join(', ') : String(val)} {k === 'radius_secret' && <CopyButton text={val} />}</dd></Fragment>
            ))}
          </dl>
        </div>
      )}
      <div className={`banner ${online ? 'info' : 'warn'}`} style={{ marginTop: 16, marginBottom: 0 }}>
        {online ? <span className="st good">{t('router_online')}</span> : <span><span className="live-dot" /> {t('waiting_router')}</span>}
      </div>
    </Modal>
  );
}

export default function Routers() {
  const { t, lang } = useI18n();
  const nav = useNavigate();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['routers'], queryFn: () => get('/routers') });
  const [adding, setAdding] = useState(false);
  const [setup, setSetup] = useState(null);
  const rows = list.data?.routers || [];
  return (
    <>
      <PageHead title={t('nav_routers')}><button className="btn primary" onClick={() => setAdding(true)}><Icon name="plus" />{t('add_router')}</button></PageHead>
      <section className="panel table-wrap">
        {!rows.length ? <Empty title={list.isLoading ? t('loading') : t('no_routers_yet')} action={<button className="btn primary" onClick={() => setAdding(true)}>{t('add_router')}</button>} /> : (
          <table className="tbl">
            <thead><tr><th>{t('name')}</th><th>{t('status')}</th><th>{t('site')}</th><th>{t('model')}</th><th className="n">{t('hotspot')}</th><th className="n">{t('pppoe')}</th><th className="n">{t('last_seen')}</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="click" onClick={() => nav(`/routers/${r.id}`)}>
                  <td><b>{r.name}</b><span className="sub mono">{r.tunnel_ip || r.public_ip}</span></td>
                  <td><Status value={r.status} /></td>
                  <td>{r.site_name || '—'}</td>
                  <td>{r.model || t(r.vendor)}<span className="sub">{r.os_version}</span></td>
                  <td className="n">{r.hotspot_online}</td>
                  <td className="n">{r.pppoe_online}</td>
                  <td className="n">{r.last_seen_at ? ago(r.last_seen_at, lang) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {adding && <RouterForm onClose={() => setAdding(false)} onSaved={(r) => { setAdding(false); qc.invalidateQueries({ queryKey: ['routers'] }); setSetup(r); }} />}
      {setup && <SetupDialog router={setup} onClose={() => { setSetup(null); nav(`/routers/${setup.id}`); }} />}
    </>
  );
}

export function RouterDetail() {
  const { id } = useParams();
  const { t, lang } = useI18n();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [hours, setHours] = useState(24);
  const [iface, setIface] = useState('');
  const [setup, setSetup] = useState(false);
  const [editing, setEditing] = useState(false);
  const r = useQuery({ queryKey: ['routers', id], queryFn: () => get(`/routers/${id}`) });
  const traffic = useQuery({ queryKey: ['routers', id, 'traffic', hours, iface], queryFn: () => get(`/routers/${id}/traffic?hours=${hours}${iface ? `&iface=${encodeURIComponent(iface)}` : ''}`), refetchInterval: 60_000 });
  const { run, busy } = useSubmit();
  const router = r.data?.router;
  if (!router) return <Empty title={r.isLoading ? t('loading') : t('none')} />;
  const info = router.info || {};
  const memUsed = info.total_memory ? Math.round(100 * (1 - info.free_memory / info.total_memory)) : null;
  const mk = router.vendor === 'mikrotik';

  return (
    <>
      <PageHead title={router.name} sub={<><Status value={router.status} /> {router.last_seen_at && <span className="muted">— {t('last_seen')} {ago(router.last_seen_at, lang)}</span>}</>}>
        <Link className="btn" to={`/sessions?router_id=${router.id}`}>{t('nav_sessions')} ({router.hotspot_online + router.pppoe_online})</Link>
        {mk && <button className="btn" disabled={busy} onClick={async () => { const x = await run(() => post(`/routers/${id}/refresh`), false); if (x) qc.setQueryData(['routers', id], x); }}><Icon name="refresh" />{t('refresh')}</button>}
        <button className="btn" onClick={() => setSetup(true)}>{t('setup_script')}</button>
        <button className="btn" onClick={() => setEditing(true)}>{t('edit')}</button>
      </PageHead>

      <div className="facts">
        <div><b>{info.uptime || '—'}</b><span>{t('uptime')}</span></div>
        <div><b>{info.cpu_load != null ? `${info.cpu_load}%` : '—'}</b><span>{t('cpu')}</span></div>
        <div><b>{memUsed != null ? `${memUsed}%` : '—'}</b><span>{t('memory')}</span></div>
        <div><b className="mono" style={{ fontSize: 16 }}>{router.tunnel_ip || router.public_ip}</b><span>{router.tunnel_ip ? t('tunnel_ip') : t('public_ip')}</span></div>
      </div>

      <section className="panel">
        <header>
          <h2>{t('bandwidth')}{traffic.data?.iface ? `: ${traffic.data.iface}` : ''}</h2>
          <div className="row">
            {traffic.data?.interfaces?.length > 1 && (
              <select className="in" style={{ width: 'auto' }} value={iface || traffic.data.iface || ''} onChange={(e) => setIface(e.target.value)} aria-label={t('interfaces')}>
                {traffic.data.interfaces.map((i) => <option key={i.iface} value={i.iface}>{i.iface}</option>)}
              </select>
            )}
            <Seg value={hours} onChange={setHours} options={[[1, t('hours_1')], [24, t('hours_24')], [168, t('days_7')], [720, t('days_30')]]} />
          </div>
        </header>
        <div className="body">
          {traffic.data?.points?.length > 1
            ? <TrafficChart points={traffic.data.points} fmtRate={bps} labels={{ download: t('download'), upload: t('upload') }}
                fmtTime={(ts, long) => (hours > 48 || long ? dateTime(ts, lang) : time(ts, lang))} />
            : <Empty title={t('no_traffic')} />}
        </div>
      </section>

      <div className="grid-halves" style={{ marginTop: 16 }}>
        <section className="panel">
          <header><h2>{t('details')}</h2></header>
          <div className="body">
            <dl className="kv">
              <dt>{t('vendor')}</dt><dd>{t(router.vendor)}</dd>
              <dt>{t('model')}</dt><dd>{router.model || info.board || '—'}</dd>
              <dt>{t('version')}</dt><dd>{router.os_version || '—'}</dd>
              <dt>{t('site')}</dt><dd>{router.site_name || '—'}</dd>
              {mk && <><dt>{t('wan_interface')}</dt><dd className="mono">{router.wan_interface}</dd></>}
              {mk && router.hotspot_enabled && <><dt>{t('hotspot_ports')}</dt><dd className="mono">{router.hotspot_ports?.join(', ') || '—'}</dd></>}
              {mk && router.hotspot_enabled && <><dt>{t('hotspot_network')}</dt><dd className="mono">{router.hotspot_network}</dd></>}
              {mk && router.pppoe_enabled && <><dt>{t('pppoe_interface')}</dt><dd className="mono">{router.pppoe_interface || 'jc-hotspot'}</dd></>}
            </dl>
            <div className="row" style={{ marginTop: 18 }}>
              {mk && <ConfirmButton className="btn" question={t('reboot_confirm', { name: router.name })} onConfirm={async () => { await post(`/routers/${id}/reboot`); toast(t('saved')); }}><Icon name="power" />{t('reboot')}</ConfirmButton>}
              <ConfirmButton className="btn danger" danger question={t('delete_router_confirm', { name: router.name })}
                onConfirm={async () => { await del(`/routers/${id}`); qc.invalidateQueries({ queryKey: ['routers'] }); nav('/routers'); }}>{t('delete')}</ConfirmButton>
            </div>
          </div>
        </section>
        <section className="panel">
          <header><h2>{t('interfaces')}</h2></header>
          <div className="body flush table-wrap">
            {!info.interfaces?.length ? <Empty title={t('none')} /> : (
              <table className="tbl">
                <thead><tr><th>{t('name')}</th><th>{t('type')}</th><th className="n">{t('download')}</th><th className="n">{t('upload')}</th></tr></thead>
                <tbody>
                  {info.interfaces.filter((i) => !i.name.startsWith('<')).map((i) => (
                    <tr key={i.name}><td><span className={`st ${i.running ? 'good' : 'idle'}`}>{i.name}</span></td><td className="muted">{i.type}</td><td className="n">{bytes(i.tx_bytes, lang)}</td><td className="n">{bytes(i.rx_bytes, lang)}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </div>
      {setup && <SetupDialog router={router} onClose={() => { setSetup(false); qc.invalidateQueries({ queryKey: ['routers'] }); }} />}
      {editing && <RouterForm editing initial={{ ...router, site_id: router.site_id || '', hotspot_ports: (router.hotspot_ports || []).join(', '), pppoe_interface: router.pppoe_interface || '' }}
        onClose={() => setEditing(false)} onSaved={(x) => { setEditing(false); qc.setQueryData(['routers', id], { router: x }); toast(t('saved')); }} />}
    </>
  );
}
