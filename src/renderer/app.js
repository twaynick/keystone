'use strict';

/* global keystone, MapMath, KeystoneTheme, Crosshair */

const $ = (id) => document.getElementById(id);

const state = {
  processes: [],
  snapshot: { attached: false, game: null, records: [] },
  collapsed: new Set(),
  filter: '',
  procFilter: '',
  platform: 'win32',
  view: 'home',
  gameTab: 'mods',
  modCat: null,
  gameSearch: '',
  homeFilter: 'all',
  launching: false,
  remote: null,
  ovStatus: null,
  ovData: { attached: false },
  ovLive: { pos: null, readouts: {} },
  calib: null,
  placing: false,   // next click on the map preview sets "I'm here"
  mapImg: null,
  mapUrl: null,
  games: [],
  lib: { info: null, page: { kind: 'home' }, entries: {}, filters: {}, searchTimer: null },
  cmd: { info: null, seg: null, catalogs: {}, filters: { q: '', category: '', map: '' }, selected: null, action: {}, values: {} },
  finder: { open: false, info: null, rowsKey: '', editing: null },
  store: { data: null, q: '', filter: 'all', checking: false },
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


// ---------- games library (home) ----------
const BOLT = '<path d="M13.2 2.5 5 13.2h5.6L9.8 21.5 19 10.3h-5.7z"/>';
const PIN = '<path d="M9 3h6l-1 6 3.5 3.5V15H13v6l-1 1-1-1v-6H6.5v-2.5L10 9z"/>';

function svgIcon(paths, cls) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  // Static markup from this file only, never from data.
  svg.innerHTML = paths;
  return svg;
}

async function refreshProcesses() {
  const [list, games] = await Promise.all([call(keystone.listProcesses()), call(keystone.listGames())]);
  if (list) state.processes = list;
  if (games) state.games = games;
  renderHome();
}

// Cover art loads through ksart://; when a game has none (or the PC is
// offline the first time), the tile shows its name instead.
function artImg(packId, kind, onFail) {
  const img = el('img', { alt: '', loading: 'lazy', src: `ksart://${kind}/${encodeURIComponent(packId)}` });
  img.addEventListener('error', () => { img.remove(); onFail?.(); });
  return img;
}

const STORES = { steam: 'Steam', epic: 'Epic', gog: 'GOG', xbox: 'Xbox' };

function renderHome() {
  const q = (state.gameSearch || '').trim().toLowerCase();
  const grid = $('gameGrid');
  const f = state.homeFilter;
  const games = state.games.filter((g) => (!q || g.name.toLowerCase().includes(q))
    && (f === 'all' || (f === 'installed' && g.installed) || (f === 'running' && g.running)));
  for (const b of $('homeFilter').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.filter === f));
  grid.replaceChildren(...games.map((g) => {
    const art = el('div', { class: 'tile-art' });
    const initials = el('span', { class: 'initials', text: g.name });
    initials.hidden = true;
    art.append(initials, artImg(g.id, 'cover', () => { initials.hidden = false; }));
    const flags = el('div', { class: 'tile-flags' });
    if (g.running) flags.append(el('span', { class: 'badge ok', text: 'Running' }));
    if (g.offlineOnly) flags.append(el('span', { class: 'badge warn', text: 'Offline only' }));
    if (g.noMods) flags.append(el('span', { class: 'badge', text: 'No mods' }));
    art.append(flags);
    const sub = g.demo ? 'Built in'
      : g.installed ? `Installed · ${STORES[g.installed.store] || g.installed.store}`
        : [g.noMods ? null : 'Mods', g.hasCommands ? 'Commands' : null, 'Library'].filter(Boolean).join(' · ');
    const tile = el('button', { class: 'game-tile', title: g.name }, art, el('span', { class: 'tile-name', text: g.name }), el('span', { class: 'tile-sub', text: sub }));
    tile.addEventListener('click', () => openGame({ packId: g.id }));
    return tile;
  }));
  if (!games.length) {
    const why = q ? `No games match "${state.gameSearch}".`
      : f === 'installed' ? (state.platform === 'win32' ? 'None of your Keystone games were found in Steam, Epic, GOG or the Xbox app.' : 'Finding installed games needs Windows.')
        : 'None of your Keystone games are running.';
    grid.replaceChildren(el('p', { class: 'pop-note', text: why }));
  }

  const ul = $('procList');
  const pq = state.procFilter.trim().toLowerCase();
  const packExes = new Set(state.games.map((g) => g.exe.toLowerCase()));
  const attachedName = state.snapshot.attached ? state.snapshot.game.name.toLowerCase() : null;
  const shown = state.processes.filter((p) => !packExes.has(p.name.toLowerCase()) && (!pq || p.name.toLowerCase().includes(pq)));
  ul.replaceChildren(...shown.map((p) => {
    const li = el('li', { class: `proc-item${attachedName === p.name.toLowerCase() ? ' active' : ''}`, tabindex: '0', title: `${p.name} (PID ${p.pid})` },
      el('span', { class: 'name', text: p.name.replace(/\.exe$/i, '') }),
      el('span', { class: 'tag', text: String(p.pid) }));
    const go = () => openGame({ pid: p.pid, name: p.name });
    li.addEventListener('click', go);
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    return li;
  }));
  const note = $('procNote');
  if (state.platform !== 'win32') note.textContent = 'Attaching to running programs needs Windows. The demo game works everywhere.';
  else if (!shown.length) note.textContent = pq ? `Nothing running matches "${state.procFilter}".` : 'Nothing else running.';
  else note.textContent = '';
}

// Opens a game's page. Picking the game you're already on just shows it.
async function openGame(target) {
  const cur = state.snapshot;
  const same = cur.attached && ((target.packId && cur.packId === target.packId) || (target.pid && cur.game.pid === target.pid));
  if (!same) {
    const res = await call(keystone.attach(target));
    if (!res) return;
    state.snapshot = res.snapshot;
    for (const n of res.notices) toast(n);
    state.gameTab = defaultTab(res.snapshot);
  }
  go('game');
}

function defaultTab(snap) {
  if (snap.identify && snap.modsBlocked) return 'library';
  if (snap.modsBlocked === 'online-only') return snap.hasCommands ? 'commands' : 'library';
  return 'mods';
}

function go(view) {
  state.view = view;
  render();
  if (view === 'home') refreshProcesses();
  if (view === 'phone') loadRemote();
  if (view === 'settings') loadAppSettings();
  if (view === 'tables') loadStore();
  if (view === 'game') loadTab();
}

function setTab(tab) {
  state.gameTab = tab;
  if (tab !== 'overlay' && state.calib) setCalib(null);
  if (tab !== 'overlay' && state.placing) setPlacing(false);
  render();
  loadTab();
}

function loadTab() {
  if (isPane('overlay')) loadOverlay();
  if (isPane('commands')) loadCommands();
  if (isPane('library')) loadLibrary();
}

const isPane = (tab) => state.view === 'game' && state.gameTab === tab;

// ---------- render ----------
function render() {
  const snap = state.snapshot;
  const attached = snap.attached;
  if (state.view === 'game' && !attached) state.view = 'home';

  for (const t of document.querySelectorAll('.nav .tab')) {
    if (t.dataset.view === state.view) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  }
  $('homeView').hidden = state.view !== 'home';
  $('gameView').hidden = state.view !== 'game';
  $('phoneView').hidden = state.view !== 'phone';
  $('settingsView').hidden = state.view !== 'settings';
  $('tablesView').hidden = state.view !== 'tables';

  // Sidebar entry for the open game.
  $('navGame').hidden = !attached;
  if (attached) {
    const name = snap.displayName || snap.game.name;
    $('navGameName').textContent = name;
    $('navDot').classList.toggle('on', !snap.game.offline);
    const key = snap.packId || '';
    if ($('navThumb').dataset.key !== key) {
      $('navThumb').dataset.key = key;
      $('navThumb').hidden = !key;
      if (key) $('navThumb').src = `ksart://cover/${encodeURIComponent(key)}`;
    }
    renderHero(snap);
  }

  for (const b of document.querySelectorAll('#gameTabs button')) {
    b.setAttribute('aria-pressed', String(b.dataset.tab === state.gameTab));
    // Mods tab disappears for games Keystone never mods.
    if (b.dataset.tab === 'mods') b.hidden = attached && snap.modsBlocked === 'online-only';
    // A pack without commands (Phasmophobia has no console) gets no Commands tab.
    if (b.dataset.tab === 'commands') b.hidden = attached && Boolean(snap.packId) && !snap.hasCommands;
  }
  $('modsPane').hidden = !isPane('mods');
  $('commandsView').hidden = !isPane('commands');
  $('libraryView').hidden = !isPane('library');
  $('overlayView').hidden = !isPane('overlay');

  if (attached && isPane('mods')) renderModsPane(snap);
  if (state.view === 'home') renderHome();
  if (state.view === 'tables') renderStore();
}

function renderHero(snap) {
  const key = snap.packId || `exe:${snap.game.name}`;
  if ($('hero').dataset.key !== key) {
    $('hero').dataset.key = key;
    const bg = $('heroImg');
    bg.hidden = !snap.packId;
    if (snap.packId) {
      bg.src = `ksart://hero/${encodeURIComponent(snap.packId)}`;
      // No hero art: fall back to the cover, blurred by the banner styling.
      bg.onerror = () => { bg.onerror = () => { bg.hidden = true; }; bg.src = `ksart://cover/${encodeURIComponent(snap.packId)}`; };
    }
    const cov = $('heroCover');
    cov.hidden = !snap.packId;
    if (snap.packId) { cov.src = `ksart://cover/${encodeURIComponent(snap.packId)}`; cov.onerror = () => { cov.hidden = true; }; }
  }
  $('gameTitle').textContent = snap.displayName || snap.game.name;

  const running = !snap.game.offline;
  const status = $('gameStatus');
  const bits = [];
  bits.push(el('span', { class: `badge ${running ? 'ok' : ''}`, text: running ? (snap.game.demo ? 'Running (demo)' : 'Running') : 'Not running' }));
  if (snap.offlineOnly) bits.push(el('span', { class: 'badge warn', text: 'Offline only' }));
  if (snap.modsBlocked === 'online-only') bits.push(el('span', { class: 'badge', text: 'Online game: no mods' }));
  if (snap.mods) bits.push(el('span', { class: 'badge accent', text: 'Mods connected' }));
  if (snap.game.tables?.length) bits.push(el('span', { text: snap.game.tables.join(', ') }));
  status.replaceChildren(...bits);

  const play = $('playBtn');
  play.classList.toggle('running', running);
  play.disabled = running || state.launching || (!snap.canLaunch);
  play.hidden = !running && !snap.canLaunch;
  $('playLabel').textContent = running ? 'Playing' : state.launching ? 'Starting…' : 'Play';
  play.title = running ? '' : `Start the game${snap.installed ? ` through ${STORES[snap.installed] || snap.installed}` : ''}; Keystone connects when it’s running`;
}

function renderModsPane(snap) {
  const hasMods = snap.mods && snap.records.length > 0;
  const banner = $('offlineBanner');
  banner.hidden = !snap.offlineOnly;
  if (snap.offlineOnly) {
    $('offlineText').textContent = snap.offlineNote || 'Mods only work in offline or solo play. Turn them off before you go online.';
    const on = snap.modsSwitch;
    for (const b of $('modsSwitch').querySelectorAll('button')) b.setAttribute('aria-pressed', String((b.dataset.v === 'on') === on));
  }
  renderPrivateRow(snap);
  // The value finder replaces the "no mods yet" message while it's open.
  const finderOpen = Boolean(snap.mods && state.finder.open);
  $('finderPanel').hidden = !finderOpen;
  $('emptyNoTable').hidden = !snap.mods || hasMods || finderOpen;
  $('emptyNoMods').hidden = snap.mods;
  if (!snap.mods) {
    const offline = snap.game.offline;
    $('noModsTitle').textContent = snap.modsBlocked === 'anticheat' ? `${snap.antiCheat} is running`
      : snap.modsBlocked === 'offline-off' ? 'Mods are off for this game'
        : offline ? 'Start the game to use mods' : 'Mods aren’t available right now';
    $('noModsText').textContent = snap.modsBlocked === 'anticheat'
      ? `Keystone doesn’t touch the game while ${snap.antiCheat} runs, even with mods switched on. Commands, the Library and the map still work.`
      : snap.modsBlocked === 'offline-off'
        ? (snap.privateServers ? 'Turn on "Use mods in this game" above when you’re playing offline or solo, or use mods for this session on your own server.' : 'Turn on "Use mods in this game" above when you’re playing offline or solo.')
      : offline ? (snap.canLaunch ? 'Press Play and Keystone connects to the game as soon as it starts.' : 'Start the game and Keystone picks it up.')
        : `Keystone can't reach this game's memory (${snap.modsError || 'access denied'}). That's normal for games with anti-cheat.`;
    $('noModsCommands').hidden = !snap.hasCommands;
  }
  $('modsView').hidden = !hasMods;
  if (hasMods) { renderMods(); renderProfiles(); renderTableCredits(snap.autoTables || []); }
}

