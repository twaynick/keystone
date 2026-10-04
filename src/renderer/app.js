'use strict';

/* global keystone, MapMath */

const $ = (id) => document.getElementById(id);

const state = {
  processes: [],
  snapshot: { attached: false, game: null, records: [] },
  collapsed: new Set(),
  filter: '',
  procFilter: '',
  platform: 'win32',
  view: 'mods',
  remote: null,
  ovStatus: null,
  ovData: { attached: false },
  ovLive: { pos: null, readouts: {} },
  calib: null,
  mapImg: null,
  mapUrl: null,
  games: [],
  lib: { info: null, page: { kind: 'home' }, entries: {}, filters: {}, searchTimer: null },
  cmd: { info: null, seg: null, catalogs: {}, filters: { q: '', category: '', map: '' }, selected: null, action: {}, values: {} },
};

// Row elements by record id, so live value updates (4×/s) patch text in place
// instead of rebuilding the list — rebuilding would steal focus from a value
// box while you're typing in it.
const rowEls = new Map();
let renderedKey = '';

// ---------- helpers ----------
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    // CSSOM assignment, not a style attribute: the CSP blocks inline style attributes.
    else if (k === 'style') Object.assign(node.style, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of children) if (c) node.append(c);
  return node;
}

function toast(message, kind = 'info') {
  const t = el('div', { class: `toast ${kind}`, text: message });
  $('toasts').append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 7000 : 3500);
}

async function call(promise) {
  const res = await promise;
  if (!res.ok) {
    toast(res.error, 'error');
    return undefined;
  }
  return res.data;
}

function fmt(v, type) {
  if (v === null || v === undefined) return '—';
  if (type === 'float') return String(Math.round(v * 100) / 100);
  if (type === 'double') return String(Math.round(v * 10000) / 10000);
  return String(v);
}

const TYPE_LABEL = { byte: 'byte', int16: '2-byte integer', int32: 'integer', int64: '8-byte integer', float: 'decimal', double: 'decimal' };

// ---------- process picker ----------
async function refreshProcesses() {
  const [list, games] = await Promise.all([call(keystone.listProcesses()), call(keystone.listGames())]);
  if (list) state.processes = list;
  if (games) state.games = games;
  renderProcesses();
}

function renderProcesses() {
  const ul = $('procList');
  ul.replaceChildren();
  const attachedName = state.snapshot.attached ? state.snapshot.game.name.toLowerCase() : null;

  const demo = el('li', { class: `proc-item demo${attachedName === 'demo.exe' ? ' active' : ''}`, role: 'option', tabindex: '0' },
    el('span', { class: 'name', text: 'Demo game' }),
    el('span', { class: 'tag', text: 'built in' }));
  demo.addEventListener('click', () => attach({ demo: true }));
  demo.addEventListener('keydown', (e) => { if (e.key === 'Enter') attach({ demo: true }); });
  ul.append(demo);

  const q = state.procFilter.trim().toLowerCase();
  // Games with a pack: pick them even when they aren't running (RCON, map,
  // waypoints still work), or attach when they are.
  const games = state.games.filter((g) => !q || g.name.toLowerCase().includes(q));
  if (games.length) {
    ul.append(el('li', { class: 'pop-section', role: 'presentation', text: 'Your games' }));
    for (const g of games) {
      const active = attachedName === g.exe.toLowerCase();
      const li = el('li', { class: `proc-item${active ? ' active' : ''}`, role: 'option', tabindex: '0' },
        el('span', { class: 'name', text: g.name }),
        el('span', { class: `tag${g.running ? ' running' : ''}`, text: g.running ? 'running' : 'not running' }));
      const go = () => attach({ packId: g.id });
      li.addEventListener('click', go);
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      ul.append(li);
    }
  }
  const packExes = new Set(state.games.map((g) => g.exe.toLowerCase()));
  const shown = state.processes.filter((p) => !packExes.has(p.name.toLowerCase()) && (!q || p.name.toLowerCase().includes(q)));
  if (shown.length) ul.append(el('li', { class: 'pop-section', role: 'presentation', text: 'Running programs' }));
  for (const p of shown) {
    const li = el('li', { class: `proc-item${attachedName === p.name.toLowerCase() ? ' active' : ''}`, role: 'option', tabindex: '0', title: `${p.name} (PID ${p.pid})` },
      el('span', { class: 'name', text: p.name.replace(/\.exe$/i, '') }),
      el('span', { class: 'tag', text: String(p.pid) }));
    li.addEventListener('click', () => attach({ pid: p.pid, name: p.name }));
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter') attach({ pid: p.pid, name: p.name }); });
    ul.append(li);
  }

  const note = $('procNote');
  if (state.platform !== 'win32') note.textContent = 'Attaching to real games needs Windows. The demo game works everywhere.';
  else if (q && !shown.length) note.textContent = `Nothing running matches "${state.procFilter}".`;
  else note.textContent = '';
}

function setSwitcher(open) {
  $('switcherPop').hidden = !open;
  $('switcherBtn').setAttribute('aria-expanded', String(open));
  if (open) {
    refreshProcesses();
    $('procSearch').focus();
  }
}

async function attach(target) {
  setSwitcher(false);
  const res = await call(keystone.attach(target));
  if (res) {
    state.snapshot = res.snapshot;
    render();
    for (const n of res.notices) toast(n);
  }
}

// ---------- mods ----------
function render() {
  const snap = state.snapshot;
  const attached = snap.attached;

  $('detachBtn').hidden = !attached;
  $('liveDot').classList.toggle('on', attached && !snap.game.offline);
  $('liveDot').classList.toggle('idle', attached && Boolean(snap.game.offline));
  if (attached) {
    $('attachedName').textContent = snap.displayName || snap.game.name;
    const meta = [
      snap.game.offline ? 'Not running' : snap.game.pid ? `PID ${snap.game.pid}` : 'Built in',
      snap.mods ? null : 'no mods',
      ...snap.game.tables,
    ].filter(Boolean);
    $('attachedMeta').textContent = meta.join(', ');
  } else {
    $('attachedName').textContent = 'Choose a game';
    $('attachedMeta').textContent = 'Nothing attached';
  }

  const hasMods = attached && snap.records.length > 0;
  const onMods = state.view === 'mods';
  $('emptyDetached').hidden = !onMods || attached;
  $('emptyNoTable').hidden = !onMods || !attached || hasMods || !snap.mods;
  $('emptyNoMods').hidden = !onMods || !attached || snap.mods;
  if (attached && !snap.mods) {
    $('noModsText').textContent = snap.game.offline
      ? 'The game isn\u2019t running. Start it and pick it again to use mods.'
      : `Keystone can't reach this game's memory (${snap.modsError || 'access denied'}). That's normal for games with anti-cheat.`;
    $('noModsCommands').hidden = !snap.hasCommands;
  }
  $('loadTableBtn').hidden = !attached || !snap.mods;
  $('modsView').hidden = !onMods || !hasMods;
  $('phoneView').hidden = state.view !== 'phone';
  $('overlayView').hidden = state.view !== 'overlay';
  $('commandsView').hidden = state.view !== 'commands';
  $('settingsView').hidden = state.view !== 'settings';
  $('libraryView').hidden = state.view !== 'library';
  for (const t of document.querySelectorAll('.tab')) {
    if (t.dataset.view === state.view) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  }

  renderProcesses();
  if (hasMods) { renderMods(); renderProfiles(); }
}

// ---------- profiles ----------
function renderProfiles() {
  const p = state.snapshot.profiles || { names: [], active: null, autoApply: true, dirty: false };
  const sel = $('profileSelect');
  sel.replaceChildren(
    el('option', { value: '', text: p.names.length ? 'No profile' : 'No saved profiles' }),
    ...p.names.map((n) => el('option', { value: n, text: n })),
  );
  sel.value = p.active || '';
  $('profileDirty').hidden = !p.dirty;
  $('profileSave').textContent = p.active ? 'Save' : 'Save profile';
  $('profileSaveAs').hidden = !p.active;
  $('profileRename').disabled = !p.active;
  $('profileDelete').disabled = !p.active;
  $('autoApply').checked = p.autoApply;
}

