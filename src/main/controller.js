'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { Session } = require('./engine/session');
const { parseCheatTable } = require('./engine/ct-parser');
const { DemoGame } = require('./engine/demo-game');
const { listProcesses } = require('./engine/process-list');
const { GameStore } = require('./store');
const { loadPacks, findPack } = require('./packs');
const { OverlayModel } = require('./overlay-model');
const { CommandsModel } = require('./commands/model');
const { FinderModel } = require('./finder');
const { autoTables, folderName } = require('./tables');
const { LibraryModel } = require('./library');
const hotkeys = require('./hotkeys');
const { InstalledGames, launchFor } = require('./installed');
const { IdentifyModel } = require('./identify');

// Everything the app can do, independent of Electron. The desktop window
// calls it over IPC; the phone remote calls the same methods, so both always
// see and change the same state.

const MAX_PROFILE_NAME = 40;

class Controller extends EventEmitter {
  constructor({ packsDir, dataDir, tablesDir = null, commands = {}, installed = {}, clipboard = null }) {
    super();
    // Electron's clipboard ({ readText, writeText }); Find me reads ARK's ccc
    // output from it. Injected so tests can fake it.
    this.clipboard = clipboard;
    // App-wide countdown timers (timers.js), set by main once settings exist.
    this.timers = null;
    this.packsDir = packsDir;
    // Bundled packs, plus a folder where users can drop their own.
    this.userPacksDir = path.join(dataDir, 'packs');
    // Tables that load by themselves (tables.js): shipped next to the packs,
    // and a per-PC folder of your own.
    this.tablesDir = tablesDir || path.join(packsDir, '..', 'tables');
    this.userTablesDir = path.join(dataDir, 'tables');
    this.autoLoaded = [];
    this.store = new GameStore(dataDir);
    this.session = null;
    this.game = null;
    this.pack = null;
    this.modsError = null;
    this.overlay = new OverlayModel(this, { dataDir });
    this.commands = new CommandsModel(this, commands);
    this.finder = new FinderModel(this);
    this.library = new LibraryModel(this, { dataDir });
    this.identify = new IdentifyModel(this);
    this.installed = new InstalledGames(installed);
  }

  _packs() {
    return loadPacks([this.packsDir, this.userPacksDir]);
  }

  // The library: every pack plus whether (and from which store) it's
  // installed on this PC.
  async listGamesWithInstalled() {
    const games = this.listGames();
    const hits = await this.installed.match(this._packs().filter((p) => !p.error));
    // Kept for snapshot(), which is synchronous: the library is always listed
    // before a game page opens, so this is warm by then.
    this._installedHits = hits;
    for (const g of games) {
      const hit = hits.get(g.id);
      g.installed = hit ? { store: hit.store, path: hit.path } : null;
      g.canLaunch = g.canLaunch || Boolean(launchFor(hit));
    }
    // Installed (and running) games first, like a launcher's library.
    return games.sort((a, b) => (a.demo - b.demo) || (b.running - a.running) || (Boolean(b.installed) - Boolean(a.installed)) || a.name.localeCompare(b.name));
  }

  // Games Keystone has a pack for, marked running or not, for the library.
  listGames() {
    const running = this.listProcesses(); // via the method so tests can stub it
    return loadPacks([this.packsDir, this.userPacksDir])
      .filter((p) => !p.error && p.exe.length)
      .map((p) => {
        const demo = p.exe.includes('demo.exe');
        const proc = demo ? null : running.find((r) => p.exe.includes(r.name.toLowerCase()));
        return {
          id: p.id,
          name: p.name,
          exe: p.exe[0],
          demo,
          running: demo ? false : Boolean(proc),
          pid: proc?.pid || null,
          hasArt: Boolean(p.art),
          canLaunch: Boolean(p.launch),
          offlineOnly: p.offlineOnly,
          noMods: !p.memory,
          hasCommands: Boolean(p.commands),
        };
      })
      .sort((a, b) => (a.demo - b.demo) || (b.running - a.running) || a.name.localeCompare(b.name));
  }

