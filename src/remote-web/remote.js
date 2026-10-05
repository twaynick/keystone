'use strict';

// Phone remote for Keystone. Talks to the desktop app over a WebSocket on the
// home network.
//
// Pairing token: the QR code opens  http://<pc>:<port>/#t=<token>
// We keep it in two places on purpose:
//   - localStorage, for Android/desktop browsers (home-screen shortcuts share
//     the browser's storage)
//   - the URL fragment, left in place, because iOS home-screen web apps get
//     their own empty storage and only remember the URL they were added from.

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'keystone.token';

const app = {
  token: null,
  ws: null,
  snapshot: null,
  collapsed: new Set(),
  pending: new Map(),
  reqSeq: 0,
  retryMs: 500,
  sheetId: null,
  rejected: false,
};

// ---------- token ----------
function readToken() {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('t');
  let stored = null;
  try { stored = localStorage.getItem(TOKEN_KEY); } catch { /* storage blocked */ }
  if (fromHash && fromHash !== stored) {
    try { localStorage.setItem(TOKEN_KEY, fromHash); } catch { /* fine, hash still works */ }
  }
  return fromHash || stored;
}

// ---------- connection ----------
function connect() {
  clearTimeout(app.retryTimer);
  if (app.ws && app.ws.readyState <= 1) return; // already connecting/connected
  if (!app.token) return show('unpaired');
  setConn('connecting');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?t=${encodeURIComponent(app.token)}`);
  app.ws = ws;

  ws.onopen = () => { app.retryMs = 500; setConn('live'); };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'snapshot') { app.snapshot = msg.data; app.snapAt = Date.now(); render(); }
    else if (msg.type === 'alert') toast(msg.text);
    else if (msg.type === 'values') patchValues(msg.data);
    else if (msg.type === 'result') settle(msg);
    else if (msg.type === 'appearance' && window.KeystoneTheme) KeystoneTheme.applyAccent(msg.data.accent);
  };
  ws.onclose = (e) => {
    app.ws = null;
    for (const p of app.pending.values()) p.reject(new Error('Lost connection to your PC.'));
    app.pending.clear();
    if (e.code === 4401) {
      // Wrong token: retrying won't help until the user re-scans.
      app.rejected = true;
      try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
      setConn('down', 'Not paired');
      return show('rejected');
    }
    if (e.code === 4429) {
      setConn('down', 'Too many attempts, waiting');
      app.retryTimer = setTimeout(connect, 60_000);
      return;
    }
    setConn('down');
    // Back off so a PC that's asleep doesn't get hammered, but cap it low
    // enough that reconnecting after Keystone restarts feels instant.
    app.retryTimer = setTimeout(connect, app.retryMs);
    app.retryMs = Math.min(app.retryMs * 2, 5000);
  };
}

function request(msg) {
  return new Promise((resolve, reject) => {
    if (!app.ws || app.ws.readyState !== 1) return reject(new Error('Not connected to your PC.'));
    const reqId = ++app.reqSeq;
    app.pending.set(reqId, { resolve, reject });
    app.ws.send(JSON.stringify({ ...msg, reqId }));
    setTimeout(() => {
      if (app.pending.delete(reqId)) reject(new Error('Your PC didn’t answer. Try again.'));
    }, 5000);
  });
}

function settle(msg) {
  const p = app.pending.get(msg.reqId);
  if (!p) return;
  app.pending.delete(msg.reqId);
  if (msg.ok) p.resolve(msg.data); else p.reject(new Error(msg.error || 'That didn’t work.'));
}

async function send(msg) {
  try {
    return await request(msg);
  } catch (err) {
    toast(err.message, 'error');
    throw err;
  }
}

// ---------- rendering ----------
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of children) if (c) node.append(c);
  return node;
}

function show(which) {
  for (const id of ['unpaired', 'rejected', 'idle', 'noMods', 'mods']) $(id).hidden = id !== which;
}

function setConn(kind, text) {
  const c = $('conn');
  c.className = `conn ${kind === 'live' ? 'live' : kind === 'down' ? 'down' : ''}`;
  $('connText').textContent = text || { live: 'Connected to your PC', down: 'Reconnecting', connecting: 'Connecting' }[kind];
}

function fmt(v, type) {
  if (v === null || v === undefined) return '—';
  if (type === 'float' || type === 'double') return String(Math.round(v * 100) / 100);
  return String(v);
}

function render() {
  const s = app.snapshot;
  if (!s || !s.attached) {
    $('game').textContent = 'Keystone';
    closeSheet();
    return show('idle');
  }
  $('game').textContent = s.displayName || (s.game.name === 'demo.exe' ? 'Demo game' : s.game.name.replace(/\.exe$/i, ''));
  // Teleport can work without mods (games with a teleport command), so a
  // game with waypoints still gets a screen.
  const tp = s.teleport && s.teleport.waypoints.length ? s.teleport : null;
  if (!s.records.length && !tp && !(s.timers || []).length && !s.checklist) return show('noMods');
  show('mods');
  renderProfiles();
  renderList();
  renderTimers(s.timers || []);
  renderChecklist(s.checklist);
  renderTeleport(tp);
  if (app.sheetId) fillSheet();
}

function renderProfiles() {
  const p = app.snapshot.profiles;
  $('profileRow').hidden = !p || !p.names.length;
  if (!p) return;
  const sel = $('profile');
  sel.replaceChildren(
    el('option', { value: '', text: p.active ? (p.dirty ? `${p.active} (changed)` : p.active) : 'Choose a profile' }),
    ...p.names.filter((n) => n !== p.active).map((n) => el('option', { value: n, text: `Apply ${n}` })),
  );
  sel.value = '';
}

const rows = new Map();

function renderList() {
  const list = $('list');
  list.replaceChildren();
  rows.clear();
  for (const r of app.snapshot.records) {
    if (r.groupPath.some((_, i) => app.collapsed.has(r.groupPath.slice(0, i + 1).join('/')))) continue;
    if (r.kind === 'group') {
      const path = r.groupPath.concat(r.name).join('/');
      const btn = el('button', { class: 'group', 'aria-expanded': String(!app.collapsed.has(path)) },
        el('span', { class: 'chev', text: '▾' }), el('span', { text: r.name }));
      btn.addEventListener('click', () => {
        if (app.collapsed.has(path)) app.collapsed.delete(path); else app.collapsed.add(path);
        renderList();
      });
      list.append(btn);
      continue;
    }
    if (r.kind !== 'value') {
      list.append(el('div', { class: 'row inert' },
        el('div', { class: 'row-main' },
          el('span', { class: 'row-name', text: r.name }),
          el('span', { class: 'row-value', text: r.kind === 'script' ? 'Script, runs only in Cheat Engine' : 'Not supported' }))));
      continue;
    }
    const value = el('span', { class: 'row-value' });
    const main = el('button', { class: 'row-main', 'aria-label': `Edit ${r.name}` }, el('span', { class: 'row-name', text: r.label || r.name }), value);
    main.addEventListener('click', () => openSheet(r.id));
    // Pack presentation: "apply" mods are a one-tap button; "toggle" mods
    // lock at the pack's value rather than whatever the game has right now.
    let control;
    if (r.ui?.control === 'apply') {
      control = el('button', { class: 'btn primary apply-btn', text: 'Apply' });
      control.addEventListener('click', () => send({ type: 'apply', id: r.id, value: r.ui.value }).then(() => toast(`${r.label || r.name}: done.`), () => {}));
    } else {
      const toggle = el('input', { type: 'checkbox', role: 'switch', 'aria-label': `${r.label || r.name} on or off` });
      toggle.checked = r.enabled;
      toggle.addEventListener('change', async () => {
        const target = toggle.checked && r.ui?.control === 'toggle' ? r.ui.value : undefined;
        try {
          await send({ type: 'toggle', id: r.id, enabled: toggle.checked, target });
        } catch {
          toggle.checked = !toggle.checked;
        }
      });
      control = el('label', { class: 'switch' }, toggle, el('span', { class: 'track' }));
    }
    const row = el('div', { class: `row${r.enabled ? ' locked' : ''}` }, main, control);
    rows.set(r.id, { row, value, rec: r });
    paintValue(r.id, r);
    list.append(row);
  }
}

// Timers count down from what the PC reported, using this phone's own clock
// for the time since: phone and PC clocks can disagree by seconds or more.
function fmtLeft(ms) {
  const t = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

const timerEls = new Map();
function renderTimers(timers) {
  $('timersSec').hidden = !timers.length;
  timerEls.clear();
  $('timerRows').replaceChildren(...timers.map((t) => {
    const left = el('span', { class: 'row-value' });
    const btn = el('button', { class: `btn ${t.state === 'running' ? '' : 'primary '}apply-btn`, text: t.state === 'running' ? 'Pause' : t.state === 'done' ? 'Again' : 'Start' });
    btn.addEventListener('click', async () => {
      try {
        if (t.state === 'done') await send({ type: 'timer', action: 'reset', id: t.id });
        await send({ type: 'timer', action: 'toggle', id: t.id });
      } catch { /* toast already shown */ }
    });
    timerEls.set(t.id, { left, t });
    return el('div', { class: `row timer ${t.state}` }, el('div', { class: 'row-main' }, el('span', { class: 'row-name', text: t.name }), left), btn);
  }));
  paintTimers();
}

function paintTimers() {
  const since = Date.now() - (app.snapAt || Date.now());
  for (const { left, t } of timerEls.values()) {
    left.textContent = t.state === 'done' ? 'Done' : fmtLeft(t.state === 'running' ? t.remainingMs - since : t.remainingMs);
  }
}
setInterval(paintTimers, 500);

function renderChecklist(list) {
  $('listSec').hidden = !list;
  if (!list) return;
  $('listName').textContent = `${list.name}  ${list.items.filter((i) => i.done).length}/${list.items.length}`;
  $('listRows').replaceChildren(...list.items.map((i) => {
    const cb = el('input', { type: 'checkbox', 'aria-label': i.text });
    cb.checked = i.done;
    cb.addEventListener('change', async () => {
      try { await send({ type: 'check', listId: list.id, itemId: i.id }); } catch { cb.checked = !cb.checked; }
    });
    return el('label', { class: `row check-row${i.done ? ' done' : ''}` }, cb, el('span', { class: 'row-name', text: i.text }));
  }));
}

function renderTeleport(tp) {
  $('teleport').hidden = !tp;
  if (!tp) return;
  $('tpList').replaceChildren(...tp.waypoints.map((w) => {
    const go = el('button', { class: 'btn primary apply-btn', text: 'Go', 'aria-label': `Teleport to ${w.name}` });
    go.addEventListener('click', async () => {
      go.disabled = true;
      try { await send({ type: 'teleport', waypointId: w.id }); toast(`Teleported to ${w.name}.`); } catch { /* toast already shown */ }
      go.disabled = false;
    });
    const main = el('div', { class: 'row-main' }, el('span', { class: 'row-name', text: w.name }));
    if (w.id === tp.tracked) main.append(el('span', { class: 'row-value', text: 'Tracked' }));
    return el('div', { class: `row${w.id === tp.tracked ? ' tracked' : ''}` }, main, go);
  }));
}

function paintValue(id, v) {
  const entry = rows.get(id);
  if (!entry) return;
  const waiting = v.status !== 'ok';
  entry.value.textContent = waiting ? 'waiting for game' : fmt(v.current, entry.rec.valueType);
  entry.value.classList.toggle('waiting', waiting);
}

function patchValues(vals) {
  if (!app.snapshot?.attached) return;
  for (const [id, v] of Object.entries(vals)) {
    const rec = app.snapshot.records.find((r) => r.id === id);
    if (rec) Object.assign(rec, { current: v.current, status: v.status });
    paintValue(id, v);
  }
  if (app.sheetId && vals[app.sheetId]) paintSheetCurrent();
}

// ---------- edit sheet ----------
function sheetRecord() {
  return app.snapshot?.records.find((r) => r.id === app.sheetId);
}

function openSheet(id) {
  app.sheetId = id;
  $('sheet').hidden = false;
  $('backdrop').hidden = false;
  $('sheetInput').value = '';
  fillSheet();
}

function fillSheet() {
  const r = sheetRecord();
  if (!r) return closeSheet();
  $('sheetName').textContent = r.name;
  $('sheetInput').placeholder = r.target !== null ? `Locked at ${fmt(r.target, r.valueType)}` : 'New value';
  $('sheetUnlock').hidden = !r.enabled;
  paintSheetCurrent();
}

function paintSheetCurrent() {
  const r = sheetRecord();
  if (r) $('sheetCurrent').textContent = r.status === 'ok' ? fmt(r.current, r.valueType) : '—';
}

function closeSheet() {
  app.sheetId = null;
  $('sheet').hidden = true;
  $('backdrop').hidden = true;
  $('sheetInput').blur();
}

function sheetValue() {
  const v = $('sheetInput').value.trim();
  if (v === '' || !Number.isFinite(Number(v))) {
    toast('Type a number first.', 'error');
    $('sheetInput').focus();
    return null;
  }
  return v;
}

function wireSheet() {
  $('backdrop').addEventListener('click', closeSheet);
  $('sheetSet').addEventListener('click', async () => {
    const v = sheetValue();
    if (v === null) return;
    await send({ type: 'apply', id: app.sheetId, value: v }).then(closeSheet, () => {});
  });
  $('sheetLock').addEventListener('click', async () => {
    const v = sheetValue();
    if (v === null) return;
    await send({ type: 'toggle', id: app.sheetId, enabled: true, target: v }).then(closeSheet, () => {});
  });
  $('sheetUnlock').addEventListener('click', async () => {
    await send({ type: 'toggle', id: app.sheetId, enabled: false }).then(closeSheet, () => {});
  });
  $('sheetInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('sheetLock').click(); });
}

// ---------- misc ----------
let toastTimer;
function toast(text, kind = 'info') {
  const t = $('toast');
  t.textContent = text;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3000);
}

$('profile').addEventListener('change', async (e) => {
  const name = e.target.value;
  if (!name) return;
  try {
    const res = await send({ type: 'applyProfile', name });
    toast(res?.skipped ? `Applied ${name}. ${res.skipped} mods weren't found.` : `Applied ${name}.`);
  } catch { /* toast already shown */ }
  e.target.value = '';
});

// Phones suspend background tabs; when the page comes back, reconnect right
// away instead of waiting out the backoff.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !app.ws && !app.rejected) { app.retryMs = 500; connect(); }
});

// Scanning a new QR code can land in an already-open tab, which only changes
// the fragment and doesn't reload. Pick up the new token and reconnect.
window.addEventListener('hashchange', () => {
  const t = readToken();
  if (!t || t === app.token) return;
  app.token = t;
  app.rejected = false;
  if (app.ws) { app.ws.onclose = null; app.ws.close(); app.ws = null; }
  connect();
});

wireSheet();
app.token = readToken();
connect();
