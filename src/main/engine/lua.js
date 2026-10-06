'use strict';

const path = require('path');
const address = require('./address');
const { recordFromEntry } = require('./ct-parser');

// Cheat Engine's Lua, for the tables that use it: Lua script entries,
// {$lua} blocks inside Auto Assembler scripts, and a table's own startup
// script (<LuaScript>).
//
// The Lua interpreter is the real one (Lua 5.4, via wasmoon, compiled to
// WebAssembly). Cheat Engine uses 5.3; scripts written for it run the same
// apart from rare corner cases.
//
// It runs in a locked box. Inside WebAssembly a script can only reach the
// functions handed to it here: the attached game's memory, the table's
// mods, timers. No files, no programs, no network, and no Cheat Engine
// features that run code inside the game (those say so when called). One
// run is stopped after a few seconds so a script that never ends can't
// freeze Keystone.
//
// Values cross between Lua and JavaScript as strings and plain numbers only:
// addresses and 64-bit integers travel as hex text, since JavaScript numbers
// can't hold every 64-bit value.

class LuaError extends Error {}

let luaModule = null;
let loading = null;

// The WebAssembly module loads asynchronously, once; after that, each
// game's Lua state is created synchronously, when its first script needs it.
function preloadLua() {
  if (!loading) {
    const { LuaFactory } = require('wasmoon');
    const wasm = path.join(path.dirname(require.resolve('wasmoon')), 'glue.wasm');
    loading = new LuaFactory(wasm).getLuaModule().then((m) => { luaModule = m; return m; });
  }
  return loading;
}

const RUN_LIMIT_MS = 3000;
const MAX_READ = 16 * 1024 * 1024;

// Cheat Engine's value-type constants (memrec.Type).
const VT = { byte: 0, int16: 1, int32: 2, int64: 3, float: 4, double: 5 };
const CE_TYPE_NAME = { 0: 'Byte', 1: '2 Bytes', 2: '4 Bytes', 3: '8 Bytes', 4: 'Float', 5: 'Double', 6: 'String', 7: 'String', 8: 'Array of byte', 9: 'Binary', 12: 'Pointer', 13: 'Custom' };

// Readable error text: "God mode:3: boom" -> "line 3: boom", and Lua's
// message for a missing Cheat Engine function made plain.
function cleanError(err, name) {
  let msg = String(err?.message || err).replace(/^Error: /, '');
  if (/thread timeout exceeded/.test(msg)) return `it ran for more than ${RUN_LIMIT_MS / 1000} seconds without finishing, so Keystone stopped it.`;
  const missing = msg.match(/attempt to call a nil value \((?:global|field|method) '([^']+)'\)/);
  if (missing) return `it uses ${missing[1]}, a Cheat Engine Lua feature Keystone doesn't have.`;
  if (name) msg = msg.split(`${name}:`).join('line ');
  return msg.replace(/^line (\d+): /, 'Lua error on line $1: ');
}

class LuaHost {
  // session: the attached game's Session (memory, records, symbols, scripts).
  constructor(session, { runLimitMs = RUN_LIMIT_MS } = {}) {
    this.session = session;
    this.mem = session.memory;
    this.runLimitMs = runLimitMs;
    this.engine = null;
    this.depth = 0;
    this.deadline = null;
    this.table = null;
    this.dirty = false;
    this.made = new Map(); // table prefix -> mods made with createMemoryRecord
    this.timers = new Map();   // id -> interval handle
    this.deferred = new Set(); // createThread callbacks waiting to run
    this.log = [];
    this.aaRuns = 0;
    this.closed = false;
  }

  _engine() {
    if (this.closed) throw new LuaError('The game has closed.');
    if (this.engine) return this.engine;
    if (!luaModule) throw new LuaError('Lua is still starting. Try again in a moment.');
    const { LuaEngine } = require('wasmoon');
    const engine = new LuaEngine(luaModule, { injectObjects: false, enableProxy: false, functionTimeout: this.runLimitMs });
    for (const [name, fn] of Object.entries(this._natives())) engine.global.set(name, fn);
    engine.global.loadString(PRELUDE, '=keystone');
    engine.global.runSync();
    this.dispatchTimer = engine.global.get('__ks_dispatch_timer');
    this.dispatchThread = engine.global.get('__ks_dispatch_thread');
    engine.doStringSync('__ks_dispatch_timer = nil; __ks_dispatch_thread = nil');
    this.engine = engine;
    return engine;
  }

