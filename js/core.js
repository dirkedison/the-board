// Pure league logic: grading against the spread, standings, timelines.
// No DOM here, so tools/ can import it under Node too.

const ET = 'America/New_York';

export function etParts(iso) {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ET, weekday: 'short', hour: 'numeric', hour12: false, minute: '2-digit',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { day: get('weekday'), hour: Number(get('hour')) % 24, minute: Number(get('minute')) };
}

// Default time-slot label for a kickoff. The commissioner can override per game.
export function slotLabelFor(iso) {
  const { day, hour } = etParts(iso);
  if (day === 'Sun') {
    if (hour < 12) return 'Sun AM';
    if (hour < 15) return 'Sun 1PM';
    if (hour < 19) return 'Sun 4PM';
    return 'Sun 8PM';
  }
  return day;
}

export function formatKickoff(iso) {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: ET, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }) + ' ET';
}

export const hasScore = (g) => g.awayScore != null && g.homeScore != null;

// Points the given team gets from the line (+ for the dog, - for the favorite).
export function lineFor(g, team) {
  if (!g.fav || !g.spread) return 0;
  return g.fav === team ? -g.spread : g.spread;
}

export function scoreFor(g, team) {
  return team === g.home ? g.homeScore : g.awayScore;
}

// ATS margin for a side: >0 covering, <0 not, 0 push. Null without a score.
export function atsMargin(g, team) {
  if (!hasScore(g)) return null;
  const opp = team === g.home ? g.away : g.home;
  return scoreFor(g, team) - scoreFor(g, opp) + lineFor(g, team);
}

// Which side covered: team code, 'push', or null while undecided.
export function coverSide(g) {
  if (g.result) return g.result; // manual override
  if (g.status !== 'final' || !hasScore(g)) return null;
  const m = atsMargin(g, g.home);
  return m > 0 ? g.home : m < 0 ? g.away : 'push';
}

// Side covering right now (for live games), or null.
export function liveCoverSide(g) {
  if (g.status !== 'live' || !hasScore(g)) return null;
  const m = atsMargin(g, g.home);
  return m > 0 ? g.home : m < 0 ? g.away : 'push';
}

export function outcome(g, team) {
  const c = coverSide(g);
  if (!c) return null;
  if (c === 'push') return 'P';
  return c === team ? 'W' : 'L';
}

// Slots of a week in kickoff order: [{label, kickoff, games}]
export function weekSlots(week) {
  const map = new Map();
  for (const g of week.games) {
    if (!map.has(g.slot)) map.set(g.slot, []);
    map.get(g.slot).push(g);
  }
  const slots = [...map.entries()].map(([label, games]) => {
    games.sort((a, b) => a.kickoff.localeCompare(b.kickoff) || a.away.localeCompare(b.away));
    return { label, games, kickoff: games[0].kickoff };
  });
  slots.sort((a, b) => a.kickoff.localeCompare(b.kickoff));
  return slots;
}

// Every pick in the league, flattened with context, in chronological slot order.
export function allPicks(league) {
  const out = [];
  let slotIndex = 0;
  for (const week of [...league.weeks].sort((a, b) => a.week - b.week)) {
    for (const slot of weekSlots(week)) {
      for (const g of slot.games) {
        for (const [pid, team] of Object.entries(g.picks || {})) {
          const opp = team === g.home ? g.away : g.home;
          out.push({
            player: pid, week: week.week, slot: slot.label, slotIndex, game: g, team, opp,
            isFav: g.fav === team, isDog: !!g.fav && g.fav !== team && !!g.spread,
            isHome: team === g.home, spread: g.spread || 0,
            outcome: outcome(g, team), margin: coverSide(g) ? atsMargin(g, team) : null,
          });
        }
      }
      // No pick in a slot counts as a loss once the commissioner marks it missed.
      for (const [pid, slots] of Object.entries(week.missed || {})) {
        if (!slots.includes(slot.label)) continue;
        out.push({
          player: pid, week: week.week, slot: slot.label, slotIndex, game: null, team: null, opp: null,
          isFav: false, isDog: false, isHome: false, spread: 0, outcome: 'L', margin: null, missed: true,
        });
      }
      slotIndex++;
    }
  }
  return out;
}

