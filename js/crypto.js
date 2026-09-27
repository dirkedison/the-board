// Password protection: the league data is stored only as AES-GCM ciphertext,
// keyed by PBKDF2 of the league password. Works in browsers and Node 20+.

const subtle = globalThis.crypto.subtle;
export const ITERATIONS = 310000;

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toB64(bytes) {
  let s = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
}

export function fromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

export async function deriveKey(password, saltB64, iterations = ITERATIONS) {
  const base = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(saltB64), iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

export async function exportKey(key) {
  return toB64(await subtle.exportKey('raw', key));
}

export async function importKey(rawB64) {
  return subtle.importKey('raw', fromB64(rawB64), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}

export async function encryptJSON(obj, key, saltB64, iterations = ITERATIONS) {
  const iv = randomBytes(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return { v: 1, kdf: 'PBKDF2-SHA256', iter: iterations, salt: saltB64, iv: toB64(iv), ct: toB64(ct) };
}

// Throws if the key is wrong.
export async function decryptJSON(blob, key) {
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(blob.iv) }, key, fromB64(blob.ct));
  return JSON.parse(dec.decode(pt));
}
