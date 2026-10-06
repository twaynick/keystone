'use strict';

const { EventEmitter } = require('events');
const values = require('./values');

// The value finder's engine: Cheat Engine's "first scan / next scan".
//
// First scan reads every writable block of the game's memory and keeps the
// spots holding the value you typed. You change the value in the game (spend
// some caps, take a hit) and the next scan keeps only the spots that changed
// the same way, until one or a few are left.
//
// It runs in the main process, so it reads a few MB at a time and yields in
// between: the freeze loop, the overlay and the phone keep going during a
// scan of a multi-GB game. Hits are kept as offsets into their memory block
// in typed arrays (4 bytes each, plus 8 for a remembered value), because a
// first scan for a common number can match millions of spots.

const CHUNK = 4 * 1024 * 1024;
const MAX_HITS = 20_000_000;
// Offsets are uint32; blocks bigger than this are split so they always fit.
const MAX_BLOCK = 1024 * 1024 * 1024;

const FLOAT = new Set(['float', 'double']);
const FIRST = new Set(['exact', 'between']);
const NEXT = new Set(['exact', 'between', 'increased', 'decreased', 'increasedBy', 'decreasedBy', 'changed', 'unchanged']);

class Grow {
  constructor(T, n = 4096) { this.T = T; this.a = new T(n); this.n = 0; }
  push(v) {
    if (this.n === this.a.length) { const b = new this.T(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = v;
  }
  done() { return this.a.slice(0, this.n); }
}

// "72.3" matches 72.25 to 72.35, the way the game rounds it on screen;
// "100" matches 99.5 to 100.5.
function tolerance(raw) {
  const m = String(raw).trim().match(/\.(\d+)$/);
  return 0.5 * 10 ** -(m ? m[1].length : 0);
}

function number(type, raw, label) {
  const s = String(raw ?? '').trim().replace(/,/g, '');
  if (s === '') throw new Error(`Type ${label}.`);
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`"${raw}" isn't a number.`);
  if (!FLOAT.has(type) && !Number.isInteger(n)) throw new Error(`"${raw}" has decimals. Pick a decimal type (float) for values like that.`);
  return n;
}

// Builds the match test for a scan: test(value, previous) -> boolean.
function makeTest(type, { compare, value, value2 }) {
  const fl = FLOAT.has(type);
  const needs = ['exact', 'between', 'increasedBy', 'decreasedBy'].includes(compare);
  const a = needs ? number(type, value, compare === 'between' ? 'the lowest value' : 'a value') : null;
  const b = compare === 'between' ? number(type, value2, 'the highest value') : null;
  const tol = fl && needs ? tolerance(value) : 0;
  const eq = fl ? (x, y) => Math.abs(x - y) <= tol : (x, y) => x === y;
  const t = inner(compare, a, b, tol, eq);
  // Tiny non-zero floats (1e-44) are almost always whole numbers read as
  // floats, never a health bar; leaving them out cuts thousands of junk hits.
  return fl ? (v, p) => !(v !== 0 && Math.abs(v) < 1e-30) && t(v, p) : t;
}

function inner(compare, a, b, tol, eq) {
  switch (compare) {
    case 'exact': return (v) => eq(v, a);
    case 'between': {
      const lo = Math.min(a, b) - tol;
      const hi = Math.max(a, b) + tol;
      return (v) => v >= lo && v <= hi;
    }
    case 'increased': return (v, p) => v > p;
    case 'decreased': return (v, p) => v < p;
    case 'increasedBy': return (v, p) => eq(v - p, a);
    case 'decreasedBy': return (v, p) => eq(p - v, a);
    case 'changed': return (v, p) => v !== p && !(Number.isNaN(v) && Number.isNaN(p));
    case 'unchanged': return (v, p) => v === p;
    default: throw new Error(`Unknown search "${compare}".`);
  }
}

// Reads values of one type out of a buffer at a byte position.
function reader(type, buf) {
  // Typed arrays need an aligned start; a fresh copy always is.
  const u8 = buf.byteOffset % 8 === 0 ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  switch (type) {
    case 'byte': return (o) => dv.getUint8(o);
    case 'int16': return (o) => dv.getInt16(o, true);
    case 'int32': return (o) => dv.getInt32(o, true);
    case 'float': return (o) => dv.getFloat32(o, true);
    case 'double': return (o) => dv.getFloat64(o, true);
    // Exact while it fits a double (±2^53), which game values do.
    case 'int64': return (o) => dv.getInt32(o + 4, true) * 4294967296 + dv.getUint32(o, true);
    default: throw new Error(`Unknown value type: ${type}`);
  }
}

const tick = () => new Promise((r) => setImmediate(r));

class Scanner extends EventEmitter {
  constructor(memory) {
    super();
    this.memory = memory;
    this.gen = null;     // current results
    this.prevGen = null; // one step back, for Undo
    this.busy = false;
    this._cancel = false;
    this.scans = 0;
  }

  get count() { return this.gen ? this.gen.count : 0; }
  get type() { return this.gen?.type || null; }

  cancel() { if (this.busy) this._cancel = true; }

  reset() {
    if (this.busy) throw new Error('Wait for the scan to finish, or cancel it.');
    this.gen = null;
    this.prevGen = null;
    this.scans = 0;
  }

  undo() {
    if (this.busy) throw new Error('Wait for the scan to finish, or cancel it.');
    if (!this.prevGen) throw new Error('There’s no earlier scan to go back to.');
    this.gen = this.prevGen;
    this.prevGen = null;
    this.scans = Math.max(1, this.scans - 1);
    return this.count;
  }

