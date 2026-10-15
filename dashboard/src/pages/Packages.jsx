import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../i18n.js';
import { useAuth } from '../App.jsx';
import { get, post, patch, del } from '../api.js';
import { money, minutes, speed, num } from '../format.js';
import { PageHead, Empty, Modal, Field, useForm, useSubmit, ConfirmButton, Icon } from '../components/ui.jsx';

const toNum = (v) => (v === '' || v == null ? null : Number(v));

function PackageForm({ initial, onClose, onSaved }) {
  const { t } = useI18n();
  const [v, , bind] = useForm({
    name: '', price: '', duration_minutes: '', data_limit_mb: '', rate_down_kbps: '', rate_up_kbps: '', device_limit: 1,
    visible_on_portal: true, is_trial: false, active: true, sort_order: 0, ...initial,
  });
  const { run, busy, errors } = useSubmit();
  const submit = async (e) => {
    e.preventDefault();
    const body = {
      name: v.name, price: Number(v.price || 0), duration_minutes: toNum(v.duration_minutes), data_limit_mb: toNum(v.data_limit_mb),
      rate_down_kbps: toNum(v.rate_down_kbps), rate_up_kbps: toNum(v.rate_up_kbps), device_limit: Number(v.device_limit || 1),
      visible_on_portal: v.visible_on_portal, is_trial: v.is_trial, active: v.active, sort_order: Number(v.sort_order || 0),
    };
    if (await run(() => (initial?.id ? patch(`/packages/${initial.id}`, body) : post('/packages', body)))) onSaved();
  };
  return (
    <Modal title={initial?.id ? t('edit') : t('add_package')} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>{t('cancel')}</button><button className="btn primary" form="pkg" disabled={busy}>{t('save')}</button>
    </>}>
      <form id="pkg" className="form-grid" onSubmit={submit}>
        <Field label={t('name')} error={errors.name}><input className="in" required {...bind('name')} placeholder="1 jour" /></Field>
        <Field label={t('price')} error={errors.price}><input className="in" type="number" min="0" step="50" required={!v.is_trial} disabled={v.is_trial} {...bind('price')} /></Field>
        <Field label={t('duration_minutes')} error={errors.duration_minutes} hint="60 = 1 h · 1440 = 1 j · 10080 = 7 j"><input className="in" type="number" min="1" {...bind('duration_minutes')} /></Field>
        <Field label={t('data_limit_mb')} optional error={errors.data_limit_mb} hint="1024 = 1 Go"><input className="in" type="number" min="1" {...bind('data_limit_mb')} /></Field>
        <Field label={t('down_kbps')} optional><input className="in" type="number" min="64" {...bind('rate_down_kbps')} /></Field>
        <Field label={t('up_kbps')} optional><input className="in" type="number" min="64" {...bind('rate_up_kbps')} /></Field>
        <Field label={t('device_limit')}><input className="in" type="number" min="1" max="20" {...bind('device_limit')} /></Field>
        <Field label="#"><input className="in" type="number" {...bind('sort_order')} /></Field>
        <label className="check full"><input type="checkbox" {...bind('visible_on_portal', 'checkbox')} disabled={v.is_trial} />{t('visible_on_portal')}</label>
        <label className="check full"><input type="checkbox" {...bind('is_trial', 'checkbox')} />{t('is_trial')}</label>
        {initial?.id && <p className="small muted full" style={{ margin: 0 }}>{t('package_sold_note')}</p>}
      </form>
    </Modal>
  );
}

function PlanForm({ initial, onClose, onSaved }) {
  const { t } = useI18n();
  const [v, , bind] = useForm({ name: '', price: '', period_days: 30, rate_down_kbps: '', rate_up_kbps: '', data_cap_mb: '', fup_rate_down_kbps: '', fup_rate_up_kbps: '', active: true, ...initial });
  const { run, busy, errors } = useSubmit();
  const submit = async (e) => {
    e.preventDefault();
    const body = {
      name: v.name, price: Number(v.price || 0), period_days: Number(v.period_days || 30), rate_down_kbps: Number(v.rate_down_kbps),
      rate_up_kbps: Number(v.rate_up_kbps), data_cap_mb: toNum(v.data_cap_mb), fup_rate_down_kbps: toNum(v.fup_rate_down_kbps),
      fup_rate_up_kbps: toNum(v.fup_rate_up_kbps), active: v.active,
    };
    if (await run(() => (initial?.id ? patch(`/plans/${initial.id}`, body) : post('/plans', body)))) onSaved();
  };
  return (
    <Modal title={initial?.id ? t('edit') : t('add_plan')} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>{t('cancel')}</button><button className="btn primary" form="plan" disabled={busy}>{t('save')}</button>
    </>}>
      <form id="plan" className="form-grid" onSubmit={submit}>
        <Field label={t('name')} error={errors.name}><input className="in" required {...bind('name')} /></Field>
        <Field label={t('price')} error={errors.price}><input className="in" type="number" min="0" step="100" required {...bind('price')} /></Field>
        <Field label={t('period_days')}><input className="in" type="number" min="1" {...bind('period_days')} /></Field>
        <span />
        <Field label={t('down_kbps')} error={errors.rate_down_kbps}><input className="in" type="number" min="64" required {...bind('rate_down_kbps')} /></Field>
        <Field label={t('up_kbps')} error={errors.rate_up_kbps}><input className="in" type="number" min="64" required {...bind('rate_up_kbps')} /></Field>
        <Field label={t('data_cap_mb')} optional><input className="in" type="number" min="1" {...bind('data_cap_mb')} /></Field>
        <Field label={t('fup_down')} optional><input className="in" type="number" min="64" {...bind('fup_rate_down_kbps')} /></Field>
      </form>
    </Modal>
  );
}

