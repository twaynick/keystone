'use strict';

/* global overlayApi, MapMath, KeystoneTheme, Crosshair */

const $ = (id) => document.getElementById(id);
const SIZES = { s: 180, m: 240, l: 320 };

const ov = {
  state: { attached: false },
  values: { pos: null, readouts: {} },
  editing: false,
  mapImg: null,
  mapUrl: null,
  // Positions arrive 4×/s; the minimap eases between them at screen refresh so
  // the arrow glides instead of jumping.
  from: null,
  to: null,
  toAt: 0,
  // What a click on the map does while editing: add a waypoint or set
  // "I'm here".
  tool: 'wp',
};

const latlon = () => ov.state.variant?.units === 'latlon';
// Lat/lon coordinates need decimals; game units don't.
const roundCoord = (n) => (latlon() ? Math.round(n * 10) / 10 : Math.round(n));
// Lat/lon reads latitude first, the way games show it.
function coordText(p) {
  return latlon() ? `${p.y.toFixed(1)}, ${p.x.toFixed(1)}` : `${Math.round(p.x)}, ${Math.round(p.y)}`;
}
function ago(at) {
  const m = Math.floor((Date.now() - at) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ago`;
}

// ---------- helpers ----------
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c) node.append(c);
  return node;
}

function fmt(v, type) {
  if (v === null || v === undefined) return '—';
  if (type === 'float' || type === 'double') return String(Math.round(v * 10) / 10);
  return String(v);
}

function lerpAngle(a, b, t) {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return a + d * t;
}

let flashTimer;
function flash(text, ms = 2200) {
  const f = $('flash');
  f.textContent = text;
  f.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { f.hidden = true; }, ms);
}

// ---------- panels ----------
function placePanels() {
  const st = ov.state;
  for (const id of ['readouts', 'minimap', 'info', 'mods', 'timers', 'checklist', 'pcstats', 'identify']) {
    const panel = $(`panel-${id}`);
    const conf = st.panels?.[id];
    const hasContent = id === 'readouts' ? st.readouts?.length > 0 || ov.editing
      : id === 'info' ? (st.info?.length || st.notes) || ov.editing
      : id === 'mods' ? st.mods?.length > 0
      : id === 'timers' ? st.timers?.length > 0
      : id === 'checklist' ? Boolean(st.checklist)
      : id === 'identify' ? Boolean(st.identify)
      : true;
    panel.hidden = !st.attached || !conf?.visible || !hasContent;
    if (!panel.hidden && !panel.classList.contains('dragging')) {
      panel.style.left = `${conf.x * 100}%`;
      panel.style.top = `${conf.y * 100}%`;
    }
  }
  const size = SIZES[st.panels?.minimap?.size] || SIZES.m;
  const canvas = $('minimap');
  if (canvas.width !== size) { canvas.width = size; canvas.height = size; }
  // [data-size]: the Pin/Here buttons share the size buttons' styling.
  for (const b of document.querySelectorAll('.size-btns button[data-size]')) b.classList.toggle('on', b.dataset.size === st.panels?.minimap?.size);
}

function renderReadouts() {
  const ul = $('readouts');
  const list = ov.state.readouts || [];
  ul.replaceChildren();
  if (!list.length) {
    ul.append(el('li', { class: 'empty', text: 'Pick stats to show in Keystone’s Overlay tab.' }));
    return;
  }
  for (const r of list) {
    ul.append(el('li', { 'data-id': r.id }, el('span', { class: 'name', text: r.name }), el('span', { class: 'val', text: '—' })));
  }
  paintReadouts();
}

function paintReadouts() {
  for (const r of ov.state.readouts || []) {
    const li = document.querySelector(`.readouts li[data-id="${CSS.escape(r.id)}"]`);
    const v = ov.values.readouts?.[r.id];
    if (!li || !v) continue;
    li.classList.toggle('locked', Boolean(v.enabled));
    li.classList.toggle('waiting', v.status !== 'ok');
    li.querySelector('.val').textContent = v.status === 'ok' ? fmt(v.current, r.valueType) : 'waiting';
  }
}

// Pinned mods. Click one while editing the layout (the overlay only takes
// clicks then) to switch it; hotkeys work any time.
function renderMods() {
  const ul = $('omods');
  ul.replaceChildren(...(ov.state.mods || []).map((m) => {
    const li = el('li', { 'data-id': m.id },
      el('span', { class: 'bolt-dot' }),
      el('span', { class: 'name', text: m.label }),
      m.hotkey ? el('span', { class: 'hk', text: m.hotkey.replace(/num(\d)/g, 'Num $1') }) : null,
      el('span', { class: 'state', text: 'Off' }));
    li.addEventListener('click', async () => {
      if (!ov.editing) return;
      const res = await overlayApi.quickAction(m.id);
      flash(res.ok ? `${res.data.label}: ${res.data.state}` : res.error);
    });
    return li;
  }));
  paintMods();
}

function paintMods() {
  for (const m of ov.state.mods || []) {
    const li = document.querySelector(`.omods li[data-id="${CSS.escape(m.id)}"]`);
    const v = ov.values.mods?.[m.id];
    if (!li || !v) continue;
    li.classList.toggle('on', Boolean(v.enabled));
    li.querySelector('.state').textContent = v.enabled ? 'On' : 'Off';
  }
}

// ---------- timers ----------
// Times come from end timestamps, so the countdown is redrawn locally each
// frame instead of waiting for updates from the main process.
function fmtLeft(ms) {
  const t = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function renderTimers() {
  const ul = $('otimers');
  ul.replaceChildren(...(ov.state.timers || []).map((t) => {
    const li = el('li', { 'data-id': t.id, class: t.state }, el('span', { class: 'name', text: t.name }), el('span', { class: 'left' }));
    li.addEventListener('click', () => { if (ov.editing) overlayApi.toggleTimer(t.id); });
    return li;
  }));
  paintTimers();
}

function paintTimers() {
  const now = Date.now();
  for (const t of ov.state.timers || []) {
    const li = document.querySelector(`.otimers li[data-id="${CSS.escape(t.id)}"]`);
    if (!li) continue;
    const left = t.state === 'running' ? t.endsAt - now : t.remainingMs;
    li.querySelector('.left').textContent = t.state === 'done' ? 'Done' : fmtLeft(left);
  }
}

// ---------- identifier ----------
function renderIdentify() {
  const id = ov.state.identify;
  if (!id) return;
  $('identTitle').textContent = id.title;
  $('identCount').textContent = `${id.left.length}/${id.total}`;
  const marked = id.traits.filter((t) => id.marks[t.id]);
  $('identChips').replaceChildren(...(marked.length ? marked : []).map((t) => el('span', { class: id.marks[t.id], text: t.name })));
  const left = $('identLeft');
  left.classList.toggle('solved', id.left.length === 1);
  left.textContent = id.left.length === 1 ? `It's the ${id.left[0].name}.`
    : id.left.length === 0 ? 'Nothing fits. Check the evidence setting.'
      : !marked.length ? 'Tick evidence on your phone or in Keystone.'
        : id.left.length <= 10 ? id.left.map((g) => g.name).join(', ') : `${id.left.length} possible`;
}

// ---------- crosshair ----------
// Drawn into a small canvas pinned at the screen centre (plus any offset),
// at the display's pixel density so thin lines stay sharp.
function renderCrosshair() {
  const c = ov.state.crosshair;
  const cv = $('crosshair');
  cv.hidden = !ov.state.attached || !c?.on;
  if (cv.hidden) return;
  const dpr = window.devicePixelRatio || 1;
  const size = Crosshair.extent(c);
  cv.width = Math.round(size * dpr);
  cv.height = Math.round(size * dpr);
  cv.style.width = `${size}px`;
  cv.style.height = `${size}px`;
  cv.style.marginLeft = `${-size / 2 + c.dx}px`;
  cv.style.marginTop = `${-size / 2 + c.dy}px`;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  Crosshair.draw(ctx, c, size / 2, size / 2, ov.colors.accent);
}

// ---------- PC stats ----------
let pc = null;
const gb = (b) => (b / 1024 ** 3).toFixed(1);
function paintPc() {
  const st = ov.state;
  const want = st.pcstats || {};
  const rows = [];
  if (want.cpu && pc) rows.push(['CPU', `${pc.cpu}%`, pc.cpu >= 90]);
  if (want.ram && pc) rows.push(['RAM', `${gb(pc.ramUsed)} / ${gb(pc.ramTotal)} GB`, pc.ramUsed / pc.ramTotal >= 0.9]);
  if (want.clock) rows.push(['Time', new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), false]);
  if (want.session && st.since) rows.push(['Playing', fmtLeft(Date.now() - st.since), false]);
  const ul = $('pcstats');
  const key = rows.map((r) => r[0]).join('|');
  if (ul.dataset.key !== key) {
    ul.dataset.key = key;
    ul.replaceChildren(...rows.map(([name]) => el('li', { 'data-k': name }, el('span', { class: 'name', text: name }), el('span', { class: 'val' }))));
    if (!rows.length) ul.append(el('li', { class: 'empty', text: 'Pick what to show in Keystone\u2019s Overlay tab.' }));
  }
  for (const [name, val, hot] of rows) {
    const li = ul.querySelector(`li[data-k="${name}"]`);
    li.querySelector('.val').textContent = val;
    li.classList.toggle('waiting', false);
    li.classList.toggle('locked', hot);
  }
}