  // Runs a chunk of Lua. Returns its first result.
  // table: the record id prefix ("ct:MyTable") of the table the code
  // belongs to, so its lookups by ID find its own mods first.
  run(code, { name = 'script', recordId = null, table = null, limitMs = null } = {}) {
    const engine = this._engine();
    const g = engine.global;
    const chunk = String(name).replace(/[\r\n]/g, ' ').slice(0, 60) || 'script';
    // Nested runs (a script switching another script on) share the
    // outermost run's time limit.
    const outer = this.depth === 0;
    if (outer) this.deadline = Date.now() + (limitMs || this.runLimitMs);
    g.setTimeout(this.deadline);
    this.depth++;
    const top = g.getTop();
    const prevTable = this.table;
    this.table = table || (recordId ? recordId.split(':').slice(0, 2).join(':') : prevTable);
    try {
      g.set('memrec', recordId || undefined);
      engine.doStringSync(`memrec = memrec and __ks_memrec(memrec) or nil; syntaxcheck = false`);
      g.loadString(String(code), `=${chunk}`);
      const out = g.runSync();
      return out[0];
    } catch (err) {
      throw new LuaError(cleanError(err, chunk));
    } finally {
      g.setTop(top);
      this.table = prevTable;
      this.depth--;
      if (outer) { g.setTimeout(undefined); this.deadline = null; this._flush(); }
    }
  }

  // Mods made or changed from Lua show up once the script is done, not one
  // redraw per line.
  _flush() {
    if (!this.dirty) return;
    this.dirty = false;
    this.session.readTick();
    this.session.emit('structure');
  }

  // A table being (re)loaded starts its Lua-made mods' numbering again, so
  // they get the same ids every time and saved mods keep finding them.
  resetMade(prefix) {
    this.made.set(prefix, 0);
  }

  close() {
    this.closed = true;
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
    this.deferred.clear();
    try { this.engine?.global.close(); } catch { /* already closed */ }
    this.engine = null;
  }

  _notice(text) {
    this.session.emit('notice', String(text));
  }

  // ---------- address helpers ----------

  _addr(x) {
    const s = String(x ?? '').trim();
    if (!s) throw new LuaError('No address given.');
    const v = this.session.scripts.evaluate(s);
    if (v === null) throw new LuaError(`Couldn't find the address "${s}".`);
    return v;
  }

  _rec(id) {
    const r = this.session.getRecord(String(id));
    if (!r) throw new LuaError('That memory record no longer exists.');
    return r;
  }

  // Rebuilds a Lua-made mod from its settings, then the ones nested under
  // it (their group follows the parent's name).
  _rebuild(id) {
    const s = this.session;
    const old = this._rec(id);
    const spec = old.spec;
    const parent = spec.parent ? s.getRecord(spec.parent) : null;
    const groupPath = parent ? [...parent.groupPath, parent.name] : [];
    const entry = {
      Description: spec.Description,
      GroupHeader: spec.IsGroupHeader ? '1' : '0',
      VariableType: CE_TYPE_NAME[spec.Type] || 'Custom',
      Address: spec.Address || undefined,
      ShowAsHex: spec.ShowAsHex ? '1' : '0',
      Offsets: { Offset: spec.Offsets.map((o) => { const b = BigInt(o); return b < 0n ? `-${(-b).toString(16)}` : b.toString(16); }) },
    };
    if (spec.Type === 11) { entry.VariableType = 'Auto Assembler Script'; entry.AssemblerScript = spec.Script || ''; }
    const rec = { ...recordFromEntry(entry, id, groupPath), spec, luaMade: true };
    s.putRecord(rec);
    for (const c of s.records.filter((r) => r.spec?.parent === id)) this._rebuild(c.id);
    this.dirty = true;
  }

  // ---------- the functions Lua gets (wrapped by PRELUDE below) ----------

