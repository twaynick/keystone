'use strict';

/* global overlayApi, MapMath, KeystoneTheme */

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
};

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
function flash(text) {
  const f = $('flash');
  f.textContent = text;
  f.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { f.hidden = true; }, 2200);
}

// ---------- panels ----------
function placePanels() {
  const st = ov.state;
  for (const id of ['readouts', 'minimap', 'info', 'mods']) {
    const panel = $(`panel-${id}`);
    const conf = st.panels?.[id];
    const hasContent = id === 'readouts' ? st.readouts?.length > 0 || ov.editing
      : id === 'info' ? (st.info?.length || st.notes) || ov.editing
      : id === 'mods' ? st.mods?.length > 0
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
  for (const b of document.querySelectorAll('.size-btns button')) b.classList.toggle('on', b.dataset.size === st.panels?.minimap?.size);
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
  const pos = currentPos(now);
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
  }

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

  // Player arrow, always at the centre when the position is known.
  if (pos) {
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

function drawGrid(ctx, v, W, H) {
  // Grid every 100/500/1000/... world units, whichever gives ~40 px spacing.
  const steps = [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000];
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
  $('coords').textContent = pos ? `${Math.round(pos.x)}, ${Math.round(pos.y)}` : 'Position unknown';
  const w = (ov.state.waypoints || []).find((x) => x.id === ov.state.tracked);
  if (!w || !pos) { $('tracked').textContent = w ? w.name : ''; return; }
  const dist = MapMath.distance(pos, w);
  const p = v.toCanvas(w.x, w.y);
  const a = Math.atan2(p.y - $('minimap').height / 2, p.x - $('minimap').width / 2);
  const idx = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
  $('tracked').textContent = `${w.name} ${Math.round(dist).toLocaleString()} ${ARROWS[idx]}`;
}

function frame(now) {
  drawMinimap(now);
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

  for (const b of document.querySelectorAll('.size-btns button')) {
    b.addEventListener('click', () => overlayApi.setPanel('minimap', { size: b.dataset.size }));
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
    const res = await overlayApi.addWaypoint({ x: Math.round(w.x), y: Math.round(w.y) });
    flash(res.ok ? `Waypoint added: ${res.data.name}` : res.error);
  });
  // Right-click teleports there, keeping the current height (the result
  // flashes from the main process).
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!ov.editing || !ov.state.teleport) return;
    const w = worldAt(e);
    overlayApi.teleportTo({ x: Math.round(w.x), y: Math.round(w.y) });
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
  $('mapTitle').textContent = st.attached ? st.game : 'Map';
  $('editHelp').textContent = `Editing overlay. Drag panels by their title, click the map to add a waypoint${st.teleport ? ', right-click it to teleport there' : ''}, scroll on the map to zoom.`;
  loadMap();
  placePanels();
  renderReadouts();
  renderInfo();
  renderMods();
});

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

// Canvas colors follow the accent too, so read them from CSS after each change.
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  ov.colors = { accent: cs.getPropertyValue('--accent').trim() || '#c48aff', glow: cs.getPropertyValue('--accent-glow').trim() };
}
overlayApi.appearance().then((r) => { if (r.ok) KeystoneTheme.applyAccent(r.data.accent); readColors(); });
overlayApi.onAppearance((a) => { KeystoneTheme.applyAccent(a.accent); readColors(); });
readColors();

wireDragging();
requestAnimationFrame(frame);
