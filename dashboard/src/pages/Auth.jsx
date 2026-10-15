import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useI18n } from '../i18n.js';
import { useAuth } from '../App.jsx';
import { post } from '../api.js';
import { Field, useForm, useSubmit } from '../components/ui.jsx';

const PITCH = {
  fr: ['Vendez votre WiFi. Encaissez par Lumicash et EcoCash.', 'Codes WiFi, abonnés PPPoE et routeurs MikroTik, gérés depuis votre téléphone.'],
  rn: ['Gurisha WiFi yawe. Rihwa na Lumicash na EcoCash.', 'Kode za WiFi, abafatabuguzi ba PPPoE na router za MikroTik, vyose kuri terefone yawe.'],
  en: ['Sell your WiFi. Get paid by Lumicash and EcoCash.', 'WiFi codes, PPPoE subscribers and MikroTik routers, run from your phone.'],
};

function Frame({ children }) {
  const { lang, setLang } = useI18n();
  const [h, p] = PITCH[lang] || PITCH.fr;
  return (
    <div className="auth">
      <section className="art">
        <div className="row" style={{ gap: 10 }}>
          <svg width="34" height="34" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#fff" fillOpacity=".12" /><circle cx="16" cy="21" r="3" fill="#E3A21A" /><path d="M8 14a11 11 0 0 1 16 0M11 17a7 7 0 0 1 10 0" stroke="#fff" strokeWidth="2.5" fill="none" strokeLinecap="round" /></svg>
          <b style={{ fontSize: 18, fontVariationSettings: "'wdth' 80" }}>Jatelo Connect</b>
        </div>
        <div><h1>{h}</h1><p>{p}</p></div>
        <div className="seg" style={{ background: 'transparent', borderColor: 'rgba(255,255,255,.3)', alignSelf: 'flex-start' }}>
          {['fr', 'rn', 'en'].map((l) => (
            <button key={l} aria-pressed={String(lang === l)} onClick={() => setLang(l)} style={{ color: '#fff', background: lang === l ? 'rgba(255,255,255,.18)' : 'none' }}>{l.toUpperCase()}</button>
          ))}
        </div>
        <svg className="waves" viewBox="0 0 400 200" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((i) => <path key={i} d={`M0 ${60 + i * 28} C 80 ${30 + i * 28}, 160 ${90 + i * 28}, 240 ${60 + i * 28} S 360 ${40 + i * 28}, 400 ${60 + i * 28}`} stroke="#E3A21A" strokeOpacity={0.15 + i * 0.12} fill="none" strokeWidth="2" />)}
        </svg>
      </section>
      <section className="form">{children}</section>
    </div>
  );
}

export function Login() {
  const { t } = useI18n();
  const { signIn } = useAuth();
  const [v, , bind] = useForm({ login: '', password: '' });
  const { run, busy } = useSubmit();
  return (
    <Frame>
      <h2>{t('sign_in_title')}</h2>
      <form className="stack" onSubmit={async (e) => { e.preventDefault(); const r = await run(() => post('/auth/login', v), false); if (r) await signIn(r); }}>
        <Field label={t('email_or_phone')}><input className="in" autoComplete="username" required {...bind('login')} /></Field>
        <Field label={t('password')}><input className="in" type="password" autoComplete="current-password" required {...bind('password')} /></Field>
        <button className="btn primary block" disabled={busy}>{t('sign_in')}</button>
        <div className="spread small"><Link to="/reset">{t('forgot')}</Link><span>{t('no_account')} <Link to="/signup">{t('create_account')}</Link></span></div>
      </form>
    </Frame>
  );
}

export function Signup() {
  const { t, lang } = useI18n();
  const { signIn } = useAuth();
  const [v, , bind] = useForm({ business_name: '', name: '', email: '', phone: '', password: '' });
  const { run, busy, errors } = useSubmit();
  return (
    <Frame>
      <h2>{t('create_account')}</h2>
      <form className="stack" onSubmit={async (e) => { e.preventDefault(); const r = await run(() => post('/auth/signup', { ...v, language: lang }), false); if (r) await signIn(r); }}>
        <Field label={t('business_name')} error={errors.business_name}><input className="in" required {...bind('business_name')} /></Field>
        <Field label={t('your_name')} error={errors.name}><input className="in" autoComplete="name" required {...bind('name')} /></Field>
        <div className="form-grid">
          <Field label={t('email')} error={errors.email}><input className="in" type="email" autoComplete="email" required {...bind('email')} /></Field>
          <Field label={t('phone')} error={errors.phone}><input className="in" type="tel" autoComplete="tel" placeholder="79 12 34 56" required {...bind('phone')} /></Field>
        </div>
        <Field label={t('password')} error={errors.password}><input className="in" type="password" autoComplete="new-password" minLength={8} required {...bind('password')} /></Field>
        <button className="btn primary block" disabled={busy}>{t('start_trial')}</button>
        <div className="small">{t('have_account')} <Link to="/login">{t('sign_in')}</Link></div>
      </form>
    </Frame>
  );
}

export function Reset() {
  const { t } = useI18n();
  const nav = useNavigate();
  const [sent, setSent] = useState(false);
  const [v, , bind] = useForm({ phone: '', code: '', password: '' });
  const { run, busy, errors } = useSubmit();
  return (
    <Frame>
      <h2>{t('reset_title')}</h2>
      {!sent ? (
        <form className="stack" onSubmit={async (e) => { e.preventDefault(); if (await run(() => post('/auth/password/forgot', { phone: v.phone }), false)) setSent(true); }}>
          <Field label={t('phone')}><input className="in" type="tel" required {...bind('phone')} /></Field>
          <button className="btn primary block" disabled={busy}>{t('send_code')}</button>
        </form>
      ) : (
        <form className="stack" onSubmit={async (e) => { e.preventDefault(); if (await run(() => post('/auth/password/reset', v))) nav('/login'); }}>
          <Field label={t('code')} error={errors.code}><input className="in" inputMode="numeric" maxLength={6} required {...bind('code')} /></Field>
          <Field label={t('new_password')} error={errors.password}><input className="in" type="password" minLength={8} required {...bind('password')} /></Field>
          <button className="btn primary block" disabled={busy}>{t('save_password')}</button>
        </form>
      )}
      <p className="small"><Link to="/login">{t('back_to_login')}</Link></p>
    </Frame>
  );
}