  _blocks() {
    if (typeof this.memory.regions !== 'function') throw new Error('This game’s memory can’t be searched.');
    const out = [];
    for (const r of this.memory.regions()) {
      for (let off = 0; off < r.size; off += MAX_BLOCK) out.push({ base: r.base + BigInt(off), size: Math.min(MAX_BLOCK, r.size - off) });
    }
    return out;
  }

  async first({ type = 'int32', compare = 'exact', value, value2 } = {}) {
    if (this.busy) throw new Error('A scan is already running.');
    if (!values.TYPES[type]) throw new Error(`Unknown value type: ${type}`);
    if (!FIRST.has(compare)) throw new Error('A first scan looks for an exact value or a range.');
    const test = makeTest(type, { compare, value, value2 });
    const size = values.sizeOf(type);
    // Cheat Engine's "fast scan": values sit on 4-byte boundaries (or their
    // own size, if smaller). Unaligned hits are almost never game values.
    const step = Math.min(size, 4);
    const keepValue = compare !== 'exact';
    const blocks = this._blocks();
    const total = blocks.reduce((n, b) => n + b.size, 0);
    this._start();
    try {
      const hits = [];
      let count = 0;
      let done = 0;
      let truncated = false;
      for (const blk of blocks) {
        const offs = new Grow(Uint32Array, 1024);
        const prev = keepValue ? new Grow(Float64Array, 1024) : null;
        for (let off = 0; off < blk.size && !truncated; off += CHUNK) {
          if (this._cancel) throw new Error('cancelled');
          // A few bytes past the chunk, so a value straddling the edge isn't lost.
          const len = Math.min(CHUNK + 8, blk.size - off);
          const buf = this.memory.read(blk.base + BigInt(off), len);
          if (buf) {
            const get = reader(type, buf);
            const end = Math.min(CHUNK, len - size + 1);
            for (let p = 0; p < end; p += step) {
              const v = get(p);
              if (test(v)) {
                offs.push(off + p);
                if (prev) prev.push(v);
                if (++count >= MAX_HITS) { truncated = true; break; }
              }
            }
          }
          done += Math.min(CHUNK, blk.size - off);
          this.emit('progress', { done, total });
          await tick();
        }
        if (offs.n) hits.push({ base: blk.base, size: blk.size, offsets: offs.done(), prev: prev ? prev.done() : null });
        if (truncated) break;
      }
      this.prevGen = null;
      this.gen = { type, hits, count, truncated, constPrev: keepValue ? null : number(type, value, 'a value') };
      this.scans = 1;
      return this.summary();
    } catch (err) {
      if (err.message === 'cancelled') return { ...this.summary(), cancelled: true };
      throw err;
    } finally {
      this._stop();
    }
  }

  async next({ compare = 'exact', value, value2 } = {}) {
    if (this.busy) throw new Error('A scan is already running.');
    if (!this.gen) throw new Error('Do a first scan first.');
    if (!NEXT.has(compare)) throw new Error(`Unknown search "${compare}".`);
    const { type } = this.gen;
    const test = makeTest(type, { compare, value, value2 });
    const size = values.sizeOf(type);
    const total = this.gen.count;
    this._start();
    try {
      const hits = [];
      let count = 0;
      let done = 0;
      let work = 0;
      for (const h of this.gen.hits) {
        const offs = new Grow(Uint32Array, Math.min(4096, h.offsets.length));
        const prev = new Grow(Float64Array, Math.min(4096, h.offsets.length));
        let i = 0;
        while (i < h.offsets.length) {
          if (this._cancel) throw new Error('cancelled');
          // Read a window covering as many of the next hits as fit in one chunk.
          const start = h.offsets[i];
          const end = Math.min(h.size, start + CHUNK);
          let j = i;
          while (j < h.offsets.length && h.offsets[j] + size <= end) j++;
          const buf = this.memory.read(h.base + BigInt(start), end - start);
          if (buf) {
            const get = reader(type, buf);
            for (let k = i; k < j; k++) {
              const v = get(h.offsets[k] - start);
              const p = h.prev ? h.prev[k] : this.gen.constPrev;
              if (test(v, p)) { offs.push(h.offsets[k]); prev.push(v); count++; }
            }
          }
          done += j - i;
          // Yield after a few MB read or ~100k values checked, whichever first.
          work += (j - i) * 40 + (buf ? buf.length : 0);
          i = Math.max(j, i + 1);
          if (work >= CHUNK) {
            work = 0;
            this.emit('progress', { done, total });
            await tick();
          }
        }
        if (offs.n) hits.push({ base: h.base, size: h.size, offsets: offs.done(), prev: prev.done() });
      }
      this.prevGen = this.gen;
      this.gen = { type, hits, count, truncated: false, constPrev: null };
      this.scans += 1;
      return this.summary();
    } catch (err) {
      if (err.message === 'cancelled') return { ...this.summary(), cancelled: true };
      throw err;
    } finally {
      this._stop();
    }
  }

  summary() {
    return { count: this.count, type: this.type, scans: this.scans, truncated: Boolean(this.gen?.truncated), canUndo: Boolean(this.prevGen) };
  }

  // The first `limit` hits with their value now and at the last scan.
  results(limit = 100) {
    const out = [];
    if (!this.gen) return out;
    const size = values.sizeOf(this.gen.type);
    for (const h of this.gen.hits) {
      for (let k = 0; k < h.offsets.length && out.length < limit; k++) {
        const address = h.base + BigInt(h.offsets[k]);
        const buf = this.memory.read(address, size);
        out.push({ address, value: buf ? values.decode(this.gen.type, buf) : null, previous: h.prev ? h.prev[k] : this.gen.constPrev });
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  _start() { this.busy = true; this._cancel = false; this.emit('busy', true); }
  _stop() { this.busy = false; this._cancel = false; this.emit('busy', false); }
}

module.exports = { Scanner, makeTest, tolerance, MAX_HITS };
