'use strict';

const asm = require('./asm');

// Runs Cheat Engine "Auto Assembler" scripts: the [ENABLE] and [DISABLE]
// sections behind most of a table's best mods (god mode, infinite ammo,
// "get player pointer"...).
//
// Supported, which covers Cheat Engine's own templates and nearly every
// table built on them:
//   aobscanmodule / aobscan / aobscanregion   find code by its bytes
//   alloc / globalalloc / dealloc             memory for a code cave, near the game's code
//   label / registersymbol / unregistersymbol / define / assert / fullaccess
//   name: and address: lines, instructions (see asm.js), db dw dd dq,
//   nop N, readmem(address,size), reassemble(address)
// Not supported (the script shows why instead of half-running):
//   Lua ({$lua}, luacall), createthread, loadlibrary, loadbinary, include.
//
// A section runs all-or-nothing: everything is assembled first, then
// written; if a write fails, what was written is put back and the memory
// allocated for it is freed.
//
// The memory backend needs, on top of read/write/getModule:
//   alloc(size, near) -> address, free(address), protect(address, size, prot) -> old,
//   flush(address, size), readableRegions(start?, end?) -> [{ base, size }]

class ScriptError extends Error {}

const UNSUPPORTED = [
  [/\{\$lua\}/i, 'It uses Lua, which needs Cheat Engine.'],
  [/^\s*luacall\s*\(/im, 'It uses Lua, which needs Cheat Engine.'],
  [/^\s*createthread\s*\(/im, 'It starts a thread in the game, which Keystone doesn’t do.'],
  [/^\s*loadlibrary\s*\(/im, 'It loads a DLL into the game, which Keystone doesn’t do.'],
  [/^\s*loadbinary\s*\(/im, 'It loads a file into the game, which Keystone doesn’t do.'],
  [/^\s*include\s*\(/im, 'It includes another script file.'],
];

// Why a script can't run in Keystone, or null if it can (as far as can be
// told without running it).
function unsupportedReason(script) {
  for (const [re, why] of UNSUPPORTED) if (re.test(script)) return why;
  return null;
}

function stripComments(text) {
  let s = String(text).replace(/\r\n?/g, '\n');
  // {$try}/{$except}/{$strict}/{$asm} directives are dropped; {$lua} was
  // turned away earlier. Then { block } and (* block *) comments.
  s = s.replace(/\{\$[a-z]+\}/gi, '');
  s = s.replace(/\{[\s\S]*?\}/g, (m) => m.replace(/[^\n]/g, ' '));
  s = s.replace(/\(\*[\s\S]*?\*\)/g, (m) => m.replace(/[^\n]/g, ' '));
  // // comments, but not inside quotes ('http://...' in a db string).
  return s.split('\n').map((line) => {
    let q = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === q) q = null; continue; }
      if (ch === '\'' || ch === '"') q = ch;
      else if (ch === '/' && line[i + 1] === '/') return line.slice(0, i);
    }
    return line;
  }).join('\n');
}

// { enable: [lines], disable: [lines] }. A script with no [ENABLE] marker is
// all enable (Cheat Engine treats it the same way).
function sections(script) {
  const lines = stripComments(script).split('\n');
  const out = { enable: [], disable: [] };
  let cur = null;
  let marked = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^\[enable\]$/i.test(line)) { cur = 'enable'; marked = true; continue; }
    if (/^\[disable\]$/i.test(line)) { cur = 'disable'; marked = true; continue; }
    if (!line) continue;
    if (!marked) out.enable.push(line);
    else if (cur) out[cur].push(line);
  }
  return out;
}

const DIRECTIVES = new Set(['aobscanmodule', 'aobscan', 'aobscanregion', 'alloc', 'globalalloc', 'dealloc', 'label',
  'registersymbol', 'unregistersymbol', 'define', 'assert', 'fullaccess']);

function directiveOf(line) {
  const m = line.match(/^([a-z]+)\s*\(([\s\S]*)\)\s*;?$/i);
  if (!m || !DIRECTIVES.has(m[1].toLowerCase())) return null;
  return { name: m[1].toLowerCase(), args: splitArgs(m[2]) };
}