function askName({ title, initial = '', confirm = 'Save' }) {
  const dlg = $('nameDialog');
  $('nameTitle').textContent = title;
  $('nameOk').textContent = confirm;
  $('nameInput').value = initial;
  $('nameError').hidden = true;
  dlg.returnValue = '';
  dlg.showModal();
  $('nameInput').select();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => {
      const v = $('nameInput').value.trim();
      resolve(dlg.returnValue === 'ok' && v ? v : null);
    }, { once: true });
  });
}

function confirmBox(text, confirm = 'OK') {
  const dlg = $('confirmDialog');
  $('confirmText').textContent = text;
  $('confirmOk').textContent = confirm;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
  });
}

function setMenu(open) {
  $('profileMenu').hidden = !open;
  $('profileMenuBtn').setAttribute('aria-expanded', String(open));
}

async function saveAsNew() {
  const name = await askName({ title: 'Save as a new profile', confirm: 'Save profile' });
  if (!name) return;
  if (state.snapshot.profiles?.names.includes(name)) {
    if (!(await confirmBox(`"${name}" already exists. Replace it with the current locks and values?`, 'Replace'))) return;
  }
  const saved = await call(keystone.saveProfile(name, { overwrite: true }));
  if (saved) toast(`Saved profile "${saved}".`);
}

function wireProfiles() {
  $('profileSelect').addEventListener('change', async (e) => {
    const p = state.snapshot.profiles;
    const name = e.target.value;
    if (!name) { await call(keystone.clearProfile()); return; }
    if (p?.dirty && !(await confirmBox(`You have unsaved changes to "${p.active}". Switch anyway and lose them?`, 'Switch'))) {
      e.target.value = p.active || '';
      return;
    }
    const res = await call(keystone.applyProfile(name));
    if (res) toast(res.skipped ? `Applied "${name}". ${res.skipped} saved mods aren't in the loaded tables.` : `Applied "${name}".`);
  });

  $('profileSave').addEventListener('click', async () => {
    const active = state.snapshot.profiles?.active;
    if (!active) return saveAsNew();
    const saved = await call(keystone.saveProfile(active, { overwrite: true }));
    if (saved) toast(`Saved "${saved}".`);
  });
  $('profileSaveAs').addEventListener('click', saveAsNew);

  $('profileMenuBtn').addEventListener('click', (e) => { e.stopPropagation(); setMenu($('profileMenu').hidden); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.menu-wrap')) setMenu(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });

  $('profileRename').addEventListener('click', async () => {
    setMenu(false);
    const from = state.snapshot.profiles?.active;
    if (!from) return;
    const to = await askName({ title: 'Rename profile', initial: from, confirm: 'Rename' });
    if (to && to !== from) {
      const done = await call(keystone.renameProfile(from, to));
      if (done) toast(`Renamed to "${done}".`);
    }
  });
  $('profileDelete').addEventListener('click', async () => {
    setMenu(false);
    const name = state.snapshot.profiles?.active;
    if (!name) return;
    if (!(await confirmBox(`Delete the profile "${name}"? Your current locks stay as they are.`, 'Delete'))) return;
    if (await call(keystone.deleteProfile(name))) toast(`Deleted "${name}".`);
  });
  $('autoApply').addEventListener('change', (e) => call(keystone.setAutoApply(e.target.checked)));
}

function visibleRecords() {
  const q = state.filter.trim().toLowerCase();
  return state.snapshot.records.filter((r) => {
    if (r.groupPath.some((g, i) => state.collapsed.has(r.groupPath.slice(0, i + 1).join('/')))) return false;
    if (!q) return true;
    if (r.kind === 'group') return true;
    return r.name.toLowerCase().includes(q) || r.groupPath.join(' ').toLowerCase().includes(q);
  });
}

function renderMods() {
  const recs = state.snapshot.records;
  const list = visibleRecords();
  const key = list.map((r) => r.id).join('|');

  // Same rows as last time: patch in place (keeps focus and scroll).
  if (key === renderedKey) {
    for (const r of list) patchRow(r);
  } else {
    renderedKey = key;
    rowEls.clear();
    const container = $('modsList');
    container.replaceChildren(...list.map(buildRow));
  }

  const usable = recs.filter((r) => r.kind === 'value').length;
  const locked = recs.filter((r) => r.enabled).length;
  $('modsCount').textContent = `${usable} mods${locked ? `, ${locked} locked` : ''}`;
}

function buildRow(r) {
  if (r.kind === 'group') {
    const path = r.groupPath.concat(r.name).join('/');
    const childCount = state.snapshot.records.filter((x) => x.kind === 'value' && x.groupPath.join('/').startsWith(path)).length;
    const btn = el('button', { class: 'group-row', 'aria-expanded': String(!state.collapsed.has(path)), style: { paddingLeft: `${2 + r.depth * 16}px` } },
      el('span', { class: 'chev', text: '▾' }),
      el('span', { text: r.name }),
      el('span', { class: 'count', text: `${childCount}` }));
    btn.addEventListener('click', () => {
      if (state.collapsed.has(path)) state.collapsed.delete(path); else state.collapsed.add(path);
      renderMods();
    });
    return btn;
  }

  // Cards already pad 16px; nest further only below the first group level.
  const indent = { paddingLeft: `${16 + Math.max(0, r.depth - 1) * 16}px` };

  if (r.kind !== 'value') {
    return el('div', { class: 'mod-row inert', style: indent },
      el('div', { class: 'mod-name' },
        el('span', { class: 'label', text: r.name }),
        el('span', { class: 'sub', text: r.kind === 'script' ? 'Script' : 'Not supported' })),
      el('span', { class: 'reason', text: r.reason || '' }));
  }

  const current = el('span', { class: 'mod-current' });
  const input = el('input', { class: 'field mod-target', inputmode: 'decimal', placeholder: 'value', 'aria-label': `${r.name} value` });
  const setBtn = el('button', { class: 'btn small', text: 'Set', title: 'Write this value once' });
  const toggle = el('input', { type: 'checkbox', role: 'switch', 'aria-label': `Lock ${r.name}` });
  const sw = el('label', { class: 'switch', title: 'Keep this value locked' }, toggle, el('span', { class: 'track' }));
  const row = el('div', { class: 'mod-row', style: indent },
    el('div', { class: 'mod-name' },
      el('span', { class: 'label', text: r.name }),
      el('span', { class: 'sub', text: TYPE_LABEL[r.valueType] || r.valueType })),
    current, input, setBtn, sw);

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitTarget(r.id, input.value); input.blur(); }
    if (e.key === 'Escape') { input.value = fmt(row._target, r.valueType).replace('—', ''); input.blur(); }
  });
  input.addEventListener('change', () => commitTarget(r.id, input.value));
  setBtn.addEventListener('click', async () => {
    if (input.value.trim() === '') { toast('Type a value first, then press Set.'); input.focus(); return; }
    await call(keystone.applyValue(r.id, input.value.trim()));
  });
  toggle.addEventListener('change', async () => {
    // Typed-but-uncommitted value counts: lock what the box shows.
    if (input.value.trim() !== '' && Number(input.value) !== row._target) {
      const ok = await call(keystone.setTarget(r.id, input.value.trim()));
      if (ok === undefined) { toggle.checked = !toggle.checked; return; }
    }
    const ok = await call(keystone.setEnabled(r.id, toggle.checked));
    if (ok === undefined) toggle.checked = !toggle.checked;
  });

  rowEls.set(r.id, { row, current, input, toggle });
  patchRow(r);
  return row;
}

async function commitTarget(id, raw) {
  const value = raw.trim();
  await call(keystone.setTarget(id, value === '' ? null : value));
}

function patchRow(r) {
  const els = rowEls.get(r.id);
  if (!els) return;
  els.row._target = r.target;
  els.row.classList.toggle('locked', r.enabled);
  els.toggle.checked = r.enabled;
  if (document.activeElement !== els.input) {
    els.input.value = r.target === null ? '' : fmt(r.target, r.valueType);
  }
  patchValue(r.id, r);
}

function patchValue(id, v) {
  const els = rowEls.get(id);
  if (!els) return;
  const rec = state.snapshot.records.find((r) => r.id === id);
  const waiting = v.status !== 'ok';
  els.current.textContent = waiting ? 'waiting' : fmt(v.current, rec?.valueType);
  els.current.classList.toggle('waiting', waiting);
  els.current.title = waiting && v.error ? `Can't read this right now: ${v.error}` : '';
}

