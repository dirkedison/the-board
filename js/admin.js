// Commissioner page: enter picks from the group chat, set lines, publish.
// Publishing re-encrypts the league and commits it to GitHub via the REST API.
import { state, store, h, render, replaceLeague, ink, chip, player } from './app.js';
import * as core from './core.js';
import { fetchWeek } from './espn.js';
import { deriveKey, encryptJSON, exportKey, toB64, randomBytes } from './crypto.js';
import { TEAMS, teamName } from './teams.js';

const DRAFT_KEY = 'theboard.draft';
const GH_KEY = 'theboard.github';
const DATA_PATH = 'data/league.enc.json';

const A = { draft: null, dirty: false, week: null, sel: null, msg: '', msgKind: '', busy: false, armedDelete: null };
const clone = (x) => JSON.parse(JSON.stringify(x));

function gh() {
  return { owner: 'dirkedison', repo: 'the-board', branch: 'main', token: '', ...(store.get(GH_KEY) || {}) };
}

function ensureDraft() {
  if (A.draft) return;
  const saved = store.get(DRAFT_KEY);
  if (saved?.draft) {
    A.draft = saved.draft;
    A.dirty = true;
    if (saved.base !== state.league.updated) {
      flash('This unpublished draft was started before the latest publish. Discard it if it looks stale.', 'warn');
    }
  } else {
    A.draft = clone(state.league);
    A.dirty = false;
  }
}

function touch() {
  A.dirty = true;
  store.set(DRAFT_KEY, { draft: A.draft, base: state.league.updated });
}

function flash(msg, kind = 'ok') { A.msg = msg; A.msgKind = kind; }

function week() {
  return A.draft.weeks.find((w) => w.week === A.week);
}

function findGame(id) {
  return week()?.games.find((g) => g.id === id);
}

// ---------- ESPN sync ----------
async function syncWeek(n) {
  const evs = await fetchWeek(A.draft.season, n);
  if (!evs.length) throw new Error(`ESPN has no games for week ${n}`);
  let wk = A.draft.weeks.find((w) => w.week === n);
  if (!wk) {
    wk = { week: n, games: [] };
    A.draft.weeks.push(wk);
    A.draft.weeks.sort((a, b) => a.week - b.week);
  }
  let added = 0;
  for (const e of evs) {
    let g = wk.games.find((x) => x.id === e.id) || wk.games.find((x) => x.away === e.away && x.home === e.home);
    if (!g) {
      g = { id: e.id, kickoff: e.kickoff, slot: core.slotLabelFor(e.kickoff), away: e.away, home: e.home, fav: null, spread: null, picks: {} };
      wk.games.push(g);
      added++;
    }
    Object.assign(g, { kickoff: e.kickoff, awayScore: e.awayScore, homeScore: e.homeScore, status: e.status, detail: e.detail });
    if (g.spread == null && e.odds) { g.fav = e.odds.fav; g.spread = e.odds.spread; }
  }
  touch();
  return added;
}

// ---------- GitHub publish ----------
async function putFile(blob, message) {
  const c = gh();
  if (!c.token) throw new Error('Add a GitHub token under "Publishing setup" first.');
  const api = `https://api.github.com/repos/${c.owner}/${c.repo}/contents/${DATA_PATH}`;
  const headers = { Authorization: `Bearer ${c.token}`, Accept: 'application/vnd.github+json' };
  const cur = await fetch(`${api}?ref=${encodeURIComponent(c.branch)}&_=${Date.now()}`, { headers, cache: 'no-store' });
  if (cur.status === 401) throw new Error('GitHub rejected the token. It may be mistyped or expired. Paste it again under "Publishing setup".');
  if (cur.status === 403 || cur.status === 404) {
    throw new Error(`The token can't see ${c.owner}/${c.repo}. When creating it, choose "Only select repositories" → ${c.repo}, and set Contents to "Read and write".`);
  }
  const sha = cur.ok ? (await cur.json()).sha : undefined;
  const res = await fetch(api, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ message, content: btoa(JSON.stringify(blob) + '\n'), sha, branch: c.branch }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (res.status === 403) throw new Error('The token can read the repo but not write to it. Edit the token on GitHub and set Contents to "Read and write".');
    throw new Error(`GitHub: ${body.message || res.status}`);
  }
}

