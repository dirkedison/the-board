import { deriveKey, exportKey, importKey, decryptJSON } from './crypto.js';
import * as core from './core.js';
import { fetchWeek, fetchCurrent, applyScores } from './espn.js';
import { analyze } from './stats.js';
import { lineChart, sparkline, pctTint } from './charts.js';
import { TEAMS, teamName } from './teams.js';
import { renderAdmin } from './admin.js';
import { roast } from './roast.js';
import { acct, initAccounts, signIn, signUp, signOut, claim, canEdit, saveBio, savePhoto, imageToDataURL } from './accounts.js';

const DATA_URL = 'data/league.enc.json';

export const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

export const state = {
  blob: null, key: null, league: null,
  espn: {}, current: null, // current = { season, week }
  focus: null, liveTimer: null, teamSort: 'ats', editingBio: null, acctMsg: null,
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
  try { sessionStorage.removeItem('theboard.authLater'); } catch { /* ignore */ }
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
  initAccounts(render).then(render).catch(() => { acct.enabled = false; });
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
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.view === view || (view === 'player' && a.dataset.view === 'players') || (view === 'team' && a.dataset.view === 'teams')));
  const main = $('#view');
  const scrollKey = view + (arg || '');
  if (main.dataset.key !== scrollKey) window.scrollTo(0, 0);
  main.dataset.key = scrollKey;
  if (view === 'standings') main.innerHTML = viewStandings();
  else if (view === 'stats') { main.innerHTML = viewStats(); mountStatsCharts(); }
  else if (view === 'player' && player(arg)) { main.innerHTML = viewPlayer(arg); mountPlayerChart(arg); }
  else if (view === 'players') main.innerHTML = viewPlayers();
  else if (view === 'account') main.innerHTML = viewAccount();
  else if (view === 'teams') main.innerHTML = viewTeams();
  else if (view === 'team' && TEAMS[arg]) main.innerHTML = viewTeam(arg);
  else if (view === 'admin') renderAdmin(main);
  else if (view === 'board') main.innerHTML = viewBoard(Number(arg) || null);
  else main.innerHTML = viewStandings();
  renderAuthSheet(view);
}

const authDeferred = () => { try { return sessionStorage.getItem('theboard.authLater') === '1'; } catch { return false; } };

