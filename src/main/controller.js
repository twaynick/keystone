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
const { LibraryModel } = require('./library');

// Everything the app can do, independent of Electron. The desktop window
// calls it over IPC; the phone remote calls the same methods, so both always
// see and change the same state.

const MAX_PROFILE_NAME = 40;

class Controller extends EventEmitter {
  constructor({ packsDir, dataDir, commands = {} }) {
    super();
    this.packsDir = packsDir;
    // Bundled packs, plus a folder where users can drop their own.
    this.userPacksDir = path.join(dataDir, 'packs');
    this.store = new GameStore(dataDir);
    this.session = null;
    this.game = null;
    this.pack = null;
    this.modsError = null;
    this.overlay = new OverlayModel(this, { dataDir });
    this.commands = new CommandsModel(this, commands);
    this.library = new LibraryModel(this, { dataDir });
  }

  // Games Keystone has a pack for, marked running or not, for the switcher.
  listGames() {
    const running = listProcesses();
    return loadPacks([this.packsDir, this.userPacksDir])
      .filter((p) => !p.error && p.exe.length && !p.exe.includes('demo.exe'))
      .map((p) => {
        const proc = running.find((r) => p.exe.includes(r.name.toLowerCase()));
        return { id: p.id, name: p.name, exe: p.exe[0], running: Boolean(proc), pid: proc?.pid || null };
      })
      .sort((a, b) => (b.running - a.running) || a.name.localeCompare(b.name));
  }

  listProcesses() {
    return listProcesses();
  }

  // Selects a game and, when possible, attaches to its memory for mods.
  //
  // The two are separate on purpose: games with anti-cheat (ASA on a
  // BattlEye server, for one) refuse memory access, but commands, the map and
  // waypoints don't need it. So a failed memory attach still selects the game.
  attach({ pid, name, demo, packId }) {
    this.detach();
    if (demo) { pid = 0; name = 'demo.exe'; }
    // Picking a game from its pack: attach to it if it's running, otherwise
    // select it offline (RCON, map, waypoints and notes still work).
    let offline = false;
    if (packId) {
      const g = this.listGames().find((x) => x.id === packId);
      if (!g) throw new Error('That game pack is missing.');
      if (g.running) { pid = g.pid; name = g.exe; } else { pid = null; name = g.exe; offline = true; }
    }
    this.game = { key: String(name).toLowerCase(), name, pid, demo: Boolean(demo), offline };
    this.modsError = null;
    // Re-read packs on every attach so a pack dropped into the folder while
    // Keystone is open gets picked up without a restart.
    this.pack = findPack(loadPacks([this.packsDir, this.userPacksDir]), name);

    const notices = [];
    let memory = null;
    if (offline) {
      this.modsError = 'the game isn\u2019t running';
    } else try {
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
    else if (!offline) this._watchProcess(pid, name);

    this.overlay.onAttach();
    this.emit('structure', this.snapshot());
    this.emit('overlay');
    return { snapshot: this.snapshot(), notices };
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
    // Reload the tables used last time, then the active profile. Order
    // matters: profile toggles point at record ids that only exist once the
    // tables are loaded.
    const saved = this.store.load(this.game.key);
    for (const t of saved.tables) {
      if (!fs.existsSync(t)) { notices.push(`Couldn't find ${path.basename(t)} any more, so it wasn't reloaded.`); continue; }
      try { this._loadTable(t, { remember: false }); } catch (err) { notices.push(`${path.basename(t)}: ${err.message}`); }
    }
    if (saved.autoApply && saved.activeProfile && saved.profiles[saved.activeProfile]) {
      const { skipped } = session.importToggles(saved.profiles[saved.activeProfile].toggles);
      notices.push(`Applied profile "${saved.activeProfile}".`);
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

  _gameExited(name) {
    this._teardown();
    this.emit('detached', { name });
    this.emit('structure', this.snapshot());
    this.emit('overlay');
  }

  detach() {
    if (!this.game) return this.snapshot();
    this._teardown();
    this.emit('structure', this.snapshot());
    this.emit('overlay');
    return this.snapshot();
  }

  _teardown() {
    const s = this.session;
    this.session = null;
    this.game = null;
    this.pack = null;
    this.modsError = null;
    clearInterval(this._watch);
    this._watch = null;
    if (s) {
      s.removeAllListeners();
      s.close();
    }
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
    const { skipped } = s.importToggles(profile.toggles);
    this.store.update(this.game.key, (d) => { d.activeProfile = name; });
    this.emit('structure', this.snapshot());
    return { skipped: skipped.length };
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
    return {
      attached: true,
      ...base,
      mods: Boolean(this.session),
      modsError: this.modsError,
      profiles: this.profileSummary(),
      pack: this.pack ? this.pack.name : null,
      displayName: this.game.demo ? 'Demo game' : (this.pack?.name || this.game.name.replace(/\.exe$/i, '')),
      hasCommands: Boolean(this.pack?.commands),
    };
  }

  values() {
    return this.session ? this.session.valuesSnapshot() : {};
  }

  shutdown() {
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