// ---------- checklist ----------
function renderChecklist() {
  const l = ov.state.checklist;
  $('listTitle').textContent = l ? l.name : 'Checklist';
  $('listCount').textContent = l ? `${l.items.filter((i) => i.done).length}/${l.items.length}` : '';
  $('olist').replaceChildren(...(l?.items || []).map((i) => {
    const li = el('li', { class: i.done ? 'done' : '' }, el('span', { class: 'box' }), el('span', { class: 'text', text: i.text }));
    li.addEventListener('click', () => { if (ov.editing) overlayApi.checkListItem(l.id, i.id); });
    return li;
  }));
}

// ---------- alerts ----------
// A short two-note chime from Web Audio: no sound file to ship, and it can't
// fail to load.
let audio = null;
function chime() {
  try {
    audio = audio || new AudioContext();
    const t0 = audio.currentTime;
    for (const [i, freq] of [[0, 880], [1, 1318.5]]) {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      const at = t0 + i * 0.18;
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(0.25, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, at + 0.5);
      o.connect(g).connect(audio.destination);
      o.start(at);
      o.stop(at + 0.55);
    }
  } catch { /* no audio device: the flash still shows */ }
}

function alertBanner(text) {
  flash(text, 6000);
  chime();
  for (const li of document.querySelectorAll('.otimers li.done')) {
    li.classList.remove('ringing');
    void li.offsetWidth; // restart the animation
    li.classList.add('ringing');
  }
}