// Private-server mode: mods for one run of the game on a server you run.
function renderPrivateRow(snap) {
  const row = $('privateRow');
  row.hidden = !snap.privateServers;
  if (row.hidden) return;
  const ac = snap.antiCheat || 'Anti-cheat';
  const btn = $('privateBtn');
  $('privateBadge').hidden = !snap.privateServer;
  btn.hidden = false;
  btn.disabled = false;
  if (snap.modsBlocked === 'anticheat') {
    $('privateText').textContent = `${ac} is running, so Keystone stays away from the game until it closes.`;
    btn.hidden = true;
  } else if (snap.privateServer) {
    $('privateText').textContent = 'Mods are on for this session, until the game closes.';
    btn.textContent = 'End';
  } else if (snap.modsSwitch) {
    btn.hidden = true;
    $('privateText').textContent = '';
    row.hidden = true;
  } else {
    $('privateText').textContent = snap.game.offline
      ? `On a server you run, with ${ac} off? Start the game, then turn mods on for that session only.`
      : `On a server you run, with ${ac} off? Turn mods on for this session only.`;
    btn.textContent = 'Use mods this session';
    btn.disabled = snap.game.offline;
  }
}

// "Tables: Fallout 4 by Someone (link) · My table (yours)" under the mods.
function renderTableCredits(list) {
  const p = $('tableCredits');
  p.hidden = !list.length;
  if (!list.length) return;
  const parts = [];
  list.forEach((t, i) => {
    if (i) parts.push(document.createTextNode(' · '));
    parts.push(document.createTextNode(t.name));
    if (t.author) {
      parts.push(document.createTextNode(' by '));
      if (t.url) {
        const a = el('a', { text: t.author, title: t.url });
        a.addEventListener('click', () => call(keystone.openBrowser(t.url)));
        parts.push(a);
      } else parts.push(document.createTextNode(t.author));
    } else if (t.url) {
      const a = el('a', { text: 'source' });
      a.addEventListener('click', () => call(keystone.openBrowser(t.url)));
      parts.push(document.createTextNode(' ('), a, document.createTextNode(')'));
    }
    if (t.source === 'mine') parts.push(document.createTextNode(' (your tables folder)'));
    // Mods Keystone can't run from this table: offer Cheat Engine for them.
    const missing = state.snapshot.records.filter((r) => r.kind === 'unsupported' && r.id.startsWith(`ct:${t.name}:`)).length;
    if (missing) {
      const a = el('a', { text: `open in Cheat Engine for the ${missing} that need${missing === 1 ? 's' : ''} it`, title: 'Opens the table with Cheat Engine, if it’s installed' });
      a.addEventListener('click', () => call(keystone.openLoadedInCE(i)));
      parts.push(document.createTextNode(' ('), a, document.createTextNode(')'));
    }
  });
  p.replaceChildren(document.createTextNode('Tables: '), ...parts);
}

// ---------- value finder ----------
const COMPARE_FIRST = [['exact', 'Exact value'], ['between', 'Value between']];
const COMPARE_NEXT = [['exact', 'Exact value'], ['increased', 'Went up'], ['decreased', 'Went down'], ['increasedBy', 'Went up by'],
  ['decreasedBy', 'Went down by'], ['changed', 'Changed'], ['unchanged', 'Didn’t change'], ['between', 'Value between']];
const NEEDS_VALUE = new Set(['exact', 'between', 'increasedBy', 'decreasedBy']);

function openFinder() {
  state.finder.open = true;
  renderModsPane(state.snapshot);
  refreshFinder();
  setTimeout(() => $('fVal').focus(), 0);
}

async function refreshFinder() {
  const i = await call(keystone.finderInfo());
  if (i) paintFinder(i);
}

function paintCompare() {
  const c = $('fCompare').value;
  $('fValWrap').hidden = !NEEDS_VALUE.has(c);
  $('fVal2Wrap').hidden = c !== 'between';
  $('fValLabel').textContent = c === 'between' ? 'From' : c === 'increasedBy' || c === 'decreasedBy' ? 'By how much' : 'Value';
}

function paintFinder(i) {
  state.finder.info = i;
  if (!state.finder.open || !i) return;
  if (!i.available) {
    $('fStatus').hidden = false;
    $('fStatus').className = 'finder-status idle';
    $('fStatusText').textContent = i.reason;
    return;
  }
  const started = i.scans > 0;
  const sel = $('fCompare');
  const opts = started ? COMPARE_NEXT : COMPARE_FIRST;
  const key = opts.map((o) => o[0]).join();
  if (sel.dataset.key !== key) {
    const prev = sel.value;
    sel.replaceChildren(...opts.map(([v, t]) => el('option', { value: v, text: t })));
    sel.dataset.key = key;
    sel.value = opts.some((o) => o[0] === prev) ? prev : 'exact';
  }
  paintCompare();
  if (started && i.type) $('fType').value = i.type;
  $('fType').disabled = started || i.busy;
  $('fFirst').hidden = started;
  $('fNext').hidden = !started;
  $('fUndo').hidden = !started;
  $('fReset').hidden = !started;
  for (const id of ['fFirst', 'fNext', 'fReset']) $(id).disabled = i.busy;
  $('fUndo').disabled = i.busy || !i.canUndo;

  const st = $('fStatus');
  st.hidden = !i.busy && !started && !i.pointer;
  st.className = `finder-status${i.busy || i.pointer ? '' : ' idle'}`;
  $('fCancel').hidden = !i.busy && !i.pointer;
  if (i.pointer) {
    const p = i.pointer.progress;
    const pct = p && p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
    $('fBar').style.width = `${pct}%`;
    $('fStatusText').textContent = `Finding a lasting address for “${i.pointer.name}”… ${p ? `step ${p.level} of ${p.maxDepth}, ` : ''}${pct}%`;
  } else if (i.busy) {
    const p = i.progress;
    const pct = p && p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
    $('fBar').style.width = `${pct}%`;
    $('fStatusText').textContent = `Searching… ${pct}%`;
  } else if (started) {
    const n = i.count.toLocaleString();
    $('fStatusText').textContent = i.count === 0 ? 'Nothing matched. Undo, or start a new scan.'
      : i.count > i.listLimit ? `${n} found${i.truncated ? ' (stopped counting at 20 million)' : ''}. Change the value in the game and scan again to narrow it down.`
        : i.count === 1 ? 'Found it. Add it as a mod below.' : `${n} found. Narrow it down, or try adding the likeliest one.`;
  }
  paintFinderResults(i);
  paintMyMods(i.mods || []);
}

function paintFinderResults(i) {
  const box = $('fResults');
  const rows = i.results || [];
  const key = rows.map((r) => r.address).join(',');
  // Same hits as before: update the numbers only, so a name being typed
  // into an Add box isn't wiped.
  if (key && key === state.finder.rowsKey) {
    for (const r of rows) {
      const tr = box.querySelector(`tr[data-a="${r.address}"]`);
      if (!tr) continue;
      tr.querySelector('.now').textContent = fmt(r.value, i.type);
      tr.classList.toggle('changed', r.value !== r.previous);
    }
    return;
  }
  state.finder.rowsKey = key;
  state.finder.editing = null;
  if (!rows.length) { box.replaceChildren(); return; }
  const table = el('table', { class: 'finder-table' },
    el('thead', {}, el('tr', {}, el('th', { text: 'Where' }), el('th', { text: 'Value now' }), el('th', { text: 'At last scan' }), el('th', { text: '' }))));
  const body = el('tbody');
  for (const r of rows) {
    const act = el('td', { class: 'act' });
    const add = el('button', { class: 'btn small', text: 'Add as mod' });
    add.addEventListener('click', () => startAdd(act, r, i.type));
    act.append(add);
    const where = el('td', { class: 'mono where', text: r.where || r.address },
      el('span', { class: `tag ${r.where ? 'keep' : 'temp'}`, text: r.where ? 'Saved' : 'Until the game closes', title: r.where ? 'In the game’s own memory: the same place every time it starts.' : 'This address changes every time the game starts.' }));
    const tr = el('tr', { 'data-a': r.address, class: r.value !== r.previous ? 'changed' : '' },
      where, el('td', { class: 'mono now', text: fmt(r.value, i.type) }), el('td', { class: 'mono', text: fmt(r.previous, i.type) }), act);
    body.append(tr);
  }
  table.append(body);
  box.replaceChildren(table);
}

function startAdd(cell, r, type) {
  const input = el('input', { class: 'field', placeholder: 'Name it, like Caps', maxlength: '60' });
  const save = el('button', { class: 'btn small primary', text: 'Save' });
  const go = async () => {
    const m = await call(keystone.finderAddMod({ address: r.address, type, name: input.value }));
    if (!m) { input.focus(); return; }
    toast(m.kept ? `Added “${m.name}” to My mods.` : `Added “${m.name}”. It works until the game closes.`);
    cell.replaceChildren(el('span', { class: 'pop-note', text: 'Added' }));
    refreshFinder();
  };
  save.addEventListener('click', go);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); if (e.key === 'Escape') state.finder.rowsKey = '', refreshFinder(); });
  cell.replaceChildren(input, save);
  input.focus();
}

// "[[demo.exe+2200]+8]+1C" for a pointer path, the way Cheat Engine shows it.
function pathText(m) {
  let t = m.address;
  for (const o of m.offsets || []) {
    const n = BigInt(o);
    t = `[${t}]${n < 0n ? '-' : '+'}${(n < 0n ? -n : n).toString(16).toUpperCase()}`;
  }
  return t;
}

function myModTag(m) {
  if (!m.kept) return el('span', { class: 'tag temp', text: 'Until the game closes' });
  if (m.pointer?.canCheck) return el('span', { class: 'tag check', text: `${m.pointer.paths} paths · check now` });
  if (m.pointer?.waiting) return el('span', { class: 'tag keep', text: `Saved · ${m.pointer.paths} paths, check after a restart` });
  return el('span', { class: 'tag keep', text: 'Saved' });
}

