import { deriveKey, exportKey, importKey, decryptJSON } from './crypto.js';
import * as core from './core.js';
import { fetchWeek, fetchCurrent, applyScores } from './espn.js';
import { analyze } from './stats.js';
import { lineChart, sparkline, pctTint } from './charts.js';
import { TEAMS, teamName } from './teams.js';
import { renderAdmin } from './admin.js';

const DATA_URL = 'data/league.enc.json';

export const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

export const state = {
  blob: null, key: null, league: null,
  espn: {}, current: null, // current = { season, week }
  focus: null, liveTimer: null,
};

export const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, root = document) => root.querySelector(sel);

export const pcolor = (id) => `var(--p-${id})`;
export const player = (id) => state.league.players.find((p) => p.id === id);
export const ink = (id) => `<b class="ink" data-player="${h(id)}" style="color:${pcolor(id)}" title="${h(player(id)?.name)}">${h(id)}</b>`;
export const chip = (id, cls = '') => `<span class="chip ${cls}" data-player="${h(id)}" style="background:${pcolor(id)}" title="${h(player(id)?.name)}">${h(id)}</span>`;
const nameLink = (id) => `<a class="name-link" href="#/player/${h(id)}">${h(player(id)?.name)}</a>`;
const signed = (n, d = 1) => (n == null ? '—' : (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(d).replace(/\.0$/, ''));
const pct0 = (x) => (x == null ? '—' : Math.round(x * 100) + '%');

// ---------- theme ----------
const THEMES = ['system', 'light', 'dark'];
function applyTheme() {
  const t = store.get('theboard.theme') || 'system';
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  const btn = $('#theme-btn');
  if (btn) btn.dataset.mode = t;
}
function cycleTheme() {
  const t = store.get('theboard.theme') || 'system';
  store.set('theboard.theme', THEMES[(THEMES.indexOf(t) + 1) % THEMES.length]);
  applyTheme();
  render();
}

function injectPlayerColors() {
  const ps = state.league.players;
  const light = ps.map((p) => `--p-${p.id}:${p.color};`).join('');
  const dark = ps.map((p) => `--p-${p.id}:${p.colorDark || p.color};`).join('');
  let tag = $('#player-colors');
  if (!tag) { tag = document.createElement('style'); tag.id = 'player-colors'; document.head.appendChild(tag); }
  tag.textContent = `:root{${light}}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${dark}}}
:root[data-theme="dark"]{${dark}}`;
}

// ---------- unlock ----------
async function loadBlob() {
  const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Could not load league data');
  return res.json();
}

async function boot() {
  applyTheme();
  try {
    state.blob = await loadBlob();
  } catch (e) {
    $('#login-error').textContent = 'Could not reach the board. Check your connection and reload.';
    showLogin();
    return;
  }
  const saved = store.get('theboard.key');
  if (saved && saved.salt === state.blob.salt) {
    try {
      state.key = await importKey(saved.raw);
      state.league = await decryptJSON(state.blob, state.key);
      return start();
    } catch { store.del('theboard.key'); }
  }
  showLogin();
}

function showLogin() {
  document.body.classList.add('locked');
  $('#login').hidden = false;
  $('#app-shell').hidden = true;
  setTimeout(() => $('#password').focus(), 50);
}

async function unlock(e) {
  e.preventDefault();
  const btn = $('#unlock-btn');
  const err = $('#login-error');
  err.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    if (!state.blob) state.blob = await loadBlob();
    const key = await deriveKey($('#password').value, state.blob.salt, state.blob.iter);
    state.league = await decryptJSON(state.blob, key);
    state.key = key;
    if ($('#remember').checked) store.set('theboard.key', { salt: state.blob.salt, raw: await exportKey(key) });
    $('#password').value = '';
    start();
  } catch {
    err.textContent = 'Wrong password.';
    $('#login-card').classList.remove('shake');
    void $('#login-card').offsetWidth;
    $('#login-card').classList.add('shake');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Unlock';
  }
}

export function lock() {
  store.del('theboard.key');
  state.key = null; state.league = null;
  clearTimeout(state.liveTimer);
  location.hash = '';
  showLogin();
}

// Called by the commissioner page after a publish.
export function replaceLeague(league, blob, key) {
  state.league = league;
  if (blob) state.blob = blob;
  if (key) state.key = key;
  injectPlayerColors();
}