function renderInfo() {
  const st = ov.state;
  $('infoTitle').textContent = st.pack || 'Info';
  const body = $('info');
  body.replaceChildren();
  for (const c of st.info || []) body.append(el('div', { class: 'card' }, el('h3', { text: c.title }), el('p', { text: c.body })));
  if (st.notes) body.append(el('div', { class: 'card' }, el('h3', { text: 'My notes' }), el('p', { text: st.notes })));
  if (!body.children.length) body.append(el('div', { class: 'card' }, el('p', { text: 'Add notes in Keystone’s Overlay tab, or install a game pack with info cards.' })));
}

function loadMap() {
  const url = ov.state.map?.url || null;
  if (url === ov.mapUrl) return;
  ov.mapUrl = url;
  ov.mapImg = null;
  if (!url) return;
  const img = new Image();
  img.onload = () => { if (ov.mapUrl === url) ov.mapImg = img; };
  img.src = url;
}

// ---------- minimap ----------
// View transform: world -> canvas, centred on the player.
function view(canvas, center) {
  const b = ov.state.map?.bounds;
  const sx = b ? Math.sign(b.right - b.left) : 1;
  const sy = b ? Math.sign(b.bottom - b.top) : -1; // no map: assume Y points north
  const span = b ? Math.abs(b.right - b.left) / 5 : 2000; // world units across at zoom 1
  const ppw = (canvas.width / span) * (ov.state.zoom || 1);
  const W = canvas.width;
  const H = canvas.height;
  return {
    sx, sy, ppw, center,
    toCanvas: (x, y) => ({ x: W / 2 + (x - center.x) * ppw * sx, y: H / 2 + (y - center.y) * ppw * sy }),
    toWorld: (px, py) => ({ x: center.x + (px - W / 2) / (ppw * sx), y: center.y + (py - H / 2) / (ppw * sy) }),
  };
}

function currentPos(now) {
  if (!ov.to) return null;
  if (!ov.from) return ov.to;
  const t = Math.min(1, (now - ov.toAt) / 250);
  return {
    x: ov.from.x + (ov.to.x - ov.from.x) * t,
    y: ov.from.y + (ov.to.y - ov.from.y) * t,
    z: ov.to.z,
    facing: ov.to.facing === null || ov.from.facing === null ? ov.to.facing : lerpAngle(ov.from.facing, ov.to.facing, t),
  };
}