function problems() {
  const out = [];
  for (const w of A.draft.weeks) for (const g of w.games) {
    if (Object.keys(g.picks || {}).length && (g.spread == null)) out.push(`W${w.week} ${teamName(g.away)} @ ${teamName(g.home)} has picks but no line`);
  }
  return out;
}

async function publish() {
  const issues = problems();
  if (issues.length) { flash('Fix before publishing: ' + issues.join(' · '), 'warn'); draw(); return; }
  A.busy = true; flash('Publishing…', 'info'); draw();
  try {
    const league = clone(A.draft);
    league.updated = new Date().toISOString();
    const blob = await encryptJSON(league, state.key, state.blob.salt, state.blob.iter);
    await putFile(blob, `Update THE BOARD (week ${A.week ?? ''})`);
    replaceLeague(league, blob);
    A.draft = clone(league); A.dirty = false;
    store.del(DRAFT_KEY);
    flash('Published. Everyone will see it within a minute or two.', 'ok');
  } catch (e) {
    flash(e.message, 'err');
  } finally {
    A.busy = false; draw();
  }
}

async function changePassword(pw) {
  A.busy = true; flash('Re-encrypting with the new password…', 'info'); draw();
  try {
    const salt = toB64(randomBytes(16));
    const key = await deriveKey(pw, salt, state.blob.iter);
    const league = clone(A.dirty ? A.draft : state.league);
    league.updated = new Date().toISOString();
    const blob = await encryptJSON(league, key, salt, state.blob.iter);
    await putFile(blob, 'Change THE BOARD password');
    replaceLeague(league, blob, key);
    if (store.get('theboard.key')) store.set('theboard.key', { salt, raw: await exportKey(key) });
    A.draft = clone(league); A.dirty = false; store.del(DRAFT_KEY);
    flash('Password changed. Send the new one to the group chat.', 'ok');
  } catch (e) {
    flash(e.message, 'err');
  } finally {
    A.busy = false; draw();
  }
}

// ---------- view ----------
let root = null;

export function renderAdmin(main) {
  root = main;
  ensureDraft();
  if (A.week == null) {
    const weeks = A.draft.weeks.map((w) => w.week);
    A.week = state.current?.week ?? weeks[weeks.length - 1] ?? 1;
  }
  draw();
  main.onclick = onClick;
  main.onchange = onChange;
  main.onsubmit = onSubmit;
  main.oninput = onInput;
}