export function record(picks) {
  const r = { W: 0, L: 0, P: 0, pending: 0 };
  for (const p of picks) {
    if (p.outcome) r[p.outcome]++;
    else r.pending++;
  }
  r.pct = r.W + r.L ? r.W / (r.W + r.L) : null;
  r.net = r.W - r.L;
  return r;
}

export const fmtRecord = (r, pushes = true) => `${r.W}-${r.L}${pushes && r.P ? '-' + r.P : ''}`;
export const fmtPct = (p) => (p == null ? '—' : p === 1 ? '1.000' : p.toFixed(3).replace(/^0/, ''));

export function streak(picks) {
  const graded = picks.filter((p) => p.outcome && p.outcome !== 'P');
  if (!graded.length) return '';
  const last = graded[graded.length - 1].outcome;
  let n = 0;
  for (let i = graded.length - 1; i >= 0 && graded[i].outcome === last; i--) n++;
  return last + n;
}

export function standings(league) {
  const picks = allPicks(league);
  const weeks = [...new Set(league.weeks.map((w) => w.week))].sort((a, b) => a - b);
  const rows = league.players.map((pl) => {
    const mine = picks.filter((p) => p.player === pl.id);
    const byWeek = {};
    for (const w of weeks) byWeek[w] = record(mine.filter((p) => p.week === w));
    return { player: pl, picks: mine, ...record(mine), streak: streak(mine), byWeek };
  });
  rows.sort((a, b) => b.net - a.net || (b.pct ?? 0) - (a.pct ?? 0) || b.W - a.W || a.player.name.localeCompare(b.player.name));
  const top = rows[0]?.net ?? 0;
  rows.forEach((r, i) => {
    r.gb = (top - r.net) / 2;
    r.rank = i > 0 && rows[i - 1].net === r.net ? rows[i - 1].rank : i + 1;
  });
  return rows;
}

// Season as a sequence of graded slots, with each player's cumulative record after each.
export function timeline(league) {
  const picks = allPicks(league).filter((p) => p.outcome);
  const slotKeys = [...new Map(picks.map((p) => [p.slotIndex, { index: p.slotIndex, week: p.week, slot: p.slot }])).values()]
    .sort((a, b) => a.index - b.index);
  const cum = Object.fromEntries(league.players.map((p) => [p.id, { W: 0, L: 0, P: 0 }]));
  const points = slotKeys.map((s) => {
    for (const p of picks.filter((x) => x.slotIndex === s.index)) cum[p.player][p.outcome]++;
    const snap = {};
    for (const [id, c] of Object.entries(cum)) snap[id] = { ...c, net: c.W - c.L };
    const best = Math.max(...Object.values(snap).map((c) => c.net));
    const leaders = Object.keys(snap).filter((id) => snap[id].net === best);
    return { ...s, snap, leaders };
  });
  return points;
}

// Every graded game on the board, from each team's side, graded against our lines.
export function teamATS(league) {
  const out = {};
  for (const w of [...league.weeks].sort((a, b) => a.week - b.week)) {
    for (const g of w.games) {
      if (g.spread == null || !coverSide(g)) continue;
      for (const team of [g.away, g.home]) {
        const isHome = team === g.home;
        (out[team] ??= []).push({
          week: w.week, game: g, team, opp: isHome ? g.away : g.home, isHome,
          isFav: g.fav === team && g.spread > 0, isDog: !!g.fav && g.fav !== team && g.spread > 0,
          spread: g.spread, outcome: outcome(g, team), margin: atsMargin(g, team),
        });
      }
    }
  }
  return out;
}