function renderAuthSheet(view) {
  let sheet = $('#auth-sheet');
  const show = acct.enabled && acct.ready && (!acct.user || !acct.me) && view !== 'account' && !authDeferred();
  if (!show) {
    if (sheet) sheet.remove();
    document.body.classList.remove('sheet-open');
    return;
  }
  // Keep typed input if the sheet is already up and nothing changed step-wise.
  const step = !acct.user ? 'auth' : 'claim';
  const msgKey = state.acctMsg?.text || '';
  if (sheet && sheet.dataset.step === step && sheet.dataset.msg === msgKey) return;
  if (!sheet) {
    sheet = document.createElement('div');
    sheet.id = 'auth-sheet';
    sheet.className = 'sheet-backdrop';
    document.body.appendChild(sheet);
  }
  sheet.dataset.step = step;
  sheet.dataset.msg = msgKey;
  sheet.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
    <h2 id="sheet-title" class="marker">${step === 'auth' ? 'Sign in to THE BOARD' : 'One more step'}</h2>
    <p class="sub">${step === 'auth'
      ? "Make an account to see the latest bios and photos, and to rewrite everyone's but your own."
      : 'Tell us which player you are.'}</p>
    ${authSteps()}
    <button class="btn ghost later" data-acct="later">Not now</button>
  </div>`;
  document.body.classList.add('sheet-open');
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
      <span class="tname" data-team="${team}">${h(teamName(team))}${line ? `<span class="spread">${line}</span>` : ''}</span>
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
    const sweat = picks.filter((p) => p.game?.status === 'live');
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
        const missed = dw.virtual ? [] : state.league.players.filter((p) => dw.week.missed?.[p.id]?.includes(s.label));
        const missing = dw.virtual ? [] : state.league.players.filter((p) => !s.games.some((g) => g.picks?.[p.id]) && !missed.includes(p));
        return `<section class="slot">
          <h2 class="slot-title"><span class="marker">${h(s.label)}</span>${missing.length && missing.length < state.league.players.length ? `<small>no pick: ${missing.map((p) => h(p.id)).join(' ')}</small>` : ''}${missed.length ? `<small class="missed-note">missed (auto L): ${missed.map((p) => ink(p.id)).join('')}</small>` : ''}</h2>
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
const profileOf = (id) => acct.profiles[id] || {};
const bioText = (p) => profileOf(p.id).bio ?? p.bio ?? '';

// Uploaded photo, else the league caricature (inline SVG from the encrypted data), else the letter.
function avatar(id, cls = 'pl-chip') {
  const photo = profileOf(id).photo;
  if (photo) return `<img class="${cls} photo" src="${photo}" alt="${h(player(id)?.name)}" style="--pc:${pcolor(id)}">`;
  const toon = player(id)?.avatar;
  if (toon) return `<span class="${cls} toon" style="--pc:${pcolor(id)}" role="img" aria-label="${h(player(id)?.name)}">${toon}</span>`;
  return `<span class="${cls}" style="background:${pcolor(id)}">${h(id)}</span>`;
}

function ago(iso) {
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  if (m < 1440) return Math.round(m / 60) + 'h ago';
  return Math.round(m / 1440) + 'd ago';
}

function bioBlock(p, withCredit = false) {
  const team = p.team && TEAMS[p.team] ? `<span class="fan-of">Roots for the <b class="marker">${h(teamName(p.team))}</b></span>` : '';
  const text = bioText(p);
  const bio = text ? `<p class="bio">${h(text)}</p>` : '';
  const prof = profileOf(p.id);
  const credit = withCredit && prof.bio_by ? `<span class="credit">Bio by ${nameLink(prof.bio_by)} · ${ago(prof.updated_at)}${prof.photo_by ? ` · photo by ${nameLink(prof.photo_by)}` : ''}</span>` : '';
  return bio || team ? `<div class="bio-block">${bio}${credit}${team}</div>` : '';
}

function editControls(p) {
  if (!acct.enabled) return '';
  if (!acct.user || !acct.me) return `<a class="btn ghost sm" href="#/account">Sign in to roast ${h(p.name)}</a>`;
  if (acct.me === p.id) return `<p class="hint self-note">This is you. You can't edit your own bio or photo. That's everyone else's job.</p>`;
  if (state.editingBio === p.id) {
    return `<form class="bio-editor" data-form="bio" data-pid="${p.id}">
      <textarea name="bio" rows="6" maxlength="1500" placeholder="Roast ${h(p.name)}">${h(bioText(p))}</textarea>
      <div class="row-actions"><button class="btn primary sm" type="submit">Save bio</button><button class="btn ghost sm" type="button" data-acct="cancel-bio">Cancel</button></div>
    </form>`;
  }
  return `<div class="row-actions edit-actions">
    <button class="btn sm" data-acct="edit-bio" data-pid="${p.id}">✏️ Rewrite bio</button>
    <label class="btn sm">📷 ${profileOf(p.id).photo ? 'Change' : 'Add'} photo<input type="file" accept="image/*" data-acct="photo" data-pid="${p.id}" hidden></label>
  </div>`;
}

// ---------- ACCOUNT ----------
// Sign-in / create / claim steps; '' once the user has a player.
function authSteps() {
  const msg = state.acctMsg ? `<div class="flash ${state.acctMsg.kind}">${h(state.acctMsg.text)}</div>` : '';
  if (!acct.user) {
    return msg + `<section class="card">
      <form class="form-grid" data-form="auth">
        <label class="wide">Email<input name="email" type="email" autocomplete="email" required></label>
        <label class="wide">Password<input name="password" type="password" autocomplete="current-password" minlength="6" required></label>
        <button class="btn primary" type="submit" name="mode" value="in">Sign in</button>
        <button class="btn" type="submit" name="mode" value="up">Create account</button>
      </form>
      <p class="hint form-note">New here? Enter any email and a password, then hit <b>Create account</b>. No confirmation email.</p>
    </section>`;
  }
  if (!acct.me) {
    const open = state.league.players.filter((p) => !acct.claimed[p.id]);
    return msg + `<section class="card">
      <h3>Which one are you?</h3>
      <p class="hint">Signed in as ${h(acct.user.email)}. Claim your player with the league password. Claim yourself, not somebody else; the commissioner can see who claimed what.</p>
      <form class="form-grid" data-form="claim">
        <label class="wide">I am
          <select name="player" required>${open.map((p) => `<option value="${p.id}">${h(p.name)}</option>`).join('')}</select></label>
        <label class="wide">League password<input name="code" type="password" required></label>
        <button class="btn primary" type="submit">Claim</button>
      </form>
    </section>
    <button class="btn ghost" data-acct="signout">Sign out</button>`;
  }
  return '';
}

function viewAccount() {
  const head = `<header class="view-head"><h1 class="marker">Your account</h1>
    <p class="sub">Accounts let you rewrite everyone's bio and photo except your own.</p></header>`;
  if (!acct.enabled) return head + `<p class="empty">Accounts aren't switched on yet. The commissioner needs to finish the Supabase setup (see the README).</p>`;
  if (!acct.ready) return head + `<p class="empty">Loading…</p>`;
  const steps = authSteps();
  if (steps) return head + steps;
  const me = player(acct.me);
  return head + (state.acctMsg ? `<div class="flash ${state.acctMsg.kind}">${h(state.acctMsg.text)}</div>` : '') + `<section class="card account-card" style="--pc:${pcolor(me.id)}">
      ${avatar(me.id)}
      <div><span class="marker pl-name" style="color:var(--pc)">${h(me.name)}</span>
      <p class="hint">${h(acct.user.email)}</p></div>
    </section>
    <p class="hint">Go to <a href="#/players">Players</a>, pick a victim, and hit ✏️ or 📷. Your own page is locked; your friends are in charge of you now.</p>
    <button class="btn ghost" data-acct="signout">Sign out</button>`;
}

const tagList = (tags) => `<div class="tags">${tags.map((t) => `<span class="tag">${h(t)}</span>`).join('')}</div>`;

function viewPlayers() {
  const a = analyze(state.league);
  lastAnalysis = a;
  const tl = a.timeline;
  return `<header class="view-head"><h1 class="marker">Players</h1><p class="sub">Nicknames are earned, not given. Tap anyone for the full report.</p></header>
    <div class="player-grid">
      ${a.standings.map((r) => {
        const p = r.player;
        const { nick, tags } = roast(a, p.id);
        return `<a class="pl-card" href="#/player/${p.id}" style="--pc:${pcolor(p.id)}">
          <div class="pl-top">
            ${avatar(p.id)}
            <div class="pl-id"><span class="marker pl-name" style="color:var(--pc)">${h(p.name)}</span>
              <span class="nick">“${h(nick)}”</span>
              <small>#${r.rank} · ${core.fmtRecord(r)}${r.pct != null ? ' · ' + core.fmtPct(r.pct) : ''}</small></div>
            ${sparkline(netSeries(tl, p.id), 'var(--pc)', 80, 30)}
          </div>
          ${bioBlock(p)}
          ${tagList(tags.slice(0, 4))}
        </a>`;
      }).join('')}
    </div>`;
}

// ---------- PLAYER ----------
function splitRow(label, r) {
  return `<tr><th>${h(label)}</th><td>${r.W + r.L + r.P ? core.fmtRecord(r) : '—'}</td><td style="${pctTint(r.pct, r.W + r.L)}">${r.W + r.L ? pct0(r.pct) : '—'}</td></tr>`;
}

function weekBars(row) {
  const weeks = Object.entries(row.byWeek).filter(([, r]) => r.W + r.L + r.P);
  if (!weeks.length) return '<p class="hint">No graded weeks yet.</p>';
  const max = Math.max(...weeks.map(([, r]) => Math.max(r.W, r.L)), 1);
  return `<div class="wkbars">${weeks.map(([w, r]) => `<a class="wkbar" href="#/board/${w}" title="Week ${w}: ${core.fmtRecord(r)}">
      <span class="wk-up"><span class="bar-w" style="height:${(r.W / max) * 100}%"></span></span>
      <span class="wk-down"><span class="bar-l" style="height:${(r.L / max) * 100}%"></span></span>
      <span class="wk-lbl">W${w}</span><span class="wk-rec">${core.fmtRecord(r)}</span></a>`).join('')}</div>
    <p class="legend-note"><span class="sw" style="background:var(--good)"></span> covers <span class="sw" style="background:var(--bad);margin-left:8px"></span> losses</p>`;
}

function viewPlayer(id) {
  const a = analyze(state.league);
  lastAnalysis = a;
  const p = player(id);
  const t = a.perPlayer[id];
  const row = a.standings.find((r) => r.player.id === id);
  const { nick, tags } = roast(a, id);
  const byWeek = {};
  for (const pk of [...t.picks, ...t.missed]) (byWeek[pk.week] ??= []).push(pk);
  for (const w of Object.values(byWeek)) w.sort((x, y) => x.slotIndex - y.slotIndex);
  const bestSlot = Object.entries(t.bySlot).filter(([, r]) => r.W + r.L >= 2).sort((x, y) => y[1].pct - x[1].pct || y[1].W - x[1].W)[0];
  const others = state.league.players.filter((o) => o.id !== id);
  const twin = others.map((o) => ({ o, x: a.agree[id][o.id] })).filter((z) => z.x).sort((x, y) => y.x.pct - x.x.pct)[0];
  const luck = t.closeW - t.badBeats;
  const count = (r) => r.W + r.L + r.P;
  const teams = Object.entries(t.teamRecs).sort((x, y) => count(y[1]) - count(x[1]) || y[1].net - x[1].net);
  return `<header class="view-head player-head" style="--pc:${pcolor(id)}">
      <a href="#/players" class="back" data-back>‹ Back</a>
      <div class="player-title">${avatar(id, 'pl-photo')}<div>
        <h1 class="marker" style="color:var(--pc)">${h(p.name)}</h1>
        <p class="nick big">“${h(nick)}”</p></div></div>
      <p class="sub">#${row.rank} · ${core.fmtRecord(row)} · ${core.fmtPct(row.pct)}${row.gb ? ` · ${row.gb} GB` : ''}${row.streak ? ` · streak <span class="streak ${row.streak[0]}">${row.streak}</span>` : ''}</p>
      ${bioBlock(p, true)}
      ${editControls(p)}
      ${tagList(tags)}
    </header>
    <div class="tiles">
      <div class="tile"><span class="tile-num">${pct0(t.favPct)}</span><span class="tile-label">on favorites</span></div>
      <div class="tile"><span class="tile-num">${pct0(t.homePct)}</span><span class="tile-label">on home teams</span></div>
      <div class="tile"><span class="tile-num">${signed(t.avgMargin)}</span><span class="tile-label">avg ATS margin</span></div>
      <div class="tile"><span class="tile-num">${signed(luck, 0)}</span><span class="tile-label">luck (close covers minus bad beats)</span></div>
      <div class="tile"><span class="tile-num">${pct0(t.loneShare)}</span><span class="tile-label">lone-wolf picks</span></div>
      <div class="tile"><span class="tile-num">${t.total.L}-${t.total.W}</span><span class="tile-label">record if you faded them</span></div>
      <div class="tile"><span class="tile-num sm">${bestSlot ? h(bestSlot[0]) : '—'}</span><span class="tile-label">best slot${bestSlot ? ` (${core.fmtRecord(bestSlot[1])})` : ''}</span></div>
      <div class="tile"><span class="tile-num sm">${twin ? h(twin.o.name) : '—'}</span><span class="tile-label">pick twin${twin ? ` (${Math.round(twin.x.pct * 100)}% same)` : ''}</span></div>
    </div>
    <section class="card">
      <h3>${h(p.name)} vs. the field</h3>
      <p class="hint">Games over .500 after each slot. Gray is the league average.</p>
      <div id="player-chart"></div>
    </section>
    <section class="card">
      <h3>Week by week</h3>
      ${weekBars(row)}
    </section>
    <section class="card">
      <h3>Splits</h3>
      <p class="hint">Where the money gets made, and where it gets lit on fire.</p>
      <div class="table-wrap"><table class="grid-table splits">
        <thead><tr><th></th><th>Record</th><th>Cover %</th></tr></thead>
        <tbody>
          ${splitRow('Favorites', t.fav)}${splitRow('Underdogs', t.dog)}
          ${splitRow('Home teams', t.home)}${splitRow('Road teams', t.away)}
          ${t.buckets.map(([l, r]) => splitRow('Spread ' + l, r)).join('')}
          ${splitRow('Primetime (Thu, SNF, MNF)', t.prime)}${splitRow('Sunday daytime', t.daytime)}
          ${splitRow('Lone-wolf picks', t.lone)}${splitRow('With the herd', t.herd)}
          ${Object.entries(t.bySlot).map(([s, r]) => splitRow(s, r)).join('')}
        </tbody>
      </table></div>
    </section>
    <section class="card">
      <h3>Head to head</h3>
      <p class="hint">Same side: how often you two agree. Duels: your record when you took opposite sides of the same game.</p>
      <div class="table-wrap"><table class="grid-table">
        <thead><tr><th></th><th>Same side</th><th>Duels</th><th></th></tr></thead>
        <tbody>${others.map((o) => {
          const ag = a.agree[id][o.id];
          const d = a.duels[id][o.id];
          const verdict = d.W + d.L === 0 ? '' : d.W > d.L ? 'owns them' : d.W < d.L ? 'owned' : 'dead even';
          return `<tr><th>${chip(o.id, 'sm')} ${nameLink(o.id)}</th><td>${ag ? Math.round(ag.pct * 100) + '%' : '—'}</td><td style="${pctTint(d.pct, d.W + d.L)}">${count(d) ? core.fmtRecord(d) : '—'}</td><td class="verdict">${verdict}</td></tr>`;
        }).join('')}</tbody>
      </table></div>
    </section>
    <section class="card">
      <h3>Teams</h3>
      <p class="hint">Money teams and kryptonite.</p>
      <div class="team-chips">${teams.map(([tm, r]) => `<a class="team-chip" href="#/team/${tm}" style="${pctTint(r.pct, r.W + r.L)}"><span class="marker">${h(teamName(tm))}</span><b>${core.fmtRecord(r)}</b></a>`).join('') || '<p class="hint">No picks yet.</p>'}</div>
    </section>
    ${t.best ? `<section class="card two-col">
      <div><h3>Best pick</h3>${pickLine(t.best)}</div>
      <div><h3>Worst pick</h3>${pickLine(t.worst)}</div>
    </section>` : ''}
    <section class="card">
      <h3>Every pick</h3>
      ${Object.keys(byWeek).sort((x, y) => y - x).map((w) => {
        const r = core.record(byWeek[w]);
        return `<div class="pick-week"><h4><a href="#/board/${w}">Week ${w}</a> <small>${core.fmtRecord(r)}</small></h4>
          ${byWeek[w].map((pk) => {
            if (pk.missed) {
              return `<div class="pick-item missed"><span class="slot-tag">${h(pk.slot)}</span>
                <span class="pick-main"><span class="marker">No pick</span><small>Forgot to text it in. Automatic loss.</small></span>
                <span class="result L">L</span></div>`;
            }
            const g = pk.game;
            const line = pk.isFav ? `-${pk.spread}` : pk.spread ? `+${pk.spread}` : 'PK';
            const res = pk.outcome || (g.status === 'live' ? 'live' : 'pending');
            return `<div class="pick-item">
              <span class="slot-tag">${h(pk.slot)}</span>
              <span class="pick-main"><a class="marker" href="#/team/${pk.team}">${h(teamName(pk.team))} ${line}</a>
                <small>${pk.isHome ? 'vs' : '@'} ${h(teamName(pk.opp))}${core.hasScore(g) ? ` · ${core.scoreFor(g, pk.team)}-${core.scoreFor(g, pk.opp)}` : ''}${pk.crowd === 0 ? ' · lone wolf' : ` · +${pk.crowd} other${pk.crowd > 1 ? 's' : ''}`}</small></span>
              <span class="result ${res}">${res === 'pending' ? '·' : res === 'live' ? 'LIVE' : res}${pk.margin != null && pk.outcome !== 'P' ? `<small>${signed(pk.margin)}</small>` : ''}</span>
            </div>`;
          }).join('')}</div>`;
      }).join('') || '<p class="hint">No picks yet.</p>'}
    </section>`;
}

// ---------- NFL TEAMS (ATS) ----------
function teamRows() {
  const ats = core.teamATS(state.league);
  const picks = core.allPicks(state.league);
  return Object.keys(TEAMS).map((code) => {
    const games = ats[code] || [];
    const on = picks.filter((p) => p.team === code);
    return {
      code, games,
      rec: core.record(games),
      home: core.record(games.filter((x) => x.isHome)),
      away: core.record(games.filter((x) => !x.isHome)),
      fav: core.record(games.filter((x) => x.isFav)),
      dog: core.record(games.filter((x) => x.isDog)),
      avg: games.length ? games.reduce((s, x) => s + (x.margin ?? 0), 0) / games.length : null,
      board: core.record(on),
      pickCount: on.length,
      streak: core.streak(games),
    };
  });
}

const TEAM_SORTS = {
  ats: ['Cover %', (x, y) => (y.rec.pct ?? -1) - (x.rec.pct ?? -1) || y.rec.W - x.rec.W || (y.avg ?? 0) - (x.avg ?? 0)],
  margin: ['Avg margin', (x, y) => (y.avg ?? -99) - (x.avg ?? -99)],
  board: ['Board record', (x, y) => y.board.net - x.board.net || y.pickCount - x.pickCount],
  picked: ['Most picked', (x, y) => y.pickCount - x.pickCount || y.board.net - x.board.net],
};

const recOrDash = (r) => (r.W + r.L + r.P ? core.fmtRecord(r) : '—');

function viewTeams() {
  const sort = TEAM_SORTS[state.teamSort] ? state.teamSort : 'ats';
  const rows = teamRows().sort(TEAM_SORTS[sort][1]);
  const all = rows.flatMap((r) => r.games);
  const favs = core.record(all.filter((x) => x.isFav));
  const homes = core.record(all.filter((x) => x.isHome && x.spread));
  return `<header class="view-head"><h1 class="marker">NFL vs. the spread</h1>
      <p class="sub">Every game on the board, graded against our lines.</p></header>
    <div class="tiles">
      <div class="tile"><span class="tile-num">${core.fmtRecord(favs)}</span><span class="tile-label">favorites ATS</span></div>
      <div class="tile"><span class="tile-num">${core.fmtRecord(homes)}</span><span class="tile-label">home teams ATS</span></div>
    </div>
    <nav class="pills">${Object.entries(TEAM_SORTS).map(([k, [label]]) => `<button class="pill${k === sort ? ' active' : ''}" data-teamsort="${k}">${label}</button>`).join('')}</nav>
    <section class="card flush">
      <div class="table-wrap"><table class="grid-table teams-table">
        <thead><tr><th>Team</th><th>ATS</th><th>Home</th><th>Road</th><th>Fav</th><th>Dog</th><th>Avg</th><th>Strk</th><th>Board</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <th><span class="team-sw" style="background:${TEAMS[r.code].color}"></span><a class="marker" href="#/team/${r.code}">${h(teamName(r.code))}</a></th>
          <td class="strong" style="${pctTint(r.rec.pct, r.rec.W + r.rec.L)}">${recOrDash(r.rec)}</td>
          <td>${recOrDash(r.home)}</td><td>${recOrDash(r.away)}</td>
          <td>${recOrDash(r.fav)}</td><td>${recOrDash(r.dog)}</td>
          <td>${signed(r.avg)}</td>
          <td><span class="streak ${r.streak[0] || ''}">${r.streak || '—'}</span></td>
          <td style="${pctTint(r.board.pct, r.board.W + r.board.L)}">${r.pickCount ? `${core.fmtRecord(r.board)} <small>(${r.pickCount})</small>` : '—'}</td>
        </tr>`).join('')}</tbody>
      </table></div>
      <p class="legend-note pad">Board: how the league does picking that team (times picked). Avg: average margin against the spread.</p>
    </section>`;
}

function viewTeam(code) {
  const r = teamRows().find((x) => x.code === code);
  const T = TEAMS[code];
  const picks = core.allPicks(state.league);
  const pickers = state.league.players.map((p) => {
    const mine = picks.filter((x) => x.player === p.id);
    return { p, on: core.record(mine.filter((x) => x.team === code)), against: core.record(mine.filter((x) => x.opp === code)) };
  }).filter((x) => x.on.W + x.on.L + x.on.P + x.against.W + x.against.L + x.against.P);
  return `<header class="view-head team-head" style="--tc:${T.color}">
      <a href="#/teams" class="back" data-back>‹ Back</a>
      <h1 class="marker">${h(T.city)} ${h(teamName(code))}</h1>
      <p class="sub">${core.fmtRecord(r.rec)} ATS${r.rec.pct != null ? ` · covers ${pct0(r.rec.pct)}` : ''}${r.streak ? ` · streak <span class="streak ${r.streak[0]}">${r.streak}</span>` : ''}</p>
    </header>
    <div class="tiles">
      <div class="tile"><span class="tile-num">${recOrDash(r.home)}</span><span class="tile-label">at home</span></div>
      <div class="tile"><span class="tile-num">${recOrDash(r.away)}</span><span class="tile-label">on the road</span></div>
      <div class="tile"><span class="tile-num">${recOrDash(r.fav)}</span><span class="tile-label">as favorite</span></div>
      <div class="tile"><span class="tile-num">${recOrDash(r.dog)}</span><span class="tile-label">as underdog</span></div>
      <div class="tile"><span class="tile-num">${signed(r.avg)}</span><span class="tile-label">avg ATS margin</span></div>
      <div class="tile"><span class="tile-num">${r.pickCount ? core.fmtRecord(r.board) : '—'}</span><span class="tile-label">the board backing them</span></div>
    </div>
    <section class="card">
      <h3>Game log</h3>
      ${r.games.length ? r.games.slice().reverse().map((x) => {
        const g = x.game;
        const line = x.isFav ? `-${x.spread}` : x.spread ? `+${x.spread}` : 'PK';
        const on = Object.entries(g.picks || {}).filter(([, tm]) => tm === code).map(([pid]) => pid);
        const vs = Object.entries(g.picks || {}).filter(([, tm]) => tm !== code).map(([pid]) => pid);
        return `<div class="pick-item">
          <span class="slot-tag"><a href="#/board/${x.week}">Wk ${x.week}</a></span>
          <span class="pick-main"><span class="marker">${x.isHome ? 'vs' : '@'} ${h(teamName(x.opp))} <span class="spread">${line}</span></span>
            <small>${core.hasScore(g) ? `${core.scoreFor(g, code)}-${core.scoreFor(g, x.opp)}` : ''}${on.length ? ` · backed by ${on.map(ink).join('')}` : ''}${vs.length ? ` · faded by ${vs.map(ink).join('')}` : ''}</small></span>
          <span class="result ${x.outcome}">${x.outcome}${x.margin != null && x.outcome !== 'P' ? `<small>${signed(x.margin)}</small>` : ''}</span>
        </div>`;
      }).join('') : '<p class="hint">No graded games yet.</p>'}
    </section>
    ${pickers.length ? `<section class="card">
      <h3>Who rides them, who fades them</h3>
      <div class="table-wrap"><table class="grid-table">
        <thead><tr><th></th><th>Backing</th><th>Fading</th></tr></thead>
        <tbody>${pickers.map((x) => `<tr><th>${chip(x.p.id, 'sm')} ${nameLink(x.p.id)}</th>
          <td style="${pctTint(x.on.pct, x.on.W + x.on.L)}">${recOrDash(x.on)}</td>
          <td style="${pctTint(x.against.pct, x.against.W + x.against.L)}">${recOrDash(x.against)}</td></tr>`).join('')}</tbody>
      </table></div>
    </section>` : ''}`;
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
  const act = e.target.closest('[data-acct]');
  if (act && act.tagName !== 'INPUT') {
    const a = act.dataset.acct;
    if (a === 'edit-bio') { state.editingBio = act.dataset.pid; render(); }
    else if (a === 'cancel-bio') { state.editingBio = null; render(); }
    else if (a === 'later') { try { sessionStorage.setItem('theboard.authLater', '1'); } catch { /* ignore */ } render(); }
    else if (a === 'signout') { signOut().then(() => { state.acctMsg = null; render(); }); }
    return;
  }
  const sortBtn = e.target.closest('[data-teamsort]');
  if (sortBtn) { state.teamSort = sortBtn.dataset.teamsort; render(); return; }
  const teamEl = e.target.closest('[data-team]');
  if (teamEl && !e.target.closest('a, button') && !location.hash.startsWith('#/admin')) { location.hash = '#/team/' + teamEl.dataset.team; return; }
  const mark = e.target.closest('[data-player]');
  if (mark && !mark.closest('a, button, [data-focus]') && location.hash.indexOf('#/admin') !== 0) {
    location.hash = '#/player/' + mark.dataset.player;
    return;
  }
  const f = e.target.closest('[data-focus]');
  if (f) setFocus(f.dataset.focus);
});
document.addEventListener('change', async (e) => {
  if (e.target.dataset.acct === 'photo' && e.target.files[0]) {
    const pid = e.target.dataset.pid;
    try {
      await savePhoto(pid, await imageToDataURL(e.target.files[0]));
    } catch (err) { alertInPage(err.message); }
    render();
    return;
  }
  if (e.target.id === 'picked-only') { store.set('theboard.pickedOnly', e.target.checked); render(); }
});
function alertInPage(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const f = new FormData(form);
  const btn = e.submitter;
  if (btn) btn.disabled = true;
  try {
    if (form.dataset.form === 'bio') {
      await saveBio(form.dataset.pid, f.get('bio'));
      state.editingBio = null;
    } else if (form.dataset.form === 'auth') {
      if (btn?.value === 'up') {
        const r = await signUp(f.get('email'), f.get('password'));
        state.acctMsg = r.needsConfirm
          ? { kind: 'info', text: 'Check your email to confirm, then come back and sign in.' }
          : { kind: 'ok', text: 'Account created. Now claim your player.' };
      } else {
        await signIn(f.get('email'), f.get('password'));
        state.acctMsg = null;
      }
    } else if (form.dataset.form === 'claim') {
      await claim(f.get('player'), f.get('code'));
      state.acctMsg = { kind: 'ok', text: `You're ${player(acct.me)?.name}. Go roast somebody.` };
      if (!location.hash.startsWith('#/account')) { alertInPage(state.acctMsg.text); state.acctMsg = null; }
    }
  } catch (err) {
    if (form.dataset.form === 'bio') alertInPage(err.message);
    else state.acctMsg = { kind: 'err', text: err.message };
  }
  if (btn) btn.disabled = false;
  render();
});

window.addEventListener('hashchange', () => { state.editingBio = null; try { sessionStorage.setItem('theboard.nav', '1'); } catch { /* ignore */ } render(); });
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