function draw() {
  if (!root || !location.hash.startsWith('#/admin')) return;
  const c = gh();
  const players = A.draft.players;
  const weeks = [...new Set([...A.draft.weeks.map((w) => w.week), A.week])].sort((a, b) => a - b);
  const wk = week();
  const slots = wk ? core.weekSlots(wk) : [];
  const labels = [...new Set([...slots.map((s) => s.label), 'Thu', 'Sun AM', 'Sun 1PM', 'Sun 4PM', 'Sun 8PM', 'Mon', 'Sat'])];

  const counts = Object.fromEntries(players.map((p) => [p.id, wk ? wk.games.filter((g) => g.picks?.[p.id]).length : 0]));
  const sel = A.sel;

  root.innerHTML = `
    <header class="view-head"><h1 class="marker">Commissioner</h1>
      <p class="sub">Enter picks as they come in on the group chat. Scores and grading are automatic.</p></header>

    ${A.msg ? `<div class="flash ${A.msgKind}">${h(A.msg)}</div>` : ''}

    <details class="card setup" ${c.token ? '' : 'open'}>
      <summary><h3>Publishing setup ${c.token ? '<span class="ok-dot">connected</span>' : ''}</h3></summary>
      <form id="gh-form" class="form-grid">
        <label>GitHub owner<input name="owner" value="${h(c.owner)}" autocomplete="off"></label>
        <label>Repo<input name="repo" value="${h(c.repo)}" autocomplete="off"></label>
        <label>Branch<input name="branch" value="${h(c.branch)}" autocomplete="off"></label>
        <label class="wide">Token <small>(fine-grained, Contents: read &amp; write on this repo only; stays on this device)</small>
          <input name="token" type="password" value="${h(c.token)}" autocomplete="off" placeholder="github_pat_…"></label>
        <button class="btn" type="submit">Save</button>
      </form>
    </details>

    <nav class="pills">${weeks.map((w) => `<button class="pill${w === A.week ? ' active' : ''}" data-a="week" data-w="${w}">Wk ${w}</button>`).join('')}
      <button class="pill add" data-a="week" data-w="${Math.max(...weeks) + 1}">+ Wk ${Math.max(...weeks) + 1}</button></nav>

    <div class="row-actions">
      <button class="btn" data-a="sync" ${A.busy ? 'disabled' : ''}>${wk ? 'Refresh from ESPN' : `Load week ${A.week} from ESPN`}</button>
      <span class="hint">${wk ? 'Adds missing games and fills empty lines. Your lines and picks are kept.' : 'Pulls the schedule and current lines.'}</span>
    </div>

    ${wk ? `
    <div class="picker-bar">
      <div class="picker-label">${sel ? `Entering picks for <b style="color:var(--p-${sel})">${h(player(sel)?.name)}</b> — tap their teams` : 'Tap a player, then tap the teams they picked'}</div>
      <div class="picker-chips">${players.map((p) => `<button class="pchip${sel === p.id ? ' on' : ''}" data-a="sel" data-pid="${p.id}" style="--pc:var(--p-${p.id})">
        <span class="chip" style="background:var(--p-${p.id})">${p.id}</span><span>${h(p.name)}</span><small>${counts[p.id]}/${slots.length}</small></button>`).join('')}</div>
    </div>

    ${slots.map((s) => {
      const done = players.filter((p) => s.games.some((g) => g.picks?.[p.id]));
      return `<section class="slot admin-slot">
        <h2 class="slot-title"><span class="marker">${h(s.label)}</span><small>${done.length}/${players.length} in ${done.map((p) => ink(p.id)).join('')}</small></h2>
        ${s.games.map((g) => adminGame(g, labels)).join('')}
      </section>`;
    }).join('')}` : `<p class="empty">No games for week ${A.week} yet. Load them from ESPN above.</p>`}

    <details class="card">
      <summary><h3>Player bios</h3></summary>
      <p class="hint">Shown on the Players page. Changes publish with everything else.</p>
      <div class="bio-edit">${players.map((p) => `<div class="bio-row">
        <span class="chip" style="background:var(--p-${p.id})">${p.id}</span>
        <div class="bio-fields">
          <b>${h(p.name)}</b>
          <textarea data-a="bio" data-pid="${p.id}" maxlength="900" rows="4" placeholder="Roast ${h(p.name)}">${h(p.bio || '')}</textarea>
          <select data-a="pteam" data-pid="${p.id}"><option value="">Favorite team…</option>
            ${Object.entries(TEAMS).sort((x, y) => x[1].name.localeCompare(y[1].name)).map(([code, t]) => `<option value="${code}" ${p.team === code ? 'selected' : ''}>${h(t.name)}</option>`).join('')}
          </select>
        </div></div>`).join('')}</div>
    </details>

    <details class="card">
      <summary><h3>Change league password</h3></summary>
      <form id="pw-form" class="form-grid">
        <label>New password<input name="pw1" type="password" autocomplete="new-password" minlength="6" required></label>
        <label>Again<input name="pw2" type="password" autocomplete="new-password" minlength="6" required></label>
        <button class="btn" type="submit" ${A.busy ? 'disabled' : ''}>Change &amp; publish</button>
      </form>
      <p class="hint">Everyone will need the new password. Remembered devices get logged out.</p>
    </details>

    <details class="card">
      <summary><h3>Backup</h3></summary>
      <div class="row-actions">
        <button class="btn ghost" data-a="download">Download league JSON</button>
        <label class="btn ghost">Restore from JSON<input type="file" accept="application/json" data-a="restore" hidden></label>
      </div>
    </details>

    <div class="publish-bar${A.dirty ? ' show' : ''}">
      <span>Unpublished changes</span>
      <button class="btn ghost" data-a="discard" ${A.busy ? 'disabled' : ''}>Discard</button>
      <button class="btn primary" data-a="publish" ${A.busy ? 'disabled' : ''}>Publish</button>
    </div>`;
}

