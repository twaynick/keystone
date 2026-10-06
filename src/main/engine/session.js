'use strict';

const { EventEmitter } = require('events');
const address = require('./address');
const values = require('./values');
const { ScriptRunner } = require('./autoasm');
const { LuaHost } = require('./lua');

// One attached game: its memory backend, the loaded mod records, and the
// per-record state (frozen or not, target value, last read value).
//
// Events:
//   'structure' – records or toggles changed (send a full snapshot)
//   'values'    – current values refreshed (send live readouts)
//   'detached'  – the game exited
//   'notice'    – a message from a table's Lua (showMessage, a timer that stopped)
//
// Two loops run while attached:
//   freeze loop (50 ms)  – rewrites every enabled record's target value. Games
//                          overwrite values constantly, so a one-off write
//                          would last a frame; rewriting is what "freeze" means.
//   read loop (250 ms)   – reads current values for the UI. 4 Hz is plenty for
//                          eyes and keeps phone/overlay traffic low.

class Session extends EventEmitter {
  constructor({ memory, processName, pid, freezeMs = 50, readMs = 250 }) {
    super();
    this.memory = memory;
    this.processName = processName;
    this.pid = pid;
    // Tells one run of the game from the next (the pointer finder's
    // "check after a restart" needs to know it's a new run).
    this.runId = require('crypto').randomUUID();
    this.freezeMs = freezeMs;
    this.readMs = readMs;
    this.records = [];
    this.state = new Map();
    this.tables = [];
    this._timers = [];
    // Names Cheat Engine scripts register, which other mods' addresses use.
    this.symbols = new Map();
    // One Lua state per game, shared by all its tables (as in Cheat
    // Engine): a table's startup script defines functions its mods use.
    this._lua = null;
    this.scripts = new ScriptRunner(memory, this.symbols, { lua: () => this.lua() });
  }

  lua() {
    if (!this._lua) this._lua = new LuaHost(this);
    return this._lua;
  }

  // A table's own Lua script (<LuaScript>), run when the table loads.
  runTableScript(code, tableName) {
    this.lua().resetMade(`ct:${tableName}`);
    return this.lua().run(code, { name: tableName, table: `ct:${tableName}` });
  }

  get gameKey() {
    return String(this.processName).toLowerCase();
  }

  start() {
    this.stop();
    this._timers.push(setInterval(() => this.freezeTick(), this.freezeMs));
    this._timers.push(setInterval(() => this.readTick(), this.readMs));
    this.readTick();
  }

  stop() {
    for (const t of this._timers) clearInterval(t);
    this._timers = [];
  }

  close() {
    this.stop();
    // Leave the game as it was: scripts patch its code, and a patch with
    // nothing managing it any more (Keystone closing, switching games)
    // could crash it later, e.g. a jump into a code cave that gets freed.
    try { if (this.memory.isAlive()) this.disableScripts(); } catch { /* game gone */ }
    // After the scripts: their [DISABLE] sections may need Lua.
    this._lua?.close();
    try { this.memory.close(); } catch { /* already gone */ }
  }

  // Turns off every script that's on, newest first. Best effort.
  disableScripts() {
    const on = this.records.filter((r) => r.kind === 'script' && this.state.get(r.id)?.enabled).reverse();
    for (const r of on) {
      try { this.scripts.run(r.id, r.script, 'disable', { name: r.name }); } catch { /* keep going */ }
      this.state.get(r.id).enabled = false;
    }
  }

  // Adds a table's records. Re-loading the same table replaces its old records
  // (by id prefix) instead of duplicating them.
  addRecords(records, tableName, prefix = records[0]?.id.split(':').slice(0, 2).join(':')) {
    if (prefix) {
      this.records = this.records.filter((r) => !r.id.startsWith(prefix + ':'));
      for (const id of [...this.state.keys()]) if (id.startsWith(prefix + ':')) this.state.delete(id);
    }
    this.records.push(...records);
    for (const r of records) this._initState(r);
    if (tableName && !this.tables.includes(tableName)) this.tables.push(tableName);
    this.readTick();
    this.emit('structure');
  }

  _initState(r) {
    this.state.delete(r.id);
    if (r.kind === 'value') this.state.set(r.id, { enabled: false, target: null, current: null, status: 'pending', error: null });
    if (r.kind === 'script') this.state.set(r.id, { enabled: false, target: null, current: null, status: null, error: null });
  }

