// Parses the confirmation SMS a merchant phone receives from Lumicash or EcoCash
// ("Vous avez reçu 2 000 FBU de 79123456 JEAN N. Ref: 1234567890 ...").
// The exact wording differs by wallet and changes over time, so parsing is deliberately
// tolerant: amount, transaction id, payer phone and name are each found independently.
// Every received SMS is stored raw, so wording changes never lose a payment.

const WALLET_HINTS = [
  ['lumicash', /lumi\s*cash|lumitel|bepay|\*163#?|^\+?163$/i],
  ['ecocash', /eco\s*cash|econet|leo\b/i],
];

export function detectWallet(sender = '', body = '') {
  for (const [wallet, re] of WALLET_HINTS) if (re.test(sender) || re.test(body)) return wallet;
  return null;
}

const AMOUNT_RES = [
  /(\d{1,3}(?:[ .,  ]\d{3})+|\d+)(?:[.,]\d{1,2})?\s*(?:FBU|BIF|FRBU|Fbu|Frw?\b|francs?)/i,
  /(?:FBU|BIF)\s*[:.]?\s*(\d{1,3}(?:[ .,  ]\d{3})+|\d+)/i,
  /(?:montant|amount|amafaranga)\s*[:=]?\s*(\d{1,3}(?:[ .,  ]\d{3})+|\d+)/i,
];

const TXN_RES = [
  /(?:trans(?:action)?\s*(?:id|no|n[°o])?|txn\s*id|txnid|trx\s*id|ref(?:erence|\.)?|r[ée]f[ée]rence|id\s*trans(?:action)?|code)\s*[:#.]?\s*([A-Z0-9][A-Z0-9.\-]{5,29})/i,
  /\bID\s*[:#]\s*([A-Z0-9][A-Z0-9.\-]{5,29})/i,
];

const PHONE_RE = /(?:\+?257[\s-]?)?\b((?:6[1-9]|7[1-9])[\s-]?\d{2}[\s-]?\d{2}[\s-]?\d{2})\b/;
const NAME_RE = /(?:de|from|na|kuva|par)\s+(?:\+?257\s?)?(?:\d[\d\s-]{6,12}\d)?\s*[-,(]?\s*([A-ZÀ-Ÿ][A-ZÀ-Ÿa-zà-ÿ'.-]+(?:\s+[A-ZÀ-Ÿ][A-ZÀ-Ÿa-zà-ÿ'.-]+){0,3})/;

const RECEIVED_RE = /re[çc]u|received|wakiriye|vous avez re|credited|cr[ée]dit[ée]|payment from|paiement de|transfert re/i;
const OUTGOING_RE = /vous avez (?:envoy|pay[ée]|transf[ée]r)|you (?:have )?(?:sent|paid)|retrait|withdraw/i;

const digits = (s) => s.replace(/\D/g, '');

/**
 * @returns {{ wallet: string|null, incoming: boolean, amount: number|null, txnId: string|null,
 *             phone: string|null, name: string|null }}
 */
export function parseWalletSms(sender, body) {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  const wallet = detectWallet(sender, text);

  let amount = null;
  for (const re of AMOUNT_RES) {
    const m = re.exec(text);
    if (m) { amount = Number(digits(m[1])); break; }
  }

  let txnId = null;
  for (const re of TXN_RES) {
    const m = re.exec(text);
    if (m) {
      const cand = m[1].replace(/[.\-]+$/, '').toUpperCase();
      // A transaction id has digits; skip words such as "REFERENCE" captured by accident
      if ((/\d/.test(cand) && !/^\d{8}$/.test(cand)) || /^\d{9,}$/.test(cand)) { txnId = normalizeTxnId(cand); break; }
    }
  }

  // Payer phone: the first Burundian mobile number that is not part of the transaction id
  let phone = null;
  const scan = txnId ? text.replace(new RegExp(txnId.replace(/[.\-]/g, '.'), 'i'), ' ') : text;
  const pm = PHONE_RE.exec(scan);
  if (pm) phone = `+257${digits(pm[1])}`;

  const nm = NAME_RE.exec(text);
  const name = nm
    ? nm[1].split(/\.\s|\s(?:Ref|R[ée]f|Trans|Txn|ID|Solde|Balance|Nouveau|New)\b/i)[0].replace(/[.,]+$/, '').trim() || null
    : null;

  const incoming = RECEIVED_RE.test(text) && !OUTGOING_RE.test(text);
  return { wallet, incoming, amount, txnId, phone, name };
}

/** Normalise what a customer types as a transaction id, for matching. */
export const normalizeTxnId = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
