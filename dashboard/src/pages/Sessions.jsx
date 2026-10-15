import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../i18n.js';
import { get, post, qs } from '../api.js';
import { bytes, duration } from '../format.js';
import { PageHead, Seg, Empty, ConfirmButton, useToast } from '../components/ui.jsx';

export default function Sessions() {
  const { t, lang } = useI18n();
  const [params, setParams] = useSearchParams();
  const type = params.get('type') || '';
  const [q, setQ] = useState('');
  const routers = useQuery({ queryKey: ['routers'], queryFn: () => get('/routers') });
  const routerId = params.get('router_id') || '';
  const list = useQuery({
    queryKey: ['sessions', type, routerId],
    queryFn: () => get(`/sessions${qs({ type, router_id: routerId })}`),
    refetchInterval: 30_000,
  });
  const qc = useQueryClient();
  const toast = useToast();
  const rows = (list.data?.sessions || []).filter((s) => !q || [s.username, s.mac, s.ip, s.customer_name, s.customer_phone]
    .some((x) => x && String(x).toLowerCase().includes(q.toLowerCase())));
  const set = (k, v) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p, { replace: true }); };

  return (
    <>
      <PageHead title={t('sessions_title')} sub={list.data ? `${list.data.sessions.length} ${t('online_users')}` : t('loading')} />
      <div className="toolbar">
        <Seg value={type} onChange={(v) => set('type', v)} options={[['', t('all')], ['hotspot', t('hotspot')], ['pppoe', t('pppoe')]]} />
        <select className="in" value={routerId} onChange={(e) => set('router_id', e.target.value)} aria-label={t('router')}>
          <option value="">{t('routers')}: {t('all')}</option>
          {(routers.data?.routers || []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <input className="in" type="search" placeholder={t('search')} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <section className="panel">
        <div className="table-wrap">
          {!rows.length ? <Empty title={list.isLoading ? t('loading') : t('nobody_online')} /> : (
            <table className="tbl">
              <thead><tr>
                <th>{t('username')}</th><th>{t('customer')}</th><th>{t('router')}</th><th>{t('device')}</th>
                <th className="n">{t('connected_since')}</th><th className="n">{t('download')}</th><th className="n">{t('upload')}</th><th />
              </tr></thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id}>
                    <td><span className="code-text">{s.username}</span><span className="sub">{s.type === 'pppoe' ? t('pppoe') : t('hotspot')} — {s.product}</span></td>
                    <td>{s.customer_name || '—'}<span className="sub">{s.customer_phone}</span></td>
                    <td>{s.router_name}</td>
                    <td><span className="mono">{s.ip || '—'}</span><span className="sub mono">{s.mac}</span></td>
                    <td className="n">{duration(s.seconds)}</td>
                    <td className="n">{bytes(s.download_bytes, lang)}</td>
                    <td className="n">{bytes(s.upload_bytes, lang)}</td>
                    <td className="act">
                      <ConfirmButton className="btn small danger" danger question={t('disconnect_confirm', { user: s.username })}
                        onConfirm={async () => {
                          await post('/sessions/disconnect', { username: s.username, type: s.type });
                          toast(t('saved'));
                          setTimeout(() => qc.invalidateQueries({ queryKey: ['sessions'] }), 1500);
                        }}>{t('disconnect')}</ConfirmButton>
                    </td>
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