function start() {
  document.body.classList.remove('locked');
  $('#login').hidden = true;
  $('#app-shell').hidden = false;
  injectPlayerColors();
  render();
  refreshScores();
}

// ---------- live scores ----------
async function refreshScores() {
  clearTimeout(state.liveTimer);
  const L = state.league;
  if (!L) return;
  try {
    const cur = await fetchCurrent();
    if (cur.season === L.season && cur.regular) {
      state.current = { season: cur.season, week: cur.week };
      state.espn[cur.week] = cur.events;
    }
    const need = L.weeks.filter((w) => w.games.some((g) => g.status !== 'final') && !state.espn[w.week]);
    await Promise.all(need.map(async (w) => { state.espn[w.week] = await fetchWeek(L.season, w.week); }));
    let changed = false;
    for (const w of L.weeks) if (state.espn[w.week]) changed = applyScores(w, state.espn[w.week]) || changed;
    if (!location.hash.startsWith('#/admin')) render();
    $('#sync-status').textContent = 'Scores updated ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    $('#sync-status').textContent = 'Live scores unavailable';
  }
  const anyLive = Object.values(state.espn).some((evs) => evs.some((e) => e.status === 'live'));
  state.liveTimer = setTimeout(() => { state.espn = {}; refreshScores(); }, anyLive ? 45000 : 600000);
}

// A week to display: the league's week, or a read-only ESPN slate if picks aren't posted yet.
function displayWeek(n) {
  const w = state.league.weeks.find((x) => x.week === n);
  if (w) return { week: w, virtual: false };
  const evs = state.espn[n];
  if (!evs) return null;
  return {
    virtual: true,
    week: {
      week: n,
      games: evs.map((e) => ({ ...e, slot: core.slotLabelFor(e.kickoff), fav: e.odds?.fav, spread: e.odds?.spread, picks: {} })),
    },
  };
}

function weekNumbers() {
  const set = new Set(state.league.weeks.map((w) => w.week));
  if (state.current) set.add(state.current.week);
  return [...set].sort((a, b) => a - b);
}

// ---------- routing ----------
function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  return { view: parts[0] || 'standings', arg: parts[1] };
}

export function render() {
  if (!state.league) return;
  const { view, arg } = route();
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.view === view || (view === 'player' && a.dataset.view === 'players')));
  const main = $('#view');
  const scrollKey = view + (arg || '');
  if (main.dataset.key !== scrollKey) window.scrollTo(0, 0);
  main.dataset.key = scrollKey;
  if (view === 'standings') main.innerHTML = viewStandings();
  else if (view === 'stats') { main.innerHTML = viewStats(); mountStatsCharts(); }
  else if (view === 'player' && player(arg)) { main.innerHTML = viewPlayer(arg); mountPlayerChart(arg); }
  else if (view === 'players') main.innerHTML = viewPlayers();
  else if (view === 'admin') renderAdmin(main);
  else if (view === 'board') main.innerHTML = viewBoard(Number(arg) || null);
  else main.innerHTML = viewStandings();
}

// ---------- BOARD ----------
const X_MARK = `<svg class="xmark" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true"><path d="M3 4 Q50 22 97 37"/><path d="M4 36 Q48 16 96 3"/></svg>`;

function gameCard(g) {
  const players = state.league.players;
  const cover = core.coverSide(g);
  const live = core.liveCoverSide(g);
  const picked = Object.keys(g.picks || {}).length > 0;
  const side = (team) => {
    const pickers = players.filter((p) => g.picks?.[p.id] === team).map((p) => p.id);
    const line = g.fav === team && g.spread ? `-${g.spread}` : g.spread === 0 && team === g.home ? 'PK' : '';
    let cls = 'side';
    if (cover && cover !== 'push') cls += cover === team ? (picked ? ' circled' : ' won') : picked ? ' crossed' : ' lost';
    if (live === team) cls += ' covering';
    const score = core.hasScore(g) ? core.scoreFor(g, team) : '';
    return `<div class="${cls}">
      <span class="tname">${h(teamName(team))}${line ? `<span class="spread">${line}</span>` : ''}</span>
      <span class="pickers">${pickers.map(ink).join('')}</span>
      <span class="score">${score}</span>
      ${cls.includes('crossed') ? X_MARK : ''}
    </div>`;
  };
  let meta;
  if (cover) {
    const m = cover === 'push' ? 0 : core.atsMargin(g, cover);
    meta = `<span>${h(g.detail || 'Final')}</span><span class="res">${cover === 'push' ? '<b class="push">PUSH</b>' : `${h(teamName(cover))} cover by ${m}`}</span>`;
  } else if (g.status === 'live') {
    const m = live && live !== 'push' ? core.atsMargin(g, live) : 0;
    meta = `<span class="live-pill">LIVE</span><span>${h(g.detail || '')}</span><span class="res">${live === 'push' ? 'On the number' : live ? `${h(teamName(live))} covering by ${m}` : ''}</span>`;
  } else {
    meta = `<span>${h(core.formatKickoff(g.kickoff))}</span>`;
  }
  return `<article class="game${picked ? ' picked' : ' quiet'}${g.status === 'live' ? ' is-live' : ''}">
    ${side(g.away)}${side(g.home)}
    <div class="meta">${meta}</div>
  </article>`;
}