  _natives() {
    const mem = this.mem;
    const s = this.session;
    const hex = (v) => (BigInt.asUintN(64, BigInt(v))).toString(16);
    return {
      __ks_read: (a, n) => {
        const size = Number(n);
        if (!(size >= 0) || size > MAX_READ) throw new LuaError(`Can't read ${n} bytes at once.`);
        let at;
        try { at = this._addr(a); } catch { return undefined; }
        const buf = mem.read(at, size);
        return buf ? buf.toString('hex') : undefined;
      },
      __ks_write: (a, h) => {
        let at;
        try { at = this._addr(a); } catch { return false; }
        const buf = Buffer.from(String(h), 'hex');
        if (!buf.length) return true;
        const prot = mem.protect?.(at, buf.length, 0x40);
        const ok = mem.write(at, buf);
        if (prot !== null && prot !== undefined && prot !== 0x40) mem.protect(at, buf.length, prot);
        return Boolean(ok);
      },
      __ks_addr: (a) => {
        try { return hex(this._addr(a)); } catch { return undefined; }
      },
      __ks_name: (a) => {
        const at = BigInt('0x' + a);
        for (const m of mem.modules?.values?.() || []) {
          const base = BigInt(m.base);
          if (at >= base && at < base + BigInt(m.size)) return `${m.name}+${(at - base).toString(16).toUpperCase()}`;
        }
        return at.toString(16).toUpperCase();
      },
      __ks_regsym: (name, a) => { s.symbols.set(String(name).toLowerCase(), BigInt('0x' + a)); return true; },
      __ks_unregsym: (name) => { s.symbols.delete(String(name).toLowerCase()); return true; },
      __ks_aob: (pattern, moduleName, unique) => s.scripts.aobScan(String(pattern), moduleName || null, Boolean(unique)).map(hex).join(' '),
      __ks_aa: (script, which, id) => {
        const runId = id || `lua:${++this.aaRuns}`;
        s.scripts.run(runId, String(script), which === 'disable' ? 'disable' : 'enable', { name: 'autoAssemble' });
        return runId;
      },
      __ks_alloc: (size, near) => hex(mem.alloc(Math.max(1, Number(size) || 1), near ? BigInt('0x' + near) : null)),
      __ks_free: (a) => { mem.free(BigInt('0x' + a)); return true; },
      __ks_protect: (a, size) => { mem.protect?.(BigInt('0x' + a), Number(size), 0x40); return true; },
      __ks_module: (name) => {
        const m = mem.getModule(String(name));
        return m ? `${BigInt(m.base).toString(16)} ${Number(m.size).toString(16)}` : undefined;
      },
      __ks_modules: () => [...(mem.modules?.values?.() || [])].map((m) => `${m.name}\t${BigInt(m.base).toString(16)}\t${Number(m.size).toString(16)}`).join('\n'),
      __ks_process: () => `${s.processName}\t${s.pid || 0}\t${(mem.pointerSize || 8) === 8 ? 1 : 0}`,
      __ks_print: (text) => {
        this.log.push(String(text));
        if (this.log.length > 200) this.log.shift();
      },
      __ks_notice: (text) => { this._notice(text); },
      __ks_now: () => Date.now(),
      __ks_sleep: (ms) => {
        // Blocks, like Cheat Engine's sleep; the run's time limit still applies.
        const n = Math.min(Math.max(Number(ms) || 0, 0), 1000);
        if (n) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n);
      },
      __ks_timer: (id, interval, on) => {
        clearInterval(this.timers.get(id));
        this.timers.delete(id);
        if (!on || this.closed) return;
        const t = setInterval(() => this._fireTimer(id), Math.max(10, Number(interval) || 1000));
        t.unref?.();
        this.timers.set(id, t);
      },
      __ks_thread: (id) => {
        this.deferred.add(id);
        setImmediate(() => {
          if (!this.deferred.delete(id) || this.closed) return;
          this._call(this.dispatchThread, id, 'A Lua background task');
        });
      },
      // Memory records (the table's mods), by record id.
      __ks_mr_count: () => s.records.length,
      __ks_mr_at: (i) => s.records[Number(i)]?.id,
      __ks_mr_find: (field, v) => {
        // IDs (and names) repeat across tables: the running table's own
        // mods win.
        const match = field === 'id' ? (r) => r.id.split(':').pop() === String(v) : (r) => r.name === String(v);
        const own = this.table ? s.records.find((r) => r.id.startsWith(`${this.table}:`) && match(r)) : null;
        return (own || s.records.find(match))?.id;
      },
      __ks_mr_get: (id, field, extra) => {
        const r = this._rec(id);
        const st = s.state.get(r.id);
        switch (field) {
          case 'Description': return r.name;
          case 'Active': return Boolean(st?.enabled);
          case 'Value': {
            if (r.kind !== 'value') return r.kind === 'script' ? '<script>' : '';
            const cur = st?.current ?? s._read(r);
            return cur === null || cur === undefined ? '??' : String(cur);
          }
          case 'Address': return r.spec ? r.spec.Address : (r.address || '');
          case 'CurrentAddress': {
            if (r.kind !== 'value') return undefined;
            try { return BigInt.asUintN(64, address.resolve(r, mem, s.symbols)).toString(16); } catch { return undefined; }
          }
          case 'ID': { const n = Number(r.id.split(':').pop()); return Number.isFinite(n) ? n : s.records.indexOf(r); }
          case 'Type': return r.spec ? r.spec.Type : (r.kind === 'script' ? 11 : (VT[r.valueType] ?? 2));
          case 'Index': return s.records.indexOf(r);
          case 'Script': return r.script || '';
          case 'IsGroupHeader': return r.kind === 'group';
          case 'ShowAsHex': return Boolean(r.hex);
          case 'OffsetCount': return r.spec ? r.spec.Offsets.length : (r.offsets || []).length;
          case 'Offset': {
            // Cheat Engine numbers offsets last-applied-first; Keystone keeps
            // them in the order they're applied.
            const list = r.spec ? r.spec.Offsets : [...(r.offsets || [])].reverse().map(Number);
            const v = list[Number(extra)];
            return v === undefined ? undefined : BigInt.asUintN(64, BigInt(v)).toString(16);
          }
          case 'Parent': {
            if (r.spec) return r.spec.parent || undefined;
            const depth = r.depth;
            const i = s.records.indexOf(r);
            for (let j = i - 1; j >= 0; j--) if (s.records[j].depth < depth) return s.records[j].id;
            return undefined;
          }
          case 'Children': {
            const i = s.records.indexOf(r);
            const out = [];
            for (let j = i + 1; j < s.records.length && s.records[j].depth > r.depth; j++) if (s.records[j].depth === r.depth + 1) out.push(s.records[j].id);
            return out.join('\n');
          }
          default: return undefined;
        }
      },
      __ks_mr_set: (id, field, v, extra) => {
        const r = this._rec(id);
        if (field === 'Active') {
          if (r.kind === 'value' || r.kind === 'script') s.setEnabled(r.id, Boolean(v));
          return true;
        }
        if (field === 'Value') {
          if (r.kind !== 'value') throw new LuaError(`"${r.name}" has no value to set.`);
          const n = Number(String(v).trim());
          if (!Number.isFinite(n)) throw new LuaError(`"${v}" isn't a number.`);
          if (s.state.get(r.id)?.enabled) s.setTarget(r.id, n); else s.applyValue(r.id, n);
          return true;
        }
        if (field === 'Description' && !r.spec) {
          r.name = String(v);
          this.dirty = true;
          return true;
        }
        if (!r.spec) throw new LuaError(`Keystone can only change the ${field} of mods made with Lua.`);
        const sp = r.spec;
        switch (field) {
          case 'Description': sp.Description = String(v); break;
          case 'Address': sp.Address = String(v); break;
          case 'Type': sp.Type = Number(v); break;
          case 'Script': sp.Script = String(v); break;
          case 'IsGroupHeader': sp.IsGroupHeader = Boolean(v); break;
          case 'ShowAsHex': sp.ShowAsHex = Boolean(v); break;
          case 'OffsetCount': {
            const n = Math.max(0, Math.min(64, Number(v) || 0));
            while (sp.Offsets.length < n) sp.Offsets.push(0);
            sp.Offsets.length = n;
            break;
          }
          case 'Offset': {
            const i = Number(extra);
            while (sp.Offsets.length <= i) sp.Offsets.push(0);
            sp.Offsets[i] = BigInt.asIntN(64, BigInt('0x' + v)).toString();
            break;
          }
          default: return true;
        }
        if (r.kind === 'script' && s.state.get(r.id)?.enabled && field === 'Script') {
          throw new LuaError(`Switch "${r.name}" off before changing its script.`);
        }
        this._rebuild(r.id);
        return true;
      },
      __ks_mr_create: () => {
        const prefix = this.table || 'ct:lua';
        const n = (this.made.get(prefix) || 0) + 1;
        this.made.set(prefix, n);
        // High numbers, clear of the IDs in the table's own file.
        const id = `${prefix}:${900000 + n}`;
        const spec = { Description: 'No description', Type: 2, Address: '', Offsets: [], Script: '', IsGroupHeader: false, ShowAsHex: false, parent: null };
        s.putRecord({ id, name: spec.Description, kind: 'unsupported', reason: 'No address', groupPath: [], depth: 0, spec, luaMade: true });
        this._rebuild(id);
        return id;
      },
      __ks_mr_append: (id, parentId) => {
        const r = this._rec(id);
        const parent = this._rec(parentId);
        if (!r.spec) throw new LuaError('Keystone can only move mods made with Lua.');
        r.spec.parent = parent.id;
        s.moveRecord(r.id, parent.id);
        this._rebuild(r.id);
        return true;
      },
      __ks_mr_delete: (id) => {
        s.removeRecord(this._rec(id).id);
        this.dirty = true;
        return true;
      },
    };
  }

  _fireTimer(id) {
    if (this.closed || !this.dispatchTimer) return;
    this._call(this.dispatchTimer, id, 'A Lua timer');
  }

  // A Lua function called from JavaScript later (timers, background tasks).
  // wasmoon runs it with the time limit (functionTimeout); scripts it
  // switches on share that deadline. An error stops a timer instead of
  // repeating every tick.
  _call(fn, id, what) {
    if (this.depth > 0) return; // never re-enter a running script
    this.depth++;
    this.deadline = Date.now() + this.runLimitMs;
    try {
      fn(id);
    } catch (err) {
      clearInterval(this.timers.get(id));
      this.timers.delete(id);
      this._notice(`${what} in this table stopped: ${cleanError(err)}`);
    } finally {
      this.depth--;
      this.deadline = null;
      try { this.engine?.global.setTimeout(undefined); } catch { /* closed */ }
      this._flush();
    }
  }
}