function adminGame(g, labels) {
  const picks = g.picks || {};
  const side = (team) => {
    const who = Object.entries(picks).filter(([, t]) => t === team).map(([id]) => id);
    const mine = A.sel && picks[A.sel] === team;
    const line = g.fav === team && g.spread ? ` -${g.spread}` : '';
    return `<button class="a-team${mine ? ' mine' : ''}" data-a="pick" data-gid="${g.id}" data-team="${team}" ${mine ? `style="--pc:var(--p-${A.sel})"` : ''}>
      <span class="marker">${h(teamName(team))}${line}</span><span class="a-pickers">${who.map(ink).join('')}</span></button>`;
  };
  const cover = core.coverSide(g);
  const status = cover ? (cover === 'push' ? 'Final · push' : `Final · ${teamName(cover)} covered`) : g.status === 'live' ? `Live · ${g.detail || ''}` : core.formatKickoff(g.kickoff);
  const noLine = g.spread == null;
  return `<div class="a-game${Object.keys(picks).length ? ' has-picks' : ''}">
    <div class="a-teams">${side(g.away)}<span class="at">@</span>${side(g.home)}</div>
    <div class="a-controls">
      <label class="${noLine ? 'needs' : ''}">Fav <select data-a="fav" data-gid="${g.id}">
        <option value="">${noLine ? '—' : 'Pick’em'}</option>
        ${[g.away, g.home].map((t) => `<option value="${t}" ${g.fav === t ? 'selected' : ''}>${h(teamName(t))}</option>`).join('')}
      </select></label>
      <label class="${noLine ? 'needs' : ''}">By <input type="number" inputmode="decimal" step="0.5" min="0" max="40" data-a="spread" data-gid="${g.id}" value="${g.spread ?? ''}" placeholder="?"></label>
      <span class="a-status">${h(status)}</span>
      <details class="a-more"><summary aria-label="More options">•••</summary>
        <label>Slot <select data-a="slot" data-gid="${g.id}">${labels.map((l) => `<option ${l === g.slot ? 'selected' : ''}>${h(l)}</option>`).join('')}</select></label>
        <label>Result <select data-a="result" data-gid="${g.id}">
          <option value="">Auto (scores)</option>
          ${[g.away, g.home].map((t) => `<option value="${t}" ${g.result === t ? 'selected' : ''}>${h(teamName(t))} covered</option>`).join('')}
          <option value="push" ${g.result === 'push' ? 'selected' : ''}>Push</option>
        </select></label>
        <button class="btn ghost danger" data-a="del" data-gid="${g.id}">${A.armedDelete === g.id ? 'Tap again to remove' : 'Remove game'}</button>
      </details>
    </div>
  </div>`;
}