function paintMyMods(mods) {
  $('fMine').hidden = !mods.length;
  $('fShare').disabled = !mods.some((m) => m.kept);
  const box = $('fMineList');
  if (box.contains(document.activeElement)) return; // mid-rename or mid-check
  const searching = Boolean(state.finder.info?.pointer);
  const table = el('table', { class: 'finder-table' });
  for (const m of mods) {
    const act = el('td', { class: 'act' });
    const rename = el('button', { class: 'btn small ghost', text: 'Rename' });
    const del = el('button', { class: 'btn small ghost', text: 'Delete' });
    rename.addEventListener('click', () => {
      const input = el('input', { class: 'field', value: m.name, maxlength: '60' });
      const save = el('button', { class: 'btn small primary', text: 'Save' });
      const go = async () => { if (await call(keystone.finderRenameMod(m.id, input.value)) !== undefined) refreshFinder(); };
      save.addEventListener('click', go);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      act.replaceChildren(input, save);
      input.select();
    });
    del.addEventListener('click', async () => {
      if (!window.confirm(`Delete “${m.name}”?`)) return;
      if (await call(keystone.finderRemoveMod(m.id)) !== undefined) refreshFinder();
    });
    if (!m.kept) {
      const last = el('button', { class: 'btn small primary', text: 'Make it last', title: 'Find a way to this value that survives restarting the game', disabled: searching });
      last.addEventListener('click', async () => {
        const r = await call(keystone.finderMakeLast(m.id));
        if (!r || r.cancelled) return;
        toast(r.paths > 1
          ? `Saved “${m.name}” with ${r.paths} possible paths. Restart the game, then come back and press Check to keep the right one.`
          : `Saved “${m.name}”. It comes back every time you open the game.`);
        refreshFinder();
      });
      act.append(last);
    }
    if (m.pointer?.canCheck) {
      const check = el('button', { class: 'btn small primary', text: 'Check' });
      check.addEventListener('click', () => {
        const input = el('input', { class: 'field', placeholder: `${m.name} in game now`, inputmode: 'decimal', autocomplete: 'off' });
        const ok = el('button', { class: 'btn small primary', text: 'Check' });
        const go = async () => {
          const r = await call(keystone.finderCheck(m.id, input.value));
          if (!r) return;
          toast(r.paths === 1 ? `Found the right path for “${m.name}”. It comes back every time you open the game.`
            : `${r.paths} paths still lead to it (${r.dropped} dropped). Check again after the next restart to narrow it down.`);
          input.blur();
          refreshFinder();
        };
        ok.addEventListener('click', go);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
        act.replaceChildren(input, ok);
        input.focus();
      });
      act.append(check);
    }
    act.append(rename, del);
    table.append(el('tr', {},
      el('td', { text: m.name }),
      el('td', { class: 'mono where', text: pathText(m) }, myModTag(m)),
      act));
  }
  box.replaceChildren(table);
}

async function runScan(kind) {
  const compare = $('fCompare').value;
  const value = $('fVal').value.trim();
  let type = $('fType').value;
  // "72.5" can't be a whole number: search decimals instead of finding nothing.
  if (kind === 'first' && /\.\d/.test(value) && !['float', 'double'].includes(type)) {
    type = 'float';
    $('fType').value = 'float';
    toast('That number has decimals, so Keystone is searching decimal values.');
  }
  const opts = { compare, value, value2: $('fVal2').value.trim(), type };
  const res = await call(kind === 'first' ? keystone.finderFirst(opts) : keystone.finderNext(opts));
  if (res?.cancelled) toast('Scan cancelled.');
  await refreshFinder();
  if (NEEDS_VALUE.has(compare)) $('fVal').select();
}

function wireFinder() {
  $('findBtn').addEventListener('click', openFinder);
  $('emptyFindBtn').addEventListener('click', openFinder);
  $('finderClose').addEventListener('click', () => { state.finder.open = false; renderModsPane(state.snapshot); });
  $('fCompare').addEventListener('change', paintCompare);
  $('fFirst').addEventListener('click', () => runScan('first'));
  $('fNext').addEventListener('click', () => runScan('next'));
  for (const id of ['fVal', 'fVal2']) {
    $(id).addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || state.finder.info?.busy) return;
      runScan(state.finder.info?.scans > 0 ? 'next' : 'first');
    });
  }
  $('fUndo').addEventListener('click', async () => { await call(keystone.finderUndo()); refreshFinder(); });
  $('fReset').addEventListener('click', async () => {
    await call(keystone.finderReset());
    state.finder.rowsKey = '';
    $('fVal').value = '';
    $('fVal2').value = '';
    refreshFinder();
    $('fVal').focus();
  });
  $('fCancel').addEventListener('click', () => call(state.finder.info?.pointer ? keystone.finderCancelPointer() : keystone.finderCancel()));
  $('fShare').addEventListener('click', async () => {
    const r = await call(keystone.finderExport());
    if (r) toast(`Saved ${r.count} mod${r.count === 1 ? '' : 's'} to ${r.file.split(/[\\/]/).pop()}.`);
  });
  keystone.onFinder(paintFinder);
  // Live values for the listed hits while the finder is open.
  setInterval(() => {
    const i = state.finder.info;
    if (!state.finder.open || !i?.available || i.busy || !i.count || i.count > i.listLimit) return;
    if ($('finderPanel').hidden || document.hidden) return;
    refreshFinder();
  }, 1000);
}

// ---------- profiles ----------
function renderProfiles() {
  const p = state.snapshot.profiles || { names: [], active: null, autoApply: true, dirty: false };
  const sel = $('profileSelect');
  sel.replaceChildren(
    el('option', { value: '', text: p.names.length ? 'None' : 'None saved yet' }),
    ...p.names.map((n) => el('option', { value: n, text: n })),
  );
  sel.value = p.active || '';
  $('profileDirty').hidden = !p.dirty;
  $('profileSave').textContent = p.active ? 'Save' : 'Save these mods';
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

// ---------- mods ----------
// Top-level table groups become the category tabs (like Wand's ALL / PLAYER /
// INVENTORY), and each group renders as one glass panel.
function topGroup(r) {
  return r.groupPath[0] || (r.kind === 'group' ? r.name : 'Other');
}

function modLabel(r) {
  return r.label || r.name;
}

function visibleRecords() {
  const q = state.filter.trim().toLowerCase();
  const cat = state.modCat;
  return state.snapshot.records.filter((r) => {
    if (r.kind === 'group') return false;
    if (cat === '__pinned') { if (!r.pinned) return false; } else if (cat && topGroup(r) !== cat) return false;
    if (!q) return true;
    return modLabel(r).toLowerCase().includes(q) || r.groupPath.join(' ').toLowerCase().includes(q);
  });
}

function renderCats() {
  const recs = state.snapshot.records;
  const cats = [...new Set(recs.filter((r) => r.kind !== 'group').map(topGroup))];
  const anyPinned = recs.some((r) => r.pinned);
  if (state.modCat === '__pinned' ? !anyPinned : (state.modCat && !cats.includes(state.modCat))) state.modCat = null;
  const key = cats.join('|') + '#' + state.modCat + '#' + anyPinned;
  if ($('modCats').dataset.key === key) return;
  $('modCats').dataset.key = key;
  const btn = (label, value, icon) => {
    const b = el('button', { 'aria-pressed': String(state.modCat === value) });
    if (icon) b.append(svgIcon(icon));
    b.append(document.createTextNode(label));
    b.addEventListener('click', () => { state.modCat = value; renderMods(); });
    return b;
  };
  $('modCats').replaceChildren(
    btn('All', null, '<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/>'),
    ...(anyPinned ? [btn('Pinned', '__pinned', PIN)] : []),
    ...(cats.length > 1 ? cats.map((c) => btn(c, c)) : []),
  );
}

function renderMods() {
  renderCats();
  const recs = state.snapshot.records;
  const list = visibleRecords();
  const key = list.map((r) => `${r.id}:${r.hotkey || ''}:${r.pinned ? 1 : 0}`).join('|') + '#' + [...state.collapsed].join('|');

  // Same rows as last time: patch in place (keeps focus, slider drags and scroll).
  if (key === renderedKey) {
    for (const r of list) patchRow(r);
  } else {
    renderedKey = key;
    rowEls.clear();
    const groups = new Map();
    for (const r of list) {
      const g = r.groupPath.join(' / ') || 'Mods';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(r);
    }
    $('modsList').replaceChildren(...[...groups].map(([name, rows]) => {
      const open = !state.collapsed.has(name);
      const title = el('button', { class: 'group-title', 'aria-expanded': String(open) },
        el('span', { class: 'chev', text: '▾' }), el('span', { text: name }), el('span', { class: 'count', text: String(rows.length) }));
      title.addEventListener('click', () => {
        if (state.collapsed.has(name)) state.collapsed.delete(name); else state.collapsed.add(name);
        renderMods();
      });
      return el('section', { class: 'mod-group' }, title, ...(open ? rows.map(buildRow) : []));
    }));
    if (!list.length) $('modsList').replaceChildren(el('p', { class: 'pop-note', text: 'No mods match your search.' }));
  }

  const usable = recs.filter((r) => r.kind === 'value' || r.kind === 'script').length;
  const locked = recs.filter((r) => r.enabled).length;
  $('modsCount').textContent = `${usable} mods${locked ? `, ${locked} on` : ''}`;
}

// Every value mod gets a control picked by the pack (modsUi) or the default:
//   toggle  Off/On; On keeps the value at the pack's number
//   slider  drag to a value; On keeps it there
//   steps   pick one of a few values; picking one turns it on
//   apply   one button that writes the pack's value once
//   default value box, Apply (write once) and Off/On (keep it there)
function buildRow(r) {
  const nameEl = el('div', { class: 'mod-name' }, el('span', { class: 'label', text: modLabel(r), title: r.label ? r.name : '' }));
  if (r.kind === 'script') return buildScriptRow(r, nameEl);
  if (r.kind !== 'value') {
    return el('div', { class: 'mod inert' }, svgIcon(BOLT, 'bolt'), nameEl,
      el('span', { class: 'reason', text: r.kind === 'script' ? 'Script: needs Cheat Engine' : (r.reason || 'Not supported') }));
  }
  const now = el('span', { class: 'now' });
  nameEl.append(now);
  if (r.sessionOnly) nameEl.append(el('span', { class: 'temp-note', text: 'Until the game closes' }));
  const controls = el('div', { class: 'mod-controls' });
  const row = el('div', { class: 'mod' }, svgIcon(BOLT, 'bolt'), nameEl, controls);
  const ui = r.ui || {};
  const els = { row, now, ui, kind: ui.control || 'default' };

  const seg = () => {
    const s = el('span', { class: 'seg', role: 'group', 'aria-label': `${modLabel(r)} on or off` },
      el('button', { 'data-v': 'off', text: 'Off' }), el('button', { 'data-v': 'on', text: 'On' }));
    s.addEventListener('click', async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const on = b.dataset.v === 'on';
      if (on === Boolean(els.enabled)) return;
      await turn(r, els, on);
    });
    els.seg = s;
    return s;
  };

  if (els.kind === 'toggle') {
    controls.append(seg());
  } else if (els.kind === 'apply') {
    const b = el('button', { class: 'btn primary apply', text: 'Apply' });
    b.addEventListener('click', () => applyNow(r, ui.value));
    controls.append(b);
  } else if (els.kind === 'steps') {
    const box = el('span', { class: 'steps', role: 'group', 'aria-label': modLabel(r) });
    (ui.values || []).forEach((v, i) => {
      const b = el('button', { text: ui.labels?.[i] ?? String(v), 'data-value': String(v) });
      b.addEventListener('click', async () => {
        if (els.enabled && Number(els.target) === Number(v)) { await call(keystone.setEnabled(r.id, false)); return; }
        if (await call(keystone.setTarget(r.id, v)) !== undefined) await call(keystone.setEnabled(r.id, true));
      });
      box.append(b);
    });
    els.steps = box;
    controls.append(box);
  } else if (els.kind === 'slider') {
    const min = Number(ui.min ?? 0);
    const max = Number(ui.max ?? 100);
    const valBox = el('input', { class: 'value-box', inputmode: 'decimal', 'aria-label': `${modLabel(r)} value` });
    const slider = el('input', { class: 'slider', type: 'range', min: String(min), max: String(max), step: String(ui.step ?? 1), 'aria-label': modLabel(r) });
    const paint = () => slider.style.setProperty('--fill', `${((Number(slider.value) - min) / (max - min || 1)) * 100}%`);
    let t;
    slider.addEventListener('input', () => {
      valBox.value = slider.value;
      paint();
      // Debounced: a drag fires dozens of input events.
      clearTimeout(t);
      t = setTimeout(() => call(keystone.setTarget(r.id, slider.value)), 120);
    });
    valBox.addEventListener('change', async () => {
      if (valBox.value.trim() === '') return;
      await call(keystone.setTarget(r.id, valBox.value.trim()));
    });
    els.slider = slider; els.valBox = valBox; els.paint = paint;
    controls.append(valBox, el('span', { class: 'slider-wrap' }, slider), seg());
  } else {
    const valBox = el('input', { class: 'value-box', inputmode: 'decimal', placeholder: 'value', 'aria-label': `${modLabel(r)} value` });
    const apply = el('button', { class: 'btn apply', text: 'Apply', title: 'Write this value once' });
    valBox.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitTarget(r.id, valBox.value); valBox.blur(); }
      if (e.key === 'Escape') { valBox.value = els.target === null ? '' : fmt(els.target, r.valueType); valBox.blur(); }
    });
    valBox.addEventListener('change', () => commitTarget(r.id, valBox.value));
    apply.addEventListener('click', async () => {
      if (valBox.value.trim() === '') { toast('Type a value first, then press Apply.'); valBox.focus(); return; }
      await applyNow(r, valBox.value.trim());
    });
    els.valBox = valBox;
    controls.append(valBox, apply, seg());
  }

  // Pin and hotkey sit before the control, like Wand's row layout.
  const pin = el('button', { class: `pin-btn${r.pinned ? ' on' : ''}`, title: r.pinned ? 'Unpin' : 'Pin: show it first and in the overlay', 'aria-label': `${r.pinned ? 'Unpin' : 'Pin'} ${modLabel(r)}`, 'aria-pressed': String(Boolean(r.pinned)) });
  pin.append(svgIcon(PIN));
  pin.addEventListener('click', () => call(keystone.setPinned(r.id, !r.pinned)));
  const key = el('button', { class: `keycap${r.hotkey ? '' : ' unset'}`, title: r.hotkey ? `Hotkey: ${r.hotkey}. Click to change.` : 'Set a hotkey' });
  if (r.hotkey) key.append(...keyParts(r.hotkey));
  else key.textContent = '+ Key';
  key.addEventListener('click', () => captureHotkey(r));
  controls.prepend(pin, key);

  rowEls.set(r.id, els);
  patchRow(r);
  return row;
}

