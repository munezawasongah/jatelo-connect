import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../i18n.js';
import { get, patch } from '../api.js';
import { dateTime } from '../format.js';
import { PageHead, Empty, Status, CopyButton, Seg, useSubmit } from '../components/ui.jsx';
import { SubscriberForm } from './Subscribers.jsx';

export default function Requests() {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const [status, setStatus] = useState('new');
  const list = useQuery({ queryKey: ['requests', status], queryFn: () => get(`/service-requests${status ? `?status=${status}` : ''}`) });
  const account = useQuery({ queryKey: ['settings'], queryFn: () => get('/settings') });
  const [creating, setCreating] = useState(null);
  const { run } = useSubmit();
  const link = account.data ? `${account.data.portal_url}/join/${account.data.account.slug}` : '';
  const mark = async (id, s, subscriptionId) => {
    if (await run(() => patch(`/service-requests/${id}`, { status: s, ...(subscriptionId ? { subscription_id: subscriptionId } : {}) }))) {
      qc.invalidateQueries({ queryKey: ['requests'] }); qc.invalidateQueries({ queryKey: ['dashboard'] });
    }
  };
  return (
    <>
      <PageHead title={t('requests_title')} />
      {link && (
        <div className="banner info"><span>{t('share_link')}: <b className="mono">{link}</b></span><CopyButton text={link} /></div>
      )}
      <div className="toolbar">
        <Seg value={status} onChange={setStatus} options={[['new', t('st_new')], ['contacted', t('st_contacted')], ['installed', t('st_installed')], ['rejected', t('st_rejected')], ['', t('all')]]} />
      </div>
      <section className="panel table-wrap">
        {!list.data?.requests?.length ? <Empty title={list.isLoading ? t('loading') : t('none')} /> : (
          <table className="tbl">
            <thead><tr><th>{t('date')}</th><th>{t('name')}</th><th>{t('address')}</th><th>{t('plan')}</th><th>{t('status')}</th><th /></tr></thead>
            <tbody>{list.data.requests.map((r) => (
              <tr key={r.id}>
                <td>{dateTime(r.created_at, lang)}</td>
                <td><b>{r.name}</b><span className="sub"><a href={`tel:${r.phone}`}>{r.phone}</a></span></td>
                <td>{r.address || '—'}{r.latitude && <span className="sub"><a href={`https://maps.google.com/?q=${r.latitude},${r.longitude}`} target="_blank" rel="noreferrer">{Number(r.latitude).toFixed(4)}, {Number(r.longitude).toFixed(4)}</a></span>}
                  {r.notes && <span className="sub">{r.notes}</span>}</td>
                <td>{r.plan_name || '—'}</td>
                <td><Status value={r.status} /></td>
                <td className="act">
                  {r.status !== 'installed' && <button className="btn small primary" onClick={() => setCreating(r)}>{t('create_subscriber')}</button>}{' '}
                  {r.status === 'new' && <button className="btn small" onClick={() => mark(r.id, 'contacted')}>{t('st_contacted')}</button>}{' '}
                  {['new', 'contacted'].includes(r.status) && <button className="btn small danger" onClick={() => mark(r.id, 'rejected')}>{t('st_rejected')}</button>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>
      {creating && (
        <SubscriberForm prefill={{ name: creating.name, phone: creating.phone, address: creating.address || '', plan_id: creating.plan_id || '', activation: 'paid_cash' }}
          onClose={() => setCreating(null)} onSaved={async (s) => { await mark(creating.id, 'installed', s.id); setCreating(null); }} />
      )}
    </>
  );
}
