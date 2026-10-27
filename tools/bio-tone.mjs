// Weekly bio tone tiers, per the commissioner's rule:
//   nice  - winning record overall AND a winning week
//   mixed - one of the two is winning, the other isn't (half praise, half roast)
//   mean  - neither is winning, or the player is alone in last place
// "Winning" means more wins than losses; exactly .500 doesn't count.
// Usage: BOARD_PASSWORD=... npm run decrypt && node tools/bio-tone.mjs [week]
import { readFileSync } from 'node:fs';
import { standings, fmtRecord } from '../js/core.js';

const league = JSON.parse(readFileSync(new URL('../data/league.json', import.meta.url), 'utf8'));
const rows = standings(league);
const week = Number(process.argv[2]) || Math.max(...league.weeks.map((w) => w.week));
const worst = Math.min(...rows.map((r) => r.net));
const aloneLast = (r) => r.net === worst && rows.filter((x) => x.net === worst).length === 1;

export function tone(r) {
  const overallUp = r.W > r.L;
  const wk = r.byWeek[week] || { W: 0, L: 0 };
  const weekUp = wk.W > wk.L;
  if (aloneLast(r)) return 'mean';
  if (overallUp && weekUp) return 'nice';
  if (overallUp || weekUp) return 'mixed';
  return 'mean';
}

console.log(`Bio tones for week ${week}:`);
for (const r of rows) {
  const wk = r.byWeek[week] || { W: 0, L: 0, P: 0 };
  console.log(`  ${r.player.name.padEnd(6)} ${tone(r).padEnd(5)}  season ${fmtRecord(r).padEnd(8)} week ${fmtRecord(wk)}${aloneLast(r) ? '  (alone in last)' : ''}`);
}