// Cheat Engine scripts: On runs the script's [ENABLE] part, Off its
// [DISABLE] part. No value to type, so just the switch.
function buildScriptRow(r, nameEl) {
  const now = el('span', { class: 'now' });
  nameEl.append(now);
  const controls = el('div', { class: 'mod-controls' });
  const row = el('div', { class: 'mod script' }, svgIcon(BOLT, 'bolt'), nameEl, controls);
  const els = { row, now, ui: {}, kind: 'script' };
  const s = el('span', { class: 'seg', role: 'group', 'aria-label': `${modLabel(r)} on or off` },
    el('button', { 'data-v': 'off', text: 'Off' }), el('button', { 'data-v': 'on', text: 'On' }));
  s.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const on = b.dataset.v === 'on';
    if (on === Boolean(els.enabled)) return;
    await call(keystone.setEnabled(r.id, on));
  });
  els.seg = s;
  const pin = el('button', { class: `pin-btn${r.pinned ? ' on' : ''}`, title: r.pinned ? 'Unpin' : 'Pin: show it first and in the overlay', 'aria-label': `${r.pinned ? 'Unpin' : 'Pin'} ${modLabel(r)}`, 'aria-pressed': String(Boolean(r.pinned)) });
  pin.append(svgIcon(PIN));
  pin.addEventListener('click', () => call(keystone.setPinned(r.id, !r.pinned)));
  const key = el('button', { class: `keycap${r.hotkey ? '' : ' unset'}`, title: r.hotkey ? `Hotkey: ${r.hotkey}. Click to change.` : 'Set a hotkey' });
  if (r.hotkey) key.append(...keyParts(r.hotkey));
  else key.textContent = '+ Key';
  key.addEventListener('click', () => captureHotkey(r));
  controls.append(pin, key, s);
  rowEls.set(r.id, els);
  patchRow(r);
  return row;
}

const KEY_NAMES = { numadd: 'Num +', numsub: 'Num −', nummult: 'Num *', numdiv: 'Num /', numdec: 'Num .' };
function keyLabel(k) {
  if (KEY_NAMES[k]) return KEY_NAMES[k];
  if (/^num\d$/.test(k)) return `Num ${k.slice(3)}`;
  return k;
}
function keyParts(accel) {
  return accel.split('+').map((k) => el('kbd', { text: keyLabel(k) }));
}

const CODE_KEYS = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'",
  Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Space: 'Space', Tab: 'Tab', Backspace: 'Backspace',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
};
// Physical key (e.code) rather than the typed character, so Shift+1 is still
// "1" and keyboard layouts don't change what's saved.
function codeToKey(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return `num${code.slice(6)}`;
  if (/^F\d{1,2}$/.test(code)) return code;
  return CODE_KEYS[code] || null;
}

function captureHotkey(r) {
  const dlg = $('keyDialog');
  $('keyTitle').textContent = `Hotkey for ${modLabel(r)}`;
  $('keyPreview').replaceChildren(document.createTextNode(r.hotkey ? 'Press new keys…' : 'Waiting for keys…'));
  $('keyError').hidden = true;
  $('keyRemove').hidden = !r.hotkey;
  dlg.returnValue = '';
  const onKey = async (e) => {
    if (e.key === 'Escape') return; // the dialog closes itself
    e.preventDefault();
    const key = codeToKey(e.code);
    if (!key) return; // a modifier on its own: keep waiting
    const accel = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', key].filter(Boolean).join('+');
    $('keyPreview').replaceChildren(...keyParts(accel));
    const res = await keystone.setHotkey(r.id, accel);
    if (res.ok) { dlg.close('ok'); toast(`${modLabel(r)}: ${res.data}`); } else { $('keyError').textContent = res.error; $('keyError').hidden = false; }
  };
  dlg.addEventListener('keydown', onKey);
  dlg.addEventListener('close', async () => {
    dlg.removeEventListener('keydown', onKey);
    if (dlg.returnValue === 'remove') await call(keystone.setHotkey(r.id, null));
  }, { once: true });
  dlg.showModal();
}

// On: keep the value. A typed (uncommitted) number or the pack's toggle value
// is what gets kept; with neither, the game's current value is.
async function turn(r, els, on) {
  if (on) {
    let target = null;
    if (els.kind === 'toggle' && els.ui.value !== undefined) target = els.ui.value;
    else if (els.valBox && els.valBox.value.trim() !== '' && Number(els.valBox.value) !== els.target) target = els.valBox.value.trim();
    if (target !== null && (await call(keystone.setTarget(r.id, target))) === undefined) return;
  }
  await call(keystone.setEnabled(r.id, on));
}

async function applyNow(r, value) {
  if (await call(keystone.applyValue(r.id, value)) !== undefined) toast(`${modLabel(r)}: set to ${value}.`);
}

async function commitTarget(id, raw) {
  const value = raw.trim();
  await call(keystone.setTarget(id, value === '' ? null : value));
}

function patchRow(r) {
  const els = rowEls.get(r.id);
  if (!els) return;
  els.target = r.target;
  els.enabled = r.enabled;
  els.row.classList.toggle('on', r.enabled);
  if (els.seg) for (const b of els.seg.querySelectorAll('button')) b.setAttribute('aria-pressed', String((b.dataset.v === 'on') === r.enabled));
  if (els.steps) for (const b of els.steps.querySelectorAll('button')) b.setAttribute('aria-pressed', String(r.enabled && Number(b.dataset.value) === Number(r.target)));
  if (els.valBox && document.activeElement !== els.valBox) {
    els.valBox.value = r.target === null || r.target === undefined ? '' : fmt(r.target, r.valueType);
  }
  if (els.slider && document.activeElement !== els.slider) {
    const v = r.target ?? r.current;
    if (v !== null && v !== undefined) { els.slider.value = String(v); if (document.activeElement !== els.valBox) els.valBox.value = fmt(Number(els.slider.value), r.valueType); }
    els.paint();
  }
  patchValue(r.id, r);
}

function patchValue(id, v) {
  const els = rowEls.get(id);
  if (!els) return;
  const rec = state.snapshot.records.find((r) => r.id === id);
  if (rec?.kind === 'script') {
    const failed = rec.status === 'error';
    els.now.textContent = failed ? `Didn’t work: ${rec.error}` : rec.enabled ? 'Script on' : 'Script';
    els.now.classList.toggle('waiting', !failed && !rec.enabled);
    els.now.classList.toggle('failed', failed);
    els.now.title = failed ? rec.error : '';
    return;
  }
  const waiting = v.status !== 'ok';
  els.now.textContent = waiting ? 'Waiting for the game' : `In game: ${fmt(v.current, rec?.valueType)}`;
  els.now.classList.toggle('waiting', waiting);
  els.now.title = waiting && v.error ? `Can't read this right now: ${v.error}` : '';
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

  // Where you are: mods when there are any, else "I'm here" / Find me.
  const liveTracking = Boolean(d.session && d.roles?.x && d.roles?.y);
  $('rolesBox').hidden = !d.session;
  $('hereBox').hidden = liveTracking;
  $('hereNote').textContent = d.findMe
    ? 'Keystone can\u2019t follow you live in this game without mods. Press Find me (or Ctrl+Shift+F in game) to put yourself on the map; it types the game\u2019s ccc command, which needs admin. Or click the map where you are.'
    : 'Keystone can\u2019t follow you live in this game. Click the map where you are to put yourself on the minimap; the marker stays put until you set it again.';
  $('findMeBtn').hidden = !d.findMe;
  $('hereClear').hidden = !d.here;
  $('lineUp').hidden = !(d.findMe && (d.here?.source === 'findme' || d.findMeFixed));
  $('luReset').hidden = !d.findMeFixed;
  $('hkFindMe').hidden = !d.findMe;

  // Map tools
  const variantSel = $('variantSel');
  $('variantRow').hidden = (d.variants || []).length < 2;
  if (document.activeElement !== variantSel) {
    variantSel.replaceChildren(...(d.variants || []).map((v) => el('option', { value: v.id, text: v.name })));
    variantSel.value = d.variant?.id || '';
  }
  const hasImage = Boolean(d.map?.url);
  $('mapReset').hidden = !(d.map && d.map.custom && d.pack);
  $('mapCalibrate').disabled = !hasImage;
  $('mapNote').textContent = !d.map ? ''
    : !hasImage ? 'Grid only. Add a screenshot of the in-game map for a picture.'
      : d.map.bounds ? (d.map.custom ? 'Your map, lined up.' : `From the ${d.pack} pack.`) : 'This map isn\u2019t lined up yet.';
  const layerList = $('layerList');
  layerList.hidden = !(d.layers || []).length;
  layerList.replaceChildren(...(d.layers || []).map((l) => {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = l.on;
    cb.addEventListener('change', () => call(keystone.setMarkerLayer(l.id, cb.checked)));
    const sw = el('span', { class: 'sw' });
    sw.style.background = l.color;
    return el('label', { class: 'check' }, cb, sw, el('span', { text: l.name }), el('span', { class: 'count', text: String(l.points.length) }));
  }));
  $('markerCredits').hidden = !d.markerCredits;
  $('markerCredits').textContent = d.markerCredits || '';
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
    const ll = d.variant?.units === 'latlon';
    const x = el('input', { class: 'field num', value: ll ? w.x.toFixed(1) : String(Math.round(w.x)), 'aria-label': ll ? 'Longitude' : 'X', placeholder: ll ? 'Lon' : 'X', inputmode: 'decimal' });
    const y = el('input', { class: 'field num', value: ll ? w.y.toFixed(1) : String(Math.round(w.y)), 'aria-label': ll ? 'Latitude' : 'Y', placeholder: ll ? 'Lat' : 'Y', inputmode: 'decimal' });
    const isTracked = d.tracked === w.id;
    const track = el('button', { class: `btn small${isTracked ? ' tracking' : ''}`, text: isTracked ? 'Tracking' : 'Track', title: 'Show distance and direction on the minimap' });
    const del = el('button', { class: 'btn small ghost', text: 'Delete' });
    const go = el('button', { class: 'btn small', text: 'Teleport', title: 'Move your character to this waypoint' });
    go.hidden = !d.teleport;
    go.addEventListener('click', async () => {
      const r = await call(keystone.teleport({ waypointId: w.id }));
      if (r) toast(`Teleported to ${r.name}.`);
    });
    const save = (patch) => call(keystone.updateWaypoint(w.id, patch));
    name.addEventListener('change', () => save({ name: name.value }));
    x.addEventListener('change', () => save({ x: x.value }));
    y.addEventListener('change', () => save({ y: y.value }));
    track.addEventListener('click', () => call(keystone.setTracked(isTracked ? null : w.id)));
    del.addEventListener('click', () => call(keystone.removeWaypoint(w.id)));
    // Lat/lon reads latitude first, the way games show it.
    list.append(el('div', { class: `wp-row${d.teleport ? ' tp' : ''}` }, name, ...(ll ? [y, x] : [x, y]), track, go, del));
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
  renderTimerList(d);
  renderLists(d);
  renderCrosshairBlock(d);
  for (const cb of document.querySelectorAll('[data-pc]')) cb.checked = Boolean(d.pcstats?.[cb.dataset.pc]);
  $('pcPicks').hidden = !d.panels.pcstats?.visible;
  $('identPanelToggle').hidden = !d.identify;
  paintOverlayLive();
}