  listProcesses() {
    return listProcesses();
  }

  // Selects a game and, when allowed and possible, attaches to its memory
  // for mods.
  //
  // The two are separate on purpose: games with anti-cheat (ASA on a
  // BattlEye server, for one) refuse memory access, but commands, the map and
  // waypoints don't need it. So a game can be selected without mods.
  attach({ pid, name, demo, packId }) {
    this.detach();
    if (packId) {
      const g = this.listGames().find((x) => x.id === packId);
      if (!g) throw new Error('That game pack is missing.');
      if (g.demo) demo = true;
      else { pid = g.running ? g.pid : null; name = g.exe; }
    }
    if (demo) { pid = 0; name = 'demo.exe'; }
    // Picked from the library while not running: selected "offline" so RCON,
    // the map, waypoints and the Library still work.
    const offline = !demo && !pid;
    this.game = { key: String(name).toLowerCase(), name, pid, demo: Boolean(demo), offline, since: offline ? null : Date.now() };
    this.modsError = null;
    // Re-read packs on every attach so a pack dropped into the folder while
    // Keystone is open gets picked up without a restart.
    this.pack = findPack(loadPacks([this.packsDir, this.userPacksDir]), name);

    const notices = [];
    if (offline) this.modsError = 'the game isn\u2019t running';
    else this._connectMemory(notices);

    this.overlay.onAttach();
    this.emit('structure', this.snapshot());
    this.emit('overlay');
    return { snapshot: this.snapshot(), notices };
  }

  // Why mods are off for the selected game before even trying, or null.
  modsBlocked() {
    if (!this.game || this.game.demo) return null;
    if (this.pack && !this.pack.memory) return 'online-only';
    if (this.pack?.offlineOnly && !this.store.load(this.game.key).modsEnabled) return 'offline-off';
    return null;
  }

  _connectMemory(notices) {
    const { name, pid, demo } = this.game;
    const blocked = this.modsBlocked();
    if (blocked) {
      // Never even open the process: an anti-cheat sees the attempt, not
      // just a successful read.
      this.modsError = blocked === 'online-only' ? 'this game is online-only' : 'mods are off for this game';
      this._watchProcess(pid, name);
      return;
    }
    let memory = null;
    try {
      if (demo) {
        memory = new DemoGame();
      } else {
        // Required lazily: koffi's kernel32 bindings only exist on Windows.
        const { WinMemory } = require('./engine/win-memory');
        memory = new WinMemory(pid);
      }
    } catch (err) {
      this.modsError = err.message;
      notices.push(`Mods aren't available for this game (${err.message}) Commands, the map and waypoints still work.`);
    }
    if (memory) this._startSession(memory, name, pid, notices);
    else this._watchProcess(pid, name);
  }

  // Turns mods on or off for an offline-only game. Turning them on while the
  // game runs attaches right away; turning them off drops the memory session
  // but keeps the game selected.
  setModsEnabled(on) {
    const g = this._requireGame();
    this.store.update(g.key, (d) => { d.modsEnabled = Boolean(on); });
    const notices = [];
    if (!on && this.session) {
      this._dropSession();
      this.modsError = 'mods are off for this game';
      this._watchProcess(g.pid, g.name);
    } else if (on && !this.session && !g.offline) {
      clearInterval(this._watch);
      this.modsError = null;
      this._connectMemory(notices);
    }
    this.emit('structure', this.snapshot());
    this.emit('overlay');
    return { snapshot: this.snapshot(), notices };
  }