// ---------- phone remote ----------
function renderRemote() {
  const r = state.remote;
  if (!r) return;
  $('remoteEnabled').checked = r.enabled && r.running;
  $('qrCard').classList.toggle('on', Boolean(r.qr));
  $('qrImg').hidden = !r.qr;
  if (r.qr) $('qrImg').src = r.qr;
  $('qrOff').hidden = Boolean(r.qr);
  $('qrOff').textContent = r.running && !r.host
    ? 'This PC isn\u2019t on a network your phone can reach. Connect it to your Wi-Fi or router.'
    : 'Turn on phone control to show the pairing code.';
  $('remoteError').hidden = !r.error;
  $('remoteError').textContent = r.error || '';
  $('remoteClients').textContent = r.running
    ? (r.clients ? `${r.clients} phone${r.clients === 1 ? '' : 's'} connected` : 'No phones connected yet')
    : '';
  $('phoneBadge').hidden = !r.clients;
  $('phoneBadge').textContent = String(r.clients || '');

  const sel = $('remoteHost');
  sel.replaceChildren(...(r.addresses.length ? r.addresses : [{ address: '', adapter: 'No network found' }]).map((a) =>
    el('option', { value: a.address, text: a.address ? `${a.address}  (${a.adapter}${a.virtual ? ', virtual' : ''})` : a.adapter })));
  sel.value = r.host || '';
  if (document.activeElement !== $('remotePort')) $('remotePort').value = String(r.port);
}

async function loadRemote() {
  const r = await call(keystone.remoteStatus());
  if (r) { state.remote = r; renderRemote(); }
}

function wireRemote() {
  $('remoteEnabled').addEventListener('change', async (e) => {
    const r = await call(keystone.setRemoteEnabled(e.target.checked));
    if (r) { state.remote = r; renderRemote(); } else loadRemote();
  });
  $('remoteHost').addEventListener('change', async (e) => {
    const r = await call(keystone.setRemoteHost(e.target.value));
    if (r) { state.remote = r; renderRemote(); }
  });
  $('remotePortSave').addEventListener('click', async () => {
    const r = await call(keystone.setRemotePort($('remotePort').value.trim()));
    if (r) { state.remote = r; renderRemote(); toast(`Phone control now uses port ${r.port}. Phones need to scan the new code.`); }
  });
  $('remoteReset').addEventListener('click', async () => {
    if (!(await confirmBox('Reset pairing? Every connected phone is disconnected and has to scan the new code.', 'Reset pairing'))) return;
    const r = await call(keystone.resetPairing());
    if (r) { state.remote = r; renderRemote(); toast('Pairing reset. Scan the new code on your phone.'); }
  });
  keystone.onRemoteStatus((r) => { state.remote = r; renderRemote(); });
}

// ---------- overlay tab ----------
function renderOverlayStatus() {
  const s = state.ovStatus;
  if (!s) return;
  $('ovEnabled').checked = s.enabled;
  $('ovOnlyGame').checked = s.onlyOverGame;
  $('ovEditBtn').disabled = !s.enabled || !state.snapshot.attached;
  $('ovEditBtn').textContent = s.editing ? 'Finish editing' : 'Edit layout';
  const sel = $('ovDisplay');
  sel.replaceChildren(...s.displays.map((d) => el('option', { value: String(d.id), text: d.label })));
  sel.value = String(s.display);
  sel.disabled = s.displays.length < 2;
  $('ovHotkeyErrors').hidden = !s.hotkeyErrors.length;
  $('ovHotkeyErrors').textContent = s.hotkeyErrors.length ? `Some hotkeys didn't register: ${s.hotkeyErrors.join('; ')}.` : '';
}

function valueRecords() {
  return state.snapshot.records.filter((r) => r.kind === 'value');
}

function recordLabel(r) {
  return r.groupPath.length ? `${r.groupPath.join(' / ')} / ${r.name}` : r.name;
}

function renderOverlayData() {
  const d = state.ovData;
  const attached = Boolean(d.attached);
  $('ovDetached').hidden = attached;
  $('ovGame').hidden = !attached;
  if (!attached) return;
  const recs = valueRecords();

  for (const sel of document.querySelectorAll('select.role')) {
    const role = sel.dataset.role;
    const optional = role === 'z' || role === 'facing';
    sel.replaceChildren(
      el('option', { value: '', text: optional ? 'Not used' : 'Choose a mod' }),
      ...recs.map((r) => el('option', { value: r.id, text: recordLabel(r) })),
    );
    sel.value = d.roles?.[role] || '';
  }

  // Map tools
  $('mapReset').hidden = !(d.map && d.map.custom && d.pack);
  $('mapCalibrate').disabled = !d.map;
  $('mapNote').textContent = !d.map ? '' : d.map.bounds ? (d.map.custom ? 'Your map, lined up.' : `From the ${d.pack} pack.`) : 'This map isn\u2019t lined up yet.';
  for (const input of document.querySelectorAll('[data-edge]')) {
    if (document.activeElement !== input) input.value = d.map?.bounds ? String(Math.round(d.map.bounds[input.dataset.edge] * 100) / 100) : '';
  }
  loadPreviewMap();

  // Waypoints. Skip the rebuild while a waypoint field has focus, or the
  // 4×/s updates would wipe out what's being typed.
  const list = $('wpList');
  if (list.contains(document.activeElement)) { paintOverlayLive(); return; }
  list.replaceChildren();
  if (!d.waypoints.length) list.append(el('p', { class: 'wp-empty', text: 'No waypoints yet. Add one here, press Ctrl+Shift+W in game, or click the map in edit mode.' }));
  for (const w of d.waypoints) {
    const name = el('input', { class: 'field', value: w.name, 'aria-label': 'Waypoint name', maxlength: '40' });
    const x = el('input', { class: 'field num', value: String(Math.round(w.x)), 'aria-label': 'X', inputmode: 'decimal' });
    const y = el('input', { class: 'field num', value: String(Math.round(w.y)), 'aria-label': 'Y', inputmode: 'decimal' });
    const isTracked = d.tracked === w.id;
    const track = el('button', { class: `btn small${isTracked ? ' tracking' : ''}`, text: isTracked ? 'Tracking' : 'Track', title: 'Show distance and direction on the minimap' });
    const del = el('button', { class: 'btn small ghost', text: 'Delete' });
    const save = (patch) => call(keystone.updateWaypoint(w.id, patch));
    name.addEventListener('change', () => save({ name: name.value }));
    x.addEventListener('change', () => save({ x: x.value }));
    y.addEventListener('change', () => save({ y: y.value }));
    track.addEventListener('click', () => call(keystone.setTracked(isTracked ? null : w.id)));
    del.addEventListener('click', () => call(keystone.removeWaypoint(w.id)));
    list.append(el('div', { class: 'wp-row' }, name, x, y, track, del));
  }

  // Panels, zoom
  for (const cb of document.querySelectorAll('.panel-toggles input')) cb.checked = Boolean(d.panels[cb.dataset.panel]?.visible);
  $('ovSize').value = d.panels.minimap?.size || 'm';
  $('ovZoom').value = String(d.zoom);
  $('ovZoomVal').textContent = `${d.zoom}×`;

  // Readouts
  const picks = $('readoutPicks');
  const chosen = new Set(d.readouts.map((r) => r.id));
  picks.replaceChildren(...(recs.length ? recs.map((r) => {
    const cb = el('input', { type: 'checkbox', value: r.id });
    cb.checked = chosen.has(r.id);
    cb.addEventListener('change', () => {
      const ids = [...picks.querySelectorAll('input:checked')].map((i) => i.value);
      call(keystone.setReadouts(ids));
    });
    return el('label', { class: 'check' }, cb, el('span', { text: recordLabel(r) }));
  }) : [el('p', { class: 'block-note', text: 'Load a cheat table to pick stats.' })]));

  if (document.activeElement !== $('ovNotes')) $('ovNotes').value = d.notes || '';
  paintOverlayLive();
}

function paintOverlayLive() {
  const p = state.ovLive.pos;
  const out = $('ovPos');
  out.classList.toggle('none', !p);
  out.textContent = p
    ? `You're at ${Math.round(p.x)}, ${Math.round(p.y)}${p.z !== null ? `, height ${Math.round(p.z)}` : ''}${p.facing !== null ? `, facing ${Math.round(p.facing)}°` : ''}`
    : state.ovData.roles?.x && state.ovData.roles?.y ? 'Waiting for the game to report a position.' : 'Choose the X and Y mods to see your position.';
  drawPreview();
}