function viewBoard(n) {
  const weeks = weekNumbers();
  if (!n) {
    const cur = state.current?.week;
    n = cur && weeks.includes(cur) ? cur : weeks[weeks.length - 1];
  }
  const dw = displayWeek(n);
  const pills = weeks.map((w) => `<a class="pill${w === n ? ' active' : ''}" href="#/board/${w}">Wk ${w}${w === state.current?.week ? '<i class="now"></i>' : ''}</a>`).join('');
  const pickedOnly = store.get('theboard.pickedOnly') ?? false;
  let body;
  if (!dw) {
    body = `<p class="empty">Loading week ${n}…</p>`;
  } else {
    const slots = core.weekSlots(dw.week);
    const picks = core.allPicks({ ...state.league, weeks: [dw.week] });
    const wk = state.league.players.map((p) => {
      const r = core.record(picks.filter((x) => x.player === p.id));
      return `<a class="wk-rec" href="#/player/${p.id}">${chip(p.id)}<span>${core.fmtRecord(r, false)}</span>${r.pending ? `<small>${r.pending} open</small>` : ''}</a>`;
    }).join('');
    const sweat = picks.filter((p) => p.game.status === 'live');
    const sweatHtml = sweat.length ? `<section class="card sweat"><h3>Sweating right now</h3>${sweat.map((p) => {
      const m = core.atsMargin(p.game, p.team);
      return `<div class="sweat-row">${chip(p.player)}<span class="marker">${h(teamName(p.team))}</span><span class="${m > 0 ? 'up' : m < 0 ? 'down' : ''}">${m > 0 ? 'covering by ' + m : m < 0 ? 'short by ' + -m : 'on the number'}</span></div>`;
    }).join('')}</section>` : '';
    body = `
      ${dw.virtual ? `<div class="notice">Picks for week ${n} aren't on the board yet. Showing ESPN's slate and lines.</div>` : `<div class="wk-recs">${wk}</div>`}
      ${sweatHtml}
      <label class="toggle"><input type="checkbox" id="picked-only" ${pickedOnly ? 'checked' : ''}> Only games with picks</label>
      ${slots.map((s) => {
        const games = pickedOnly && !dw.virtual ? s.games.filter((g) => Object.keys(g.picks || {}).length) : s.games;
        if (!games.length) return '';
        const missing = dw.virtual ? [] : state.league.players.filter((p) => !s.games.some((g) => g.picks?.[p.id]));
        return `<section class="slot">
          <h2 class="slot-title"><span class="marker">${h(s.label)}</span>${missing.length && missing.length < state.league.players.length ? `<small>no pick: ${missing.map((p) => h(p.id)).join(' ')}</small>` : ''}</h2>
          <div class="games">${games.map(gameCard).join('')}</div>
        </section>`;
      }).join('')}`;
  }
  return `<header class="view-head board-head">
      <h1 class="marker board-title">NFL Week ${n}</h1>
    </header>
    <nav class="pills" aria-label="Weeks">${pills}</nav>
    ${body}`;
}

// ---------- STANDINGS ----------
function netSeries(tl, id) {
  return tl.map((pt) => pt.snap[id].net);
}