  // Waits for a just-launched game to start, then attaches to it.
  waitForLaunch(packId, { timeoutMs = 180_000, everyMs = 2000 } = {}) {
    clearInterval(this._launchWait);
    const started = Date.now();
    return new Promise((resolve) => {
      this._launchWait = setInterval(() => {
        const g = this.listGames().find((x) => x.id === packId);
        if (g?.running) {
          clearInterval(this._launchWait);
          this._launchWait = null;
          // A few extra seconds lets the game finish creating its window
          // before Keystone looks for it.
          setTimeout(() => {
            try { resolve(this.attach({ packId })); } catch (err) { resolve({ error: err.message }); }
          }, 4000);
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(this._launchWait);
          this._launchWait = null;
          resolve({ error: 'The game didn\u2019t start within 3 minutes.' });
        }
      }, everyMs);
    });
  }

  // Picks up a game started outside Keystone (from Steam, a desktop shortcut,
  // a restart after a crash). Called every few seconds by main.
  //
  // Only steps in when nothing live is attached, and never switches away from
  // a game the person has open: if they're on one game's page, only that game
  // starting attaches. A game has to stay up for `graceMs` first, so the
  // launcher stub some games run for a second isn't grabbed, and the game has
  // its window by the time the overlay looks for it.
  autoAttachTick({ graceMs = 4000, now = Date.now() } = {}) {
    if (this._launchWait) return null; // Play is already waiting for it
    if (this.game && !this.game.offline) return null;
    const running = this.listGames().filter((g) => g.running && g.pid !== this._skipPid);
    const pick = this.game
      ? running.find((g) => g.exe.toLowerCase() === this.game.key)
      : running[0];
    if (!pick) { this._seen = null; return null; }
    if (this._seen?.pid !== pick.pid) { this._seen = { pid: pick.pid, since: now }; return null; }
    if (now - this._seen.since < graceMs) return null;
    this._seen = null;
    // A failure is reported once, not every tick: that process is skipped.
    try { return { game: pick.name, ...this.attach({ packId: pick.id }) }; } catch (err) { this._skipPid = pick.pid; throw err; }
  }

  // How to start a game: through the store it's installed from, else the
  // pack's own launch info. Installed copy first: a pack names one Steam
  // app, but the player may own another edition (Fallout 3 vs its GOTY
  // edition) or have it on GOG or Epic.
  async launchTarget(packId) {
    const p = this._packs().find((x) => x.id === packId);
    const hit = p ? (await this.installed.match([p])).get(p.id) : null;
    if (!hit && p?.launch) return { kind: 'uri', uri: p.launch.uri };
    const t = launchFor(hit);
    if (!t) throw new Error('Keystone doesn\u2019t know how to start this game. Start it yourself and it\u2019ll be picked up.');
    return t;
  }

  _startSession(memory, name, pid, notices) {
    const session = new Session({ memory, processName: name, pid });
    session.on('structure', () => this.emit('structure', this.snapshot()));
    session.on('values', (v) => this.emit('values', v));
    session.on('detached', () => this._gameExited(name));
    this.session = session;
    session.start();

    if (this.pack?.table) {
      try { this._loadTable(this.pack.table, { remember: false }); } catch (err) { notices.push(`${this.pack.name} pack: ${err.message}`); }
    }
    // Bundled and personal tables for this game, with their credits.
    this.autoLoaded = [];
    for (const t of autoTables({ bundledDir: this.tablesDir, userDir: this.userTablesDir }, this.pack, this.game)) {
      try {
        this._loadTable(t.file, { remember: false });
        this.autoLoaded.push({ name: t.name, source: t.source, author: t.author, url: t.url, note: t.note });
      } catch (err) { notices.push(`${t.name}: ${err.message}`); }
    }
    // Reload the tables used last time, then the active profile. Order
    // matters: profile toggles point at record ids that only exist once the
    // tables are loaded.
    const saved = this.store.load(this.game.key);
    for (const t of saved.tables) {
      if (!fs.existsSync(t)) { notices.push(`Couldn't find ${path.basename(t)} any more, so it wasn't reloaded.`); continue; }
      try { this._loadTable(t, { remember: false }); } catch (err) { notices.push(`${path.basename(t)}: ${err.message}`); }
    }
    // Mods made with the value finder, before the profile: it may use them.
    try { this.finder.load(); } catch (err) { notices.push(`My mods: ${err.message}`); }
    if (saved.autoApply && saved.activeProfile && saved.profiles[saved.activeProfile]) {
      const { skipped, failed } = session.importToggles(saved.profiles[saved.activeProfile].toggles);
      notices.push(`Applied profile "${saved.activeProfile}".`);
      for (const f of failed || []) notices.push(f);
      if (skipped.length) notices.push(`${skipped.length} saved mods aren't in the loaded tables and were skipped.`);
    }
  }

