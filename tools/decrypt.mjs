// Decrypt data/league.enc.json -> data/league.json (gitignored) for local editing.
// Usage: BOARD_PASSWORD=... node tools/decrypt.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { deriveKey, decryptJSON } from '../js/crypto.js';

const password = process.env.BOARD_PASSWORD || process.argv[2];
if (!password) {
  console.error('Set BOARD_PASSWORD or pass the password as an argument.');
  process.exit(1);
}
const blob = JSON.parse(readFileSync(new URL('../data/league.enc.json', import.meta.url)));
const key = await deriveKey(password, blob.salt, blob.iter);
const league = await decryptJSON(blob, key).catch(() => {
  console.error('Wrong password.');
  process.exit(1);
});
writeFileSync(new URL('../data/league.json', import.meta.url), JSON.stringify(league, null, 2) + '\n');
console.log('Wrote data/league.json');