// Cheat Engine's Lua API, written in Lua on top of the __ks_ natives. Runs
// once per Lua state; the natives are then only reachable from here.
const PRELUDE = String.raw`
local N = {}
for k, v in pairs(_G) do if type(k) == 'string' and k:sub(1, 5) == '__ks_' then N[k:sub(6)] = v; _G[k] = nil end end

-- ---- the locked box ----
io = nil; package = nil; require = nil; dofile = nil; loadfile = nil; debug = nil
string.dump = nil
os = { time = os.time, clock = os.clock, date = os.date, difftime = os.difftime }
local rawload = load
load = function(chunk, name, _mode, env) return rawload(chunk, name, 't', env) end
loadstring = load

local function A(x)
  local t = math.type(x)
  -- '$' marks hex, so a number never reads as a symbol named like hex ("BEEF").
  if t == 'integer' then return string.format('$%X', x) end
  if t == 'float' then return string.format('$%X', math.floor(x)) end
  if type(x) == 'string' then return x end
  error('bad address: ' .. tostring(x), 3)
end
local function I(h) if h == nil then return nil end return math.tointeger(tonumber(h, 16)) end
local function tohex(s) return (s:gsub('.', function(c) return string.format('%02x', c:byte()) end)) end
local function fromhex(h) return (h:gsub('..', function(c) return string.char(tonumber(c, 16)) end)) end
local function rd(a, n) local h = N.read(A(a), n); if h == nil or #h < n * 2 then return nil end return fromhex(h) end
local function wr(a, s) return N.write(A(a), tohex(s)) end
local function u(n) return function(a, signed)
  local s = rd(a, n); if not s then return nil end
  return string.unpack((signed and '<i' or '<I') .. n, s)
end end

-- ---- memory ----
readBytes = function(a, n, asTable)
  n = n or 1
  local s = rd(a, n); if not s then return nil end
  local t = {}
  for i = 1, #s do t[i] = s:byte(i) end
  if asTable then return t end
  return table.unpack(t)
end
writeBytes = function(a, ...)
  local t = select('#', ...) == 1 and type(...) == 'table' and ... or { ... }
  local parts = {}
  for i = 1, #t do parts[i] = string.char(math.tointeger(t[i]) & 0xFF) end
  return wr(a, table.concat(parts))
end
readByte = u(1)
readSmallInteger = u(2)
readInteger = u(4)
readQword = function(a) local s = rd(a, 8); if not s then return nil end return string.unpack('<i8', s) end
readPointer = function(a) local _, _, is64 = getOpenedProcessInfo(); if is64 then return readQword(a) end return readInteger(a) end
readFloat = function(a) local s = rd(a, 4); if not s then return nil end return string.unpack('<f', s) end
readDouble = function(a) local s = rd(a, 8); if not s then return nil end return string.unpack('<d', s) end
readString = function(a, max, wide)
  max = max or 6000
  local s = rd(a, wide and max * 2 or max) or rd(a, 64)
  if not s then return nil end
  if wide then
    local out = {}
    for i = 1, #s - 1, 2 do
      local c = string.unpack('<I2', s, i)
      if c == 0 then break end
      out[#out + 1] = utf8.char(c)
    end
    return table.concat(out)
  end
  return (s:match('^[^%z]*'))
end
writeByte = function(a, v) return wr(a, string.pack('<I1', v & 0xFF)) end
writeSmallInteger = function(a, v) return wr(a, string.pack('<I2', v & 0xFFFF)) end
writeInteger = function(a, v) return wr(a, string.pack('<I4', math.tointeger(v) & 0xFFFFFFFF)) end
writeQword = function(a, v) return wr(a, string.pack('<i8', math.tointeger(v))) end
writePointer = function(a, v) local _, _, is64 = getOpenedProcessInfo(); if is64 then return writeQword(a, v) end return writeInteger(a, v) end
writeFloat = function(a, v) return wr(a, string.pack('<f', v)) end
writeDouble = function(a, v) return wr(a, string.pack('<d', v)) end
writeString = function(a, text, wide)
  if wide then
    local out = {}
    for _, c in utf8.codes(text) do out[#out + 1] = string.pack('<I2', c) end
    return wr(a, table.concat(out))
  end
  return wr(a, text)
end

-- ---- addresses and symbols ----
getAddress = function(x)
  local v = I(N.addr(A(x)))
  if v == nil then error('Couldn\'t find the address "' .. tostring(x) .. '"', 2) end
  return v
end
getAddressSafe = function(x) return I(N.addr(A(x))) end
getNameFromAddress = function(a) return N.name(string.format('%x', getAddress(a))) end
registerSymbol = function(name, a) return N.regsym(name, string.format('%x', getAddress(a))) end
unregisterSymbol = function(name) return N.unregsym(name) end
getModuleSize = function(name) local m = N.module(name); if not m then return nil end return I(m:match(' (%x+)')) end
inModule = function(a)
  a = getAddress(a)
  for _, m in ipairs(enumModules()) do if a >= m.Address and a < m.Address + m.Size then return true end end
  return false
end
inSystemModule = function() return false end
enumModules = function()
  local out = {}
  for line in (N.modules() .. '\n'):gmatch('([^\n]*)\n') do
    local name, base, size = line:match('^(.-)\t(%x+)\t(%x+)$')
    if name then out[#out + 1] = { Name = name, Address = I(base), Size = I(size), Is64Bit = true } end
  end
  return out
end

-- ---- scanning, assembling, memory blocks ----
local function strings(list)
  local t = { Count = #list }
  for i, v in ipairs(list) do t[i - 1] = v end
  t.getString = function(i) return t[i] end
  t.getCount = function() return t.Count end
  t.destroy = function() end
  t.Destroy = t.destroy
  return t
end
local function split(s) local t = {}; for w in s:gmatch('%x+') do t[#t + 1] = w:upper() end return t end
AOBScan = function(pattern, ...)
  local r = split(N.aob(pattern, nil, false))
  if #r == 0 then return nil end
  return strings(r)
end
AOBScanUnique = function(pattern) local r = split(N.aob(pattern, nil, true)); return r[1] and I(r[1]) or nil end
AOBScanModuleUnique = function(mod, pattern) local r = split(N.aob(pattern, mod, true)); return r[1] and I(r[1]) or nil end
autoAssemble = function(script, targetself, disableInfo)
  local ok, res = pcall(N.aa, script, disableInfo and 'disable' or 'enable', disableInfo and disableInfo.__id or nil)
  if not ok then return false, tostring(res) end
  return true, { __id = res }
end
autoAssembleCheck = function() return true end
allocateMemory = function(size, near) return I(N.alloc(size, near and string.format('%x', getAddress(near)) or nil)) end
deAlloc = function(a) return N.free(string.format('%x', getAddress(a))) end
fullAccess = function(a, size) return N.protect(string.format('%x', getAddress(a)), size or 4096) end

-- ---- the process ----
getOpenedProcessInfo = function()
  local name, pid, is64 = N.process():match('^(.-)\t(%d+)\t(%d)$')
  return name, tonumber(pid), is64 == '1'
end
getOpenedProcessID = function() local _, pid = getOpenedProcessInfo(); return pid end
getProcessIDFromProcessName = function(n) local name, pid = getOpenedProcessInfo(); if n and n:lower() == name:lower() then return pid end return nil end
targetIs64Bit = function() local _, _, is64 = getOpenedProcessInfo(); return is64 end
process = (getOpenedProcessInfo())
openProcess = function() return true end
getCheatEngineVersion = function() return 7.5 end
getCEVersion = getCheatEngineVersion
cheatEngineIs64Bit = function() return true end
getTickCount = function() return math.tointeger(N.now() % 0x7FFFFFFF) end
sleep = function(ms) N.sleep(ms or 0) end

-- ---- messages ----
print = function(...)
  local t = table.pack(...)
  for i = 1, t.n do t[i] = tostring(t[i]) end
  N.print(table.concat(t, ' '))
end
showMessage = function(text) N.notice(tostring(text)) end
mrOk, mrCancel, mrAbort, mrRetry, mrIgnore, mrYes, mrNo = 1, 2, 3, 4, 5, 6, 7
mtWarning, mtError, mtInformation, mtConfirmation = 0, 1, 2, 3
mbYes, mbNo, mbOK, mbCancel = 0, 1, 2, 3
-- Nobody is there to answer: questions get the answer that carries on.
messageDialog = function(text) return mrYes end
inputQuery = function(caption, prompt, default) return default end

-- ---- conversions ----
local function bt(t) local p = {}; for i = 1, #t do p[i] = string.char(t[i] & 0xFF) end return table.concat(p) end
local function tb(s) local t = {}; for i = 1, #s do t[i] = s:byte(i) end return t end
wordToByteTable = function(v) return tb(string.pack('<I2', v & 0xFFFF)) end
dwordToByteTable = function(v) return tb(string.pack('<I4', math.tointeger(v) & 0xFFFFFFFF)) end
qwordToByteTable = function(v) return tb(string.pack('<i8', math.tointeger(v))) end
floatToByteTable = function(v) return tb(string.pack('<f', v)) end
doubleToByteTable = function(v) return tb(string.pack('<d', v)) end
stringToByteTable = function(s) return tb(s) end
wideStringToByteTable = function(s) local out = {}; for _, c in utf8.codes(s) do out[#out + 1] = string.pack('<I2', c) end return tb(table.concat(out)) end
byteTableToWord = function(t, signed) return string.unpack(signed and '<i2' or '<I2', bt(t)) end
byteTableToDword = function(t, signed) return string.unpack(signed and '<i4' or '<I4', bt(t)) end
byteTableToQword = function(t) return string.unpack('<i8', bt(t)) end
byteTableToFloat = function(t) return string.unpack('<f', bt(t)) end
byteTableToDouble = function(t) return string.unpack('<d', bt(t)) end
byteTableToString = function(t) return bt(t) end
byteTableToWideString = function(t)
  local s, out = bt(t), {}
  for i = 1, #s - 1, 2 do out[#out + 1] = utf8.char(string.unpack('<I2', s, i)) end
  return table.concat(out)
end
bAnd = function(a, b) return a & b end
bOr = function(a, b) return a | b end
bXor = function(a, b) return a ~ b end
bNot = function(a) return ~a end
bShl = function(a, b) return a << b end
bShr = function(a, b) return a >> b end
vtByte, vtWord, vtDword, vtQword, vtSingle, vtDouble, vtString, vtUnicodeString, vtByteArray, vtBinary, vtAutoAssembler, vtPointer, vtCustom = 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13

-- ---- the table's mods (memory records), by record id ----
local mrCache = {}
local memrecObj
local function children(id)
  local out = {}
  for c in (N.mr_get(id, 'Children') .. '\n'):gmatch('([^\n]+)\n') do out[#out + 1] = c end
  return out
end
memrecObj = function(id)
  if id == nil then return nil end
  if mrCache[id] then return mrCache[id] end
  local o = {}
  local offsets = setmetatable({}, {
    __index = function(_, i) return I(N.mr_get(id, 'Offset', i)) end,
    __newindex = function(_, i, v) N.mr_set(id, 'Offset', string.format('%x', math.tointeger(v) or 0), i) end,
  })
  local childList = setmetatable({}, { __index = function(_, i) return memrecObj(children(id)[i + 1]) end })
  local methods = {
    getDescription = function() return N.mr_get(id, 'Description') end,
    setDescription = function(_, v) N.mr_set(id, 'Description', tostring(v)) end,
    getActive = function() return N.mr_get(id, 'Active') end,
    setActive = function(_, v) N.mr_set(id, 'Active', v and true or false) end,
    getValue = function() return N.mr_get(id, 'Value') end,
    setValue = function(_, v) N.mr_set(id, 'Value', tostring(v)) end,
    getAddress = function() return N.mr_get(id, 'Address') end,
    setAddress = function(_, v) N.mr_set(id, 'Address', tostring(v)) end,
    getID = function() return N.mr_get(id, 'ID') end,
    getOffsetCount = function() return N.mr_get(id, 'OffsetCount') end,
    setOffsetCount = function(_, n) N.mr_set(id, 'OffsetCount', n) end,
    getOffset = function(_, i) return offsets[i] end,
    setOffset = function(_, i, v) offsets[i] = v end,
    getCount = function() return #children(id) end,
    getChild = function(_, i) return childList[i] end,
    appendToEntry = function(self, parent) N.mr_append(id, parent and rawget(parent, '__id') or error('appendToEntry needs a memory record', 2)) end,
    delete = function() N.mr_delete(id); mrCache[id] = nil end,
    disableWithoutExecute = function() end,
    createHotkey = function() return setmetatable({}, { __index = function() return function() end end }) end,
  }
  methods.destroy = methods.delete
  methods.Delete = methods.delete
  local props = { Description = true, Active = true, Value = true, Address = true, ID = true, Type = true, Index = true,
    Script = true, IsGroupHeader = true, ShowAsHex = true, OffsetCount = true }
  rawset(o, '__id', id)
  setmetatable(o, {
    __index = function(_, k)
      if methods[k] then return methods[k] end
      if props[k] then return N.mr_get(id, k) end
      if k == 'Offset' then return offsets end
      if k == 'CurrentAddress' then return I(N.mr_get(id, 'CurrentAddress')) end
      if k == 'Count' then return #children(id) end
      if k == 'Child' then return childList end
      if k == 'Parent' then return memrecObj(N.mr_get(id, 'Parent')) end
      return nil
    end,
    __newindex = function(t, k, v)
      if k == 'Active' or k == 'IsGroupHeader' or k == 'ShowAsHex' then N.mr_set(id, k, v and true or false)
      elseif k == 'Value' or k == 'Description' or k == 'Address' or k == 'Script' then N.mr_set(id, k, tostring(v))
      elseif k == 'Type' or k == 'OffsetCount' then N.mr_set(id, k, math.tointeger(v) or 0)
      else rawset(t, k, v) end
    end,
  })
  mrCache[id] = o
  return o
end
__ks_memrec = memrecObj
local list = {}
local listMethods = {
  getCount = function() return N.mr_count() end,
  getMemoryRecord = function(i) return memrecObj(N.mr_at(i)) end,
  getMemoryRecordByDescription = function(d) return memrecObj(N.mr_find('desc', d)) end,
  getMemoryRecordByID = function(id) return memrecObj(N.mr_find('id', id)) end,
  createMemoryRecord = function() return memrecObj(N.mr_create()) end,
  disableAllWithoutExecute = function() end,
  clear = function() end,
}
for k, f in pairs(listMethods) do
  list[k] = function(a, ...) if a == list then return f(...) end return f(a, ...) end
end
setmetatable(list, {
  __index = function(_, k)
    if k == 'Count' then return N.mr_count() end
    if math.type(k) == 'integer' then return memrecObj(N.mr_at(k)) end
    if k == 'MemoryRecord' then return setmetatable({}, { __index = function(_, i) return memrecObj(N.mr_at(i)) end }) end
    return nil
  end,
})
getAddressList = function() return list end
AddressList = list

-- ---- timers and background tasks ----
local timers, nextTimer = {}, 0
createTimer = function(owner, enabled)
  nextTimer = nextTimer + 1
  local id = nextTimer
  local st = { Interval = 1000, Enabled = (enabled == nil) and true or enabled, OnTimer = nil }
  local t = {}
  local function sync() N.timer(id, st.Interval, st.Enabled and st.OnTimer ~= nil) end
  local methods = {
    destroy = function() st.Enabled = false; sync(); timers[id] = nil end,
    setEnabled = function(_, v) st.Enabled = v and true or false; sync() end,
    getEnabled = function() return st.Enabled end,
    setInterval = function(_, v) st.Interval = v; sync() end,
    getInterval = function() return st.Interval end,
    setOnTimer = function(_, f) st.OnTimer = f; sync() end,
    getOnTimer = function() return st.OnTimer end,
  }
  methods.Destroy = methods.destroy
  setmetatable(t, {
    __index = function(_, k) if methods[k] then return methods[k] end return st[k] end,
    __newindex = function(_, k, v)
      if k == 'Interval' or k == 'Enabled' or k == 'OnTimer' then st[k] = v; sync() else rawset(t, k, v) end
    end,
  })
  timers[id] = { obj = t, st = st }
  sync()
  return t
end
__ks_dispatch_timer = function(id)
  local tm = timers[id]
  if tm and tm.st.Enabled and tm.st.OnTimer then tm.st.OnTimer(tm.obj) end
end
local threads, nextThread = {}, 0
createThread = function(f, ...)
  nextThread = nextThread + 1
  local args = table.pack(...)
  local th = { Terminated = false, terminate = function(self) self.Terminated = true end, waitfor = function() end, synchronize = function(_, g, ...) return g(...) end }
  th.Terminate = th.terminate
  threads[nextThread] = function() f(th, table.unpack(args, 1, args.n)) end
  N.thread(nextThread)
  return th
end
__ks_dispatch_thread = function(id) local f = threads[id]; threads[id] = nil; if f then f() end end
synchronize = function(f, ...) return f(...) end
queue = synchronize
inMainThread = function() return true end

-- ---- windows: tables that build their own forms run, but nothing shows ----
local function dummy()
  local d = {}
  return setmetatable(d, {
    __index = function(_, k) return function() return dummy() end end,
    __newindex = function(t, k, v) rawset(t, k, v) end,
    __call = function() return dummy() end,
  })
end
for _, n in ipairs({ 'createForm', 'createButton', 'createLabel', 'createEdit', 'createCheckBox', 'createMemo',
  'createPanel', 'createListBox', 'createComboBox', 'createImage', 'createTrackBar', 'createMenuItem', 'createMainMenu',
  'createPopupMenu', 'createGroupBox', 'createRadioGroup', 'createToggleBox', 'createProgressBar', 'createListView',
  'createSplitter', 'createStringlist', 'createStringList', 'createHotkey', 'getMainForm', 'getAutoAttachList',
  'getApplication', 'getSettings', 'getLuaEngine', 'getMemoryViewForm', 'getFreezeTimer', 'getUpdateTimer',
  'createFormFromFile', 'getFormCount', 'getForm' }) do
  _G[n] = function() return dummy() end
end
MainForm = dummy()

-- ---- things that need Cheat Engine itself ----
local function refuse(why) return function() error(why, 2) end end
local inGame = 'it runs code inside the game, which Keystone doesn\'t do yet.'
for _, n in ipairs({ 'executeCode', 'executeCodeEx', 'executeMethod', 'executeCodeLocal', 'executeCodeLocalEx',
  'createRemoteThread', 'injectDLL', 'injectLibrary', 'loadLibrary' }) do _G[n] = refuse(inGame) end
for _, n in ipairs({ 'shellExecute', 'runCommand', 'getInternet', 'createProcess', 'readRegionFromFile',
  'writeRegionToFile', 'createFileStream', 'createMemoryStream', 'findTableFile' }) do
  _G[n] = refuse('it reaches outside the game (files, programs or the internet), which Keystone\'s Lua doesn\'t allow.')
end
for _, n in ipairs({ 'readBytesLocal', 'readIntegerLocal', 'readQwordLocal', 'readPointerLocal', 'readFloatLocal',
  'readDoubleLocal', 'readStringLocal', 'writeBytesLocal', 'writeIntegerLocal', 'writeQwordLocal', 'writeFloatLocal',
  'writeDoubleLocal', 'writeStringLocal' }) do _G[n] = refuse('it reads or writes Cheat Engine\'s own memory.') end
speedhack_setSpeed = refuse('the speed hack needs Cheat Engine\'s own DLL in the game.')
LaunchMonoDataCollector = refuse('it uses Unity Mono features, which Keystone doesn\'t have yet.')
setmetatable(_G, {
  __index = function(_, k)
    if type(k) == 'string' then
      if k:match('^mono_') or k:match('^il2cpp') or k:match('^dotnet') or k == 'monopipe' then
        return refuse('it uses Unity Mono features, which Keystone doesn\'t have yet.')
      end
      if k:match('^debug_') or k:match('^dbk_') or k:match('^dbvm_') then
        return refuse('it uses Cheat Engine\'s debugger, which Keystone doesn\'t have.')
      end
    end
    return nil
  end,
})
`;

module.exports = { LuaHost, LuaError, preloadLua, cleanError, RUN_LIMIT_MS };
