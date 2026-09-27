// Hand-rolled SVG charts. Colors come from CSS custom properties so light/dark
// themes each use their own validated steps.

const NS = 'http://www.w3.org/2000/svg';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    // var() isn't reliable in presentation attributes; route it through style.
    if ((k === 'stroke' || k === 'fill') && String(v).startsWith('var(')) e.style[k] = v;
    else e.setAttribute(k, v);
  }
  if (parent) parent.appendChild(e);
  return e;
}

function niceTicks(min, max) {
  const span = max - min || 1;
  const step = span <= 6 ? 1 : span <= 12 ? 2 : span <= 30 ? 5 : 10;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) out.push(v);
  return out;
}

// Spread labels so they never overlap: keep order, enforce a minimum gap.
function declutter(items, gap, lo, hi) {
  items.sort((a, b) => a.y - b.y);
  for (let i = 1; i < items.length; i++) items[i].y = Math.max(items[i].y, items[i - 1].y + gap);
  const over = items.length ? items[items.length - 1].y - hi : 0;
  if (over > 0) for (const it of items) it.y -= over;
  for (let i = items.length - 2; i >= 0; i--) items[i].y = Math.min(items[i].y, items[i + 1].y - gap);
  if (items.length && items[0].y < lo) {
    const d = lo - items[0].y;
    for (const it of items) it.y += d;
  }
  return items;
}

/**
 * series: [{ id, label, color, values: number[] }]
 * points: [{ label, group }] — one per x position; group changes draw a divider.
 * tooltipRow(seriesItem, i) -> html string for extra detail.
 */