// ---------- events ----------
async function onClick(e) {
  if (!location.hash.startsWith('#/admin')) return;
  const t = e.target.closest('[data-a]');
  if (!t || t.tagName === 'SELECT' || t.tagName === 'INPUT') return;
  const a = t.dataset.a;
  if (a !== 'del') A.armedDelete = null;
  if (a === 'sel') {
    A.sel = A.sel === t.dataset.pid ? null : t.dataset.pid;
    A.msg = '';
  } else if (a === 'pick') {
    if (!A.sel) { flash('Tap a player first.', 'warn'); draw(); return; }
    const g = findGame(t.dataset.gid);
    const team = t.dataset.team;
    g.picks ||= {};
    if (g.picks[A.sel] === team) delete g.picks[A.sel];
    else {
      for (const other of week().games) if (other.slot === g.slot && other.picks?.[A.sel]) delete other.picks[A.sel];
      g.picks[A.sel] = team;
    }
    A.msg = '';
    touch();
  } else if (a === 'week') {
    A.week = Number(t.dataset.w);
    A.msg = '';
  } else if (a === 'sync') {
    A.busy = true; flash('Loading from ESPN…', 'info'); draw();
    try {
      const added = await syncWeek(A.week);
      flash(added ? `Added ${added} games. Check the lines against your board.` : 'Scores and times refreshed.', 'ok');
    } catch (err) { flash(err.message, 'err'); }
    A.busy = false;
  } else if (a === 'del') {
    if (A.armedDelete === t.dataset.gid) {
      const wk = week();
      wk.games = wk.games.filter((g) => g.id !== t.dataset.gid);
      A.armedDelete = null;
      touch();
    } else A.armedDelete = t.dataset.gid;
  } else if (a === 'publish') { publish(); return; }
  else if (a === 'discard') {
    A.draft = clone(state.league); A.dirty = false; store.del(DRAFT_KEY); flash('Draft discarded.', 'info');
  } else if (a === 'download') {
    const url = URL.createObjectURL(new Blob([JSON.stringify(A.draft, null, 2)], { type: 'application/json' }));
    const link = Object.assign(document.createElement('a'), { href: url, download: `the-board-${new Date().toISOString().slice(0, 10)}.json` });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  } else return;
  draw();
}

async function onChange(e) {
  if (!location.hash.startsWith('#/admin')) return;
  const t = e.target;
  const a = t.dataset.a;
  if (!a) return;
  if (a === 'restore') {
    try {
      const data = JSON.parse(await t.files[0].text());
      if (!Array.isArray(data.weeks) || !Array.isArray(data.players)) throw new Error('Not a league file');
      A.draft = data; touch(); flash('Backup loaded as a draft. Publish to make it live.', 'ok');
    } catch (err) { flash('Could not read that file: ' + err.message, 'err'); }
    draw();
    return;
  }
  if (a === 'bio' || a === 'pteam') {
    const p = A.draft.players.find((x) => x.id === t.dataset.pid);
    if (a === 'bio') p.bio = t.value.trim(); else p.team = t.value || undefined;
    touch();
    draw();
    keepOpen('Player bios');
    return;
  }
  const g = findGame(t.dataset.gid);
  if (!g) return;
  if (a === 'fav') { g.fav = t.value || null; if (!t.value) g.spread = 0; }
  else if (a === 'spread') { g.spread = t.value === '' ? null : Math.abs(Number(t.value)); if (g.spread && !g.fav) g.fav = g.home; }
  else if (a === 'slot') g.slot = t.value;
  else if (a === 'result') { if (t.value) g.result = t.value; else delete g.result; }
  touch();
  draw();
}

// Re-rendering closes <details>; reopen the one being edited.
function keepOpen(title) {
  root.querySelectorAll('details.card').forEach((d) => { if (d.querySelector('summary h3')?.textContent.startsWith(title)) d.open = true; });
}

function saveGh(form) {
  const f = new FormData(form);
  store.set(GH_KEY, { owner: f.get('owner').trim(), repo: f.get('repo').trim(), branch: f.get('branch').trim() || 'main', token: f.get('token').trim() });
}

// Save setup fields as they're typed, so a pasted token works without hitting Save.
function onInput(e) {
  const form = e.target.closest('#gh-form');
  if (form) saveGh(form);
}

function onSubmit(e) {
  if (!location.hash.startsWith('#/admin')) return;
  e.preventDefault();
  const f = new FormData(e.target);
  if (e.target.id === 'gh-form') {
    saveGh(e.target);
    flash('Saved on this device.', 'ok');
    draw();
  } else if (e.target.id === 'pw-form') {
    if (f.get('pw1') !== f.get('pw2')) { flash("Passwords don't match.", 'warn'); draw(); return; }
    changePassword(f.get('pw1'));
  }
}