// ---------- crosshair ----------
const XH_SWATCHES = [['accent', 'Accent colour'], ['white', 'White'], ['green', 'Green'], ['red', 'Red'], ['cyan', 'Cyan'], ['yellow', 'Yellow']];

// Edits show in the preview straight away and are saved a moment after the
// slider stops, so dragging doesn't write the settings file 60 times a second.
let xhDraft = null;
let xhSaveTimer = null;
function xhEdit(patch) {
  xhDraft = Crosshair.normalize({ ...(xhDraft || state.ovData.crosshair), ...patch });
  drawCrosshairPreview(xhDraft);
  paintCrosshairControls(xhDraft);
  clearTimeout(xhSaveTimer);
  xhSaveTimer = setTimeout(async () => {
    const saved = await call(keystone.setCrosshair(xhDraft));
    if (saved) xhDraft = null;
  }, 150);
}

function accentColor() {
  return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
}

function drawCrosshairPreview(c) {
  const cv = $('xhPreview');
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== 240 * dpr) { cv.width = 240 * dpr; cv.height = 180 * dpr; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, 240, 180);
  // The preview shows the shape even when it's switched off, dimmed.
  Crosshair.draw(ctx, c.on ? c : { ...c, opacity: c.opacity * 0.35 }, 120, 90, accentColor());
}

function paintCrosshairControls(c) {
  $('xhOn').checked = c.on;
  for (const b of $('xhStyle').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === c.style));
  for (const input of document.querySelectorAll('input.slider[data-xh]')) {
    if (document.activeElement !== input) input.value = String(c[input.dataset.xh]);
    const k = input.dataset.xh;
    input.style.setProperty('--fill', `${((c[k] - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100}%`);
    input.nextElementSibling.textContent = k === 'opacity' ? `${Math.round(c[k] * 100)}%` : `${c[k]}px`;
  }
  for (const input of document.querySelectorAll('input.xh-num')) if (document.activeElement !== input) input.value = String(c[input.dataset.xh]);
  $('xhOutline').checked = c.outline;
  for (const b of $('xhColors').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.c === c.color));
}

function renderCrosshairBlock(d) {
  const colors = $('xhColors');
  if (!colors.children.length) {
    colors.replaceChildren(...XH_SWATCHES.map(([id, label]) => {
      const b = el('button', { role: 'radio', 'data-c': id, title: label, 'aria-label': label });
      b.style.background = id === 'accent' ? 'var(--accent)' : Crosshair.COLORS[id];
      b.addEventListener('click', () => xhEdit({ color: id }));
      return b;
    }));
  }
  const c = xhDraft || d.crosshair;
  if (!c) return;
  drawCrosshairPreview(c);
  paintCrosshairControls(c);
}

// ---------- timers ----------
function fmtLeft(ms) {
  const t = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function renderTimerList(d) {
  const presets = $('timerPresets');
  presets.hidden = !(d.timerPresets || []).length;
  presets.replaceChildren(el('span', { class: 'block-note', text: 'Start one now:' }), ...(d.timerPresets || []).map((name, i) => {
    const b = el('button', { class: 'btn small', text: name });
    b.addEventListener('click', () => call(keystone.startTimerPreset(i)));
    return b;
  }));
  const list = $('timerList');
  const timers = d.timers || [];
  if (!timers.length) { list.replaceChildren(el('p', { class: 'wp-empty', text: 'No timers yet.' })); return; }
  list.replaceChildren(...timers.map((t) => {
    const run = el('button', { class: `btn small${t.state === 'running' ? '' : ' primary'}`, text: t.state === 'running' ? 'Pause' : t.state === 'paused' ? 'Resume' : 'Start' });
    run.addEventListener('click', () => call(keystone.toggleTimer(t.id)));
    const reset = el('button', { class: 'btn small ghost', text: 'Reset' });
    reset.disabled = t.state === 'idle';
    reset.addEventListener('click', () => call(keystone.resetTimer(t.id)));
    const del = el('button', { class: 'btn small ghost', text: 'Delete' });
    del.addEventListener('click', () => call(keystone.removeTimer(t.id)));
    const name = el('span', { class: 't-name', text: t.name, title: `${fmtLeft(t.durationMs)}${t.repeat ? ', repeats' : ''}` });
    name.append(el('small', { text: `${fmtLeft(t.durationMs)}${t.repeat ? ' \u21bb' : ''}` }));
    return el('div', { class: `timer-row ${t.state}`, 'data-id': t.id }, name, el('span', { class: 't-left' }), run, reset, del);
  }));
  paintTimerList();
}

// Counts down from the end times locally; the main process only sends a
// new list when something changes.
function paintTimerList() {
  const now = Date.now();
  for (const t of state.ovData.timers || []) {
    const row = document.querySelector(`.timer-row[data-id="${CSS.escape(t.id)}"] .t-left`);
    if (row) row.textContent = t.state === 'done' ? 'Done' : fmtLeft(t.state === 'running' ? t.endsAt - now : t.remainingMs);
  }
}

// ---------- checklists ----------
function renderLists(d) {
  const body = $('listBody');
  // Don't rebuild under the cursor: typing an item or a new name would be lost.
  if (body.contains(document.activeElement) && document.activeElement.tagName === 'INPUT' && document.activeElement.type === 'text') return;
  const lists = d.checklists || [];
  const cur = d.checklist;
  const tabs = $('listTabs');
  tabs.hidden = !lists.length;
  tabs.replaceChildren(...lists.map((l) => {
    const b = el('button', { role: 'tab', 'aria-pressed': String(cur?.id === l.id) }, el('span', { text: l.name }), el('span', { class: 'n', text: ` ${l.done}/${l.total}` }));
    b.addEventListener('click', () => call(keystone.setActiveList(l.id)));
    return b;
  }));
  if (!cur) { body.replaceChildren(el('p', { class: 'wp-empty', text: 'No checklists yet.' })); return; }

  const name = el('input', { class: 'field', type: 'text', value: cur.name, maxlength: '40', 'aria-label': 'Checklist name' });
  name.addEventListener('change', () => call(keystone.renameList(cur.id, name.value)));
  const untick = el('button', { class: 'btn small ghost', text: 'Untick all' });
  untick.disabled = !cur.items.some((i) => i.done);
  untick.addEventListener('click', () => call(keystone.resetList(cur.id)));
  const del = el('button', { class: 'btn small ghost', text: 'Delete checklist' });
  del.addEventListener('click', async () => {
    if (await confirmBox(`Delete the checklist "${cur.name}"?`, 'Delete')) call(keystone.removeList(cur.id));
  });

  const items = el('ul', { class: 'list-items' }, ...cur.items.map((i) => {
    const cb = el('input', { type: 'checkbox', 'aria-label': i.text });
    cb.checked = i.done;
    cb.addEventListener('change', () => call(keystone.checkListItem(cur.id, i.id, cb.checked)));
    const x = el('button', { class: 'btn small ghost x', text: 'Remove', 'aria-label': `Remove ${i.text}` });
    x.addEventListener('click', () => call(keystone.removeListItem(cur.id, i.id)));
    return el('li', { class: i.done ? 'done' : '' }, el('label', { class: 'check' }, cb), el('span', { class: 'text', text: i.text }), x);
  }));

  const input = el('input', { class: 'field', type: 'text', placeholder: 'Add an item', maxlength: '80', 'aria-label': 'New item' });
  const add = el('button', { class: 'btn small', type: 'submit', text: 'Add' });
  const form = el('form', { class: 'list-add' }, input, add);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value;
    input.value = '';
    if (text.trim()) await call(keystone.addListItem(cur.id, text));
    input.focus();
  });
  body.replaceChildren(el('div', { class: 'list-head' }, name, untick, del), items, form);
}

// Live position from mods, else the "I'm here" marker.
function curPos() {
  if (state.ovLive.pos) return state.ovLive.pos;
  const h = state.ovData.here;
  return h ? { x: h.x, y: h.y, z: h.z, facing: null, manual: true, source: h.source, at: h.at } : null;
}

function coordText(p) {
  return state.ovData.variant?.units === 'latlon' ? `lat ${p.y.toFixed(1)}, lon ${p.x.toFixed(1)}` : `${Math.round(p.x)}, ${Math.round(p.y)}`;
}