function viewStandings() {
  const rows = core.standings(state.league);
  const tl = core.timeline(state.league);
  const weeks = [...new Set(state.league.weeks.map((w) => w.week))].sort((a, b) => a - b);
  const leader = rows[0];
  const second = rows.find((r) => r.net < leader.net);
  const tied = rows.filter((r) => r.net === leader.net);
  const lead = tied.length > 1
    ? `${tied.map((r) => h(r.player.name)).join(' & ')} tied for first`
    : `${h(leader.player.name)} leads by ${second ? (leader.net - second.net) / 2 : 0} game${second && leader.net - second.net === 2 ? '' : 's'}`;
  return `<header class="view-head"><h1 class="marker">Standings</h1><p class="sub">${lead}</p></header>
    <ol class="standings">
      ${rows.map((r) => `<li>
        <a href="#/player/${r.player.id}" class="st-row" style="--pc:${pcolor(r.player.id)}">
          <span class="rank">${r.rank}</span>
          <span class="st-name"><span class="marker" style="color:var(--pc)">${h(r.player.name)}</span>
            <small>${r.pct == null ? '' : core.fmtPct(r.pct)} ${r.gb ? `· ${r.gb} GB` : ''} ${r.streak ? `· <span class="streak ${r.streak[0]}">${r.streak}</span>` : ''}</small></span>
          ${sparkline(netSeries(tl, r.player.id), pcolor(r.player.id))}
          <span class="st-rec">${core.fmtRecord(r, false)}${r.P ? `<small>${r.P}P</small>` : ''}</span>
        </a></li>`).join('')}
    </ol>
    <section class="card">
      <h3>Week by week</h3>
      <div class="table-wrap"><table class="grid-table">
        <thead><tr><th></th>${weeks.map((w) => `<th><a href="#/board/${w}">W${w}</a></th>`).join('')}<th>Total</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><th>${chip(r.player.id, 'sm')} ${nameLink(r.player.id)}</th>${weeks.map((w) => {
          const x = r.byWeek[w];
          return `<td style="${pctTint(x.pct, x.W + x.L)}">${x.W + x.L + x.P ? core.fmtRecord(x) : '—'}</td>`;
        }).join('')}<td class="strong">${core.fmtRecord(r)}</td></tr>`).join('')}</tbody>
      </table></div>
      <p class="legend-note"><span class="sw pos"></span> above .500 <span class="sw neg"></span> below .500</p>
    </section>`;
}

// ---------- STATS ----------
let lastAnalysis = null;

function recCell(r) {
  const n = r.W + r.L;
  return `<td style="${pctTint(r.pct, n)}">${n + r.P ? core.fmtRecord(r) : '—'}</td>`;
}

function viewStats() {
  const a = analyze(state.league);
  lastAnalysis = a;
  const ps = state.league.players;
  if (!a.graded.length) return `<header class="view-head"><h1 class="marker">Stats</h1></header><p class="empty">Stats show up once games are graded.</p>`;
  const maxFirst = Math.max(...Object.values(a.slotsInFirst));
  const o = a.overall;
  return `<header class="view-head"><h1 class="marker">Stats</h1><p class="sub">${a.graded.length} graded picks · ${a.timeline.length} slots</p></header>

    <div class="tiles">
      <div class="tile"><span class="tile-num">${a.leadChanges}</span><span class="tile-label">lead changes</span></div>
      <div class="tile"><span class="tile-num">${core.fmtRecord(a.crowdRec, false)}</span><span class="tile-label">the crowd (majority picks)</span></div>
      <div class="tile"><span class="tile-num">${pct0(o.fav.W + o.fav.L + o.dog.W + o.dog.L ? (o.fav.W + o.fav.L) / (o.fav.W + o.fav.L + o.dog.W + o.dog.L) : null)}</span><span class="tile-label">of picks on favorites</span></div>
      <div class="tile"><span class="tile-num">${a.sweats.length}</span><span class="tile-label">picks decided by ≤1.5</span></div>
    </div>

    <section class="card">
      <h3>The race</h3>
      <p class="hint">Games over .500 after every time slot. Tap the chart for the standings at that moment; tap a letter to follow one player.</p>
      <div class="legend">${ps.map((p) => `<button class="legend-item${state.focus && state.focus !== p.id ? ' dim' : ''}" data-focus="${p.id}">${chip(p.id, 'sm')}${h(p.name)}</button>`).join('')}</div>
      <div id="race-chart"></div>
      <details class="table-toggle"><summary>Table view</summary>
        <div class="table-wrap"><table class="grid-table"><thead><tr><th>After</th>${ps.map((p) => `<th>${p.id}</th>`).join('')}<th>Leader</th></tr></thead>
        <tbody>${a.timeline.map((pt) => `<tr><th>W${pt.week} ${h(pt.slot)}</th>${ps.map((p) => `<td>${signed(pt.snap[p.id].net, 0)}</td>`).join('')}<td>${pt.leaders.join(' ')}</td></tr>`).join('')}</tbody></table></div>
      </details>
    </section>

    <section class="card">
      <h3>Time in first place</h3>
      <p class="hint">Slots spent leading or tied for the lead.</p>
      <div class="bars">${ps.map((p) => ({ p, v: a.slotsInFirst[p.id] })).sort((x, y) => y.v - x.v).map(({ p, v }) =>
        `<div class="bar-row" title="${h(p.name)}: ${v} of ${a.timeline.length}">${chip(p.id, 'sm')}<span class="bar-track"><span class="bar" style="width:${maxFirst ? (v / maxFirst) * 100 : 0}%;background:${pcolor(p.id)}"></span></span><span class="bar-val">${v}</span></div>`).join('')}</div>
    </section>

    <section class="card">
      <h3>By time slot</h3>
      <p class="hint">Who owns primetime and who should skip Thursday.</p>
      <div class="table-wrap"><table class="grid-table">
        <thead><tr><th></th>${a.cats.map((c) => `<th>${h(c)}</th>`).join('')}</tr></thead>
        <tbody>${ps.map((p) => `<tr><th>${chip(p.id, 'sm')}</th>${a.cats.map((c) => recCell(a.perPlayer[p.id].bySlot[c])).join('')}</tr>`).join('')}</tbody>
      </table></div>
    </section>

    <section class="card">
      <h3>Pick tendencies</h3>
      <p class="hint">Favorite vs. underdog and home vs. road, with each player's record on each. "Avg line" is the average spread taken (+ means getting points).</p>
      <div class="table-wrap"><table class="grid-table tendencies">
        <thead><tr><th></th><th>Fav %</th><th>Fav</th><th>Dog</th><th>Home %</th><th>Home</th><th>Road</th><th>Avg line</th><th>Avg ATS</th><th>Fade them</th></tr></thead>
        <tbody>${ps.map((p) => {
          const t = a.perPlayer[p.id];
          return `<tr><th>${chip(p.id, 'sm')}</th><td>${pct0(t.favPct)}</td>${recCell(t.fav)}${recCell(t.dog)}<td>${pct0(t.homePct)}</td>${recCell(t.home)}${recCell(t.away)}<td>${signed(t.avgLine)}</td><td>${signed(t.avgMargin)}</td><td>${t.total.L}-${t.total.W}</td></tr>`;
        }).join('')}
        <tr class="total"><th>All</th><td>—</td>${recCell(o.fav)}${recCell(o.dog)}<td>—</td>${recCell(o.home)}${recCell(o.away)}<td></td><td></td><td></td></tr></tbody>
      </table></div>
    </section>

    <section class="card">
      <h3>Lone wolves vs. the herd</h3>
      <p class="hint">A lone-wolf pick is a side nobody else took. A herd pick is one a majority of the league piled onto.</p>
      <div class="table-wrap"><table class="grid-table">
        <thead><tr><th></th><th>Lone wolf %</th><th>Lone wolf</th><th>With herd</th></tr></thead>
        <tbody>${ps.map((p) => {
          const t = a.perPlayer[p.id];
          return `<tr><th>${chip(p.id, 'sm')} ${nameLink(p.id)}</th><td>${pct0(t.loneShare)}</td>${recCell(t.lone)}${recCell(t.herd)}</tr>`;
        }).join('')}</tbody>
      </table></div>
    </section>

    <section class="card">
      <h3>Pick twins</h3>
      <p class="hint">How often two players took the exact same side in the same slot.</p>
      <div class="table-wrap"><table class="grid-table matrix">
        <thead><tr><th></th>${ps.map((p) => `<th>${chip(p.id, 'sm')}</th>`).join('')}</tr></thead>
        <tbody>${ps.map((r) => `<tr><th>${chip(r.id, 'sm')}</th>${ps.map((c) => {
          if (r.id === c.id) return '<td class="self"></td>';
          const x = a.agree[r.id][c.id];
          if (!x) return '<td>—</td>';
          return `<td style="background:color-mix(in oklab, var(--seq) ${Math.round(x.pct * 75)}%, var(--surface))" class="${x.pct > 0.55 ? 'on-dark' : ''}" title="${h(r.name)} & ${h(c.name)}: ${x.same} of ${x.both}">${Math.round(x.pct * 100)}</td>`;
        }).join('')}</tr>`).join('')}</tbody>
      </table></div>
    </section>

    <section class="card">
      <h3>Team ledger</h3>
      <p class="hint">Teams the league backs most, and how that's gone.</p>
      <div class="bars">${a.teamRows.filter((t) => t.count).slice(0, 10).map((t) => `<div class="bar-row team-row">
        <span class="marker team-lbl">${h(teamName(t.team))}</span>
        <span class="bar-track"><span class="bar neutral" style="width:${(t.count / a.teamRows[0].count) * 100}%"></span></span>
        <span class="bar-val">${t.count} <small>${core.fmtRecord(t.rec)}</small></span></div>`).join('')}</div>
    </section>

    <section class="card two-col">
      <div><h3>Biggest covers</h3>${a.blowouts.map(pickLine).join('') || '<p class="hint">None yet</p>'}</div>
      <div><h3>Bad beats</h3>${a.beats.map(pickLine).join('') || '<p class="hint">None yet</p>'}</div>
    </section>`;
}

function pickLine(p) {
  const g = p.game;
  const line = p.isFav ? `-${p.spread}` : p.spread ? `+${p.spread}` : 'PK';
  return `<div class="pick-line">${chip(p.player, 'sm')}<span><span class="marker">${h(teamName(p.team))} ${line}</span> <small>W${p.week} · ${core.scoreFor(g, p.team)}-${core.scoreFor(g, p.opp)} vs ${h(teamName(p.opp))}</small></span><span class="margin ${p.outcome}">${signed(p.margin)}</span></div>`;
}

function mountStatsCharts() {
  const host = $('#race-chart');
  if (!host || !lastAnalysis) return;
  const tl = lastAnalysis.timeline;
  const ps = state.league.players;
  lineChart(host, {
    series: ps.map((p) => ({ id: p.id, label: p.name, color: pcolor(p.id), values: netSeries(tl, p.id) })),
    points: tl.map((pt) => ({ label: `Week ${pt.week} · ${pt.slot}`, group: `W${pt.week}` })),
    yLabel: 'Games over .500 by time slot',
    focus: state.focus,
    onFocus: setFocus,
    tooltipRow: (s, i) => { const c = tl[i].snap[s.id]; return `${c.W}-${c.L}${c.P ? '-' + c.P : ''} <b>${signed(c.net, 0)}</b>`; },
  });
}

function setFocus(id) {
  state.focus = state.focus === id ? null : id;
  document.querySelectorAll('[data-focus]').forEach((b) => b.classList.toggle('dim', !!state.focus && b.dataset.focus !== state.focus));
  mountStatsCharts();
}

// ---------- PLAYERS ----------
function bioBlock(p) {
  const team = p.team && TEAMS[p.team] ? `<span class="fan-of">Roots for the <b class="marker">${h(teamName(p.team))}</b></span>` : '';
  const bio = p.bio ? `<p class="bio">${h(p.bio)}</p>` : '';
  return bio || team ? `<div class="bio-block">${bio}${team}</div>` : '';
}

// Auto-generated personality tags from pick history.
function scoutingTags(a, id) {
  const t = a.perPlayer[id];
  const row = a.standings.find((r) => r.player.id === id);
  const tags = [];
  const n = t.picks.length;
  if (row.rank === 1) tags.push('👑 Top of the board');
  if (row.streak && /^W[3-9]/.test(row.streak)) tags.push(`🔥 On fire (${row.streak})`);
  if (row.streak && /^L[3-9]/.test(row.streak)) tags.push(`🧊 Ice cold (${row.streak})`);
  if (n >= 4 && t.favPct != null && t.favPct >= 0.65) tags.push('Chalk eater');
  if (n >= 4 && t.favPct != null && t.favPct <= 0.35) tags.push('Dog lover');
  if (n >= 4 && t.homePct >= 0.7) tags.push('Homebody');
  if (n >= 4 && t.homePct <= 0.3) tags.push('Road warrior');
  if (n >= 4 && t.loneShare >= 0.3) tags.push('Lone wolf');
  if (n >= 4 && t.loneShare <= 0.1) tags.push('Runs with the herd');
  const slots = Object.entries(t.bySlot).filter(([, r]) => r.W + r.L >= 2);
  const best = slots.filter(([, r]) => r.pct === 1).sort((x, y) => y[1].W - x[1].W)[0];
  const worst = slots.filter(([, r]) => r.pct === 0).sort((x, y) => y[1].L - x[1].L)[0];
  if (best) tags.push(`Owns ${best[0]}`);
  if (worst) tags.push(`Cursed on ${worst[0]}`);
  if (t.favTeam && t.favTeam.count >= 3) tags.push(`Rides the ${teamName(t.favTeam.team)}`);
  if (t.badBeats >= 2) tags.push('Bad-beat magnet');
  return tags.slice(0, 5);
}

function viewPlayers() {
  const a = analyze(state.league);
  lastAnalysis = a;
  const tl = a.timeline;
  return `<header class="view-head"><h1 class="marker">Players</h1><p class="sub">Tap anyone for the full scouting report.</p></header>
    <div class="player-grid">
      ${a.standings.map((r) => {
        const p = r.player;
        return `<a class="pl-card" href="#/player/${p.id}" style="--pc:${pcolor(p.id)}">
          <div class="pl-top">
            <span class="pl-chip" style="background:var(--pc)">${h(p.id)}</span>
            <div class="pl-id"><span class="marker pl-name" style="color:var(--pc)">${h(p.name)}</span>
              <small>#${r.rank} · ${core.fmtRecord(r)}${r.pct != null ? ' · ' + core.fmtPct(r.pct) : ''}</small></div>
            ${sparkline(netSeries(tl, p.id), 'var(--pc)', 80, 30)}
          </div>
          ${bioBlock(p)}
          <div class="tags">${scoutingTags(a, p.id).map((t) => `<span class="tag">${h(t)}</span>`).join('')}</div>
        </a>`;
      }).join('')}
    </div>`;
}

// ---------- PLAYER ----------
function viewPlayer(id) {
  const a = analyze(state.league);
  lastAnalysis = a;
  const p = player(id);
  const t = a.perPlayer[id];
  const row = a.standings.find((r) => r.player.id === id);
  const byWeek = {};
  for (const pk of t.picks) (byWeek[pk.week] ??= []).push(pk);
  const bestSlot = Object.entries(t.bySlot).filter(([, r]) => r.W + r.L >= 2).sort((x, y) => y[1].pct - x[1].pct || y[1].W - x[1].W)[0];
  const others = state.league.players.filter((o) => o.id !== id);
  const twin = others.map((o) => ({ o, x: a.agree[id][o.id] })).filter((z) => z.x).sort((x, y) => y.x.pct - x.x.pct)[0];
  return `<header class="view-head player-head" style="--pc:${pcolor(id)}">
      <a href="#/players" class="back" data-back>‹ Back</a>
      <h1 class="marker" style="color:var(--pc)">${h(p.name)} <span class="big-chip">${chip(id)}</span></h1>
      <p class="sub">#${row.rank} · ${core.fmtRecord(row)} · ${core.fmtPct(row.pct)}${row.streak ? ` · streak <span class="streak ${row.streak[0]}">${row.streak}</span>` : ''}</p>
      ${bioBlock(p)}
      <div class="tags">${scoutingTags(a, id).map((t) => `<span class="tag">${h(t)}</span>`).join('')}</div>
    </header>
    <div class="tiles">
      <div class="tile"><span class="tile-num">${pct0(t.favPct)}</span><span class="tile-label">on favorites</span></div>
      <div class="tile"><span class="tile-num">${pct0(t.homePct)}</span><span class="tile-label">on home teams</span></div>
      <div class="tile"><span class="tile-num">${signed(t.avgMargin)}</span><span class="tile-label">avg ATS margin</span></div>
      <div class="tile"><span class="tile-num">${t.badBeats}</span><span class="tile-label">losses by &lt;3 ATS</span></div>
      <div class="tile"><span class="tile-num sm">${bestSlot ? h(bestSlot[0]) : '—'}</span><span class="tile-label">best slot${bestSlot ? ` (${core.fmtRecord(bestSlot[1])})` : ''}</span></div>
      <div class="tile"><span class="tile-num sm">${twin ? h(twin.o.name) : '—'}</span><span class="tile-label">pick twin${twin ? ` (${Math.round(twin.x.pct * 100)}% same)` : ''}</span></div>
    </div>
    <section class="card">
      <h3>${h(p.name)} vs. the field</h3>
      <p class="hint">Games over .500 after each slot. Gray is the league average.</p>
      <div id="player-chart"></div>
    </section>
    <section class="card">
      <h3>Every pick</h3>
      ${Object.keys(byWeek).sort((x, y) => y - x).map((w) => {
        const r = core.record(byWeek[w]);
        return `<div class="pick-week"><h4><a href="#/board/${w}">Week ${w}</a> <small>${core.fmtRecord(r)}</small></h4>
          ${byWeek[w].map((pk) => {
            const g = pk.game;
            const line = pk.isFav ? `-${pk.spread}` : pk.spread ? `+${pk.spread}` : 'PK';
            const res = pk.outcome || (g.status === 'live' ? 'live' : 'pending');
            return `<div class="pick-item">
              <span class="slot-tag">${h(pk.slot)}</span>
              <span class="pick-main"><span class="marker">${h(teamName(pk.team))} ${line}</span>
                <small>${pk.isHome ? 'vs' : '@'} ${h(teamName(pk.opp))}${core.hasScore(g) ? ` · ${core.scoreFor(g, pk.team)}-${core.scoreFor(g, pk.opp)}` : ''}${pk.crowd === 0 ? ' · lone wolf' : ` · +${pk.crowd} other${pk.crowd > 1 ? 's' : ''}`}</small></span>
              <span class="result ${res}">${res === 'pending' ? '·' : res === 'live' ? 'LIVE' : res}${pk.margin != null && pk.outcome !== 'P' ? `<small>${signed(pk.margin)}</small>` : ''}</span>
            </div>`;
          }).join('')}</div>`;
      }).join('') || '<p class="hint">No picks yet.</p>'}
    </section>`;
}

function mountPlayerChart(id) {
  const host = $('#player-chart');
  if (!host) return;
  const tl = core.timeline(state.league);
  if (!tl.length) { host.innerHTML = '<p class="hint">No graded picks yet.</p>'; return; }
  const ps = state.league.players;
  const avgVals = tl.map((pt) => ps.reduce((s, p) => s + pt.snap[p.id].net, 0) / ps.length);
  lineChart(host, {
    series: [
      { id: 'avg', label: 'League avg', color: 'var(--muted)', values: avgVals },
      { id, label: player(id).name, color: pcolor(id), values: netSeries(tl, id) },
    ],
    points: tl.map((pt) => ({ label: `Week ${pt.week} · ${pt.slot}`, group: `W${pt.week}` })),
    height: 220,
    tooltipRow: (s, i) => (s.id === 'avg' ? signed(s.values[i]) : `<b>${signed(s.values[i], 0)}</b>`),
  });
  host.querySelector('.end-label[data-id="avg"] text').textContent = '~';
}

// ---------- events ----------
document.addEventListener('click', (e) => {
  const back = e.target.closest('[data-back]');
  if (back && sessionStorage.getItem('theboard.nav') === '1') { e.preventDefault(); history.back(); return; }
  const mark = e.target.closest('[data-player]');
  if (mark && !mark.closest('a, button, [data-focus]') && location.hash.indexOf('#/admin') !== 0) {
    location.hash = '#/player/' + mark.dataset.player;
    return;
  }
  const f = e.target.closest('[data-focus]');
  if (f) setFocus(f.dataset.focus);
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'picked-only') { store.set('theboard.pickedOnly', e.target.checked); render(); }
});
window.addEventListener('hashchange', () => { try { sessionStorage.setItem('theboard.nav', '1'); } catch { /* ignore */ } render(); });
let resizeT;
window.addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => {
    const { view, arg } = route();
    if (view === 'stats') mountStatsCharts();
    if (view === 'player') mountPlayerChart(arg);
  }, 150);
});
$('#login-form').addEventListener('submit', unlock);
$('#theme-btn').addEventListener('click', cycleTheme);
$('#lock-btn').addEventListener('click', lock);
$('#refresh-btn').addEventListener('click', () => { state.espn = {}; refreshScores(); });

boot();