function loadPreviewMap() {
  const url = state.ovData.map?.url || null;
  if (url === state.mapUrl) { drawPreview(); return; }
  state.mapUrl = url;
  state.mapImg = null;
  $('mapEmpty').hidden = Boolean(url);
  if (!url) { drawPreview(); return; }
  const img = new Image();
  img.onload = () => {
    if (state.mapUrl !== url) return;
    state.mapImg = img;
    const c = $('mapPreview');
    c.width = 760;
    c.height = Math.round(Math.min(520, (760 * img.naturalHeight) / img.naturalWidth));
    drawPreview();
  };
  img.onerror = () => toast('Couldn\u2019t load the map image.', 'error');
  img.src = url;
}

// Image fitted inside the preview canvas (contain).
function previewFit() {
  const c = $('mapPreview');
  const img = state.mapImg;
  const scale = Math.min(c.width / img.naturalWidth, c.height / img.naturalHeight);
  return { scale, ox: (c.width - img.naturalWidth * scale) / 2, oy: (c.height - img.naturalHeight * scale) / 2 };
}

function drawPreview() {
  const c = $('mapPreview');
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  const img = state.mapImg;
  if (!img) return;
  const f = previewFit();
  ctx.drawImage(img, f.ox, f.oy, img.naturalWidth * f.scale, img.naturalHeight * f.scale);
  const b = state.ovData.map?.bounds;
  const toCanvas = (x, y) => {
    const p = MapMath.worldToImage(b, img.naturalWidth, img.naturalHeight, x, y);
    return { x: f.ox + p.x * f.scale, y: f.oy + p.y * f.scale };
  };
  if (b) {
    for (const w of state.ovData.waypoints || []) {
      const p = toCanvas(w.x, w.y);
      ctx.beginPath();
      ctx.arc(p.x, p.y, w.id === state.ovData.tracked ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = w.id === state.ovData.tracked ? '#d4af74' : '#ffffff';
      ctx.fill();
      ctx.font = '500 12px Geist, sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = 'rgba(0,0,0,.8)';
      ctx.shadowBlur = 3;
      ctx.fillText(w.name, p.x + 7, p.y + 4);
      ctx.shadowBlur = 0;
    }
    const pos = state.ovLive.pos;
    if (pos) {
      const p = toCanvas(pos.x, pos.y);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = '#c48aff';
      ctx.shadowColor = 'rgba(196,138,255,.8)';
      ctx.shadowBlur = 10;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#0e1115';
      ctx.stroke();
    }
  }
  if (state.calib?.a) {
    const p = { x: f.ox + state.calib.a.px.x * f.scale, y: f.oy + state.calib.a.px.y * f.scale };
    ctx.strokeStyle = '#c48aff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(p.x - 8, p.y); ctx.lineTo(p.x + 8, p.y); ctx.moveTo(p.x, p.y - 8); ctx.lineTo(p.x, p.y + 8);
    ctx.stroke();
  }
}

function setCalib(next) {
  state.calib = next;
  const banner = $('calibBanner');
  $('mapPreviewWrap').classList.toggle('calibrating', Boolean(next));
  $('mapCalibrate').textContent = next ? 'Cancel lining up' : 'Line up the map';
  banner.hidden = !next;
  if (next) {
    banner.textContent = next.a
      ? 'Step 2 of 2: Move to a second spot far from the first (across and up or down the map), then click where you are now.'
      : 'Step 1 of 2: In game, stand somewhere you can find on this map, then click that exact spot here.';
  }
  drawPreview();
}

function wireOverlay() {
  $('ovEnabled').addEventListener('change', (e) => call(keystone.setOverlayEnabled(e.target.checked)));
  $('ovOnlyGame').addEventListener('change', (e) => call(keystone.setOverlayOnlyOverGame(e.target.checked)));
  $('ovDisplay').addEventListener('change', (e) => call(keystone.setOverlayDisplay(e.target.value)));
  $('ovEditBtn').addEventListener('click', () => call(keystone.setOverlayEditing(!state.ovStatus?.editing)));

  for (const sel of document.querySelectorAll('select.role')) {
    sel.addEventListener('change', () => call(keystone.setRole(sel.dataset.role, sel.value || null)));
  }

  $('mapChoose').addEventListener('click', async () => {
    const m = await call(keystone.chooseMap());
    if (m) { toast('Map added. Now line it up so your position lands in the right place.'); setCalib({}); }
  });
  $('mapReset').addEventListener('click', () => call(keystone.resetMap()));
  $('mapCalibrate').addEventListener('click', () => setCalib(state.calib ? null : {}));
  $('mapPreview').addEventListener('click', async (e) => {
    if (!state.calib || !state.mapImg) return;
    const pos = state.ovLive.pos;
    if (!pos) { toast('Keystone needs your position first. Choose the X and Y mods above.', 'error'); return; }
    const c = $('mapPreview');
    const rect = c.getBoundingClientRect();
    const cx = ((e.clientX - rect.left) / rect.width) * c.width;
    const cy = ((e.clientY - rect.top) / rect.height) * c.height;
    const f = previewFit();
    const point = { world: { x: pos.x, y: pos.y }, px: { x: (cx - f.ox) / f.scale, y: (cy - f.oy) / f.scale } };
    if (!state.calib.a) { setCalib({ a: point }); return; }
    const res = await call(keystone.calibrateMap(state.calib.a, point, state.mapImg.naturalWidth, state.mapImg.naturalHeight));
    if (res) { setCalib(null); toast('Map lined up.'); } else setCalib({});
  });
  $('edgesSave').addEventListener('click', () => {
    const b = {};
    for (const input of document.querySelectorAll('[data-edge]')) b[input.dataset.edge] = input.value.trim();
    call(keystone.setMapBounds(b)).then((r) => r && toast('Map edges saved.'));
  });

  $('wpAdd').addEventListener('click', async () => {
    const wp = await call(keystone.addWaypoint({}));
    if (wp) toast(`Added ${wp.name}.`);
  });
  for (const cb of document.querySelectorAll('.panel-toggles input')) {
    cb.addEventListener('change', () => call(keystone.setPanel(cb.dataset.panel, { visible: cb.checked })));
  }
  $('ovSize').addEventListener('change', (e) => call(keystone.setPanel('minimap', { size: e.target.value })));
  $('ovZoom').addEventListener('input', (e) => { $('ovZoomVal').textContent = `${e.target.value}×`; });
  $('ovZoom').addEventListener('change', (e) => call(keystone.setZoom(Number(e.target.value))));
  let notesTimer;
  $('ovNotes').addEventListener('input', (e) => {
    clearTimeout(notesTimer);
    notesTimer = setTimeout(() => call(keystone.setNotes(e.target.value)), 600);
  });

  keystone.onOverlayStatus((s) => { state.ovStatus = s; renderOverlayStatus(); });
  keystone.onOverlayData((d) => { state.ovData = d; if (state.view === 'overlay') renderOverlayData(); });
  keystone.onOverlayLive((v) => { state.ovLive = v; if (state.view === 'overlay') paintOverlayLive(); });
}

async function loadOverlay() {
  const [s, d, v] = await Promise.all([call(keystone.overlayStatus()), call(keystone.overlayData()), call(keystone.overlayLive())]);
  if (s) state.ovStatus = s;
  if (d) state.ovData = d;
  if (v) state.ovLive = v;
  renderOverlayStatus();
  renderOverlayData();
}

// ---------- commands ----------
const SEG_LABEL = { creatures: 'Creatures', items: 'Items', quick: 'Quick commands', raw: 'Type a command' };

function cmdSegments(info) {
  const segs = info.catalogs.filter((c) => info.actions.some((a) => a.catalog === c));
  if (info.quick.length) segs.push('quick');
  segs.push('raw');
  return segs;
}

async function loadCommands() {
  const info = await call(keystone.commandsInfo());
  if (info) { state.cmd.info = info; renderCommands(); }
}

function renderCommands() {
  const info = state.cmd.info;
  const c = state.cmd;
  $('cmdUnavailable').hidden = Boolean(info?.available);
  $('cmdBody').hidden = !info?.available;
  $('cmdLogin').hidden = true;
  if (!info?.available) {
    $('cmdUnavailable').textContent = info?.reason || 'Choose a game first.';
    return;
  }
  const snap = state.snapshot;
  const running = snap.attached && !snap.game.offline;
  $('cmdSub').textContent = `${info.pack}. Pick what you want, set the details, and Keystone runs the admin command for you.`;
  const st = info.settings;
  $('cmdLogin').hidden = !st.canEnable || !running;

  const chipGame = $('chipGame');
  chipGame.className = `chip ${running ? 'ok' : 'warn'}`;
  chipGame.textContent = running ? 'Game running: console commands ready' : 'Game not running: console commands unavailable';
  const chipRcon = $('chipRcon');
  chipRcon.hidden = !st.rconSupported;
  const rconReady = st.rcon.host && st.rcon.port && st.rcon.hasPassword;
  chipRcon.className = `chip ${rconReady ? 'ok' : 'warn'}`;
  chipRcon.textContent = rconReady ? `RCON: ${st.rcon.host}:${st.rcon.port}` : 'RCON not set up';

  renderCmdSettings(st);

  const segs = cmdSegments(info);
  if (!segs.includes(c.seg)) c.seg = segs[0];
  $('cmdSegments').replaceChildren(...segs.map((sg) => {
    const b = el('button', { text: SEG_LABEL[sg] || sg, 'aria-pressed': String(sg === c.seg) });
    b.addEventListener('click', () => { c.seg = sg; renderCommands(); });
    return b;
  }));
  const isCatalog = info.catalogs.includes(c.seg);
  $('catalogView').hidden = !isCatalog;
  $('quickView').hidden = c.seg !== 'quick';
  $('rawView').hidden = c.seg !== 'raw';
  if (isCatalog) renderCatalog();
  if (c.seg === 'quick') renderQuick();
  $('rawVia').hidden = !st.rconSupported;
  renderHistory(info.history);
  $('cmdCredits').textContent = info.credits || '';
}

function renderCmdSettings(st) {
  if (!document.activeElement || !$('cmdSettings').contains(document.activeElement)) {
    $('setKey').value = st.consoleKey;
    $('setPrefix').replaceChildren(...st.prefixes.map((p) => el('option', { value: p, text: p ? `${p} (e.g. ${p} God)` : 'None' })));
    $('setPrefix').value = st.prefix;
    $('setMode').value = st.mode;
    $('setAdminPw').placeholder = st.hasAdminPassword ? 'Saved. Type to replace it' : 'Server admin password';
    $('rconHost').value = st.rcon.host;
    $('rconPort').value = st.rcon.port;
    $('rconPw').placeholder = st.rcon.hasPassword ? 'Saved. Leave empty to keep it' : 'Server admin password';
  }
  $('adminField').hidden = !st.canEnable;
  $('rconSettings').hidden = !st.rconSupported;
}

async function ensureCatalog(name) {
  if (state.cmd.catalogs[name]) return state.cmd.catalogs[name];
  const list = await call(keystone.commandsCatalog(name));
  state.cmd.catalogs[name] = list || [];
  return state.cmd.catalogs[name];
}

let catalogToken = 0;
async function renderCatalog() {
  const c = state.cmd;
  const name = c.seg;
  const token = ++catalogToken;
  const list = await ensureCatalog(name);
  if (token !== catalogToken) return;

  // Filter dropdowns from the data itself.
  const cats = [...new Set(list.map((x) => x.category).filter(Boolean))].sort();
  const maps = [...new Set(list.map((x) => x.map).filter(Boolean))];
  const selCat = $('catCategory');
  if (selCat.dataset.for !== name) {
    selCat.dataset.for = name;
    c.filters = { q: '', category: '', map: '' };
    $('catSearch').value = '';
    $('catSearch').placeholder = name === 'creatures' ? 'Search creatures' : 'Search items';
    selCat.replaceChildren(el('option', { value: '', text: 'All categories' }), ...cats.map((x) => el('option', { value: x, text: x })));
    $('catMap').replaceChildren(el('option', { value: '', text: 'All maps' }), ...maps.map((x) => el('option', { value: x, text: x })));
    c.selected = null;
  }
  $('catMap').hidden = !maps.length;
  // Arrived from a Library page: pick that entry and its action.
  const pend = c.pendingSelect;
  if (pend && pend.catalog === name) {
    c.pendingSelect = null;
    c.selected = pend.id;
    c.values = {};
    if (pend.action) c.action[name] = pend.action;
    c.filters.q = pend.name;
    $('catSearch').value = pend.name;
  }

  const q = c.filters.q.trim().toLowerCase();
  const matches = list.filter((x) => (!c.filters.category || x.category === c.filters.category)
    && (!c.filters.map || x.map === c.filters.map)
    && (!q || x.name.toLowerCase().includes(q) || x.id.toLowerCase().includes(q)));
  // Exact and prefix matches first, so "rex" puts Rex above Alpha T-Rex.
  if (q) matches.sort((a, b) => rank(a.name, q) - rank(b.name, q) || a.name.localeCompare(b.name));
  const LIMIT = 240;
  $('catGrid').replaceChildren(...matches.slice(0, LIMIT).map((x) => {
    const card = el('button', { class: 'cat-card', 'aria-pressed': String(x.id === c.selected) },
      el('span', { class: 'cat-name', text: x.name }),
      el('span', { class: 'cat-meta', text: [x.category, x.map].filter(Boolean).join(', ') }));
    card.addEventListener('click', () => { c.selected = x.id; c.values = {}; renderCatalog(); });
    return card;
  }));
  $('catMore').textContent = !matches.length ? 'Nothing matches. Try a shorter search.'
    : matches.length > LIMIT ? `Showing ${LIMIT} of ${matches.length}. Search or filter to narrow it down.` : `${matches.length} shown.`;
  renderForm(list.find((x) => x.id === c.selected) || null);
}

function rank(name, q) {
  const n = name.toLowerCase();
  return n === q ? 0 : n.startsWith(q) ? 1 : 2;
}

function renderForm(entry) {
  const c = state.cmd;
  const info = c.info;
  $('formEmpty').hidden = Boolean(entry);
  $('formBody').hidden = !entry;
  if (!entry) return;
  const actions = info.actions.filter((a) => a.catalog === c.seg);
  if (!actions.some((a) => a.id === c.action[c.seg])) c.action[c.seg] = actions[0].id;
  const action = actions.find((a) => a.id === c.action[c.seg]);

  $('formName').textContent = entry.name;
  $('formMeta').textContent = [entry.category, entry.map].filter(Boolean).join(', ');
  $('actionPick').replaceChildren(...(actions.length > 1 ? actions.map((a) => {
    const b = el('button', { text: a.label, 'aria-pressed': String(a.id === action.id) });
    b.addEventListener('click', () => { c.action[c.seg] = a.id; renderForm(entry); });
    return b;
  }) : []));
  $('formHelp').textContent = action.help || '';
  $('formFields').replaceChildren(...action.fields.map((f) => fieldInput(f, c.values, () => schedulePreview(action, entry))));
  $('formSubmit').textContent = action.label;
  $('formSubmit').onclick = () => submitAction(action, entry);
  schedulePreview(action, entry);
}

// Builds a form control for a pack-defined field; values live in `bag`.
function fieldInput(f, bag, onChange) {
  if (bag[f.key] === undefined) bag[f.key] = f.default ?? (f.type === 'toggle' ? false : '');
  if (f.type === 'toggle') {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = Boolean(bag[f.key]);
    cb.addEventListener('change', () => { bag[f.key] = cb.checked; onChange(); });
    return el('label', { class: 'check' }, cb, el('span', { text: f.label }));
  }
  const input = el('input', { class: 'field', value: String(bag[f.key] ?? ''), inputmode: f.type === 'number' ? 'numeric' : 'text', autocomplete: 'off' });
  input.addEventListener('input', () => { bag[f.key] = input.value; onChange(); });
  // Levels get a slider too; typing 150 is fine, dragging is faster.
  if (f.type === 'number' && f.key === 'level') {
    const range = el('input', { type: 'range', min: String(f.min ?? 1), max: String(Math.min(f.max ?? 600, 600)), step: '1', value: String(bag[f.key]) });
    range.addEventListener('input', () => { input.value = range.value; bag[f.key] = range.value; onChange(); });
    input.addEventListener('input', () => { range.value = input.value; });
    return el('label', {}, el('span', { text: f.label }), el('span', { class: 'level-row' }, range, input));
  }
  return el('label', {}, el('span', { text: f.label }), input);
}

let previewTimer;
function schedulePreview(action, entry) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const res = await keystone.buildCommand('action', action.id, { entryId: entry.id, values: state.cmd.values });
    if (res.ok) {
      const n = res.data.lines.length;
      $('previewLine').textContent = res.data.lines[0] + (n > 1 ? `   (${n} times)` : '');
      const running = state.snapshot.attached && !state.snapshot.game.offline;
      const blocked = res.data.via === 'console' && !running;
      $('formError').hidden = !blocked;
      $('formError').classList.toggle('muted', blocked);
      $('formError').textContent = blocked ? 'Start the game to run this. It goes through the game console.' : '';
      $('formSubmit').disabled = blocked;
    } else {
      $('previewLine').textContent = '';
      $('formError').textContent = res.error;
      $('formError').classList.remove('muted');
      $('formError').hidden = false;
      $('formSubmit').disabled = true;
    }
  }, 120);
}