export default function Packages() {
  const { t, lang } = useI18n();
  const { me } = useAuth();
  const cur = me.tenant?.currency || 'BIF';
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'hotspot';
  const qc = useQueryClient();
  const pk = useQuery({ queryKey: ['packages'], queryFn: () => get('/packages') });
  const pl = useQuery({ queryKey: ['plans'], queryFn: () => get('/plans') });
  const [form, setForm] = useState(null);
  const done = () => { setForm(null); qc.invalidateQueries({ queryKey: ['packages'] }); qc.invalidateQueries({ queryKey: ['plans'] }); };

  return (
    <>
      <PageHead title={t('nav_packages')}>
        <button className="btn primary" onClick={() => setForm({ kind: tab })}><Icon name="plus" />{tab === 'hotspot' ? t('add_package') : t('add_plan')}</button>
      </PageHead>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'hotspot'} onClick={() => setParams({ tab: 'hotspot' })}>{t('hotspot_packages')}</button>
        <button role="tab" aria-selected={tab === 'pppoe'} onClick={() => setParams({ tab: 'pppoe' })}>{t('pppoe_plans')}</button>
      </div>
      <section className="panel table-wrap">
        {tab === 'hotspot' ? (
          !pk.data?.packages?.length ? <Empty title={pk.isLoading ? t('loading') : t('none')} /> : (
            <table className="tbl">
              <thead><tr><th>{t('name')}</th><th>{t('duration')}</th><th>{t('data')}</th><th>{t('speed')}</th><th className="n">{t('device_limit')}</th><th className="n">{t('unused')}</th><th className="n">{t('price')}</th><th /></tr></thead>
              <tbody>
                {pk.data.packages.map((p) => (
                  <tr key={p.id} style={{ opacity: p.active ? 1 : 0.55 }}>
                    <td><b>{p.name}</b>{p.is_trial && <span className="tag" style={{ marginLeft: 8 }}>{t('st_trial')}</span>}{!p.active && <span className="tag" style={{ marginLeft: 8 }}>{t('archived')}</span>}
                      {!p.visible_on_portal && !p.is_trial && p.active && <span className="sub">{t('visible_on_portal')}: {t('no')}</span>}</td>
                    <td>{minutes(p.duration_minutes, lang)}</td>
                    <td>{p.data_limit_mb ? `${num(p.data_limit_mb)} Mo` : t('unlimited')}</td>
                    <td>{speed(p.rate_down_kbps)}</td>
                    <td className="n">{p.device_limit}</td>
                    <td className="n">{num(p.vouchers_unused)}</td>
                    <td className="n"><b>{p.is_trial ? '—' : money(p.price, cur)}</b></td>
                    <td className="act">
                      <button className="btn small" onClick={() => setForm({ kind: 'hotspot', initial: p })}>{t('edit')}</button>{' '}
                      {p.active && <ConfirmButton className="btn small danger" danger question={`${t('delete')} ${p.name} ?`} onConfirm={async () => { await del(`/packages/${p.id}`); done(); }}>{t('delete')}</ConfirmButton>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : (
          !pl.data?.plans?.length ? <Empty title={pl.isLoading ? t('loading') : t('none')} /> : (
            <table className="tbl">
              <thead><tr><th>{t('name')}</th><th>{t('speed')}</th><th>{t('data_cap_mb')}</th><th className="n">{t('subscribers_count')}</th><th className="n">{t('price')}</th><th /></tr></thead>
              <tbody>
                {pl.data.plans.map((p) => (
                  <tr key={p.id} style={{ opacity: p.active ? 1 : 0.55 }}>
                    <td><b>{p.name}</b>{!p.active && <span className="tag" style={{ marginLeft: 8 }}>{t('archived')}</span>}</td>
                    <td>{speed(p.rate_down_kbps)} / {speed(p.rate_up_kbps)}</td>
                    <td>{p.data_cap_mb ? `${num(p.data_cap_mb)} Mo` : t('unlimited')}</td>
                    <td className="n">{p.subscribers}</td>
                    <td className="n"><b>{money(p.price, cur)}</b><span className="sub">{t('per_period', { n: p.period_days })}</span></td>
                    <td className="act">
                      <button className="btn small" onClick={() => setForm({ kind: 'pppoe', initial: p })}>{t('edit')}</button>{' '}
                      {p.active && <ConfirmButton className="btn small danger" danger question={`${t('delete')} ${p.name} ?`} onConfirm={async () => { await del(`/plans/${p.id}`); done(); }}>{t('delete')}</ConfirmButton>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}
      </section>
      {form?.kind === 'hotspot' && <PackageForm initial={form.initial} onClose={() => setForm(null)} onSaved={done} />}
      {form?.kind === 'pppoe' && <PlanForm initial={form.initial} onClose={() => setForm(null)} onSaved={done} />}
    </>
  );
}