  // Adds or replaces one record (mods a table's Lua makes). A new one goes
  // after the last record nested under 'after', or at the end. The caller
  // emits 'structure' once it's done changing records.
  putRecord(rec, { after = null } = {}) {
    const i = this.records.findIndex((r) => r.id === rec.id);
    if (i >= 0) {
      const old = this.records[i];
      this.records[i] = rec;
      // Same kind keeps its switch and value; a value that became a script
      // (or the reverse) starts fresh.
      if (old.kind !== rec.kind || !this.state.has(rec.id)) this._initState(rec);
      return;
    }
    let at = this.records.length;
    const p = after ? this.records.findIndex((r) => r.id === after) : -1;
    if (p >= 0) {
      at = p + 1;
      while (at < this.records.length && this.records[at].depth > this.records[p].depth) at++;
    }
    this.records.splice(at, 0, rec);
    this._initState(rec);
  }

  // Moves a record (and what's nested under it) to sit under another.
  moveRecord(id, parentId) {
    const i = this.records.findIndex((r) => r.id === id);
    if (i < 0) return;
    let end = i + 1;
    while (end < this.records.length && this.records[end].depth > this.records[i].depth) end++;
    const block = this.records.splice(i, end - i);
    const p = this.records.findIndex((r) => r.id === parentId);
    let at = this.records.length;
    if (p >= 0) {
      at = p + 1;
      while (at < this.records.length && this.records[at].depth > this.records[p].depth) at++;
    }
    this.records.splice(at, 0, ...block);
  }

  removeRecord(id) {
    const i = this.records.findIndex((r) => r.id === id);
    if (i < 0) return;
    let end = i + 1;
    while (end < this.records.length && this.records[end].depth > this.records[i].depth) end++;
    for (const r of this.records.slice(i, end).reverse()) {
      if (r.kind === 'script' && this.state.get(r.id)?.enabled) {
        try { this.scripts.run(r.id, r.script, 'disable', { name: r.name }); } catch { /* keep going */ }
      }
      this.state.delete(r.id);
    }
    this.records.splice(i, end - i);
  }

  getRecord(id) {
    return this.records.find((r) => r.id === id);
  }

  setEnabled(id, enabled) {
    if (this.getRecord(id)?.kind === 'script') return this._setScript(id, enabled);
    const rec = this._valueRecord(id);
    const st = this.state.get(id);
    if (enabled && (st.target === null || st.target === undefined)) {
      // No target typed yet: freeze whatever the game has right now. That's
      // what people expect from "lock this value".
      const cur = this._read(rec);
      if (cur === null) throw new Error(`"${rec.name}" can't be read right now, so there's no value to freeze. Type a value first or try again in game.`);
      st.target = cur;
    }
    st.enabled = Boolean(enabled);
    if (st.enabled) this._write(rec, st.target);
    this.emit('structure');
  }

  // Runs a script's [ENABLE] or [DISABLE] section. A failure leaves the
  // game untouched (autoasm undoes partial writes) and shows on the mod.
  _setScript(id, enabled) {
    const rec = this.getRecord(id);
    const st = this.state.get(id);
    const on = Boolean(enabled);
    if (st.enabled === on) return;
    try {
      this.scripts.run(id, rec.script, on ? 'enable' : 'disable', { name: rec.name });
      st.enabled = on;
      st.status = 'ok';
      st.error = null;
    } catch (err) {
      st.status = 'error';
      st.error = err.message;
      this.emit('structure');
      throw new Error(`"${rec.name}" didn't turn ${on ? 'on' : 'off'}: ${err.message}`);
    }
    this.readTick();
    this.emit('structure');
  }

  setTarget(id, value) {
    const rec = this._valueRecord(id);
    const st = this.state.get(id);
    if (value === '' || value === null || value === undefined) {
      st.target = null;
    } else {
      values.encode(rec.valueType, value); // validates
      st.target = Number(value);
      if (st.enabled) this._write(rec, st.target);
    }
    this.emit('structure');
  }

  // One-shot write without freezing ("Set" button).
  applyValue(id, value) {
    const rec = this._valueRecord(id);
    if (!this._write(rec, Number(value))) {
      throw new Error(`Couldn't write "${rec.name}". The game may be on a loading screen.`);
    }
    this.state.get(id).target = Number(value);
    this.readTick();
    this.emit('structure');
  }