function agoText(at) {
  const m = Math.floor((Date.now() - at) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ago`;
}

function paintOverlayLive() {
  const p = curPos();
  const d = state.ovData;
  const out = $('ovPos');
  out.classList.toggle('none', !p);
  out.textContent = !p
    ? (d.session ? (d.roles?.x && d.roles?.y ? 'Waiting for the game to report a position.' : 'Choose the X and Y mods to see your position.') : 'Position not set.')
    : p.manual
      ? `Marked at ${coordText(p)} (${p.source === 'findme' ? 'Find me' : 'clicked'}, ${agoText(p.at)})`
      : `You're at ${coordText(p)}${p.z !== null ? `, height ${Math.round(p.z)}` : ''}${p.facing !== null ? `, facing ${Math.round(p.facing)}°` : ''}`;
  drawPreview();
}

function loadPreviewMap() {
  const url = state.ovData.map?.url || null;
  const gridOnly = !url && Boolean(state.ovData.map?.bounds);
  const empty = $('mapEmpty');
  empty.hidden = Boolean(url);
  empty.classList.toggle('corner', gridOnly);
  empty.textContent = gridOnly
    ? `${state.ovData.variant?.units === 'latlon' ? 'Longitude along the top, latitude down the side. ' : ''}No picture yet: choose a screenshot of the full in-game map and it usually lines up on its own.`
    : 'No map yet. Use a screenshot of the game\u2019s world map, then line it up with two clicks.';
  if (url === state.mapUrl) { drawPreview(); return; }
  state.mapUrl = url;
  state.mapImg = null;
  if (!url) {
    const b = state.ovData.map?.bounds;
    const c = $('mapPreview');
    c.width = 760;
    c.height = b ? Math.round(Math.min(520, 760 * Math.abs((b.bottom - b.top) / (b.right - b.left)))) : 420;
    drawPreview();
    return;
  }
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

// What the preview shows, fitted inside the canvas (contain): the map
// picture, or, for a map with coordinates but no picture, a stand-in "image"
// with the map's proportions so the same world<->pixel maths works.
function previewFit() {
  const c = $('mapPreview');
  const img = state.mapImg;
  const b = state.ovData.map?.bounds;
  let iw;
  let ih;
  if (img) { iw = img.naturalWidth; ih = img.naturalHeight; } else if (b) { iw = 1000; ih = 1000 * Math.abs((b.bottom - b.top) / (b.right - b.left)); } else return null;
  const scale = Math.min(c.width / iw, c.height / ih);
  return { iw, ih, scale, ox: (c.width - iw * scale) / 2, oy: (c.height - ih * scale) / 2 };
}

// Canvas pixel (from a mouse event) -> world coordinates, or null.
function previewWorld(e) {
  const c = $('mapPreview');
  const f = previewFit();
  const b = state.ovData.map?.bounds;
  if (!f || !b) return null;
  const rect = c.getBoundingClientRect();
  const cx = ((e.clientX - rect.left) / rect.width) * c.width;
  const cy = ((e.clientY - rect.top) / rect.height) * c.height;
  return MapMath.imageToWorld(b, f.iw, f.ih, (cx - f.ox) / f.scale, (cy - f.oy) / f.scale);
}

function markerShape(ctx, shape, x, y, r) {
  ctx.beginPath();
  if (shape === 'square') ctx.rect(x - r, y - r, r * 2, r * 2);
  else if (shape === 'diamond') { ctx.moveTo(x, y - r - 1); ctx.lineTo(x + r + 1, y); ctx.lineTo(x, y + r + 1); ctx.lineTo(x - r - 1, y); ctx.closePath(); }
  else if (shape === 'triangle') { ctx.moveTo(x, y - r - 1); ctx.lineTo(x + r + 1, y + r); ctx.lineTo(x - r - 1, y + r); ctx.closePath(); }
  else ctx.arc(x, y, r, 0, Math.PI * 2);
}

function drawPreview() {
  const c = $('mapPreview');
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  const img = state.mapImg;
  const b = state.ovData.map?.bounds;
  const f = previewFit();
  if (!f) return;
  const toCanvas = (x, y) => {
    const p = MapMath.worldToImage(b, f.iw, f.ih, x, y);
    return { x: f.ox + p.x * f.scale, y: f.oy + p.y * f.scale };
  };
  if (img) {
    ctx.drawImage(img, f.ox, f.oy, f.iw * f.scale, f.ih * f.scale);
  } else {
    // Grid-only map: a line every 10 units, labelled along the edges.
    ctx.fillStyle = '#12151a';
    ctx.fillRect(f.ox, f.oy, f.iw * f.scale, f.ih * f.scale);
    const span = Math.abs(b.right - b.left);
    const step = [1, 2, 5, 10, 20, 50, 100, 250, 500, 1000, 2500, 5000, 10000].find((s) => span / s <= 12) || span / 10;
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '500 10px Geist, sans-serif';
    ctx.lineWidth = 1;
    for (let v = Math.ceil(Math.min(b.left, b.right) / step) * step; v <= Math.max(b.left, b.right); v += step) {
      const p = toCanvas(v, b.top);
      ctx.beginPath(); ctx.moveTo(p.x, f.oy); ctx.lineTo(p.x, f.oy + f.ih * f.scale); ctx.stroke();
      ctx.fillText(String(v), p.x + 3, f.oy + 12);
    }
    for (let v = Math.ceil(Math.min(b.top, b.bottom) / step) * step; v <= Math.max(b.top, b.bottom); v += step) {
      const p = toCanvas(b.left, v);
      ctx.beginPath(); ctx.moveTo(f.ox, p.y); ctx.lineTo(f.ox + f.iw * f.scale, p.y); ctx.stroke();
      if (v !== b.top) ctx.fillText(String(v), f.ox + 3, p.y - 3);
    }
  }
  if (b) {
    for (const l of state.ovData.layers || []) {
      if (!l.on) continue;
      for (const m of l.points) {
        const p = toCanvas(m.x, m.y);
        markerShape(ctx, l.shape, p.x, p.y, 4);
        ctx.fillStyle = l.color;
        ctx.fill();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = '#0e1115';
        ctx.stroke();
        ctx.font = '500 11px Geist, sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.shadowColor = 'rgba(0,0,0,.8)';
        ctx.shadowBlur = 3;
        ctx.fillText(m.name, p.x + 7, p.y + 4);
        ctx.shadowBlur = 0;
      }
    }
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
    const pos = curPos();
    if (pos) {
      const p = toCanvas(pos.x, pos.y);
      const cs = getComputedStyle(document.documentElement);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      if (pos.manual) {
        // "I'm here" is a ring: it marks a spot, it doesn't track you.
        ctx.lineWidth = 3;
        ctx.strokeStyle = cs.getPropertyValue('--accent').trim();
        ctx.stroke();
      } else {
        ctx.fillStyle = cs.getPropertyValue('--accent').trim();
        ctx.shadowColor = cs.getPropertyValue('--accent-glow').trim();
        ctx.shadowBlur = 10;
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#0e1115';
        ctx.stroke();
      }
    }
  }
  if (state.calib?.a) {
    const p = { x: f.ox + state.calib.a.px.x * f.scale, y: f.oy + state.calib.a.px.y * f.scale };
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(p.x - 8, p.y); ctx.lineTo(p.x + 8, p.y); ctx.moveTo(p.x, p.y - 8); ctx.lineTo(p.x, p.y + 8);
    ctx.stroke();
  }
}

function setPlacing(on) {
  state.placing = on;
  if (on && state.calib) setCalib(null);
  $('mapPreviewWrap').classList.toggle('placing', on);
  $('hereBtn').classList.toggle('on', on);
  $('hereBtn').textContent = on ? 'Click where you are on the map below' : 'I\u2019m here: click the map';
}

function setCalib(next) {
  state.calib = next;
  if (next && state.placing) setPlacing(false);
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
    if (state.placing) {
      const w = previewWorld(e);
      if (!w) return;
      const ll = state.ovData.variant?.units === 'latlon';
      const r = (n) => (ll ? Math.round(n * 10) / 10 : Math.round(n));
      setPlacing(false);
      const h = await call(keystone.setHere({ x: r(w.x), y: r(w.y) }));
      if (h) toast(`Marked you at ${coordText(h)}.`);
      return;
    }
    if (!state.calib || !state.mapImg) return;
    // Lining up a picture needs to know where you are: from mods, or a
    // fresh Find me before each click.
    const pos = curPos();
    if (!pos) { toast('Keystone needs your position first: choose the X and Y mods above, or press Find me.', 'error'); return; }
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

  $('variantSel').addEventListener('change', (e) => call(keystone.setMapVariant(e.target.value)));
  $('xhOn').addEventListener('change', (e) => xhEdit({ on: e.target.checked }));
  for (const b of $('xhStyle').querySelectorAll('button')) b.addEventListener('click', () => xhEdit({ style: b.dataset.v }));
  for (const input of document.querySelectorAll('input.slider[data-xh]')) input.addEventListener('input', () => xhEdit({ [input.dataset.xh]: Number(input.value) }));
  for (const input of document.querySelectorAll('input.xh-num')) input.addEventListener('change', () => xhEdit({ [input.dataset.xh]: Number(input.value) || 0 }));
  $('xhOutline').addEventListener('change', (e) => xhEdit({ outline: e.target.checked }));
  for (const cb of document.querySelectorAll('[data-pc]')) cb.addEventListener('change', () => call(keystone.setPcStats({ [cb.dataset.pc]: cb.checked })));
  $('timerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const t = await call(keystone.addTimer({ name: $('timerName').value, duration: $('timerLen').value, repeat: $('timerRepeat').checked }));
    if (t) { $('timerName').value = ''; $('timerLen').value = ''; $('timerRepeat').checked = false; toast(`Added ${t.name}. Press Start when you're ready.`); }
  });
  $('listNew').addEventListener('click', async () => {
    const name = await askName({ title: 'New checklist', confirm: 'Create' });
    if (name) call(keystone.addList(name));
  });
  setInterval(() => { if (isPane('overlay') && !document.hidden) paintTimerList(); }, 500);
  $('hereBtn').addEventListener('click', () => {
    if (!state.ovData.map?.bounds) { toast('This map isn\u2019t lined up yet, so Keystone can\u2019t tell where a click is. Line up the map first.', 'error'); return; }
    setPlacing(!state.placing);
  });
  $('hereClear').addEventListener('click', () => call(keystone.clearHere()));
  $('findMeBtn').addEventListener('click', async () => {
    const b = $('findMeBtn');
    b.disabled = true;
    b.textContent = 'Finding you\u2026';
    const h = await call(keystone.findMe());
    b.disabled = false;
    b.textContent = 'Find me';
    if (h) toast(`Found you at ${coordText(h)}.`);
  });
  $('luSave').addEventListener('click', async () => {
    const r = await call(keystone.lineUpFindMe({ lat: $('luLat').value.trim(), lon: $('luLon').value.trim() }));
    if (r) { toast('Find me is lined up for this map.'); $('luLat').value = ''; $('luLon').value = ''; }
  });
  $('luReset').addEventListener('click', async () => {
    if (await call(keystone.resetFindMe())) toast('Back to the pack\u2019s values for this map.');
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
  keystone.onOverlayData((d) => {
    state.ovData = d;
    if (isPane('overlay')) renderOverlayData();
    // Evidence ticked on the phone shows here straight away.
    if (isPane('library') && state.lib.page.kind === 'identify') renderIdentify($('libMain'), state.lib.page);
  });
  keystone.onOverlayLive((v) => { state.ovLive = v; if (isPane('overlay')) paintOverlayLive(); });
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
// Catalogs a pack names something else ("npcs", "ghosts") fall back to a
// capitalized id.
const segLabel = (sg) => SEG_LABEL[sg] || sg.charAt(0).toUpperCase() + sg.slice(1);

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
  $('cmdSub').textContent = `${info.pack}. Pick what you want, set the details, and Keystone runs the command for you.`;
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
    const b = el('button', { text: segLabel(sg), 'aria-pressed': String(sg === c.seg) });
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
    // Paste only where the game's console supports it; prefix only when
    // there's a choice to make.
    $('setMode').querySelector('option[value="paste"]').hidden = !st.pasteSupported;
    $('setMode').closest('label').hidden = !st.pasteSupported;
    $('setPrefix').closest('label').hidden = st.prefixes.length < 2;
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
    const card = catCard(name, x, (c.info.thumbs || []).includes(name), { 'aria-pressed': String(x.id === c.selected) });
    card.addEventListener('click', () => { c.selected = x.id; c.values = {}; renderCatalog(); });
    return card;
  }));
  $('catMore').textContent = !matches.length ? 'Nothing matches. Try a shorter search.'
    : matches.length > LIMIT ? `Showing ${LIMIT} of ${matches.length}. Search or filter to narrow it down.` : `${matches.length} shown.`;
  renderForm(list.find((x) => x.id === c.selected) || null);
}

// Wiki thumbnail for a catalog entry (kslib:// in main), or null when the
// pack has none. A picture the wiki lacks just disappears.
function thumbImg(catalog, id) {
  const img = el('img', { class: 'cat-thumb', alt: '', loading: 'lazy', decoding: 'async', src: `kslib://thumb/${encodeURIComponent(catalog)}/${encodeURIComponent(id)}` });
  img.addEventListener('error', () => img.classList.add('none'));
  return img;
}

