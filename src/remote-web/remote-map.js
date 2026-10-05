'use strict';

/* global MapMath, $, el, app, send, toast */

// The phone's Map tab: the same map, markers, waypoints and position as the
// desktop overlay, drawn on a canvas you can drag and pinch.
//
// What it gets and from where:
//   snapshot.map        everything small (map, layers on/off, waypoints, "I'm
//                       here", whether teleport and Find me work)
//   "mapPoints"         the marker points, fetched once per map (hundreds)
//   GET /api/map-image  the picture, fetched once per picture (megabytes)
//   values.pos          live position, a few times a second
const PhoneMap = (() => {
  const canvas = $('mapCanvas');
  const ctx = canvas.getContext('2d');
  const st = {
    map: null,
    visible: false,
    points: new Map(), // layer id -> [{ name, x, y, note }]
    pointsKey: null,
    img: null,
    imgKey: null,
    live: null,
    view: null, // { cx, cy, ppw }: world point at the centre, CSS px per world unit
    fitPpw: 1,
    fitFor: null,
    follow: false,
    spot: null,
  };

  // ---------- coordinates ----------
  const latlon = () => st.map?.variant.units === 'latlon';
  // Lat/lon reads latitude first, the way games show it.
  const coordText = (p) => (latlon() ? `${p.y.toFixed(1)}, ${p.x.toFixed(1)}` : `${Math.round(p.x)}, ${Math.round(p.y)}`);
  const distText = (d) => (latlon() ? d.toFixed(1) : Math.round(d).toLocaleString());

  // A custom picture that hasn't been lined up has no world edges yet. It's
  // still worth showing, but nothing can be placed on it.
  function drawBounds() {
    if (st.map?.bounds) return st.map.bounds;
    if (st.img) return { left: 0, right: st.img.naturalWidth, top: 0, bottom: st.img.naturalHeight };
    return null;
  }
  const aligned = () => Boolean(st.map?.bounds) || !st.img;

  function signs() {
    const b = drawBounds();
    // No edges at all: game units, Y pointing north, like the overlay assumes.
    return b ? { sx: Math.sign(b.right - b.left) || 1, sy: Math.sign(b.bottom - b.top) || 1 } : { sx: 1, sy: -1 };
  }

  function size() {
    return { W: canvas.clientWidth, H: canvas.clientHeight };
  }

  function toScreen(x, y) {
    const { W, H } = size();
    const { sx, sy } = signs();
    const v = st.view;
    return { x: W / 2 + (x - v.cx) * v.ppw * sx, y: H / 2 + (y - v.cy) * v.ppw * sy };
  }

  function toWorld(px, py) {
    const { W, H } = size();
    const { sx, sy } = signs();
    const v = st.view;
    return { x: v.cx + (px - W / 2) / (v.ppw * sx), y: v.cy + (py - H / 2) / (v.ppw * sy) };
  }

  // The whole map in view; with no map, all the waypoints.
  function fit() {
    const { W, H } = size();
    if (!W || !H) return false;
    const b = drawBounds();
    let box = b ? { l: Math.min(b.left, b.right), r: Math.max(b.left, b.right), t: Math.min(b.top, b.bottom), btm: Math.max(b.top, b.bottom) } : null;
    if (!box) {
      const pts = [...(st.map?.waypoints || []), st.live, st.map?.here].filter(Boolean);
      if (pts.length) {
        const xs = pts.map((p) => p.x);
        const ys = pts.map((p) => p.y);
        const pad = Math.max(100, (Math.max(...xs) - Math.min(...xs)) * 0.15, (Math.max(...ys) - Math.min(...ys)) * 0.15);
        box = { l: Math.min(...xs) - pad, r: Math.max(...xs) + pad, t: Math.min(...ys) - pad, btm: Math.max(...ys) + pad };
      } else {
        box = { l: -1000, r: 1000, t: -1000, btm: 1000 };
      }
    }
    const ppw = Math.min(W / (box.r - box.l), H / (box.btm - box.t)) * 0.98;
    st.fitPpw = ppw;
    st.view = { cx: (box.l + box.r) / 2, cy: (box.t + box.btm) / 2, ppw };
    return true;
  }

  function clampZoom(ppw) {
    return Math.min(st.fitPpw * 60, Math.max(st.fitPpw * 0.5, ppw));
  }

  // Zoom keeping the world point under (px, py) where it is on screen.
  function zoomAt(px, py, factor) {
    if (!st.view) return;
    const before = toWorld(px, py);
    st.view.ppw = clampZoom(st.view.ppw * factor);
    const after = toWorld(px, py);
    st.view.cx += before.x - after.x;
    st.view.cy += before.y - after.y;
    schedule();
  }

  function centerOn(p, zoom) {
    if (!st.view || !p) return;
    st.view.cx = p.x;
    st.view.cy = p.y;
    if (zoom) st.view.ppw = clampZoom(Math.max(st.view.ppw, st.fitPpw * zoom));
    schedule();
  }

  // ---------- drawing ----------
  let rafId = 0;
  function schedule() {
    if (!rafId) rafId = requestAnimationFrame(() => { rafId = 0; draw(); });
  }

  function myPos() {
    if (st.live) return { ...st.live, manual: false };
    const h = st.map?.here;
    return h ? { x: h.x, y: h.y, z: h.z, facing: null, manual: true, at: h.at } : null;
  }

  function draw() {
    if (!st.visible || !st.map) return;
    const { W, H } = size();
    if (!W || !H) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    if (!st.view || st.fitFor !== fitKey()) {
      if (!fit()) return;
      st.fitFor = fitKey();
      st.size = `${W}x${H}`;
    } else if (st.size !== `${W}x${H}`) {
      // Rotated, or full screen on/off: same spot in the middle, same zoom
      // relative to the whole map.
      const zoom = st.view.ppw / st.fitPpw;
      const { cx, cy } = st.view;
      fit();
      st.view = { cx, cy, ppw: st.fitPpw * zoom };
      st.size = `${W}x${H}`;
    }
    if (st.follow && st.live) { st.view.cx = st.live.x; st.view.cy = st.live.y; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0e1115';
    ctx.fillRect(0, 0, W, H);

    const b = drawBounds();
    if (st.img && b) {
      const tl = toScreen(b.left, b.top);
      const br = toScreen(b.right, b.bottom);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(st.img, tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    } else {
      drawGrid(W, H);
      if (b) {
        const tl = toScreen(b.left, b.top);
        const br = toScreen(b.right, b.bottom);
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.lineWidth = 1;
        ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
      }
    }
    if (aligned()) {
      drawMarkers(W, H);
      drawWaypoints(W, H);
      drawMe();
    }
    if (st.spot) {
      const p = toScreen(st.spot.x, st.spot.y);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 13, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    }
    paintStatus();
  }

  function drawGrid(W, H) {
    // Lines at whichever step gives ~48 px spacing. The small steps are for
    // lat/lon maps, 100 units across.
    const steps = [0.5, 1, 2, 5, 10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];
    const step = steps.find((s) => s * st.view.ppw >= 48) || steps[steps.length - 1];
    const a = toWorld(0, 0);
    const c = toWorld(W, H);
    ctx.strokeStyle = 'rgba(134,136,138,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = Math.ceil(Math.min(a.x, c.x) / step) * step; x <= Math.max(a.x, c.x); x += step) {
      const px = toScreen(x, 0).x;
      ctx.moveTo(px, 0); ctx.lineTo(px, H);
    }
    for (let y = Math.ceil(Math.min(a.y, c.y) / step) * step; y <= Math.max(a.y, c.y); y += step) {
      const py = toScreen(0, y).y;
      ctx.moveTo(0, py); ctx.lineTo(W, py);
    }
    ctx.stroke();
  }

  function label(text, x, y, size = 12) {
    ctx.font = `500 ${size}px Geist, system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 4;
    ctx.fillText(text, x, y);
    ctx.shadowBlur = 0;
  }

  function markerPath(shape, x, y, r) {
    ctx.beginPath();
    if (shape === 'square') ctx.rect(x - r, y - r, r * 2, r * 2);
    else if (shape === 'diamond') { ctx.moveTo(x, y - r - 1); ctx.lineTo(x + r + 1, y); ctx.lineTo(x, y + r + 1); ctx.lineTo(x - r - 1, y); ctx.closePath(); }
    else if (shape === 'triangle') { ctx.moveTo(x, y - r - 1); ctx.lineTo(x + r + 1, y + r); ctx.lineTo(x - r - 1, y + r); ctx.closePath(); }
    else ctx.arc(x, y, r, 0, Math.PI * 2);
  }

  // Names once zoomed in far enough that they don't pile up.
  const showLabels = () => st.view.ppw >= st.fitPpw * 2.5;

  function visibleMarkers() {
    const out = [];
    for (const layer of st.map.layers) {
      if (!layer.on) continue;
      for (const m of st.points.get(layer.id) || []) out.push({ ...m, layer });
    }
    return out;
  }

  function drawMarkers(W, H) {
    const labels = showLabels();
    for (const m of visibleMarkers()) {
      const p = toScreen(m.x, m.y);
      if (p.x < -12 || p.x > W + 12 || p.y < -12 || p.y > H + 12) continue;
      markerPath(m.layer.shape, p.x, p.y, 5);
      ctx.fillStyle = m.layer.color;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#0e1115';
      ctx.stroke();
      if (labels && m.name) label(m.name, p.x + 8, p.y + 4, 11);
    }
  }

  function drawWaypoints(W, H) {
    const list = st.map.waypoints;
    for (const w of list) {
      const p = toScreen(w.x, w.y);
      if (p.x < -12 || p.x > W + 12 || p.y < -12 || p.y > H + 12) continue;
      const tracked = w.id === st.map.tracked;
      ctx.beginPath();
      ctx.arc(p.x, p.y, tracked ? 7 : 5.5, 0, Math.PI * 2);
      ctx.fillStyle = tracked ? '#d4af74' : '#ffffff';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#0e1115';
      ctx.stroke();
      if (tracked || showLabels() || list.length <= 8) label(w.name, p.x + 10, p.y + 4);
    }
  }

  function accent() {
    return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#c48aff';
  }

  function drawMe() {
    const me = myPos();
    if (!me) return;
    const p = toScreen(me.x, me.y);
    const color = accent();
    if (me.manual) {
      // "I'm here": a ring rather than an arrow, since it doesn't move with you.
      ctx.beginPath();
      ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
      ctx.lineWidth = 3;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      return;
    }
    const { sx, sy } = signs();
    const angle = !Number.isFinite(me.facing) ? -Math.PI / 2
      : Math.atan2(Math.sin((me.facing * Math.PI) / 180) * sy, Math.cos((me.facing * Math.PI) / 180) * sx);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(13, 0); ctx.lineTo(-8, -8); ctx.lineTo(-4, 0); ctx.lineTo(-8, 8); ctx.closePath();
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#0e1115';
    ctx.stroke();
    ctx.restore();
  }

  const ARROWS = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];

  function paintStatus() {
    const me = myPos();
    $('mapPos').textContent = !aligned() ? 'Line up this map on your PC to place things on it'
      : !me ? 'Position unknown. Tap the map and pick “I’m here”.'
        : me.manual ? `I’m here: ${coordText(me)}` : `You: ${coordText(me)}`;
    const w = st.map.waypoints.find((x) => x.id === st.map.tracked);
    if (!w) { $('mapTracked').textContent = ''; return; }
    if (!me) { $('mapTracked').textContent = `Tracking ${w.name}`; return; }
    const a = toScreen(me.x, me.y);
    const b = toScreen(w.x, w.y);
    const idx = ((Math.round(Math.atan2(b.y - a.y, b.x - a.x) / (Math.PI / 4)) % 8) + 8) % 8;
    $('mapTracked').textContent = `${w.name} ${distText(MapMath.distance(me, w))} ${ARROWS[idx]}`;
  }

  function fitKey() {
    const b = drawBounds();
    return `${st.map?.variant.id}|${b ? [b.left, b.right, b.top, b.bottom].join(',') : 'none'}`;
  }

  // ---------- gestures ----------
  // One finger drags, two pinch, a tap that barely moved picks what's there.
  const ptrs = new Map();
  let g = null;

  function local(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function startPan(p) {
    g = { mode: 'pan', start: p, cx: st.view.cx, cy: st.view.cy, t: performance.now(), moved: g?.moved || false };
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!st.view) return;
    canvas.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, local(e));
    if (ptrs.size === 1) { g = null; startPan(local(e)); }
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      g = { mode: 'pinch', dist: Math.hypot(b.x - a.x, b.y - a.y) || 1, ppw: st.view.ppw, anchor: toWorld(mid.x, mid.y), moved: true };
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!ptrs.has(e.pointerId) || !g) return;
    ptrs.set(e.pointerId, local(e));
    const { sx, sy } = signs();
    if (g.mode === 'pan' && ptrs.size === 1) {
      const p = local(e);
      const dx = p.x - g.start.x;
      const dy = p.y - g.start.y;
      if (!g.moved && Math.hypot(dx, dy) < 8) return;
      g.moved = true;
      st.follow = false;
      st.view.cx = g.cx - dx / (st.view.ppw * sx);
      st.view.cy = g.cy - dy / (st.view.ppw * sy);
      schedule();
    } else if (g.mode === 'pinch' && ptrs.size >= 2) {
      const [a, b] = [...ptrs.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      st.view.ppw = clampZoom(g.ppw * ((Math.hypot(b.x - a.x, b.y - a.y) || 1) / g.dist));
      // Keep the pinched world point under the fingers' midpoint.
      const now = toWorld(mid.x, mid.y);
      st.view.cx += g.anchor.x - now.x;
      st.view.cy += g.anchor.y - now.y;
      st.follow = false;
      schedule();
    }
  });

  function endPointer(e, cancelled) {
    if (!ptrs.has(e.pointerId)) return;
    const p = local(e);
    ptrs.delete(e.pointerId);
    if (ptrs.size === 1) { startPan([...ptrs.values()][0]); g.moved = true; return; }
    if (ptrs.size === 0) {
      const tap = g && g.mode === 'pan' && !g.moved && !cancelled && performance.now() - g.t < 500;
      g = null;
      // Acted on in the click that follows: opening the sheet now would put
      // the backdrop under the finger, and that click would close it again.
      tapAt = tap ? p : null;
    }
  }
  let tapAt = null;
  canvas.addEventListener('click', () => {
    const p = tapAt;
    tapAt = null;
    if (p) pick(p.x, p.y);
  });
  canvas.addEventListener('pointerup', (e) => endPointer(e, false));
  canvas.addEventListener('pointercancel', (e) => endPointer(e, true));
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = local(e);
    zoomAt(p.x, p.y, e.deltaY < 0 ? 1.25 : 0.8);
  }, { passive: false });

  $('mapZoomIn').addEventListener('click', () => { const { W, H } = size(); zoomAt(W / 2, H / 2, 1.6); });
  $('mapZoomOut').addEventListener('click', () => { const { W, H } = size(); zoomAt(W / 2, H / 2, 1 / 1.6); });
  $('mapFull').addEventListener('click', () => {
    const full = !$('mapWrap').classList.contains('full');
    $('mapWrap').classList.toggle('full', full);
    $('mapFull').setAttribute('aria-pressed', String(full));
    $('mapFull').setAttribute('aria-label', full ? 'Exit full screen' : 'Full screen map');
    // Keep the same spot in the middle; the canvas just got bigger or smaller.
    schedule();
  });
  $('mapCenter').addEventListener('click', () => {
    const me = myPos();
    if (!me) { toast('Keystone doesn’t know where you are yet. Tap the map and pick “I’m here”.'); return; }
    st.follow = Boolean(st.live);
    centerOn(me, 4);
  });

  // ---------- tapping things ----------
  function pick(px, py) {
    if (!aligned()) {
      toast('This picture isn’t lined up yet. Line it up in Keystone’s Overlay tab on your PC.');
      return;
    }
    // Waypoints win over markers: they're yours and fewer.
    let best = null;
    const consider = (item, x, y, r) => {
      const p = toScreen(x, y);
      const d = Math.hypot(p.x - px, p.y - py);
      if (d <= r && (!best || d < best.d)) best = { ...item, d };
    };
    for (const w of st.map.waypoints) consider({ kind: 'waypoint', id: w.id, name: w.name, x: w.x, y: w.y }, w.x, w.y, 24);
    if (!best) for (const m of visibleMarkers()) consider({ kind: 'marker', name: m.name, sub: [m.layer.name, m.note].filter(Boolean).join(' · '), x: m.x, y: m.y }, m.x, m.y, 20);
    if (!best) {
      const w = toWorld(px, py);
      best = { kind: 'spot', name: 'This spot', x: w.x, y: w.y };
    }
    openSpot(best);
  }

  function action(text, fn, kind = '') {
    const b = el('button', { class: `btn ${kind}`, text });
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { await fn(); } catch { /* send() already showed why */ }
      b.disabled = false;
    });
    return b;
  }

  function openSpot(spot) {
    st.spot = spot;
    const m = st.map;
    $('spotName').textContent = spot.name || 'Marker';
    $('spotSub').textContent = [spot.sub, coordText(spot)].filter(Boolean).join(' · ');
    const input = $('spotInput');
    const canAdd = spot.kind !== 'waypoint';
    input.hidden = !canAdd;
    input.value = spot.kind === 'marker' ? (spot.name || '').slice(0, 40) : '';
    const acts = [];
    if (m.teleport) {
      acts.push(action('Teleport here', async () => {
        await send({ type: 'teleportTo', x: spot.x, y: spot.y }, 12000);
        toast(`Teleported${spot.kind === 'spot' ? '' : ` to ${spot.name}`}.`);
        closeSpot();
      }, 'primary'));
    }
    if (canAdd) {
      acts.push(action('Add waypoint', async () => {
        const wp = await send({ type: 'addWaypoint', name: input.value.trim(), x: spot.x, y: spot.y });
        toast(`Added ${wp.name}.`);
        closeSpot();
      }, m.teleport ? '' : 'primary'));
    }
    if (spot.kind === 'waypoint') {
      const tracked = m.tracked === spot.id;
      acts.push(action(tracked ? 'Stop tracking' : 'Track', async () => {
        await send({ type: 'setTracked', id: tracked ? null : spot.id });
        closeSpot();
      }, m.teleport ? '' : 'primary'));
      acts.push(action('Delete', async () => {
        await send({ type: 'removeWaypoint', id: spot.id });
        toast(`Deleted ${spot.name}.`);
        closeSpot();
      }, 'ghost danger'));
    }
    // "I'm here" is for when Keystone can't read your position.
    if (!st.live && spot.kind !== 'waypoint') {
      acts.push(action('I’m here', async () => {
        await send({ type: 'setHere', x: spot.x, y: spot.y });
        closeSpot();
      }));
    }
    $('spotActions').replaceChildren(...acts);
    $('spotSheet').hidden = false;
    $('backdrop').hidden = false;
    schedule();
  }

  function closeSpot() {
    if ($('spotSheet').hidden && !st.spot) return;
    st.spot = null;
    $('spotSheet').hidden = true;
    $('spotInput').blur();
    if (!app.sheetId) $('backdrop').hidden = true;
    schedule();
  }
  $('backdrop').addEventListener('click', closeSpot);
  $('spotInput').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const add = [...$('spotActions').children].find((b) => b.textContent === 'Add waypoint');
    if (add) add.click();
  });

  // ---------- controls under and over the map ----------
  function renderControls() {
    const m = st.map;
    const sel = $('mapVariant');
    sel.hidden = m.variants.length < 2;
    if (document.activeElement !== sel) {
      sel.replaceChildren(...m.variants.map((v) => el('option', { value: v.id, text: v.name })));
      sel.value = m.variant.id;
    }
    $('mapFindMe').hidden = !m.findMe;
    $('mapLayers').hidden = !m.layers.length;
    $('mapLayers').replaceChildren(...m.layers.map((l) => {
      const dot = el('span', { class: 'chip-dot' });
      // Set through the style object: the page's CSP blocks style="" attributes.
      dot.style.background = /^#[0-9a-f]{3,8}$/i.test(l.color) ? l.color : '#999';
      const b = el('button', { class: `chip${l.on ? ' on' : ''}`, 'aria-pressed': String(l.on) },
        dot, el('span', { text: l.name }), el('span', { class: 'chip-n', text: String(l.count) }));
      b.addEventListener('click', () => send({ type: 'setLayer', id: l.id, on: !l.on }).catch(() => {}));
      return b;
    }));
    const note = $('mapNote');
    const text = !aligned() ? 'This picture isn’t lined up yet. Line it up in Keystone’s Overlay tab on your PC.'
      : !m.image ? 'No map picture yet, so this is a grid. Add one in Keystone’s Overlay tab on your PC.'
        : '';
    note.hidden = !text;
    note.textContent = text;
    $('mapCredit').hidden = !m.credits;
    $('mapCredit').textContent = m.credits || '';
    renderWaypoints();
  }

  function renderWaypoints() {
    const m = st.map;
    const me = myPos();
    if (!m.waypoints.length) {
      $('wpList').replaceChildren(el('p', { class: 'wp-empty', text: 'Tap the map to add one.' }));
      return;
    }
    $('wpList').replaceChildren(...m.waypoints.map((w) => {
      const tracked = w.id === m.tracked;
      const main = el('button', { class: 'row-main', 'aria-label': `Show ${w.name} on the map` },
        el('span', { class: 'row-name', text: w.name }),
        el('span', { class: 'row-value', text: tracked ? `Tracking${me ? ` · ${distText(MapMath.distance(me, w))} away` : ''}` : me ? `${distText(MapMath.distance(me, w))} away` : coordText(w) }));
      main.addEventListener('click', () => { st.follow = false; centerOn(w, 3); window.scrollTo({ top: 0, behavior: 'smooth' }); });
      const row = el('div', { class: `row${tracked ? ' tracked' : ''}` }, main);
      const track = el('button', { class: `btn small${tracked ? ' on' : ''}`, text: tracked ? 'Tracking' : 'Track', 'aria-pressed': String(tracked) });
      track.addEventListener('click', () => send({ type: 'setTracked', id: tracked ? null : w.id }).catch(() => {}));
      row.append(track);
      if (m.teleport) {
        const go = el('button', { class: 'btn primary apply-btn', text: 'Go', 'aria-label': `Teleport to ${w.name}` });
        go.addEventListener('click', async () => {
          go.disabled = true;
          try { await send({ type: 'teleport', waypointId: w.id }, 12000); toast(`Teleported to ${w.name}.`); } catch { /* shown */ }
          go.disabled = false;
        });
        row.append(go);
      }
      return row;
    }));
  }

  $('mapVariant').addEventListener('change', (e) => send({ type: 'setVariant', id: e.target.value }).catch(() => {}));
  $('mapFindMe').addEventListener('click', async () => {
    const b = $('mapFindMe');
    b.disabled = true;
    try {
      const h = await send({ type: 'findMe' }, 15000);
      toast(`Found you at ${coordText(h)}.`);
      centerOn(h, 4);
    } catch { /* shown */ }
    b.disabled = false;
  });

  // ---------- data ----------
  async function loadPoints() {
    const key = st.map.pointsKey;
    if (key === st.pointsKey) return;
    st.pointsKey = key;
    st.points = new Map();
    if (!st.map.layers.length) return;
    try {
      const res = await send({ type: 'mapPoints' });
      if (st.map?.pointsKey !== key) return; // map changed while we waited
      st.points = new Map(res.layers.map((l) => [l.id, l.points]));
      schedule();
    } catch {
      st.pointsKey = null; // try again on the next snapshot
    }
  }

  async function loadImage() {
    const key = st.map.image?.key || null;
    if (key === st.imgKey) return;
    st.imgKey = key;
    st.img = null;
    if (!key) { schedule(); return; }
    try {
      // The token goes in a header: an <img src> can't send one, and a URL
      // with the token in it could end up somewhere it shouldn't.
      const res = await fetch(`/api/map-image?k=${encodeURIComponent(key)}`, { headers: { 'X-Keystone-Token': app.token } });
      if (!res.ok) throw new Error(String(res.status));
      const url = URL.createObjectURL(await res.blob());
      const img = new Image();
      img.onload = () => {
        if (st.imgKey !== key) return;
        st.img = img;
        st.fitFor = null; // an unaligned picture's edges are its size
        renderControls();
        schedule();
      };
      img.src = url;
    } catch {
      st.imgKey = null; // retry on the next snapshot
      toast('Couldn’t load the map picture from your PC.', 'error');
    }
  }

  function update(map, visible) {
    st.visible = Boolean(visible);
    if (!map || !st.visible) $('mapWrap').classList.remove('full');
    if (!map) { st.map = null; closeSpot(); return; }
    const variantChanged = st.map?.variant.id !== map.variant.id;
    st.map = map;
    if (variantChanged) { st.follow = false; st.spot = null; }
    if (!st.visible) return;
    loadPoints();
    loadImage();
    renderControls();
    schedule();
  }

  let listAt = 0;
  function setLive(pos) {
    const had = Boolean(st.live);
    st.live = pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) ? pos : null;
    if (!st.visible || !st.map) return;
    // Distances in the waypoint list: once a second is plenty.
    if (had !== Boolean(st.live)) renderControls();
    else if (st.live && Date.now() - listAt > 1000) { listAt = Date.now(); renderWaypoints(); }
    schedule();
  }

  new ResizeObserver(() => schedule()).observe(canvas);

  return { update, setLive };
})();
window.PhoneMap = PhoneMap;
