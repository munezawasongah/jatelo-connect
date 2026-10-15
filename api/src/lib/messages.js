// SMS and customer-facing message templates in French, Kirundi and English.
// Kirundi strings should be reviewed by a native speaker before launch.

const T = {
  otp: {
    fr: 'Jatelo Connect : votre code est {code}. Il expire dans 10 minutes. Ne le partagez avec personne.',
    rn: 'Jatelo Connect: kode yawe ni {code}. Izorangira mu minota 10. Ntuyihe uwundi muntu.',
    en: 'Jatelo Connect: your code is {code}. It expires in 10 minutes. Do not share it.',
  },
  voucher_purchased: {
    fr: '{brand} : paiement de {amount} reçu. Code WiFi : {code} ({package}). Code de récupération : {pin}.',
    rn: '{brand}: twakiriye {amount}. Kode ya WiFi: {code} ({package}). Kode yo kugarura: {pin}.',
    en: '{brand}: payment of {amount} received. WiFi code: {code} ({package}). Recovery PIN: {pin}.',
  },
  pppoe_welcome: {
    fr: '{brand} : bienvenue {name}. Identifiant internet : {username} / mot de passe : {password}. Expire le {expires}.',
    rn: '{brand}: kaze {name}. Izina: {username} / ijambo ry\'ibanga: {password}. Birangira {expires}.',
    en: '{brand}: welcome {name}. Internet login: {username} / password: {password}. Expires {expires}.',
  },
  pppoe_reminder: {
    fr: '{brand} : votre internet expire le {expires}. Payez {amount} au {merchant} avec la référence {ref} pour continuer.',
    rn: '{brand}: interineti yawe izorangira {expires}. Riha {amount} kuri {merchant}, referanse {ref}, ngo ubandanye.',
    en: '{brand}: your internet expires on {expires}. Pay {amount} to {merchant}, reference {ref}, to stay connected.',
  },
  pppoe_expired: {
    fr: '{brand} : votre internet a expiré. Payez {amount} au {merchant} avec la référence {ref} pour être reconnecté immédiatement.',
    rn: '{brand}: interineti yawe yarangiye. Riha {amount} kuri {merchant}, referanse {ref}, usubire ku murongo ubwo nyene.',
    en: '{brand}: your internet has expired. Pay {amount} to {merchant}, reference {ref}, to reconnect instantly.',
  },
  pppoe_renewed: {
    fr: '{brand} : paiement de {amount} reçu. Votre internet est actif jusqu\'au {expires}. Merci !',
    rn: '{brand}: twakiriye {amount}. Interineti yawe ikora gushika {expires}. Murakoze!',
    en: '{brand}: payment of {amount} received. Your internet is active until {expires}. Thank you!',
  },
};

export function render(key, lang = 'fr', vars = {}) {
  const tpl = T[key]?.[lang] ?? T[key]?.fr;
  if (!tpl) throw new Error(`Unknown message template ${key}`);
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? '').toString());
}

/** 12500 → "12 500 BIF" (French grouping, used in all three languages in Burundi). */
export const formatMoney = (amount, currency = 'BIF') =>
  `${Math.round(amount).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} ${currency}`;

export const formatDate = (d, tz = 'Africa/Bujumbura') =>
  new Date(d).toLocaleString('fr-FR', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