async function submitAction(action, entry) {
  if (action.confirm && !(await confirmBox(action.confirm, 'Run it'))) return;
  $('formSubmit').disabled = true;
  try {
    const res = await call(keystone.runCommand('action', action.id, { entryId: entry.id, values: state.cmd.values }));
    if (res) toast(res.output ? `Done. Server replied: ${res.output}` : `Sent: ${action.label}, ${entry.name}.`);
  } finally {
    $('formSubmit').disabled = false;
  }
}

function renderQuick() {
  const info = state.cmd.info;
  const running = state.snapshot.attached && !state.snapshot.game.offline;
  $('quickView').replaceChildren(...info.quick.map((q) => {
    const bag = state.cmd.quickValues?.[q.id] || {};
    state.cmd.quickValues = { ...(state.cmd.quickValues || {}), [q.id]: bag };
    const btn = el('button', { class: 'btn small primary', text: 'Run' });
    const usable = q.via === 'rcon' || running;
    btn.disabled = !usable;
    btn.title = usable ? '' : 'Start the game to use console commands';
    btn.addEventListener('click', async () => {
      if (q.confirm && !(await confirmBox(q.confirm, 'Run it'))) return;
      const res = await call(keystone.runCommand('quick', q.id, { values: bag }));
      if (res) toast(res.output ? `${q.label}: ${res.output}` : `Sent: ${q.label}.`);
    });
    return el('div', { class: 'quick-card' },
      el('h3', { text: q.label }),
      q.help ? el('p', { text: q.help }) : null,
      ...(q.fields || []).map((f) => fieldInput(f, bag, () => {})),
      el('div', { class: 'quick-foot' }, el('span', { class: `via ${q.via}`, text: q.via === 'rcon' ? 'RCON' : 'Game console' }), btn));
  }));
}