  // Bulk state for profiles: { [id]: { enabled, target } }
  exportToggles() {
    const out = {};
    for (const [id, st] of this.state) {
      if (st.enabled || st.target !== null) out[id] = { enabled: st.enabled, target: st.target };
    }
    return out;
  }

  // Applies saved toggles. Unknown ids (table changed since saving) are
  // skipped and reported rather than failing the whole profile.
  importToggles(toggles, { replace = true } = {}) {
    const skipped = [];
    const failed = [];
    const want = toggles || {};
    // Scripts first, in table order: values often read through a symbol a
    // script registers. Scripts not in the profile turn off when replacing.
    for (const rec of this.records) {
      if (rec.kind !== 'script') continue;
      const on = Boolean(want[rec.id]?.enabled);
      if (!on && !replace) continue;
      try { this._setScript(rec.id, on); } catch (err) { failed.push(err.message); }
    }
    if (replace) {
      for (const [id, st] of this.state) {
        if (this.getRecord(id)?.kind === 'script') continue;
        st.enabled = false; st.target = null;
      }
    }
    for (const [id, t] of Object.entries(want)) {
      const st = this.state.get(id);
      if (!st) { skipped.push(id); continue; }
      if (this.getRecord(id)?.kind === 'script') continue;
      st.target = t.target ?? null;
      st.enabled = Boolean(t.enabled) && st.target !== null;
    }
    this.freezeTick();
    this.emit('structure');
    return { skipped, failed };
  }

  freezeTick() {
    for (const rec of this.records) {
      if (rec.kind !== 'value') continue;
      const st = this.state.get(rec.id);
      if (st.enabled && st.target !== null) this._write(rec, st.target);
    }
  }

  readTick() {
    if (!this.memory.isAlive()) {
      this.stop();
      this.emit('detached');
      return;
    }
    for (const rec of this.records) {
      if (rec.kind !== 'value') continue;
      const st = this.state.get(rec.id);
      try {
        const addr = address.resolve(rec, this.memory, this.symbols);
        const buf = this.memory.read(addr, values.sizeOf(rec.valueType));
        if (!buf) throw new address.AddressError('Unreadable address');
        st.current = values.decode(rec.valueType, buf);
        st.status = 'ok';
        st.error = null;
      } catch (err) {
        st.current = null;
        st.status = 'waiting';
        st.error = err.message;
      }
    }
    this.emit('values', this.valuesSnapshot());
  }

  snapshot() {
    return {
      game: { name: this.processName, pid: this.pid, key: this.gameKey, tables: [...this.tables] },
      records: this.records.map((r) => {
        const st = this.state.get(r.id);
        return {
          id: r.id,
          name: r.name,
          kind: r.kind,
          depth: r.depth,
          groupPath: r.groupPath,
          valueType: r.valueType || null,
          reason: r.reason || null,
          enabled: st?.enabled || false,
          target: st?.target ?? null,
          current: st?.current ?? null,
          status: st?.status || null,
          error: st?.error || null,
          // Value-finder mods on an address that changes every run.
          ...(r.sessionOnly ? { sessionOnly: true } : {}),
        };
      }),
    };
  }

  valuesSnapshot() {
    const out = {};
    for (const [id, st] of this.state) out[id] = { current: st.current, status: st.status, enabled: st.enabled, error: st.error };
    return out;
  }

  _valueRecord(id) {
    const rec = this.getRecord(id);
    if (!rec) throw new Error(`No mod with id ${id}`);
    if (rec.kind !== 'value') throw new Error(`"${rec.name}" can't be toggled: ${rec.reason || 'not a value'}`);
    return rec;
  }

  _read(rec) {
    try {
      const addr = address.resolve(rec, this.memory, this.symbols);
      const buf = this.memory.read(addr, values.sizeOf(rec.valueType));
      return buf ? values.decode(rec.valueType, buf) : null;
    } catch {
      return null;
    }
  }

  _write(rec, value) {
    try {
      const addr = address.resolve(rec, this.memory, this.symbols);
      return this.memory.write(addr, values.encode(rec.valueType, value));
    } catch {
      // Unresolvable right now (loading screen); the next tick retries.
      return false;
    }
  }
}

module.exports = { Session };