let lastPos = null;

function drawMinimap(now) {
  const canvas = $('minimap');
  if ($('panel-minimap').hidden) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const live = currentPos(now);
  const here = !live && ov.state.here ? { x: ov.state.here.x, y: ov.state.here.y, z: ov.state.here.z, facing: null, manual: true } : null;
  const pos = live || here;
  lastPos = pos;
  const b = ov.state.map?.bounds;
  const center = pos || (b ? { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 } : { x: 0, y: 0 });
  const v = view(canvas, center);

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0e1115';
  ctx.fillRect(0, 0, W, H);

  if (ov.mapImg && b) {
    const tl = v.toCanvas(b.left, b.top);
    const br = v.toCanvas(b.right, b.bottom);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(ov.mapImg, tl.x, tl.y, br.x - tl.x, br.y - tl.y);
  } else {
    drawGrid(ctx, v, W, H);
    if (b) {
      // Edges of a map that has coordinates but no picture yet.
      const tl = v.toCanvas(b.left, b.top);
      const br = v.toCanvas(b.right, b.bottom);
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    }
  }

  drawMarkers(ctx, v, W, H);

  // Waypoints: on-map dots with labels; off-map ones become edge pips.
  const tracked = ov.state.tracked;
  for (const w of ov.state.waypoints || []) {
    const p = v.toCanvas(w.x, w.y);
    const isTracked = w.id === tracked;
    const inside = p.x >= 6 && p.x <= W - 6 && p.y >= 6 && p.y <= H - 6;
    if (inside) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, isTracked ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = isTracked ? '#d4af74' : '#ffffff';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#0e1115';
      ctx.stroke();
      if (isTracked || ov.state.zoom >= 1.5 || (ov.state.waypoints || []).length <= 8) {
        ctx.font = '500 11px Geist, sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.shadowColor = 'rgba(0,0,0,0.8)';
        ctx.shadowBlur = 3;
        ctx.fillText(w.name, p.x + 7, p.y + 4);
        ctx.shadowBlur = 0;
      }
    } else if (isTracked) {
      edgePip(ctx, W, H, p);
    }
  }

  // "I'm here": a ring rather than an arrow, since it doesn't move with you.
  if (here) {
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, 7, 0, Math.PI * 2);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = ov.colors.accent;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = ov.colors.accent;
    ctx.fill();
  }

  // Player arrow, always at the centre when the position is known.
  if (live) {
    const angle = pos.facing === null ? -Math.PI / 2
      : Math.atan2(Math.sin((pos.facing * Math.PI) / 180) * v.sy, Math.cos((pos.facing * Math.PI) / 180) * v.sx);
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(9, 0);
    ctx.lineTo(-6, -6);
    ctx.lineTo(-3, 0);
    ctx.lineTo(-6, 6);
    ctx.closePath();
    ctx.fillStyle = ov.colors.accent;
    ctx.shadowColor = ov.colors.glow;
    ctx.shadowBlur = 8;
    ctx.fill();
    ctx.restore();
  }

  paintFooter(pos, v);
}

function markerPath(ctx, shape, x, y, r) {
  ctx.beginPath();
  if (shape === 'square') ctx.rect(x - r, y - r, r * 2, r * 2);
  else if (shape === 'diamond') { ctx.moveTo(x, y - r - 1); ctx.lineTo(x + r + 1, y); ctx.lineTo(x, y + r + 1); ctx.lineTo(x - r - 1, y); ctx.closePath(); }
  else if (shape === 'triangle') { ctx.moveTo(x, y - r - 1); ctx.lineTo(x + r + 1, y + r); ctx.lineTo(x - r - 1, y + r); ctx.closePath(); }
  else ctx.arc(x, y, r, 0, Math.PI * 2);
}

