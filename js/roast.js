// Nicknames and roast tags, earned from pick history. Rules fire on real stats;
// the highest-priority rule with a nickname wins the title.
import { teamName } from './teams.js';

const n = (r) => r.W + r.L;
const fmt = (r) => `${r.W}-${r.L}${r.P ? '-' + r.P : ''}`;

function candidates(a, id) {
  const t = a.perPlayer[id];
  const rows = a.standings;
  const row = rows.find((r) => r.player.id === id);
  const others = rows.filter((r) => r.player.id !== id);
  const total = t.total;
  const graded = n(total);
  const lastNet = Math.min(...rows.map((r) => r.net));
  const isLast = row.net === lastNet && rows.some((r) => r.net > lastNet);
  const soleLast = isLast && rows.filter((r) => r.net === lastNet).length === 1;
  const soleLeader = row.rank === 1 && others.every((r) => r.net < row.net);
  const streakN = Number((row.streak || '').slice(1)) || 0;
  const streakW = row.streak?.startsWith('W');
  const twin = others
    .map((r) => ({ name: r.player.name, x: a.agree[id][r.player.id] }))
    .filter((z) => z.x && z.x.both >= 4)
    .sort((x, y) => y.x.pct - x.x.pct)[0];
  const slotRows = Object.entries(t.bySlot).filter(([, r]) => n(r) >= 2);
  const deadSlot = slotRows.filter(([, r]) => r.W === 0).sort((x, y) => y[1].L - x[1].L)[0];
  const ownSlot = slotRows.filter(([, r]) => r.L === 0).sort((x, y) => y[1].W - x[1].W)[0];
  const weeks = Object.values(row.byWeek).filter((r) => n(r) >= 4);
  const worstWeek = weeks.filter((r) => r.W <= 1).sort((x, y) => x.W - y.W)[0];
  const cleanWeek = weeks.find((r) => r.L === 0);
  const teamEntries = Object.entries(t.teamRecs).filter(([, r]) => n(r) >= 3);
  const loyalLoser = teamEntries.filter(([, r]) => r.pct < 0.4).sort((x, y) => y[1].L - x[1].L)[0];
  const moneyTeam = teamEntries.filter(([, r]) => r.pct >= 0.75).sort((x, y) => y[1].W - x[1].W)[0];
  const luck = t.closeW - t.badBeats;

  const rules = [
    [soleLeader, 100, 'The Board Boss', '👑 Running the board'],
    [soleLast && graded >= 5, 95, 'Bottom Feeder', '🗑️ Dead last. Embarrassing.'],
    [isLast && !soleLast && graded >= 5, 80, null, '🗑️ Tied for dead last'],
    [graded >= 6 && total.pct < 0.35, 90, 'The Human Fade Button', `Fading you is free money (${total.L}-${total.W})`],
    [graded >= 6 && total.pct >= 0.65, 70, 'Actually Knows Ball', `Hitting ${Math.round(total.pct * 100)}%. Suspicious.`],
    [!streakW && streakN >= 5, 88, 'Needs a Timeout', `🧊 ${streakN} straight Ls. Put the phone down.`],
    [!streakW && streakN >= 3 && streakN < 5, 60, 'Ice Cold', `🧊 ${streakN} straight Ls`],
    [streakW && streakN >= 3, 65, 'The Heater', `🔥 ${streakN} straight covers`],
    [graded >= 4 && t.avgMargin <= -6, 75, 'Not Even Close', `Loses by ${Math.abs(t.avgMargin).toFixed(1)} a pick on average`],
    [graded >= 4 && t.avgMargin >= 6, 55, null, `Covers by a mile (+${t.avgMargin.toFixed(1)} avg)`],
    [luck >= 2, 72, 'Lucky Bastard', `${t.closeW} covers by less than a field goal. Backdoor merchant.`],
    [t.badBeats >= 2 && luck <= -2, 74, 'Cursed', `${t.badBeats} losses by less than a field goal. The football gods hate you.`],
    [t.favPct != null && t.favPct >= 0.65 && t.fav.pct != null && t.fav.pct < 0.5, 68, 'Pays Retail for Chalk', `Loves favorites, favorites don't love back (${fmt(t.fav)})`],
    [t.favPct != null && t.favPct >= 0.65 && !(t.fav.pct < 0.5), 40, 'Chalk Eater', 'Chalk eater'],
    [t.favPct != null && t.favPct <= 0.35 && t.dog.pct != null && t.dog.pct < 0.5, 67, 'Dog Hoarder', `Adopts every dog at the shelter and they all bite (${fmt(t.dog)})`],
    [t.favPct != null && t.favPct <= 0.35 && !(t.dog.pct < 0.5), 45, 'Dog Whisperer', 'Lives on the points'],
    [t.loneShare <= 0.1 && t.picks.length >= 5, 50, 'NPC', 'Zero original thoughts'],
    [t.herd.pct != null && n(t.herd) >= 3 && t.herd.pct < 0.4, 62, 'The Sheep', `Follows the herd straight off a cliff (${fmt(t.herd)})`],
    [t.loneShare >= 0.3 && t.lone.pct != null && t.lone.pct < 0.4, 64, 'Contrarian for No Reason', `Goes rogue and gets rocked (${fmt(t.lone)})`],
    [t.loneShare >= 0.3 && t.lone.pct != null && t.lone.pct >= 0.6, 58, 'Lone Wolf', `Sees what nobody else sees (${fmt(t.lone)})`],
    [t.homePct >= 0.7 && t.picks.length >= 5, 35, 'The Homer', 'Homebody'],
    [t.homePct <= 0.3 && t.picks.length >= 5, 35, 'Road Warrior', 'Road warrior'],
    [n(t.prime) >= 3 && t.prime.pct <= 0.3, 63, 'Scared of the Lights', `Chokes in primetime (${fmt(t.prime)})`],
    [n(t.prime) >= 3 && t.prime.pct >= 0.75, 57, 'Primetime Player', `Lives for the lights (${fmt(t.prime)})`],
    [!!deadSlot, 52, deadSlot && `The ${deadSlot[0]} Disaster`, deadSlot && `Banned from ${deadSlot[0]} (${fmt(deadSlot[1])})`],
    [!!ownSlot, 42, null, ownSlot && `Owns ${ownSlot[0]} (${fmt(ownSlot[1])})`],
    [!!worstWeek, 48, 'One-Win Wonder', worstWeek && `Went ${fmt(worstWeek)} in a week. Unforgivable.`],
    [!!cleanWeek, 54, 'Perfect Week', cleanWeek && `Had a clean ${fmt(cleanWeek)} week`],
    [!!twin && twin.x.pct >= 0.6, 56, 'Copy Paste', twin && `${twin.name}'s shadow (${Math.round(twin.x.pct * 100)}% same picks)`],
    [!!loyalLoser, 61, null, loyalLoser && `Blind loyalty to the ${teamName(loyalLoser[0])} (${fmt(loyalLoser[1])})`],
    [!!moneyTeam, 44, null, moneyTeam && `Cashes on the ${teamName(moneyTeam[0])} (${fmt(moneyTeam[1])})`],
    [total.P >= 2, 30, 'Push King', `${total.P} pushes. Can't even lose right.`],
  ].filter((r) => r[0] && r[3]);

  rules.sort((x, y) => y[1] - x[1]);
  return { nicks: rules.filter((r) => r[2]).map((r) => [r[2], r[1]]), tags: rules.map((r) => r[3]).slice(0, 6) };
}

const FALLBACK = ['Background Character', 'Warm Body', 'Participation Trophy', 'Replacement Level', 'Just Happy to Be Here', 'Filler'];

// Nicknames are unique: whoever has the strongest claim gets it; everyone else takes their next one.
export function roastAll(a) {
  if (a._roast) return a._roast;
  const cands = a.standings.map((r) => ({ id: r.player.id, ...candidates(a, r.player.id) }));
  const claims = cands.flatMap((c) => c.nicks.map(([nick, pri]) => ({ id: c.id, nick, pri })));
  claims.sort((x, y) => y.pri - x.pri);
  const out = {};
  const used = new Set();
  for (const cl of claims) {
    if (out[cl.id] || used.has(cl.nick)) continue;
    out[cl.id] = cl.nick;
    used.add(cl.nick);
  }
  const spare = FALLBACK.filter((f) => !used.has(f));
  a._roast = Object.fromEntries(cands.map((c) => [c.id, { nick: out[c.id] || spare.shift() || 'Rookie', tags: c.tags }]));
  return a._roast;
}

export const roast = (a, id) => roastAll(a)[id];