function renderHistory(list) {
  const ol = $('historyList');
  if (!list?.length) {
    ol.replaceChildren(el('li', { class: 'h-empty', text: 'Commands you run show up here.' }));
    return;
  }
  ol.replaceChildren(...list.slice(0, 15).map((h) => {
    const t = new Date(h.at);
    const again = h.lines.length === 1 && h.label !== 'Admin login'
      ? el('button', { class: 'btn small ghost', text: 'Run again' }) : null;
    again?.addEventListener('click', async () => {
      // Lines already carry the console prefix, so strip it for runRaw.
      const prefix = state.cmd.info.settings.prefix;
      const line = h.via === 'console' && prefix && h.lines[0].startsWith(`${prefix} `) ? h.lines[0].slice(prefix.length + 1) : h.lines[0];
      const res = await call(keystone.runRaw(line, h.via));
      if (res) toast(res.output ? `Server replied: ${res.output}` : 'Sent.');
    });
    return el('li', {},
      el('span', { class: 'h-time', text: t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }),
      el('div', { class: 'h-main' },
        el('span', { class: 'h-label', text: `${h.label}${h.lines.length > 1 ? ` (${h.lines.length} times)` : ''}` }),
        el('span', { class: 'h-line', text: `${h.via === 'rcon' ? 'RCON' : 'Console'}: ${h.lines[0]}` }),
        h.output ? el('span', { class: 'h-out', text: h.output }) : null,
        h.ok ? null : el('span', { class: 'h-err', text: h.error })),
      again);
  }));
}

function wireCommands() {
  $('cmdSettingsBtn').addEventListener('click', () => {
    const open = $('cmdSettings').hidden;
    $('cmdSettings').hidden = !open;
    $('cmdSettingsBtn').setAttribute('aria-expanded', String(open));
  });
  $('cmdLogin').addEventListener('click', async () => {
    if (await call(keystone.enableAdmin())) toast('Typed the admin login into the game console.');
  });
  $('setKey').addEventListener('change', (e) => call(keystone.setCommandSettings({ consoleKey: e.target.value })));
  $('setPrefix').addEventListener('change', (e) => call(keystone.setCommandSettings({ prefix: e.target.value })));
  $('setMode').addEventListener('change', (e) => call(keystone.setCommandSettings({ mode: e.target.value })));
  $('saveAdminPw').addEventListener('click', async () => {
    const v = $('setAdminPw').value;
    if (!v) { toast('Type the password first.'); return; }
    if (await call(keystone.setCommandSettings({ adminPassword: v }))) { $('setAdminPw').value = ''; toast('Admin password saved.'); }
  });
  $('rconSave').addEventListener('click', async () => {
    const res = await call(keystone.setRcon({ host: $('rconHost').value, port: $('rconPort').value, password: $('rconPw').value }));
    if (res) { $('rconPw').value = ''; toast('RCON settings saved.'); }
  });
  $('rconTest').addEventListener('click', async () => {
    const out = $('rconOut');
    out.hidden = false;
    out.textContent = 'Connecting…';
    const res = await keystone.testRcon();
    out.textContent = res.ok ? `Connected. Players online:\n${res.data.output}` : res.error;
  });
  $('catSearch').addEventListener('input', (e) => { state.cmd.filters.q = e.target.value; renderCatalog(); });
  $('catCategory').addEventListener('change', (e) => { state.cmd.filters.category = e.target.value; renderCatalog(); });
  $('catMap').addEventListener('change', (e) => { state.cmd.filters.map = e.target.value; renderCatalog(); });
  $('copyPreview').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('previewLine').textContent.replace(/\s+\(\d+ times\)$/, '')); toast('Command copied.'); } catch { toast('Couldn’t copy.', 'error'); }
  });
  const sendRaw = async () => {
    const text = $('rawInput').value;
    const res = await call(keystone.runRaw(text, $('rawVia').hidden ? 'console' : $('rawVia').value));
    if (res) { $('rawInput').value = ''; toast(res.output ? `Server replied: ${res.output}` : 'Sent.'); }
  };
  $('rawSend').addEventListener('click', sendRaw);
  $('rawInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendRaw(); });
  $('historyClear').addEventListener('click', () => call(keystone.clearCommandHistory()));
  keystone.onCommandsInfo((info) => {
    const packChanged = info.pack !== state.cmd.info?.pack;
    state.cmd.info = info;
    if (packChanged) { state.cmd.catalogs = {}; state.cmd.selected = null; $('catCategory').dataset.for = ''; }
    if (state.view === 'commands') {
      // History/settings updates shouldn't rebuild the catalog grid.
      if (packChanged) renderCommands();
      else { renderHistory(info.history); renderCmdSettings(info.settings); }
    }
  });
}

// ---------- library ----------
async function loadLibrary() {
  const info = await call(keystone.libraryInfo());
  if (!info) return;
  const changed = info.game !== state.lib.info?.game;
  state.lib.info = info;
  if (changed) { state.lib.page = { kind: 'home' }; state.lib.entries = {}; }
  renderLibrary();
}

function libGo(page) {
  state.lib.page = page;
  renderLibrary();
  $('libMain').scrollTop = 0;
}

