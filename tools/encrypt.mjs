// Encrypt data/league.json -> data/league.enc.json (the only copy that gets committed).
// Usage: BOARD_PASSWORD=... node tools/encrypt.mjs [--new-salt]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { deriveKey, encryptJSON, toB64, randomBytes, ITERATIONS } from '../js/crypto.js';

const password = process.env.BOARD_PASSWORD || process.argv.find((a, i) => i > 1 && !a.startsWith('--'));
if (!password) {
  console.error('Set BOARD_PASSWORD or pass the password as an argument.');
  process.exit(1);
}
const encPath = new URL('../data/league.enc.json', import.meta.url);
const plainPath = new URL('../data/league.json', import.meta.url);

// Reusing the salt keeps members' "remember me" keys valid while the password is unchanged.
let salt = toB64(randomBytes(16));
if (existsSync(encPath) && !process.argv.includes('--new-salt')) salt = JSON.parse(readFileSync(encPath)).salt;

const league = JSON.parse(readFileSync(plainPath, 'utf8'));
league.updated = new Date().toISOString();
const key = await deriveKey(password, salt, ITERATIONS);
writeFileSync(encPath, JSON.stringify(await encryptJSON(league, key, salt, ITERATIONS)) + '\n');
console.log('Wrote data/league.enc.json');