  // Without a memory session there's no handle to notice the game closing,
  // so poll the process list (needs no access to the game itself).
  _watchProcess(pid, name) {
    if (process.platform !== 'win32' || !pid) return;
    this._watch = setInterval(() => {
      if (!listProcesses().some((p) => p.pid === pid)) this._gameExited(name);
    }, 3000);
    this._watch.unref?.();
  }

  // The game closed: keep it selected (its page, map and Library stay open)
  // but drop the memory session.
  _gameExited(name) {
    this._dropSession();
    clearInterval(this._watch);
    this._watch = null;
    if (this.game) {
      this.game.pid = null;
      this.game.offline = true;
      this.game.since = null;
      this.modsError = 'the game isn\u2019t running';
    }
    this.emit('detached', { name });
    this.emit('structure', this.snapshot());
    this.emit('overlay');
  }

  _dropSession() {
    const s = this.session;
    this.session = null;
    if (s) {
      s.removeAllListeners();
      s.close();
    }
  }

  detach() {
    if (!this.game) return this.snapshot();
    // Detaching from a running game by hand means "leave it alone": don't let
    // auto-attach grab the same process again a few seconds later.
    if (this.game.pid) this._skipPid = this.game.pid;
    this._teardown();
    this.emit('structure', this.snapshot());
    this.emit('overlay');
    return this.snapshot();
  }

  _teardown() {
    this._dropSession();
    this.game = null;
    this.pack = null;
    this.modsError = null;
    clearInterval(this._watch);
    this._watch = null;
  }