export function lineChart(host, { series, points, yLabel = '', tooltipRow, focus, onFocus, height = 280 }) {
  host.innerHTML = '';
  host.classList.add('chart');
  const W = Math.max(300, host.clientWidth || 340);
  const H = height;
  const m = { l: 34, r: 34, t: 14, b: 30 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const all = series.flatMap((s) => s.values);
  let lo = Math.min(0, ...all), hi = Math.max(0, ...all);
  if (hi - lo < 4) { hi += 1; lo -= 1; }
  const n = points.length;
  const x = (i) => m.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v) => m.t + ih - ((v - lo) / (hi - lo)) * ih;

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': yLabel }, host);

  // grid
  const g = el('g', { class: 'grid' }, svg);
  for (const t of niceTicks(lo, hi)) {
    el('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: t === 0 ? 'zero' : '' }, g);
    const tx = el('text', { x: m.l - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'tick' }, g);
    tx.textContent = t > 0 ? '+' + t : t;
  }
  // week dividers
  let prevGroup = null;
  points.forEach((p, i) => {
    if (p.group !== prevGroup) {
      if (i > 0) el('line', { x1: (x(i) + x(i - 1)) / 2, x2: (x(i) + x(i - 1)) / 2, y1: m.t, y2: m.t + ih, class: 'divider' }, g);
      const t = el('text', { x: i === 0 ? x(i) : (x(i) + x(i - 1)) / 2 + 4, y: H - 8, class: 'tick', 'text-anchor': 'start' }, g);
      t.textContent = p.group;
      prevGroup = p.group;
    }
  });

  // lines: surface halo underneath each so crossings stay legible
  const lines = el('g', {}, svg);
  const path = (vals) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const order = [...series].sort((a, b) => (a.id === focus) - (b.id === focus));
  for (const s of order) {
    const dim = focus && s.id !== focus ? ' dim' : '';
    const grp = el('g', { class: 'series' + dim, 'data-id': s.id }, lines);
    el('path', { d: path(s.values), class: 'halo' }, grp);
    el('path', { d: path(s.values), class: 'line', stroke: s.color }, grp);
  }

  // direct labels at the right edge
  const labels = declutter(series.map((s) => ({ s, y: y(s.values[n - 1]) })), 15, m.t, m.t + ih);
  const lg = el('g', {}, svg);
  for (const { s, y: ly } of labels) {
    const dim = focus && s.id !== focus ? ' dim' : '';
    const grp = el('g', { class: 'end-label' + dim, 'data-id': s.id }, lg);
    el('line', { x1: x(n - 1) + 2, x2: x(n - 1) + 12, y1: y(s.values[n - 1]), y2: ly, stroke: s.color, class: 'leader' }, grp);
    el('circle', { cx: x(n - 1) + 20, cy: ly, r: 8, fill: s.color }, grp);
    const t = el('text', { x: x(n - 1) + 20, y: ly + 4, 'text-anchor': 'middle', class: 'end-letter' }, grp);
    t.textContent = s.id;
  }

  // hover layer
  const cross = el('line', { y1: m.t, y2: m.t + ih, class: 'crosshair', visibility: 'hidden' }, svg);
  const dots = el('g', { visibility: 'hidden' }, svg);
  const dotEls = series.map((s) => el('circle', { r: 4.5, fill: s.color, class: 'dot' }, dots));
  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.hidden = true;
  host.appendChild(tip);
  const hit = el('rect', { x: m.l - 10, y: 0, width: iw + 20, height: H, fill: 'transparent' }, svg);

  function show(i) {
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i));
    cross.setAttribute('visibility', 'visible'); dots.setAttribute('visibility', 'visible');
    series.forEach((s, k) => { dotEls[k].setAttribute('cx', x(i)); dotEls[k].setAttribute('cy', y(s.values[i])); });
    const rows = [...series].sort((a, b) => b.values[i] - a.values[i]).map((s) =>
      `<div class="tip-row"><span class="chip sm" style="background:${s.color}">${esc(s.id)}</span><span class="tip-name">${esc(s.label)}</span><span class="tip-val">${tooltipRow ? tooltipRow(s, i) : s.values[i]}</span></div>`).join('');
    tip.innerHTML = `<div class="tip-head">${esc(points[i].label)}</div>${rows}`;
    tip.hidden = false;
    const tw = tip.offsetWidth;
    let left = x(i) + 14;
    if (left + tw > W) left = x(i) - tw - 14;
    tip.style.left = Math.max(0, left) + 'px';
    tip.style.top = m.t + 'px';
  }
  function hide() {
    cross.setAttribute('visibility', 'hidden'); dots.setAttribute('visibility', 'hidden'); tip.hidden = true;
  }
  function idxFrom(evt) {
    const r = svg.getBoundingClientRect();
    const px = ((evt.clientX - r.left) / r.width) * W;
    return Math.max(0, Math.min(n - 1, Math.round(((px - m.l) / iw) * (n - 1))));
  }
  hit.addEventListener('pointermove', (e) => show(idxFrom(e)));
  hit.addEventListener('pointerdown', (e) => show(idxFrom(e)));
  hit.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
  svg.querySelectorAll('.end-label').forEach((lbl) => {
    lbl.style.cursor = 'pointer';
    lbl.addEventListener('click', () => onFocus && onFocus(lbl.dataset.id));
  });
}

export function sparkline(values, color, w = 90, h = 26) {
  if (values.length < 2) return '';
  const lo = Math.min(0, ...values), hi = Math.max(0, ...values);
  const span = hi - lo || 1;
  const px = (i) => 2 + (i / (values.length - 1)) * (w - 4);
  const py = (v) => 2 + (h - 4) - ((v - lo) / span) * (h - 4);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join('');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">
    <line x1="2" x2="${w - 2}" y1="${py(0)}" y2="${py(0)}" class="spark-zero"/>
    <path d="${d}" style="stroke:${color}" class="spark-line"/>
    <circle cx="${px(values.length - 1)}" cy="${py(values[values.length - 1])}" r="3" style="fill:${color}"/></svg>`;
}

// Diverging cell tint around .500: cool = winning, warm = losing, surface at even.
export function pctTint(pct, n) {
  if (pct == null || !n) return '';
  const d = pct - 0.5;
  const strength = Math.min(1, Math.abs(d) * 2) * Math.min(1, 0.45 + n * 0.12);
  const color = d >= 0 ? 'var(--div-pos)' : 'var(--div-neg)';
  return `background: color-mix(in oklab, ${color} ${Math.round(strength * 70)}%, var(--surface));`;
}