function splitArgs(s) {
  const out = [];
  let depth = 0;
  let q = null;
  let cur = '';
  for (const ch of s) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === '\'') { q = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// "48 8B ?? 10 *" -> { bytes, mask } (mask 0xFF exact, 0x00 any, 0xF0/0x0F half)
function parsePattern(text) {
  const toks = String(text).trim().split(/[\s]+/).flatMap((t) => (t.length > 2 && !/[?*]/.test(t) ? t.match(/../g) : [t]));
  const bytes = [];
  const mask = [];
  for (const t of toks) {
    if (/^(\?\?|\?|\*|\*\*|xx)$/i.test(t)) { bytes.push(0); mask.push(0); continue; }
    const m = t.match(/^([0-9a-f?*])([0-9a-f?*])$/i);
    if (!m) throw new ScriptError(`"${t}" isn't a byte in the search pattern.`);
    const hi = /[0-9a-f]/i.test(m[1]);
    const lo = /[0-9a-f]/i.test(m[2]);
    bytes.push((hi ? parseInt(m[1], 16) << 4 : 0) | (lo ? parseInt(m[2], 16) : 0));
    mask.push((hi ? 0xf0 : 0) | (lo ? 0x0f : 0));
  }
  if (!bytes.length) throw new ScriptError('The search pattern is empty.');
  return { bytes, mask };
}

// First match of a pattern inside the given regions, or null.
function findPattern(mem, regions, pattern) {
  const { bytes, mask } = pattern;
  // Longest run of exact bytes: Buffer.indexOf finds it fast, then the
  // rest of the pattern is checked around it.
  let best = { at: 0, len: 0 };
  for (let i = 0; i < bytes.length;) {
    if (mask[i] !== 0xff) { i++; continue; }
    let j = i;
    while (j < bytes.length && mask[j] === 0xff) j++;
    if (j - i > best.len) best = { at: i, len: j - i };
    i = j;
  }
  const CHUNK = 16 * 1024 * 1024;
  const needle = best.len ? Buffer.from(bytes.slice(best.at, best.at + best.len)) : null;
  for (const r of regions) {
    for (let off = 0; off < r.size; off += CHUNK) {
      const len = Math.min(CHUNK + bytes.length, r.size - off);
      const buf = mem.read(r.base + BigInt(off), len);
      if (!buf) continue;
      const limit = Math.min(CHUNK, len - bytes.length + 1);
      const check = (p) => {
        for (let k = 0; k < bytes.length; k++) if ((buf[p + k] & mask[k]) !== bytes[k]) return false;
        return true;
      };
      if (needle) {
        for (let at = buf.indexOf(needle, best.at); at >= 0; at = buf.indexOf(needle, at + 1)) {
          const p = at - best.at;
          if (p >= limit) break;
          if (p >= 0 && check(p)) return r.base + BigInt(off + p);
        }
      } else {
        for (let p = 0; p < limit; p++) if (check(p)) return r.base + BigInt(off + p);
      }
    }
  }
  return null;
}

// Bytes for db/dw/dd/dq: numbers (hex by default), (float)x, 'strings'.
function dataBytes(kind, argText, ev) {
  const size = { db: 1, dw: 2, dd: 4, dq: 8 }[kind];
  const out = [];
  for (const item of argText.match(/'[^']*'|"[^"]*"|\S+/g) || []) {
    const parts = item.startsWith('\'') || item.startsWith('"') ? [item] : item.split(',').filter(Boolean);
    for (const p of parts) {
      if (/^['"]/.test(p)) { out.push(...Buffer.from(p.slice(1, -1), 'latin1')); continue; }
      const v = ev(p);
      const b = Buffer.alloc(size);
      if (size === 1) b.writeUInt8(Number(v & 0xffn));
      else if (size === 2) b.writeUInt16LE(Number(v & 0xffffn));
      else if (size === 4) b.writeUInt32LE(Number(v & 0xffffffffn));
      else b.writeBigUInt64LE(v & ((1n << 64n) - 1n));
      out.push(...b);
    }
  }
  return Buffer.from(out);
}

const PAGE_EXECUTE_READWRITE = 0x40;

class ScriptRunner {
  // symbols: the session's registered symbols (Map name -> address), shared
  // with the mod values that use them.
  constructor(memory, symbols) {
    this.mem = memory;
    this.symbols = symbols;
    this.state = new Map(); // record id -> { allocs: Map, syms: Map }
  }

  _state(id) {
    if (!this.state.has(id)) this.state.set(id, { allocs: new Map(), syms: new Map() });
    return this.state.get(id);
  }

  // Runs one section: 'enable' or 'disable'.
  run(id, script, which) {
    const why = unsupportedReason(script);
    if (why) throw new ScriptError(why);
    const st = this._state(id);
    let lines = sections(script)[which];

    // define(name, text): plain text substitution, Cheat Engine style.
    const defines = [];
    lines = lines.filter((l) => {
      const d = directiveOf(l);
      if (d?.name !== 'define') return true;
      if (d.args.length < 2) throw new ScriptError(`define needs a name and a value: ${l}`);
      defines.push([new RegExp(`(?<![\\w.])${d.args[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'gi'), d.args.slice(1).join(',')]);
      return false;
    });
    lines = lines.map((l) => defines.reduce((s, [re, v]) => s.replace(re, v), l));

    const labels = new Map();      // declared labels -> address (null until placed)
    const local = new Map(st.syms); // aob results and allocs from this script
    for (const [n, a] of st.allocs) local.set(n, a.address);
    const newAllocs = [];
    const register = [];
    const unregister = [];
    const deallocs = [];
    const lower = (n) => String(n).toLowerCase();

    const resolve = (name, rip) => {
      const k = lower(name);
      if (labels.has(k)) return labels.get(k) ?? rip ?? 0n;
      if (local.has(k)) return local.get(k);
      if (this.symbols.has(k)) return this.symbols.get(k);
      const mod = this.mem.getModule(name);
      return mod ? BigInt(mod.base) : null;
    };
    const readPtr = (a) => {
      const b = this.mem.read(a, this.mem.pointerSize || 8);
      if (!b) throw new ScriptError(`Can't read the pointer at ${a.toString(16)}.`);
      return (this.mem.pointerSize || 8) === 8 ? b.readBigUInt64LE(0) : BigInt(b.readUInt32LE(0));
    };
    const ev = (expr, rip) => asm.evalExpr(expr, { resolve: (n) => resolve(n, rip), read: readPtr });

    try {
      // ---- directives, in order ----
      const body = [];
      for (const l of lines) {
        const d = directiveOf(l);
        if (!d) { body.push(l); continue; }
        const a = d.args;
        switch (d.name) {
          case 'label': for (const n of a) labels.set(lower(n), null); break;
          case 'aobscanmodule': {
            const mod = this.mem.getModule(a[1].replace(/"/g, ''));
            if (!mod) throw new ScriptError(`The game has no module called ${a[1]}.`);
            const regions = this.mem.readableRegions(BigInt(mod.base), BigInt(mod.base) + BigInt(mod.size));
            const at = findPattern(this.mem, regions, parsePattern(a.slice(2).join(' ')));
            if (at === null) throw new ScriptError(`Couldn't find the code this script changes (${a[0]}). The game may have updated since the table was made.`);
            local.set(lower(a[0]), at);
            break;
          }
          case 'aobscan': {
            const at = findPattern(this.mem, this.mem.readableRegions(), parsePattern(a.slice(1).join(' ')));
            if (at === null) throw new ScriptError(`Couldn't find the code this script changes (${a[0]}). The game may have updated since the table was made.`);
            local.set(lower(a[0]), at);
            break;
          }
          case 'aobscanregion': {
            const from = ev(a[1]);
            const to = ev(a[2]);
            const at = findPattern(this.mem, this.mem.readableRegions(from, to), parsePattern(a.slice(3).join(' ')));
            if (at === null) throw new ScriptError(`Couldn't find the code this script changes (${a[0]}).`);
            local.set(lower(a[0]), at);
            break;
          }
          case 'alloc':
          case 'globalalloc': {
            const name = lower(a[0]);
            if (d.name === 'globalalloc' && this.symbols.has(name)) { local.set(name, this.symbols.get(name)); break; }
            if (st.allocs.has(name)) { local.set(name, st.allocs.get(name).address); break; }
            const size = Number(ev(a[1]));
            const near = a[2] ? ev(a[2]) : null;
            const address = this.mem.alloc(Math.max(size, 1), near);
            newAllocs.push({ name, address, size });
            local.set(name, address);
            if (d.name === 'globalalloc') register.push(name);
            break;
          }
          case 'dealloc': deallocs.push(lower(a[0])); break;
          case 'registersymbol': register.push(...a.map(lower)); break;
          case 'unregistersymbol': unregister.push(...a.map(lower)); break;
          case 'assert': {
            const at = ev(a[0]);
            const p = parsePattern(a.slice(1).join(' '));
            if (findPattern(this.mem, [{ base: at, size: p.bytes.length }], p) !== at) {
              throw new ScriptError('The game’s code isn’t what this script expects. The game may have updated since the table was made.');
            }
            break;
          }
          case 'fullaccess': this.mem.protect(ev(a[0]), Number(ev(a[1])), PAGE_EXECUTE_READWRITE); break;
          default: break;
        }
      }

      // ---- assembly: twice, so labels used before they're placed resolve ----
      let writes = null;
      let sizes = null;
      for (let pass = 0; pass < 4; pass++) {
        const out = [];
        const lens = [];
        let cur = null;
        for (const line of body) {
          const lab = line.match(/^(.+?):$/);
          if (lab && !/^(db|dw|dd|dq)\b/i.test(line)) {
            const k = lower(lab[1].trim());
            if (labels.has(k)) {
              if (cur === null) throw new ScriptError(`"${lab[1]}:" comes before any address to place it at.`);
              labels.set(k, cur);
            } else {
              cur = ev(lab[1]);
            }
            continue;
          }
          if (cur === null) throw new ScriptError(`"${line}" comes before any address to write it to.`);
          let bytes;
          const data = line.match(/^(db|dw|dd|dq)\s+(.+)$/i);
          const nop = line.match(/^nop\s+(\S+)$/i);
          const readmem = line.match(/^readmem\s*\((.+),(.+)\)$/i);
          const reasm = line.match(/^reassemble\s*\((.+)\)$/i);
          if (data) bytes = dataBytes(data[1].toLowerCase(), data[2], (e) => ev(e, cur));
          else if (nop) bytes = Buffer.alloc(Number(ev(nop[1], cur)), 0x90);
          else if (readmem) {
            const from = ev(readmem[1], cur);
            const n = Number(ev(readmem[2], cur));
            bytes = this.mem.read(from, n);
            if (!bytes) throw new ScriptError(`Couldn't read ${n} bytes at ${from.toString(16)}.`);
          } else if (reasm) {
            const from = ev(reasm[1], cur);
            const src = this.mem.read(from, 15) || this.mem.read(from, 8);
            if (!src) throw new ScriptError(`Couldn't read the instruction at ${from.toString(16)}.`);
            bytes = asm.reassemble(src, from, cur).bytes;
          } else {
            try {
              bytes = asm.assembleInstruction(line, cur, { eval: (e) => ev(e, cur) });
            } catch (err) {
              throw new ScriptError(err.message);
            }
          }
          out.push({ address: cur, bytes });
          lens.push(bytes.length);
          cur += BigInt(bytes.length);
        }
        const unplaced = [...labels].filter(([, v]) => v === null).map(([k]) => k);
        if (unplaced.length && pass > 0) throw new ScriptError(`Label "${unplaced[0]}" is declared but never placed.`);
        if (sizes && sizes.join() === lens.join() && !unplaced.length) { writes = out; break; }
        sizes = lens;
        writes = out;
      }

      // ---- write, all or nothing ----
      const done = [];
      try {
        for (const w of merge(writes)) {
          const old = this.mem.read(w.address, w.bytes.length);
          if (!old) throw new ScriptError(`Can't read the game's memory at ${w.address.toString(16)}.`);
          const prot = this.mem.protect(w.address, w.bytes.length, PAGE_EXECUTE_READWRITE);
          const ok = this.mem.write(w.address, w.bytes);
          if (prot !== null && prot !== undefined && prot !== PAGE_EXECUTE_READWRITE) this.mem.protect(w.address, w.bytes.length, prot);
          if (!ok) throw new ScriptError(`Couldn't write to the game's memory at ${w.address.toString(16)}.`);
          done.push({ address: w.address, old });
          this.mem.flush(w.address, w.bytes.length);
        }
      } catch (err) {
        for (const d of done.reverse()) this.mem.write(d.address, d.old);
        throw err;
      }

      // ---- bookkeeping, now that it worked ----
      for (const a of newAllocs) st.allocs.set(a.name, { address: a.address, size: a.size });
      for (const [k, v] of local) if (!st.allocs.has(k)) st.syms.set(k, v);
      for (const [k, v] of labels) if (v !== null) st.syms.set(k, v);
      for (const n of register) {
        const v = resolve(n);
        if (v === null) throw new ScriptError(`registersymbol(${n}): there's no ${n} to register.`);
        this.symbols.set(n, v);
      }
      for (const n of unregister) this.symbols.delete(n);
      for (const n of deallocs) {
        const a = st.allocs.get(n);
        if (!a) continue;
        try { this.mem.free(a.address); } catch { /* the game may have freed it */ }
        st.allocs.delete(n);
      }
      return { writes: writes.length, bytes: writes.reduce((n, w) => n + w.bytes.length, 0) };
    } catch (err) {
      // Memory reserved for a section that didn't go through goes back.
      for (const a of newAllocs) { try { this.mem.free(a.address); } catch { /* ignore */ } }
      throw err instanceof ScriptError || err instanceof asm.AsmError ? new ScriptError(err.message) : err;
    }
  }
}

// Adjacent writes become one, so a cave and its jump are two writes, not forty.
function merge(writes) {
  const out = [];
  for (const w of writes) {
    if (!w.bytes.length) continue;
    const last = out[out.length - 1];
    if (last && last.address + BigInt(last.bytes.length) === w.address) last.bytes = Buffer.concat([last.bytes, w.bytes]);
    else out.push({ address: w.address, bytes: Buffer.from(w.bytes) });
  }
  return out;
}

module.exports = { ScriptRunner, ScriptError, sections, stripComments, parsePattern, findPattern, unsupportedReason };