  // This game's personal tables folder (created on first use), for "Tables folder".
  userTablesFolder() {
    if (!this.game) throw new Error('Choose a game first.');
    const dir = path.join(this.userTablesDir, folderName(this.pack, this.game));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  // A table just installed from the Tables tab, for the game that's open
  // right now: load it straight away instead of on the next start.
  loadInstalledTables(packId, files) {
    if (!this.session || this.pack?.id !== packId) return false;
    const credits = new Map(autoTables({ bundledDir: null, userDir: this.userTablesDir }, this.pack, this.game).map((t) => [t.file, t]));
    for (const f of files) {
      this._loadTable(f, { remember: false });
      const t = credits.get(f) || { name: path.basename(f).replace(/\.ct$/i, '') };
      this.autoLoaded.push({ name: t.name, source: 'mine', author: t.author || null, url: t.url || null, note: t.note || null });
    }
    this.emit('structure', this.snapshot());
    return true;
  }

  loadTableFile(filePath) {
    const records = this._loadTable(filePath, { remember: true });
    return { snapshot: this.snapshot(), summary: summarize(records, path.basename(filePath)) };
  }

  _loadTable(filePath, { remember }) {
    const s = this._requireSession();
    const xml = fs.readFileSync(filePath, 'utf8');
    const tableName = path.basename(filePath);
    // Source name goes into record ids, so ids stay stable across reloads of
    // the same file and saved profiles keep matching.
    const records = parseCheatTable(xml, { sourceName: tableName.replace(/\.ct$/i, '') });
    if (!records.length) throw new Error(`${tableName} has no entries.`);
    s.addRecords(records, tableName);
    if (remember) {
      const abs = path.resolve(filePath);
      this.store.update(this.game.key, (d) => {
        if (!d.tables.includes(abs)) d.tables.push(abs);
      });
    }
    return records;
  }

  setEnabled(id, enabled) { this._requireSession().setEnabled(id, enabled); return true; }
  setTarget(id, value) { this._requireSession().setTarget(id, value); return true; }
  applyValue(id, value) { this._requireSession().applyValue(id, value); return true; }

  // ---------- hotkeys, pins, quick actions ----------

  setHotkey(id, accel) {
    const s = this._requireSession();
    const rec = s.getRecord(id);
    if (!rec || (rec.kind !== 'value' && rec.kind !== 'script')) throw new Error('Only mods that can be switched can have a hotkey.');
    const clean = accel ? hotkeys.normalize(accel) : null;
    const d = this.store.load(this.game.key);
    if (clean) {
      const taken = Object.entries(d.hotkeys || {}).find(([other, a]) => a === clean && other !== id);
      if (taken) {
        const otherRec = s.getRecord(taken[0]);
        throw new Error(`${clean} is already used by "${this._label(otherRec) || 'another mod'}".`);
      }
    }
    this.store.update(this.game.key, (data) => {
      data.hotkeys = { ...(data.hotkeys || {}) };
      if (clean) data.hotkeys[id] = clean; else delete data.hotkeys[id];
    });
    this.emit('structure', this.snapshot());
    return clean;
  }

  setPinned(id, on) {
    this._requireGame();
    this.store.update(this.game.key, (d) => {
      const set = new Set(d.pinned || []);
      if (on) set.add(id); else set.delete(id);
      d.pinned = [...set];
    });
    this.emit('structure', this.snapshot());
    this.emit('overlay');
    return Boolean(on);
  }

  // Hotkeys for the open game, only while mods are connected.
  activeHotkeys() {
    if (!this.session) return {};
    const ids = new Set(this.session.records.map((r) => r.id));
    return Object.fromEntries(Object.entries(this.store.load(this.game.key).hotkeys || {}).filter(([id]) => ids.has(id)));
  }

  _label(rec) {
    if (!rec) return null;
    const u = this.pack?.modsUi?.[rec.groupPath.concat(rec.name).join('/')];
    return u?.label || rec.name;
  }

  // What a hotkey (or a tap in the overlay or on the phone) does to a mod,
  // depending on its control:
  //   apply   writes the pack's value once
  //   steps   moves to the next value; past the last one, turns off
  //   toggle  On at the pack's value / Off
  //   other   On (keeps the current target, or the game's value) / Off
  quickAction(id) {
    const s = this._requireSession();
    const rec = s.getRecord(id);
    if (!rec || (rec.kind !== 'value' && rec.kind !== 'script')) throw new Error('That mod can\u2019t be switched.');
    const st = s.state.get(id);
    if (rec.kind === 'script') {
      s.setEnabled(id, !st.enabled);
      return { label: this._label(rec), state: st.enabled ? 'On' : 'Off' };
    }
    const ui = this.pack?.modsUi?.[rec.groupPath.concat(rec.name).join('/')] || {};
    const label = ui.label || rec.name;
    if (ui.control === 'apply') {
      s.applyValue(id, ui.value);
      return { label, state: 'Applied' };
    }
    if (ui.control === 'steps' && Array.isArray(ui.values) && ui.values.length) {
      const i = st.enabled ? ui.values.findIndex((v) => Number(v) === Number(st.target)) : -1;
      if (i === ui.values.length - 1) { s.setEnabled(id, false); return { label, state: 'Off' }; }
      const next = ui.values[i + 1];
      s.setTarget(id, next);
      s.setEnabled(id, true);
      return { label, state: ui.labels?.[i + 1] ?? String(next) };
    }
    if (st.enabled) { s.setEnabled(id, false); return { label, state: 'Off' }; }
    if (ui.control === 'toggle' && ui.value !== undefined) s.setTarget(id, ui.value);
    s.setEnabled(id, true);
    return { label, state: 'On' };
  }

  // ---------- profiles ----------

  saveProfile(name, { overwrite = true } = {}) {
    const s = this._requireSession();
    const clean = cleanName(name);
    const data = this.store.load(this.game.key);
    if (!overwrite && data.profiles[clean]) throw new Error(`A profile named "${clean}" already exists.`);
    this.store.update(this.game.key, (d) => {
      d.profiles[clean] = { toggles: s.exportToggles(), updatedAt: new Date().toISOString() };
      d.activeProfile = clean;
    });
    this.emit('structure', this.snapshot());
    return clean;
  }

  applyProfile(name) {
    const s = this._requireSession();
    const data = this.store.load(this.game.key);
    const profile = data.profiles[name];
    if (!profile) throw new Error(`No profile named "${name}".`);
    const { skipped, failed } = s.importToggles(profile.toggles);
    this.store.update(this.game.key, (d) => { d.activeProfile = name; });
    this.emit('structure', this.snapshot());
    return { skipped: skipped.length, failed };
  }

  deleteProfile(name) {
    const s = this._requireSession();
    this.store.update(this.game.key, (d) => {
      if (!d.profiles[name]) throw new Error(`No profile named "${name}".`);
      delete d.profiles[name];
      if (d.activeProfile === name) d.activeProfile = null;
    });
    this.emit('structure', this.snapshot());
    return true;
  }

  renameProfile(from, to) {
    const s = this._requireSession();
    const clean = cleanName(to);
    this.store.update(this.game.key, (d) => {
      if (!d.profiles[from]) throw new Error(`No profile named "${from}".`);
      if (clean !== from && d.profiles[clean]) throw new Error(`A profile named "${clean}" already exists.`);
      d.profiles[clean] = d.profiles[from];
      if (clean !== from) delete d.profiles[from];
      if (d.activeProfile === from) d.activeProfile = clean;
    });
    this.emit('structure', this.snapshot());
    return clean;
  }

  // "No profile": keep the current locks but stop tracking (and auto-applying) a profile.
  clearActiveProfile() {
    const s = this._requireSession();
    this.store.update(this.game.key, (d) => { d.activeProfile = null; });
    this.emit('structure', this.snapshot());
    return true;
  }

  setAutoApply(on) {
    const s = this._requireSession();
    this.store.update(this.game.key, (d) => { d.autoApply = Boolean(on); });
    this.emit('structure', this.snapshot());
    return true;
  }

  profileSummary() {
    if (!this.session) return null;
    const d = this.store.load(this.game.key);
    const names = Object.keys(d.profiles).sort((a, b) => a.localeCompare(b));
    const active = d.activeProfile && d.profiles[d.activeProfile] ? d.activeProfile : null;
    return {
      names,
      active,
      autoApply: d.autoApply,
      // "Unsaved changes" = current toggles differ from the active profile.
      dirty: active ? !sameToggles(this.session.exportToggles(), d.profiles[active].toggles) : false,
    };
  }

  // ---------- state ----------

  snapshot() {
    if (!this.game) return { attached: false, game: null, records: [], profiles: null, pack: null, mods: false, modsError: null };
    const base = this.session
      ? this.session.snapshot()
      : { game: { name: this.game.name, pid: this.game.pid, key: this.game.key, tables: [], offline: this.game.offline }, records: [] };
    // Pack presentation (friendly labels, sliders, steps), hotkeys and pins
    // ride along on each record, so the desktop, overlay and phone agree.
    const ui = this.pack?.modsUi || {};
    const saved = this.store.load(this.game.key);
    const keys = saved.hotkeys || {};
    const pinned = new Set(saved.pinned || []);
    base.records = base.records.map((r) => {
      const u = ui[r.groupPath.concat(r.name).join('/')];
      const extra = {};
      if (u) { extra.label = u.label || r.name; extra.ui = u; }
      if (keys[r.id]) extra.hotkey = keys[r.id];
      if (pinned.has(r.id)) extra.pinned = true;
      return Object.keys(extra).length ? { ...r, ...extra } : r;
    });
    return {
      attached: true,
      ...base,
      mods: Boolean(this.session),
      modsError: this.modsError,
      modsBlocked: this.modsBlocked(),
      offlineOnly: Boolean(this.pack?.offlineOnly),
      offlineNote: this.pack?.offlineNote || null,
      // Tables that loaded by themselves, with who made them.
      autoTables: this.session ? this.autoLoaded : [],
      profiles: this.profileSummary(),
      pack: this.pack ? this.pack.name : null,
      packId: this.pack ? this.pack.id : null,
      canLaunch: Boolean(this.pack?.launch || (this.pack && launchFor(this._installedHits?.get(this.pack.id)))),
      installed: (this.pack && this._installedHits?.get(this.pack.id)?.store) || null,
      displayName: this.game.demo ? 'Demo game' : (this.pack?.name || this.game.name.replace(/\.exe$/i, '')),
      hasCommands: Boolean(this.pack?.commands),
      identify: this._identifyBrief(),
      timerPresets: (this.pack?.timerPresets || []).map((t) => t.name),
      // Timers are app-wide; the checklist is the one the overlay shows.
      timers: this.timers ? this.timers.list() : [],
      checklist: this.overlay.activeList(),
      // All the lists, for the phone's list picker.
      checklists: this.overlay.checklists().map((l) => ({ id: l.id, name: l.name, total: l.items.length, done: l.items.filter((i) => i.done).length })),
      // The phone's Map tab (marker points come separately).
      map: this.overlay.phoneMap(),
      // Whether the phone gets a Library tab.
      library: Boolean(this.pack?.library),
      // For the phone's Teleport list.
      teleport: this.overlay.teleportMethod()
        ? { waypoints: this.overlay.waypoints().map((w) => ({ id: w.id, name: w.name })), tracked: this.store.load(this.game.key).overlay.tracked || null }
        : null,
    };
  }

  values() {
    return this.session ? this.session.valuesSnapshot() : {};
  }

  // The identifier, trimmed for the phone and overlay.
  _identifyBrief() {
    const i = this.identify.info();
    if (!i) return null;
    return {
      title: i.title, traits: i.traits, marks: i.marks, given: i.given, givenOptions: i.givenOptions,
      left: i.candidates.filter((c) => c.possible).map((c) => ({ id: c.id, name: c.name })),
      total: i.candidates.length, useful: i.useful,
    };
  }

  shutdown() {
    clearInterval(this._launchWait);
    this._teardown();
    this.commands.shutdown();
  }

  _requireSession() {
    if (!this.game) throw new Error('Attach to a game first.');
    if (!this.session) throw new Error(this.modsError ? `Mods aren't available for this game: ${this.modsError}` : 'Attach to a game first.');
    return this.session;
  }

  _requireGame() {
    if (!this.game) throw new Error('Choose a game first.');
    return this.game;
  }
}

function cleanName(name) {
  const clean = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (!clean) throw new Error('Give the profile a name.');
  if (clean.length > MAX_PROFILE_NAME) throw new Error(`Keep profile names under ${MAX_PROFILE_NAME} characters.`);
  return clean;
}

function sameToggles(a, b) {
  const norm = (t) => JSON.stringify(Object.keys(t).sort().map((k) => [k, Boolean(t[k].enabled), t[k].target ?? null]));
  return norm(a || {}) === norm(b || {});
}

function summarize(records, tableName) {
  const count = (k) => records.filter((r) => r.kind === k).length;
  return { table: tableName, values: count('value'), scripts: count('script'), unsupported: count('unsupported') };
}

module.exports = { Controller };