// Pack marker layers (caves, artifacts...). Names show once zoomed in far
// enough that they don't pile on top of each other.
function drawMarkers(ctx, v, W, H) {
  const labels = (ov.state.zoom || 1) >= 2;
  for (const layer of ov.state.layers || []) {
    if (!layer.on) continue;
    for (const m of layer.points) {
      const p = v.toCanvas(m.x, m.y);
      if (p.x < -10 || p.x > W + 10 || p.y < -10 || p.y > H + 10) continue;
      markerPath(ctx, layer.shape, p.x, p.y, 3.5);
      ctx.fillStyle = layer.color;
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = '#0e1115';
      ctx.stroke();
      if (labels && m.name) {
        ctx.font = '500 10px Geist, sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.shadowColor = 'rgba(0,0,0,0.85)';
        ctx.shadowBlur = 3;
        ctx.fillText(m.name, p.x + 6, p.y + 3);
        ctx.shadowBlur = 0;
      }
    }
  }
}

function drawGrid(ctx, v, W, H) {
  // Grid lines whichever step gives ~40 px spacing. The small steps are for
  // lat/lon maps, where the whole world is 100 units across.
  const steps = [0.5, 1, 2, 5, 10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000];
  const step = steps.find((s) => s * v.ppw >= 40) || steps[steps.length - 1];
  const tl = v.toWorld(0, 0);
  const br = v.toWorld(W, H);
  ctx.strokeStyle = 'rgba(134,136,138,0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = Math.ceil(Math.min(tl.x, br.x) / step) * step; x <= Math.max(tl.x, br.x); x += step) {
    const px = v.toCanvas(x, 0).x;
    ctx.moveTo(px, 0); ctx.lineTo(px, H);
  }
  for (let y = Math.ceil(Math.min(tl.y, br.y) / step) * step; y <= Math.max(tl.y, br.y); y += step) {
    const py = v.toCanvas(0, y).y;
    ctx.moveTo(0, py); ctx.lineTo(W, py);
  }
  ctx.stroke();
}

function edgePip(ctx, W, H, p) {
  const cx = W / 2;
  const cy = H / 2;
  const a = Math.atan2(p.y - cy, p.x - cx);
  // Push out along the ray to the canvas edge, 8 px inside.
  const tx = Math.abs((W / 2 - 8) / Math.cos(a));
  const ty = Math.abs((H / 2 - 8) / Math.sin(a));
  const r = Math.min(tx, ty);
  ctx.save();
  ctx.translate(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  ctx.rotate(a);
  ctx.beginPath();
  ctx.moveTo(6, 0); ctx.lineTo(-4, -5); ctx.lineTo(-4, 5); ctx.closePath();
  ctx.fillStyle = '#d4af74';
  ctx.fill();
  ctx.restore();
}

const ARROWS = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];

function paintFooter(pos, v) {
  const c = $('coords');
  c.classList.toggle('manual', Boolean(pos?.manual));
  c.textContent = !pos ? 'Position unknown'
    : pos.manual ? `${coordText(pos)} · ${ago(ov.state.here.at)}`
      : coordText(pos);
  const w = (ov.state.waypoints || []).find((x) => x.id === ov.state.tracked);
  if (!w || !pos) { $('tracked').textContent = w ? w.name : ''; return; }
  const dist = MapMath.distance(pos, w);
  const p = v.toCanvas(w.x, w.y);
  const a = Math.atan2(p.y - $('minimap').height / 2, p.x - $('minimap').width / 2);
  const idx = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
  $('tracked').textContent = `${w.name} ${latlon() ? dist.toFixed(1) : Math.round(dist).toLocaleString()} ${ARROWS[idx]}`;
}

let lastPcPaint = 0;
function frame(now) {
  drawMinimap(now);
  paintTimers();
  if (now - lastPcPaint > 1000 && !$('panel-pcstats').hidden) { lastPcPaint = now; paintPc(); }
  requestAnimationFrame(frame);
}