function renderLibrary() {
  const info = state.lib.info;
  $('libUnavailable').hidden = Boolean(info?.available);
  $('libShell').hidden = !info?.available;
  if (!info?.available) { $('libUnavailable').textContent = info?.reason || 'Choose a game first.'; return; }
  const page = state.lib.page;
  $('libGame').textContent = info.game;

  const nav = $('libNav');
  const navBtn = (label, target, count) => {
    const current = page.kind === target.kind && (page.catalog || '') === (target.catalog || '');
    const b = el('button', { 'aria-current': String(current) }, el('span', { text: label }), count !== undefined ? el('span', { class: 'n', text: String(count) }) : null);
    b.addEventListener('click', () => libGo(target));
    return b;
  };
  nav.replaceChildren(
    navBtn('Overview', { kind: 'home' }),
    info.sections.length ? el('h3', { text: 'Browse' }) : null,
    ...info.sections.map((sct) => navBtn(sct.label, { kind: 'section', catalog: sct.catalog, label: sct.label }, state.lib.entries[sct.catalog]?.length)),
    el('h3', { text: 'Guides' }),
    navBtn('All guides', { kind: 'guides' }, info.guides.length),
  );

  $('libLinks').replaceChildren(...info.links.map((l) => {
    const a = el('a', { href: '#', text: l.label });
    a.addEventListener('click', (e) => { e.preventDefault(); call(keystone.openBrowser(l.url)); });
    return a;
  }));
  $('libLinksWrap').querySelector('h3').hidden = !info.links.length;

  const main = $('libMain');
  if (page.kind === 'home') renderLibHome(main, info);
  else if (page.kind === 'guides') renderLibGuides(main, info);
  else if (page.kind === 'section') renderLibSection(main, page);
  else if (page.kind === 'entry') renderLibEntry(main, page);
  else if (page.kind === 'guide') renderLibGuide(main, page);
  else if (page.kind === 'search') renderLibSearch(main, page);
}

function guideCard(g) {
  const card = el('button', { class: 'guide-card' },
    el('span', { class: 'g-title', text: g.title }),
    g.summary ? el('span', { class: 'g-sum', text: g.summary }) : null,
    el('span', { class: 'g-src', text: g.source === 'mine' ? 'Your guide' : 'Guide' }));
  card.addEventListener('click', () => libGo({ kind: 'guide', id: g.id }));
  return card;
}

function renderLibHome(main, info) {
  const kids = [el('h1', { text: info.game }), el('p', { class: 'lib-sub', text: 'Guides, creature and item pages, and your own notes. Search covers everything.' })];
  if (info.sections.length) {
    kids.push(el('div', { class: 'lib-section-head' }, el('h2', { text: 'Browse' })));
    kids.push(el('div', { class: 'guide-cards' }, ...info.sections.map((sct) => {
      const card = el('button', { class: 'guide-card' }, el('span', { class: 'g-title', text: sct.label }), el('span', { class: 'g-sum', text: `Every ${sct.label.toLowerCase().replace(/s$/, '')} with its IDs, details and your notes.` }));
      card.addEventListener('click', () => libGo({ kind: 'section', catalog: sct.catalog, label: sct.label }));
      return card;
    })));
  }
  kids.push(el('div', { class: 'lib-section-head' }, el('h2', { text: 'Guides' })));
  kids.push(info.guides.length ? el('div', { class: 'guide-cards' }, ...info.guides.map(guideCard))
    : el('p', { class: 'lib-sub', text: 'No guides for this game yet. Add your own as Markdown files.' }));
  main.replaceChildren(...kids);
}

function renderLibGuides(main, info) {
  const folderBtn = el('button', { class: 'btn small', text: 'Open my guides folder' });
  folderBtn.addEventListener('click', () => call(keystone.openGuidesFolder()));
  main.replaceChildren(
    el('h1', { text: 'Guides' }),
    el('p', { class: 'lib-sub', text: 'Write your own as Markdown (.md) files in your guides folder; they show up here next to the pack’s guides.' }),
    folderBtn,
    el('div', { class: 'guide-cards', style: { marginTop: '18px' } }, ...info.guides.map(guideCard)),
  );
}

async function renderLibSection(main, page) {
  let list = state.lib.entries[page.catalog];
  if (!list) {
    main.replaceChildren(el('p', { class: 'lib-sub', text: 'Loading…' }));
    list = await call(keystone.libraryEntries(page.catalog));
    if (!list) return;
    state.lib.entries[page.catalog] = list;
    if (state.lib.page !== page) return;
    renderLibrary();
    return;
  }
  const f = state.lib.filters[page.catalog] || (state.lib.filters[page.catalog] = { q: '', category: '', map: '' });
  const cats = [...new Set(list.map((x) => x.category).filter(Boolean))].sort();
  const maps = [...new Set(list.map((x) => x.map).filter(Boolean))];
  const search = el('input', { class: 'field', type: 'search', placeholder: `Filter ${page.label.toLowerCase()}`, value: f.q, autocomplete: 'off' });
  const catSel = el('select', { class: 'field' }, el('option', { value: '', text: 'All categories' }), ...cats.map((c) => el('option', { value: c, text: c })));
  catSel.value = f.category;
  const mapSel = el('select', { class: 'field' }, el('option', { value: '', text: 'All maps' }), ...maps.map((m) => el('option', { value: m, text: m })));
  mapSel.value = f.map;
  mapSel.hidden = !maps.length;
  const grid = el('div', { class: 'catalog-grid' });
  const more = el('p', { class: 'catalog-more' });
  const paint = () => {
    const q = f.q.trim().toLowerCase();
    const m = list.filter((x) => (!f.category || x.category === f.category) && (!f.map || x.map === f.map) && (!q || x.name.toLowerCase().includes(q)));
    if (q) m.sort((a, b) => rank(a.name, q) - rank(b.name, q) || a.name.localeCompare(b.name));
    const LIMIT = 300;
    grid.replaceChildren(...m.slice(0, LIMIT).map((x) => {
      const card = el('button', { class: 'cat-card' }, el('span', { class: 'cat-name', text: x.name }), el('span', { class: 'cat-meta', text: [x.category, x.map].filter(Boolean).join(', ') }));
      card.addEventListener('click', () => libGo({ kind: 'entry', catalog: page.catalog, id: x.id, back: page }));
      return card;
    }));
    more.textContent = !m.length ? 'Nothing matches.' : m.length > LIMIT ? `Showing ${LIMIT} of ${m.length}. Filter to narrow it down.` : `${m.length} shown.`;
  };
  search.addEventListener('input', () => { f.q = search.value; paint(); });
  catSel.addEventListener('change', () => { f.category = catSel.value; paint(); });
  mapSel.addEventListener('change', () => { f.map = mapSel.value; paint(); });
  main.replaceChildren(el('h1', { text: page.label }), el('div', { class: 'catalog-filters' }, search, catSel, mapSel), grid, more);
  paint();
}

async function renderLibEntry(main, page) {
  const e = await call(keystone.libraryEntry(page.catalog, page.id));
  if (!e || state.lib.page !== page) return;
  const back = el('button', { class: 'btn small ghost lib-back', text: page.back ? `Back to ${page.back.label || 'results'}` : 'Back' });
  back.addEventListener('click', () => libGo(page.back || { kind: 'home' }));
  const copyBtn = (text) => {
    const b = el('button', { class: 'btn small ghost', text: 'Copy' });
    b.addEventListener('click', async () => { try { await navigator.clipboard.writeText(text); toast('Copied.'); } catch { toast('Couldn’t copy.', 'error'); } });
    return b;
  };
  const rows = [];
  const add = (label, node) => rows.push(el('dt', { text: label }), el('dd', {}, ...[].concat(node)));
  if (e.category) add('Category', el('span', { text: e.category }));
  if (e.map) add('Map', el('span', { text: e.map }));
  if (e.stack) add('Stack size', el('span', { text: String(e.stack) }));
  add(page.catalog === 'creatures' ? 'Creature ID' : 'Class name', [el('code', { text: e.id }), copyBtn(e.id)]);
  if (e.blueprint) add('Blueprint', [el('code', { text: e.blueprint }), copyBtn(e.blueprint)]);

  const actions = e.commandActions.map((a) => {
    const b = el('button', { class: 'btn primary', text: a.label });
    b.addEventListener('click', () => openInCommands(page.catalog, e, a.id));
    return b;
  });
  if (e.wikiUrl) {
    const w = el('button', { class: 'btn', text: `Open on ${state.lib.info.wiki?.label || 'the wiki'}` });
    w.addEventListener('click', () => call(keystone.openBrowser(e.wikiUrl)));
    actions.push(w);
  }
  const note = el('textarea', { class: 'field notes', rows: '4', maxlength: '4000', placeholder: 'Your notes: taming food, where you found it, stats you got' });
  note.value = e.note;
  let t;
  note.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => call(keystone.setLibraryNote(page.catalog, e.id, note.value)), 500); });

  main.replaceChildren(
    back,
    el('h1', { text: e.name }),
    el('dl', { class: 'entry-grid' }, ...rows),
    actions.length ? el('div', { class: 'entry-actions' }, ...actions) : null,
    el('section', { class: 'block' }, el('h2', { text: 'My notes' }), note),
  );
}