function catCard(catalog, x, withThumb, extra = {}, showId = false) {
  // Code lists show the code itself on the card, so there's no need to open
  // each one to read it.
  const meta = showId ? el('span', { class: 'cat-meta' }, el('span', { text: `${x.category} \u00b7 ` }), el('code', { class: 'cat-code', text: x.id }))
    : el('span', { class: 'cat-meta', text: [x.category, x.map].filter(Boolean).join(', ') });
  const text = el('span', { class: 'cat-text' }, el('span', { class: 'cat-name', text: x.name }), meta);
  return el('button', { class: `cat-card${withThumb ? ' has-thumb' : ''}`, ...extra }, withThumb ? thumbImg(catalog, x.id) : null, text);
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
  if (f.type === 'choice') {
    const sel = el('select', { class: 'field' }, ...f.options.map((o) => el('option', { value: String(o.value), text: o.label })));
    if (!f.options.some((o) => String(o.value) === String(bag[f.key]))) bag[f.key] = String(f.options[0].value);
    sel.value = String(bag[f.key]);
    sel.addEventListener('change', () => { bag[f.key] = sel.value; onChange(); });
    return el('label', {}, el('span', { text: f.label }), sel);
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
    if (isPane('commands')) {
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
  nav.replaceChildren(...[
    navBtn('Overview', { kind: 'home' }),
    info.sections.length ? el('h3', { text: 'Browse' }) : null,
    ...info.sections.map((sct) => navBtn(sct.label, { kind: 'section', catalog: sct.catalog, label: sct.label }, state.lib.entries[sct.catalog]?.length)),
    info.tools?.length ? el('h3', { text: 'Tools' }) : null,
    ...(info.tools || []).map((t) => navBtn(t.title, { kind: 'identify' })),
    el('h3', { text: 'Guides' }),
    navBtn('All guides', { kind: 'guides' }, info.guides.length),
  ].filter(Boolean));

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
  else if (page.kind === 'identify') renderIdentify(main, page);
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
  const kids = [el('h1', { text: info.game }), el('p', { class: 'lib-sub', text: 'Guides, reference pages and your own notes. Search covers everything.' })];
  if (info.sections.length) {
    kids.push(el('div', { class: 'lib-section-head' }, el('h2', { text: 'Browse' })));
    kids.push(el('div', { class: 'guide-cards' }, ...info.sections.map((sct) => {
      const card = el('button', { class: 'guide-card' }, el('span', { class: 'g-title', text: sct.label }), el('span', { class: 'g-sum', text: `Every ${sct.label.toLowerCase().replace(/s$/, '')} with its IDs, details and your notes.` }));
      card.addEventListener('click', () => libGo({ kind: 'section', catalog: sct.catalog, label: sct.label }));
      return card;
    })));
  }
  if (info.tools?.length) {
    kids.push(el('div', { class: 'lib-section-head' }, el('h2', { text: 'Tools' })));
    kids.push(el('div', { class: 'guide-cards' }, ...info.tools.map((t) => {
      const card = el('button', { class: 'guide-card tool-card' }, el('span', { class: 'g-title', text: t.title }), el('span', { class: 'g-sum', text: 'Tick the evidence you find or rule out, and see what it could be. Also on your phone.' }));
      card.addEventListener('click', () => libGo({ kind: 'identify' }));
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
  const sectionInfo = state.lib.info.sections.find((x) => x.catalog === page.catalog);
  const grid = el('div', { class: 'catalog-grid' });
  const more = el('p', { class: 'catalog-more' });
  const paint = () => {
    const q = f.q.trim().toLowerCase();
    const m = list.filter((x) => (!f.category || x.category === f.category) && (!f.map || x.map === f.map) && (!q || x.name.toLowerCase().includes(q)));
    if (q) m.sort((a, b) => rank(a.name, q) - rank(b.name, q) || a.name.localeCompare(b.name));
    const LIMIT = 300;
    grid.replaceChildren(...m.slice(0, LIMIT).map((x) => {
      const card = catCard(page.catalog, x, Boolean(sectionInfo?.pictures?.thumb), {}, sectionInfo?.idLabel === 'Code');
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
  const section = state.lib.info.sections.find((x) => x.catalog === page.catalog);
  // Catalogs used by commands show their IDs; reference-only ones (no
  // commands use them) don't need a made-up ID on show.
  if (e.commandActions.length || section?.idLabel !== 'ID') add(section?.idLabel || 'ID', [el('code', { text: e.id }), copyBtn(e.id)]);
  if (e.blueprint) add('Blueprint', [el('code', { text: e.blueprint }), copyBtn(e.blueprint)]);
  // Pack-provided details (evidence, price, what it does...).
  for (const [label, value] of Array.isArray(e.facts) ? e.facts : []) add(String(label), el('span', { text: String(value) }));
  const lists = (Array.isArray(e.lists) ? e.lists : []).filter(([, items]) => Array.isArray(items) && items.length)
    .map(([label, items]) => el('section', { class: 'block entry-list' }, el('h2', { text: String(label) }), el('ul', {}, ...items.map((t) => el('li', { text: String(t) })))));

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

  const pics = e.pictures;
  let figure = null;
  if (pics?.hero) {
    const img = el('img', { alt: e.name, decoding: 'async', src: `kslib://hero/${encodeURIComponent(page.catalog)}/${encodeURIComponent(e.id)}` });
    figure = el('figure', { class: 'entry-hero loading' }, img);
    img.addEventListener('load', () => figure.classList.remove('loading'));
    img.addEventListener('error', () => figure.remove());
  }
  // replaceChildren() would print a null as the text "null".
  main.replaceChildren(...[
    back,
    el('h1', { text: e.name }),
    figure,
    el('dl', { class: 'entry-grid' }, ...rows),
    actions.length ? el('div', { class: 'entry-actions' }, ...actions) : null,
    ...lists,
    pics?.spawnMaps?.length ? spawnSection(page.catalog, e, pics) : null,
    el('section', { class: 'block' }, el('h2', { text: 'My notes' }), note),
    pics?.credit ? creditLine(pics) : null,
  ].filter(Boolean));
}

function creditLine(pics) {
  const p = el('p', { class: 'pic-credit', text: `${pics.credit}.` });
  if (pics.creditUrl) {
    const a = el('a', { href: '#', text: ' Visit the wiki' });
    a.addEventListener('click', (ev) => { ev.preventDefault(); call(keystone.openBrowser(pics.creditUrl)); });
    p.append(a);
  }
  return p;
}

// Where a creature spawns, one tab per map. Which maps it's on isn't known
// up front: every map's overlay is requested, and the tabs that load stay.
function spawnSection(catalog, e, pics) {
  const q = (part, i) => `kslib://${part}/${i}/${encodeURIComponent(catalog)}/${encodeURIComponent(e.id)}`;
  const tabs = el('div', { class: 'cat-tabs spawn-tabs', role: 'tablist' });
  const base = el('img', { alt: '', class: 'spawn-base' });
  const over = el('img', { alt: '', class: 'spawn-over' });
  const stage = el('div', { class: 'spawn-stage' }, base, over);
  const section = el('section', { class: 'block spawn-block', hidden: '' },
    el('h2', { text: 'Where it spawns' }), tabs, stage,
    el('div', { class: 'spawn-legend' }, ...[['#0F0', 'Very common'], ['#B2FF00', 'Common'], ['#FF0', 'Uncommon'], ['#FC0', 'Very uncommon'], ['#F60', 'Rare'], ['#F00', 'Very rare']].map(([c, t]) => {
      const sw = el('span', { class: 'sw' });
      sw.style.background = c;
      return el('span', {}, sw, el('span', { text: t }));
    })),
    el('p', { class: 'block-note', text: 'Spawn maps come from the ARK Wiki and may show the original ARK: Survival Evolved layout for remade maps.' }));
  const found = [];
  const show = (i) => {
    base.src = q('spawnmap', i);
    over.src = q('spawn', i);
    for (const b of tabs.children) b.setAttribute('aria-pressed', String(Number(b.dataset.i) === i));
  };
  for (const m of pics.spawnMaps) {
    const probe = new Image();
    probe.onload = () => {
      found.push(m.index);
      const b = el('button', { 'data-i': String(m.index), text: m.name });
      b.addEventListener('click', () => show(m.index));
      // Keep the pack's map order, not the order the probes answered in.
      const after = [...tabs.children].find((x) => Number(x.dataset.i) > m.index);
      tabs.insertBefore(b, after || null);
      if (section.hidden || m.index < Math.min(...found.filter((i) => i !== m.index))) { section.hidden = false; show(m.index); }
    };
    probe.src = q('spawn', m.index);
  }
  return section;
}

// ---------- identifier ----------
const MARK_TEXT = { found: 'Found', out: 'Ruled out' };

async function renderIdentify(main, page) {
  const info = await call(keystone.identifyInfo());
  if (!info || state.lib.page !== page) return;
  paintIdentify(main, info);
}

function paintIdentify(main, info) {
  const redraw = async (p) => { const next = await call(p); if (next && state.lib.page.kind === 'identify') paintIdentify(main, next); };
  const evButtons = info.traits.map((t) => {
    const mark = info.marks[t.id] || null;
    const b = el('button', { class: `ev-btn ${mark || 'none'}${info.useful.includes(t.id) ? ' useful' : ''}`, title: 'Click: found, again: ruled out, again: not checked' },
      el('span', { class: 'ev-mark', text: mark === 'found' ? '\u2713' : mark === 'out' ? '\u2715' : '' }),
      el('span', { class: 'ev-name', text: t.name }),
      el('span', { class: 'ev-state', text: MARK_TEXT[mark] || (info.useful.includes(t.id) ? 'Worth checking' : '') }));
    b.addEventListener('click', () => redraw(keystone.identifyCycle(t.id)));
    return b;
  });
  const given = el('select', { class: 'field' }, ...info.givenOptions.map((o) => el('option', { value: String(o.value), text: o.label })));
  given.value = String(info.given);
  given.addEventListener('change', () => redraw(keystone.identifyGiven(Number(given.value))));
  const reset = el('button', { class: 'btn small', text: 'New contract' });
  reset.addEventListener('click', () => redraw(keystone.identifyReset()));

  const left = info.candidates.filter((c) => c.possible);
  const out = info.candidates.filter((c) => !c.possible);
  const name = (id) => info.traits.find((t) => t.id === id)?.name || id;
  const card = (c) => {
    const ev = el('span', { class: 'gh-ev' }, ...c.traits.map((t) => el('span', { class: `chip ${info.marks[t] || ''}${c.forced.includes(t) ? ' forced' : ''}`, text: name(t), title: c.forced.includes(t) ? 'Always shown, even when fewer pieces are given' : '' })));
    const b = el('div', { class: `gh-card${c.possible ? '' : ' out'}` },
      el('button', { class: 'gh-main', title: 'Open its page' }, el('span', { class: 'gh-name', text: c.name }), ev, c.possible ? null : el('span', { class: 'gh-why', text: c.why })));
    b.querySelector('.gh-main').addEventListener('click', () => libGo({ kind: 'entry', catalog: info.catalog, id: c.id, back: { kind: 'identify', label: info.title } }));
    const strike = el('button', { class: 'btn small ghost', text: info.struck.includes(c.id) ? 'Bring back' : 'Rule out', title: 'For behaviour that rules it out, like a hunt speed or a ghost event' });
    strike.addEventListener('click', () => redraw(keystone.identifyStrike(c.id)));
    if (c.possible || info.struck.includes(c.id)) b.append(strike);
    return b;
  };
  const verdict = left.length === 1 ? `It\u2019s the ${left[0].name}.` : left.length === 0 ? 'Nothing fits. Check what you\u2019ve marked, or the evidence setting.' : `${left.length} of ${info.candidates.length} still possible.`;
  main.replaceChildren(...[
    el('h1', { text: info.title }),
    el('div', { class: 'ident-bar' }, el('label', { class: 'inline-field' }, el('span', { text: info.givenLabel }), given), reset),
    el('div', { class: 'ev-grid' }, ...evButtons),
    el('p', { class: `ident-verdict${left.length === 1 ? ' solved' : ''}`, text: verdict }),
    el('div', { class: 'gh-grid' }, ...left.map(card)),
    out.length ? el('details', { class: 'gh-out' }, el('summary', { text: `Ruled out (${out.length})` }), el('div', { class: 'gh-grid' }, ...out.map(card))) : null,
  ].filter(Boolean));
}

// Jumps to Commands with this entry picked and the chosen action selected.
function openInCommands(catalog, entry, actionId) {
  state.cmd.pendingSelect = { catalog, id: entry.id, name: entry.name, action: actionId };
  state.cmd.seg = catalog;
  setTab('commands');
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
// ---------- table store ----------
async function loadStore() {
  const data = await call(keystone.storeList());
  if (data) setStore(data);
}

function setStore(data) {
  state.store.data = data;
  $('tablesBadge').hidden = !data.updates;
  $('tablesBadge').textContent = String(data.updates || '');
  if (state.view === 'tables') renderStore();
}

const CHECK_NOTE = {
  login: 'Log in on the table’s page to get update alerts',
  challenge: 'Couldn’t check for updates yet (the site was busy)',
  error: 'Couldn’t check for updates (no connection?)',
};

function storeStatusLine(t) {
  const i = t.installed;
  if (!i) return t.note || state.store.data?.sites?.[t.host]?.name || t.host;
  if (t.status === 'update') return `New version: ${i.latestName || 'on the page'}`;
  if (i.check && CHECK_NOTE[i.check]) return CHECK_NOTE[i.check];
  return i.lastChecked ? `Up to date · checked ${agoText(i.lastChecked)}` : `Installed ${agoText(i.at)}`;
}

// "40 mods · 12 scripts · 5 need Cheat Engine", from the installed file.
function worksText(s) {
  const bits = [];
  if (s.mods) bits.push(`${s.mods} mod${s.mods === 1 ? '' : 's'}`);
  if (s.scripts) bits.push(`${s.scripts} script${s.scripts === 1 ? '' : 's'}`);
  if (!bits.length && s.luaStartup) bits.push('Makes its mods with Lua');
  const missing = s.needsCE + s.types;
  if (missing) bits.push(`${missing} need${missing === 1 ? 's' : ''} Cheat Engine`);
  return bits.join(' · ') || 'Nothing Keystone can run';
}

function storeCard(t) {
  const art = el('div', { class: 'tile-art' });
  const initials = el('span', { class: 'initials', text: t.game });
  initials.hidden = true;
  art.append(initials, artImg(t.packId, 'cover', () => { initials.hidden = false; }));
  const flags = el('div', { class: 'tile-flags' });
  const sum = t.installed?.summary;
  const missing = sum ? sum.needsCE + sum.types : 0;
  const works = sum ? sum.mods + sum.scripts : 0;
  if (t.status === 'update') flags.append(el('span', { class: 'badge accent', text: 'Update' }));
  else if (t.status === 'installed') flags.append(el('span', { class: 'badge ok', text: 'Installed' }));
  if (sum && missing && works) flags.append(el('span', { class: 'badge warn', text: 'Partly works' }));
  else if (sum && missing && !sum.luaStartup) flags.append(el('span', { class: 'badge warn', text: 'Needs Cheat Engine' }));
  if (t.offlineOnly) flags.append(el('span', { class: 'badge warn', text: 'Offline only' }));
  art.append(flags);

  const open = async () => { if (await call(keystone.storeOpen(t.id))) toast(t.status === 'get' ? 'Download the table on its page. Keystone installs it for you.' : 'Download the newest file on its page. Keystone swaps it in.'); };
  const tile = el('button', { class: 'game-tile', title: `${t.title}: open its page` },
    art,
    el('span', { class: 'tile-name', text: t.title }),
    el('span', { class: 'tile-sub', text: t.author ? `${t.game} · by ${t.author}` : t.game }));
  tile.addEventListener('click', open);

  const label = t.status === 'update' ? 'Get update' : t.status === 'installed' ? 'Open page' : 'Get';
  const actions = el('div', { class: 'store-actions' },
    el('button', { class: `btn small${t.status === 'installed' ? '' : ' primary'}`, text: label, onclick: open }));
  if (t.installed && missing) {
    actions.append(el('button', {
      class: 'btn small ghost',
      text: 'Cheat Engine',
      title: 'Open this table in Cheat Engine, for the parts Keystone can’t run',
      onclick: () => call(keystone.storeOpenInCE(t.id)),
    }));
  }
  if (t.installed) {
    actions.append(el('button', {
      class: 'btn small ghost',
      text: 'Remove',
      title: 'Delete this table from your PC',
      onclick: async () => {
        if (!(await confirmBox(`Remove ${t.title}? Its file is deleted from this PC. Mods already showing stay until you reopen the game.`, 'Remove'))) return;
        if (await call(keystone.storeRemove(t.id))) toast(`Removed ${t.title}.`);
      },
    }));
  }
  return el('div', { class: `store-card${t.status === 'update' ? ' has-update' : ''}` }, tile,
    sum ? el('p', { class: `store-works${missing ? ' partly' : ''}`, text: worksText(sum) }) : null,
    el('p', { class: 'store-status', text: storeStatusLine(t) }), actions);
}

function renderStore() {
  const d = state.store.data;
  if (!d) return;
  const q = state.store.q.trim().toLowerCase();
  const f = state.store.filter;
  for (const b of $('storeFilter').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.filter === f));
  const site = Object.values(d.sites || {})[0];
  $('storeLogin').textContent = site?.login || '';
  $('storeLogin').hidden = !site?.login;
  $('storeCheck').disabled = state.store.checking || !d.tables.some((t) => t.installed);
  $('storeCheck').textContent = state.store.checking ? 'Checking…' : 'Check for updates';

  const shown = d.tables
    .filter((t) => !q || `${t.game} ${t.title} ${t.author || ''}`.toLowerCase().includes(q))
    .filter((t) => f === 'all' || (f === 'installed' && t.installed) || (f === 'update' && t.status === 'update'))
    // Updates first, then by game, keeping the catalog's order within a game.
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (b.t.status === 'update') - (a.t.status === 'update') || a.t.game.localeCompare(b.t.game) || a.i - b.i)
    .map(({ t }) => t);
  $('storeGrid').replaceChildren(...shown.map(storeCard));
  if (!shown.length) {
    const why = q ? `No tables match "${state.store.q}".`
      : f === 'installed' ? 'No tables installed yet. Pick one under All.'
        : f === 'update' ? 'Everything you have is up to date.' : 'The store is empty.';
    $('storeGrid').replaceChildren(el('p', { class: 'pop-note', text: why }));
  }
}

function wireStore() {
  $('storeSearch').addEventListener('input', (e) => { state.store.q = e.target.value; renderStore(); });
  $('storeFilter').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-filter]');
    if (!b) return;
    state.store.filter = b.dataset.filter;
    renderStore();
  });
  $('storeCheck').addEventListener('click', async () => {
    state.store.checking = true;
    renderStore();
    const data = await call(keystone.storeCheck());
    state.store.checking = false;
    if (data) {
      setStore(data);
      toast(data.updates ? `${data.updates} table update${data.updates === 1 ? '' : 's'} available.` : 'Your tables are up to date.');
    } else renderStore();
  });
  keystone.onStoreChanged(setStore);
  keystone.onStoreNotice(({ text, kind }) => toast(text, kind));
  keystone.onGoto((view) => go(view));
}

async function loadAppSettings() {
  const st = await call(keystone.appSettings());
  if (!st) return;
  $('setTray').checked = st.closeToTray;
  $('setAuto').checked = st.autoAttach;
  $('setLogin').checked = st.startWithWindows;
  $('setLogin').disabled = !st.canStartWithWindows;
  $('loginNote').textContent = st.canStartWithWindows
    ? 'It starts quietly in the tray.'
    : 'Available in the installed app. You\u2019re running Keystone from its source folder.';
  $('aboutLine').textContent = `Keystone ${st.version}. Settings folder: ${st.dataDir}`;
  renderSwatches(st.accent);
}

function renderSwatches(current) {
  $('swatches').replaceChildren(...KeystoneTheme.ACCENTS.map((a) => {
    const b = el('button', { class: 'swatch', role: 'radio', 'aria-checked': String(a.id === (current || 'keystone')), title: a.label },
      el('span', { class: 'chip-color', style: { background: a.hex } }), el('span', { text: a.label }));
    b.addEventListener('click', async () => {
      KeystoneTheme.applyAccent(a.id);
      const st = await call(keystone.setAccent(a.id));
      if (st) renderSwatches(st.accent);
    });
    return b;
  }));
}

function wireAppSettings() {
  $('setTray').addEventListener('change', (e) => call(keystone.setCloseToTray(e.target.checked)));
  $('setAuto').addEventListener('change', (e) => call(keystone.setAutoAttach(e.target.checked)));
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
  wireStore();
  wireLibrary();
  wireCommands();
  $('noModsCommands').addEventListener('click', () => setTab('commands'));
  wireOverlay();

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
  for (const t of document.querySelectorAll('.nav .tab')) t.addEventListener('click', () => go(t.dataset.view));
  for (const b of document.querySelectorAll('#gameTabs button')) b.addEventListener('click', () => setTab(b.dataset.tab));

  $('refreshBtn').addEventListener('click', refreshProcesses);
  $('gameSearch').addEventListener('input', (e) => { state.gameSearch = e.target.value; renderHome(); });
  $('homeFilter').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-filter]');
    if (b) { state.homeFilter = b.dataset.filter; renderHome(); }
  });
  $('procSearch').addEventListener('input', (e) => { state.procFilter = e.target.value; renderHome(); });
  $('modSearch').addEventListener('input', (e) => { state.filter = e.target.value; renderMods(); });
  $('detachBtn').addEventListener('click', async () => {
    const snap = await call(keystone.detach());
    if (snap) { state.snapshot = snap; go('home'); }
  });
  $('playBtn').addEventListener('click', async () => {
    const id = state.snapshot.packId;
    if (!id) return;
    state.launching = true;
    render();
    if (await call(keystone.launchGame(id)) === undefined) { state.launching = false; render(); return; }
    toast('Starting the game. Keystone connects as soon as it’s running.');
  });

  // Offline-only games: mods stay off until the person turns them on and
  // accepts the warning.
  $('modsSwitch').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const on = b.dataset.v === 'on';
    const snap = state.snapshot;
    if (on === snap.modsSwitch) return;
    if (on && !(await confirmBox(`${snap.offlineNote || 'Mods only work offline.'}\n\nOnly turn mods on when you’re playing offline or solo. Using them online can get your account banned.`, 'Turn mods on'))) return;
    const res = await call(keystone.setModsEnabled(on));
    if (res) { state.snapshot = res.snapshot; render(); for (const n of res.notices) toast(n); }
  });

  $('privateBtn').addEventListener('click', async () => {
    const snap = state.snapshot;
    const ac = snap.antiCheat || 'the anti-cheat';
    const start = !snap.privateServer;
    if (start && !(await confirmBox(`Only for a server you run (or one whose owner allows mods) with ${ac} turned off.\n\nKeystone checks ${ac} isn’t running, turns mods on until the game closes, and lets go of the game at once if ${ac} starts. Mods change your game only: things the server keeps track of won’t change.`, 'Use mods this session'))) return;
    const res = await call(keystone.setPrivateServer(start));
    if (res) { state.snapshot = res.snapshot; render(); for (const n of res.notices) toast(n); }
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
  wireFinder();
  $('tablesFolderBtn').addEventListener('click', async () => {
    const dir = await call(keystone.openTablesFolder());
    if (dir) toast('Put .CT files here and they load every time this game starts.');
  });

  keystone.onStructure((snap) => {
    const before = `${state.snapshot.game?.key}|${state.snapshot.game?.offline}`;
    const after = `${snap.game?.key}|${snap.game?.offline}`;
    state.snapshot = snap;
    if (!snap.game?.offline) state.launching = false;
    render();
    // A different game (or the game starting/stopping) changes what the
    // Commands and Library screens can do, so refresh them then, not on
    // every mod toggle.
    if (before !== after) loadTab();
  });
  keystone.onValues((vals) => {
    for (const [id, v] of Object.entries(vals)) {
      const rec = state.snapshot.records.find((r) => r.id === id);
      if (rec) Object.assign(rec, { current: v.current, status: v.status, error: v.error });
      patchValue(id, v);
    }
  });
  keystone.onDetached(({ name }) => toast(`${name.replace(/\.exe$/i, '')} closed.`));
  // Messages from a table's Lua (showMessage, a timer that stopped).
  keystone.onSessionNotice((text) => toast(text));
  // A game started outside Keystone was picked up. From the library, go to
  // its page; anywhere else (Settings, the phone screen) just say so.
  keystone.onAutoAttached(({ game, notices }) => {
    state.launching = false;
    toast(`${game} detected.`);
    for (const n of notices || []) toast(n);
    if (state.view === 'home') { state.gameTab = defaultTab(state.snapshot); go('game'); }
  });
  keystone.onNotice((msg) => { state.launching = false; render(); if (msg) toast(msg, 'error'); });
  keystone.onAppearance((a) => KeystoneTheme.applyAccent(a.accent));

  // Keep the library fresh (games get launched after Keystone).
  setInterval(() => { if (state.view === 'home' && !document.hidden) refreshProcesses(); }, 5000);
}

(async function init() {
  wire();
  const look = await call(keystone.appearance());
  KeystoneTheme.applyAccent(look?.accent);
  const p = await call(keystone.platform());
  if (p) state.platform = p.platform;
  const snap = await call(keystone.getSession());
  if (snap) state.snapshot = snap;
  render();
  refreshProcesses();
  loadRemote();
  // For the update badge on the sidebar.
  loadStore();
})();
