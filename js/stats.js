// Analytics built on core.allPicks(). Everything here is derived, nothing stored.
import { allPicks, record, timeline, standings } from './core.js';

const PRIME = ['Wed', 'Thu', 'Fri', 'Sat', 'Sun 8PM', 'Mon', 'Tue'];
export const SPREAD_BUCKETS = [
  ['Pick’em to 3', (p) => p.spread <= 3],
  ['3.5 to 6.5', (p) => p.spread > 3 && p.spread < 7],
  ['7+', (p) => p.spread >= 7],
];

const SLOT_ORDER = ['Wed', 'Thu', 'Fri', 'Sat', 'Sun AM', 'Sun 1PM', 'Sun 4PM', 'Sun 8PM', 'Mon', 'Tue'];

export function slotCategories(picks) {
  const set = new Set(picks.map((p) => p.slot));
  return [...set].sort((a, b) => {
    const ia = SLOT_ORDER.indexOf(a), ib = SLOT_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
}

const share = (arr, fn) => (arr.length ? arr.filter(fn).length / arr.length : null);
const avg = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null);

// How many other players took the exact same side in the same slot.
function crowdSize(picks, p) {
  return picks.filter((q) => q !== p && q.week === p.week && q.slot === p.slot && q.game === p.game && q.team === p.team).length;
}

export function analyze(league) {
  const picks = allPicks(league);
  const players = league.players;
  const graded = picks.filter((p) => p.outcome);
  const n = players.length;
  for (const p of picks) p.crowd = crowdSize(picks, p);

  const perPlayer = {};
  for (const pl of players) {
    const mine = picks.filter((p) => p.player === pl.id);
    const g = mine.filter((p) => p.outcome);
    const margins = g.map((p) => p.margin).filter((m) => m != null);
    const teamCounts = {};
    for (const p of mine) teamCounts[p.team] = (teamCounts[p.team] || 0) + 1;
    const favTeam = Object.entries(teamCounts).sort((a, b) => b[1] - a[1])[0];
    perPlayer[pl.id] = {
      picks: mine,
      total: record(mine),
      favPct: share(mine.filter((p) => p.spread), (p) => p.isFav),
      homePct: share(mine, (p) => p.isHome),
      avgLine: avg(mine.map((p) => (p.isFav ? -p.spread : p.spread))),
      avgMargin: avg(margins),
      fav: record(mine.filter((p) => p.isFav)),
      dog: record(mine.filter((p) => p.isDog)),
      home: record(mine.filter((p) => p.isHome)),
      away: record(mine.filter((p) => !p.isHome)),
      lone: record(mine.filter((p) => p.crowd === 0)),
      herd: record(mine.filter((p) => p.crowd + 1 > n / 2)),
      loneShare: share(mine, (p) => p.crowd === 0),
      badBeats: g.filter((p) => p.outcome === 'L' && p.margin > -3).length,
      closeW: g.filter((p) => p.outcome === 'W' && p.margin != null && p.margin < 3).length,
      prime: record(mine.filter((p) => PRIME.includes(p.slot))),
      daytime: record(mine.filter((p) => !PRIME.includes(p.slot))),
      buckets: SPREAD_BUCKETS.map(([label, fn]) => [label, record(mine.filter(fn))]),
      teamRecs: Object.fromEntries(Object.keys(teamCounts).map((tm) => [tm, record(mine.filter((p) => p.team === tm))])),
      best: [...g].filter((p) => p.margin != null).sort((x, y) => y.margin - x.margin)[0],
      worst: [...g].filter((p) => p.margin != null).sort((x, y) => x.margin - y.margin)[0],
      bySlot: {},
      favTeam: favTeam ? { team: favTeam[0], count: favTeam[1] } : null,
      teamCounts,
    };
  }
  const cats = slotCategories(picks);
  for (const pl of players) for (const c of cats) {
    perPlayer[pl.id].bySlot[c] = record(perPlayer[pl.id].picks.filter((p) => p.slot === c));
  }

  // Pairwise agreement: share of slots both picked where they took the same side.
  const agree = {};
  for (const a of players) {
    agree[a.id] = {};
    for (const b of players) {
      if (a.id === b.id) continue;
      const pa = perPlayer[a.id].picks;
      let both = 0, same = 0;
      for (const p of pa) {
        const q = perPlayer[b.id].picks.find((x) => x.week === p.week && x.slot === p.slot);
        if (!q) continue;
        both++;
        if (q.game === p.game && q.team === p.team) same++;
      }
      agree[a.id][b.id] = both ? { same, both, pct: same / both } : null;
    }
  }

  // Duels: both players on the same game, opposite sides. Record from the row player's view.
  const duels = {};
  for (const a of players) {
    duels[a.id] = {};
    for (const b of players) {
      if (a.id === b.id) continue;
      const mine = perPlayer[a.id].picks.filter((p) => perPlayer[b.id].picks.some((q) => q.game === p.game && q.team !== p.team));
      duels[a.id][b.id] = record(mine);
    }
  }

  // Team ledger: how the group does when backing each team.
  const teams = {};
  for (const p of picks) {
    teams[p.team] ??= { team: p.team, picks: [], against: [] };
    teams[p.team].picks.push(p);
    teams[p.opp] ??= { team: p.opp, picks: [], against: [] };
    teams[p.opp].against.push(p);
  }
  const teamRows = Object.values(teams).map((t) => ({
    team: t.team, count: t.picks.length, rec: record(t.picks), fadedCount: t.against.length,
  })).sort((a, b) => b.count - a.count || b.rec.net - a.rec.net);

  // Crowd: sides backed by a majority of the league.
  const majoritySides = new Map();
  for (const p of graded) if (p.crowd + 1 > n / 2) majoritySides.set(p.game.id + p.team, p);
  const crowdRec = record([...majoritySides.values()]);

  const withMargin = graded.filter((p) => p.margin != null && p.outcome !== 'P');
  const blowouts = [...withMargin].filter((p) => p.outcome === 'W').sort((a, b) => b.margin - a.margin).slice(0, 5);
  const beats = [...withMargin].filter((p) => p.outcome === 'L').sort((a, b) => b.margin - a.margin).slice(0, 5);
  const sweats = withMargin.filter((p) => Math.abs(p.margin) <= 1.5);

  // Lead history
  const tl = timeline(league);
  let changes = 0;
  const slotsInFirst = Object.fromEntries(players.map((p) => [p.id, 0]));
  let prevKey = null;
  for (const pt of tl) {
    for (const id of pt.leaders) slotsInFirst[id]++;
    const key = pt.leaders.length === 1 ? pt.leaders[0] : null;
    if (key && prevKey && key !== prevKey) changes++;
    if (key) prevKey = key;
  }

  return {
    picks, graded, perPlayer, agree, duels, teamRows, crowdRec, blowouts, beats, sweats, cats,
    timeline: tl, leadChanges: changes, slotsInFirst, standings: standings(league),
    overall: {
      fav: record(graded.filter((p) => p.isFav)),
      dog: record(graded.filter((p) => p.isDog)),
      home: record(graded.filter((p) => p.isHome)),
      away: record(graded.filter((p) => !p.isHome)),
      all: record(graded),
    },
  };
}