// ---------- edit mode ----------
function wireDragging() {
  for (const panel of document.querySelectorAll('.panel')) {
    const head = panel.querySelector('.panel-head');
    head.addEventListener('pointerdown', (e) => {
      if (!ov.editing || e.target.closest('button')) return;
      e.preventDefault();
      head.setPointerCapture(e.pointerId);
      panel.classList.add('dragging');
      const startX = e.clientX - panel.offsetLeft;
      const startY = e.clientY - panel.offsetTop;
      const move = (ev) => {
        panel.style.left = `${Math.max(0, Math.min(innerWidth - 60, ev.clientX - startX))}px`;
        panel.style.top = `${Math.max(0, Math.min(innerHeight - 30, ev.clientY - startY))}px`;
      };
      const up = () => {
        head.removeEventListener('pointermove', move);
        head.removeEventListener('pointerup', up);
        panel.classList.remove('dragging');
        overlayApi.setPanel(panel.dataset.panel, { x: panel.offsetLeft / innerWidth, y: panel.offsetTop / innerHeight });
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
    });
  }

  for (const b of document.querySelectorAll('.size-btns button[data-size]')) {
    b.addEventListener('click', () => overlayApi.setPanel('minimap', { size: b.dataset.size }));
  }
  for (const b of document.querySelectorAll('.tool-btns button')) {
    b.addEventListener('click', () => {
      ov.tool = b.dataset.tool;
      for (const x of document.querySelectorAll('.tool-btns button')) x.classList.toggle('on', x === b);
    });
  }

  const canvas = $('minimap');
  const worldAt = (e) => {
    const b = ov.state.map?.bounds;
    const center = lastPos || (b ? { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 } : { x: 0, y: 0 });
    const rect = canvas.getBoundingClientRect();
    return view(canvas, center).toWorld(e.clientX - rect.left, e.clientY - rect.top);
  };
  canvas.addEventListener('click', async (e) => {
    if (!ov.editing) return;
    const w = worldAt(e);
    if (ov.tool === 'here') {
      const res = await overlayApi.setHere({ x: roundCoord(w.x), y: roundCoord(w.y) });
      flash(res.ok ? `Marked you at ${coordText(res.data)}` : res.error);
      return;
    }
    const res = await overlayApi.addWaypoint({ x: roundCoord(w.x), y: roundCoord(w.y) });
    flash(res.ok ? `Waypoint added: ${res.data.name}` : res.error);
  });
  // Right-click teleports there, keeping the current height (the result
  // flashes from the main process).
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!ov.editing || !ov.state.teleport) return;
    const w = worldAt(e);
    overlayApi.teleportTo({ x: roundCoord(w.x), y: roundCoord(w.y) });
  });
  canvas.addEventListener('wheel', (e) => {
    if (!ov.editing) return;
    e.preventDefault();
    const z = (ov.state.zoom || 1) * (e.deltaY < 0 ? 1.25 : 0.8);
    ov.state.zoom = Math.min(8, Math.max(0.25, z));
    clearTimeout(canvas._zoomSave);
    canvas._zoomSave = setTimeout(() => overlayApi.setZoom(ov.state.zoom), 300);
  }, { passive: false });

  $('doneBtn').addEventListener('click', () => overlayApi.finishEditing());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ov.editing) overlayApi.finishEditing(); });
}

// ---------- wiring ----------
overlayApi.onState((st) => {
  ov.state = st;
  if (!st.attached) { ov.from = null; ov.to = null; }
  $('mapTitle').textContent = st.attached ? (st.variants?.length > 1 ? st.variant.name : st.pack || st.game) : 'Map';
  $('editHelp').textContent = `Editing overlay. Drag panels by their title. On the map: Pin adds a waypoint where you click, Here marks where you are${st.teleport ? ', right-click teleports' : ''}, scroll zooms.`;
  loadMap();
  placePanels();
  renderReadouts();
  renderInfo();
  renderMods();
  renderTimers();
  renderChecklist();
  renderCrosshair();
  renderIdentify();
  paintPc();
});
overlayApi.onPc((s) => { pc = s; paintPc(); });
window.addEventListener('resize', renderCrosshair);

overlayApi.onValues((v) => {
  ov.values = v;
  if (v.pos) {
    ov.from = currentPos(performance.now());
    ov.to = v.pos;
    ov.toAt = performance.now();
  } else {
    ov.from = null;
    ov.to = null;
  }
  paintReadouts();
  paintMods();
});

overlayApi.onMode(({ editing }) => {
  ov.editing = editing;
  document.body.classList.toggle('editing', editing);
  $('editBanner').hidden = !editing;
  placePanels();
});

overlayApi.onFlash(flash);
overlayApi.onAlert(alertBanner);

// Canvas colors follow the accent too, so read them from CSS after each change.
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  ov.colors = { accent: cs.getPropertyValue('--accent').trim() || '#c48aff', glow: cs.getPropertyValue('--accent-glow').trim() };
}
overlayApi.appearance().then((r) => { if (r.ok) KeystoneTheme.applyAccent(r.data.accent); readColors(); renderCrosshair(); });
overlayApi.onAppearance((a) => { KeystoneTheme.applyAccent(a.accent); readColors(); renderCrosshair(); });
readColors();

wireDragging();
requestAnimationFrame(frame);
