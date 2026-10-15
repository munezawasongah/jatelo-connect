// Encryption at rest, token generation, voucher codes and WireGuard keys.
import crypto from 'node:crypto';
import { config } from '../config.js';

const KEY = Buffer.from(config.MASTER_KEY, 'hex');

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext>, base64url parts. */
export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
}

export function decrypt(blob) {
  const [v, iv, tag, data] = String(blob).split('.');
  if (v !== 'v1') throw new Error('Unknown ciphertext version');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

// No 0/O, 1/I/L, 5/S, 8/B — codes are read aloud and typed on small phones.
const CODE_ALPHABET = '234679ACDEFGHJKMNPQRTUVWXYZ';

/** Unbiased random string from the voucher alphabet. */
export function randomCode(length = 8, alphabet = CODE_ALPHABET) {
  const out = [];
  const max = 256 - (256 % alphabet.length);
  while (out.length < length) {
    for (const b of crypto.randomBytes(length * 2)) {
      if (b < max) out.push(alphabet[b % alphabet.length]);
      if (out.length === length) break;
    }
  }
  return out.join('');
}

export const randomDigits = (n = 6) => randomCode(n, '0123456789');

/** Strong password for router API users and PPPoE accounts (letters + digits, no ambiguous chars). */
export const randomPassword = (n = 16) => randomCode(n, '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ');

/** WireGuard (Curve25519) key pair, base64 as used by wg and RouterOS. */
export function wgKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  return { publicKey: pub.toString('base64'), privateKey: priv.toString('base64') };
}

export function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
