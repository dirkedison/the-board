// ESPN's public scoreboard feed (CORS-open, no key). Used for schedules,
// default lines, live scores, and final scores that grade the board.

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

function parseOdds(comp) {
  const o = comp.odds && comp.odds[0];
  if (!o || !o.details) return null;
  const m = /^([A-Z]{2,3})\s+(-?\d+(?:\.\d+)?)$/.exec(o.details.trim());
  if (!m) return null;
  return { fav: m[1], spread: Math.abs(Number(m[2])) };
}

export function parseEvent(e) {
  const c = e.competitions[0];
  const away = c.competitors.find((t) => t.homeAway === 'away');
  const home = c.competitors.find((t) => t.homeAway === 'home');
  const state = c.status.type.state; // pre | in | post
  return {
    id: e.id,
    kickoff: e.date,
    away: away.team.abbreviation,
    home: home.team.abbreviation,
    awayScore: state === 'pre' ? null : Number(away.score),
    homeScore: state === 'pre' ? null : Number(home.score),
    status: state === 'post' ? 'final' : state === 'in' ? 'live' : 'pre',
    detail: c.status.type.shortDetail,
    odds: parseOdds(c),
  };
}

export async function fetchWeek(season, week) {
  const url = `${BASE}?seasontype=2&week=${week}&dates=${season}&_=${Date.now()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN ${res.status}`);
  const data = await res.json();
  return (data.events || []).map(parseEvent);
}

// The scoreboard ESPN considers "now" (current regular-season week).
export async function fetchCurrent() {
  const res = await fetch(`${BASE}?_=${Date.now()}`);
  if (!res.ok) throw new Error(`ESPN ${res.status}`);
  const data = await res.json();
  return {
    season: data.season?.year,
    week: data.week?.number,
    regular: data.season?.type === 2,
    events: (data.events || []).map(parseEvent),
  };
}

// Copy live/final scores onto a league week in place. Returns true if anything changed.
export function applyScores(week, events) {
  let changed = false;
  const byId = new Map(events.map((e) => [e.id, e]));
  const byTeams = new Map(events.map((e) => [e.away + '@' + e.home, e]));
  for (const g of week.games) {
    const e = byId.get(g.id) || byTeams.get(g.away + '@' + g.home);
    if (!e) continue;
    for (const k of ['awayScore', 'homeScore', 'status', 'detail', 'kickoff']) {
      if (e[k] !== undefined && g[k] !== e[k]) { g[k] = e[k]; changed = true; }
    }
  }
  return changed;
}