// Jumps to Commands with this entry picked and the chosen action selected.
function openInCommands(catalog, entry, actionId) {
  state.cmd.pendingSelect = { catalog, id: entry.id, name: entry.name, action: actionId };
  state.cmd.seg = catalog;
  document.querySelector('[data-view=commands]').click();
}

async function renderLibGuide(main, page) {
  const g = await call(keystone.libraryGuide(page.id));
  if (!g || state.lib.page !== page) return;
  const back = el('button', { class: 'btn small ghost lib-back', text: 'Back to guides' });
  back.addEventListener('click', () => libGo({ kind: 'guides' }));
  const body = el('article', { class: 'prose' });
  // Safe: the main process escapes raw HTML in guides and only emits
  // http(s) links (see library.js).
  body.innerHTML = g.html;
  for (const a of body.querySelectorAll('a[data-external]')) {
    a.addEventListener('click', (ev) => { ev.preventDefault(); call(keystone.openBrowser(a.getAttribute('href').replace(/^http:/i, 'https:'))); });
  }
  main.replaceChildren(back, body);
}

async function renderLibSearch(main, page) {
  const hits = await call(keystone.librarySearch(page.q));
  if (!hits || state.lib.page !== page) return;
  const list = el('div', { class: 'catalog-grid' }, ...hits.map((h) => {
    const card = el('button', { class: 'cat-card' }, el('span', { class: 'cat-name', text: h.title }), el('span', { class: 'cat-meta', text: h.kind === 'entry' ? `${h.section}${h.sub ? `, ${h.sub}` : ''}` : h.sub }));
    card.addEventListener('click', () => libGo(h.kind === 'entry' ? { kind: 'entry', catalog: h.catalog, id: h.id, back: page } : { kind: 'guide', id: h.id }));
    return card;
  }));
  page.label = `results for "${page.q}"`;
  main.replaceChildren(el('h1', { text: `Results for "${page.q}"` }), hits.length ? list : el('p', { class: 'lib-sub', text: 'Nothing found. Try fewer letters.' }));
}

function wireLibrary() {
  $('libSearch').addEventListener('input', (e) => {
    clearTimeout(state.lib.searchTimer);
    const q = e.target.value.trim();
    state.lib.searchTimer = setTimeout(() => libGo(q.length >= 2 ? { kind: 'search', q } : { kind: 'home' }), 200);
  });
  $('libBrowser').addEventListener('click', () => call(keystone.openBrowser(null)));
}

// ---------- app settings ----------
async function loadAppSettings() {
  const st = await call(keystone.appSettings());
  if (!st) return;
  $('setTray').checked = st.closeToTray;
  $('setLogin').checked = st.startWithWindows;
  $('setLogin').disabled = !st.canStartWithWindows;
  $('loginNote').textContent = st.canStartWithWindows
    ? 'It starts quietly in the tray.'
    : 'Available in the installed app. You\u2019re running Keystone from its source folder.';
  $('aboutLine').textContent = `Keystone ${st.version}. Settings folder: ${st.dataDir}`;
}

function wireAppSettings() {
  $('setTray').addEventListener('change', (e) => call(keystone.setCloseToTray(e.target.checked)));
  $('setLogin').addEventListener('change', async (e) => {
    const res = await call(keystone.setStartWithWindows(e.target.checked));
    if (!res) e.target.checked = !e.target.checked;
  });
  $('openData').addEventListener('click', () => call(keystone.openFolder('data')));
  $('openPacks').addEventListener('click', () => call(keystone.openFolder('packs')));
}

// ---------- wiring ----------
function wire() {
  wireAppSettings();
  wireLibrary();
  wireCommands();
  $('noModsCommands').addEventListener('click', () => document.querySelector('[data-view=commands]').click());
  wireOverlay();
  $('switcherBtn').addEventListener('click', (e) => { e.stopPropagation(); setSwitcher($('switcherPop').hidden); });
  $('pickGameBtn').addEventListener('click', (e) => { e.stopPropagation(); setSwitcher(true); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.switcher')) setSwitcher(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setSwitcher(false); });

  // Sidebar collapse is a per-machine preference, so browser storage is fine.
  const collapsed = (() => { try { return localStorage.getItem('keystone.navCollapsed') === '1'; } catch { return false; } })();
  $('app').classList.toggle('collapsed', collapsed);
  $('navCollapse').addEventListener('click', () => {
    const now = !$('app').classList.contains('collapsed');
    $('app').classList.toggle('collapsed', now);
    $('navCollapse').setAttribute('aria-label', now ? 'Expand sidebar' : 'Collapse sidebar');
    try { localStorage.setItem('keystone.navCollapsed', now ? '1' : '0'); } catch { /* not important */ }
  });
  wireProfiles();
  wireRemote();
  for (const t of document.querySelectorAll('.tab')) {
    t.addEventListener('click', () => {
      state.view = t.dataset.view;
      render();
      if (state.view === 'phone') loadRemote();
      if (state.view === 'overlay') loadOverlay();
      if (state.view === 'commands') loadCommands();
      if (state.view === 'settings') loadAppSettings();
      if (state.view === 'library') loadLibrary();
      if (state.view !== 'overlay' && state.calib) setCalib(null);
    });
  }
  $('refreshBtn').addEventListener('click', refreshProcesses);
  $('procSearch').addEventListener('input', (e) => { state.procFilter = e.target.value; renderProcesses(); });
  $('modSearch').addEventListener('input', (e) => { state.filter = e.target.value; renderMods(); });
  $('demoBtn').addEventListener('click', () => attach({ demo: true }));
  $('detachBtn').addEventListener('click', async () => {
    const snap = await call(keystone.detach());
    if (snap) { state.snapshot = snap; render(); }
  });
  const openTable = async () => {
    const res = await call(keystone.openTable());
    if (!res) return;
    state.snapshot = res.snapshot;
    render();
    const s = res.summary;
    const extra = [s.scripts && `${s.scripts} scripts`, s.unsupported && `${s.unsupported} unsupported`].filter(Boolean).join(', ');
    toast(`Loaded ${s.table}: ${s.values} mods${extra ? ` (${extra} listed but not runnable yet)` : ''}.`);
  };
  $('loadTableBtn').addEventListener('click', openTable);
  $('emptyLoadBtn').addEventListener('click', openTable);

  keystone.onStructure((snap) => {
    const before = `${state.snapshot.game?.key}|${state.snapshot.game?.offline}`;
    state.snapshot = snap;
    render();
    // A different game (or the game starting/stopping) changes what the
    // Commands screen can do, so refresh it then, not on every mod toggle.
    if (state.view === 'commands' && before !== `${snap.game?.key}|${snap.game?.offline}`) loadCommands();
    if (state.view === 'library' && before !== `${snap.game?.key}|${snap.game?.offline}`) loadLibrary();
  });
  keystone.onValues((vals) => {
    for (const [id, v] of Object.entries(vals)) {
      const rec = state.snapshot.records.find((r) => r.id === id);
      if (rec) Object.assign(rec, { current: v.current, status: v.status, error: v.error });
      patchValue(id, v);
    }
  });
  keystone.onDetached(({ name }) => toast(`${name} closed, so Keystone detached.`));

  // Keep the picker fresh while nothing is attached (games get launched after Keystone).
  setInterval(() => { if (!state.snapshot.attached && !document.hidden) refreshProcesses(); }, 5000);
}

(async function init() {
  wire();
  const p = await call(keystone.platform());
  if (p) state.platform = p.platform;
  const snap = await call(keystone.getSession());
  if (snap) state.snapshot = snap;
  render();
  refreshProcesses();
  loadRemote();
})();
