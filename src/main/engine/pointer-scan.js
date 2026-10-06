'use strict';

const { EventEmitter } = require('events');

// The pointer finder: turns a value's heap address (different every time
// the game starts) into a pointer path that starts inside the game's own
// files ("Game.exe+1A2B3C", the same every start), the way Cheat Engine's
// pointer scan does.
//
// It works backwards from the value, one level at a time. Each level reads
// the game's writable memory once and keeps every pointer that lands at, or
// a little before, an address from the level before (objects keep their
// fields at small offsets from their start). A pointer that lives inside a
// game module ends a path; the rest become the next level's targets. Paths
// come out shortest first.
//
// Most paths a scan finds only work by luck this run. "Check after a
// restart" (finder.js) keeps the ones that still lead to the value.
//
// Like the value scanner it reads a few MB at a time and yields in between,
// and can be cancelled. Addresses are kept as plain numbers: user-space
// addresses are below 2^47, well inside a double's exact range.

const CHUNK = 4 * 1024 * 1024;
const TWO32 = 4294967296;
const tick = () => new Promise((r) => setImmediate(r));

class PointerScanner extends EventEmitter {
  constructor(memory) {
    super();
    this.memory = memory;
    this.busy = false;
    this._cancel = false;
  }

  cancel() { if (this.busy) this._cancel = true; }

  // target: BigInt address. Returns { paths: [{ base, offsets }], levels }.
  // base is "module+hex offset"; offsets are applied in order (Keystone's
  // record order), each read-then-add.
  async scan(target, { maxOffset = 0x1000, maxDepth = 4, maxResults = 300, maxTargets = 20000 } = {}) {
    if (this.busy) throw new Error('A pointer search is already running.');
    const mem = this.memory;
    const ps = mem.pointerSize || 8;
    mem.refreshModules?.(true);
    const mods = [...(mem.modules?.values?.() || [])]
      .map((m) => ({ name: m.name, base: Number(m.base), end: Number(m.base) + Number(m.size) }))
      .sort((a, b) => a.base - b.base);
    const modOf = (a) => {
      let lo = 0;
      let hi = mods.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (a < mods[mid].base) hi = mid - 1;
        else if (a >= mods[mid].end) lo = mid + 1;
        else return mods[mid];
      }
      return null;
    };
    if (!mods.length) throw new Error('Keystone can’t see the game’s modules, so there’s nothing for a path to start from.');
    if (typeof mem.regions !== 'function') throw new Error('This game’s memory can’t be searched.');
    const blocks = mem.regions();
    const perLevel = blocks.reduce((n, b) => n + b.size, 0);

    // Every address reached so far: { addr, parent, offset }. Index 0 is
    // the value itself.
    const nodes = [{ addr: Number(target), parent: -1, offset: 0 }];
    const seen = new Set([Number(target)]);
    const found = [];
    let frontier = [0];
    let levels = 0;

    this.busy = true;
    this._cancel = false;
    try {
      for (let level = 1; level <= maxDepth && frontier.length && found.length < maxResults; level++) {
        levels = level;
        frontier.sort((a, b) => nodes[a].addr - nodes[b].addr);
        const tAddr = Float64Array.from(frontier, (i) => nodes[i].addr);
        const lo = tAddr[0] - maxOffset;
        const hi = tAddr[tAddr.length - 1];
        const hits = []; // [location, node index, offset] triples, flat
        const hitCap = maxTargets * 8;

        let done = 0;
        for (const blk of blocks) {
          for (let off = 0; off < blk.size; off += CHUNK) {
            if (this._cancel) throw new Error('cancelled');
            const len = Math.min(CHUNK, blk.size - off);
            const buf = mem.read(blk.base + BigInt(off), len);
            if (buf && hits.length < hitCap * 3) {
              const base = Number(blk.base) + off;
              const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
              const end = len - ps + 1;
              for (let p = 0; p < end; p += ps) {
                const v = ps === 8 ? dv.getUint32(p + 4, true) * TWO32 + dv.getUint32(p, true) : dv.getUint32(p, true);
                if (v < lo || v > hi) continue;
                // First target at or above v; every target within reach counts.
                let a = 0;
                let b = tAddr.length;
                while (a < b) { const m = (a + b) >> 1; if (tAddr[m] < v) a = m + 1; else b = m; }
                for (let k = a; k < tAddr.length && tAddr[k] - v <= maxOffset; k++) hits.push(base + p, frontier[k], tAddr[k] - v);
              }
            }
            done += len;
            this.emit('progress', { level, maxDepth, done: (level - 1) * perLevel + done, total: maxDepth * perLevel, found: found.length });
            await tick();
          }
        }

        // Smallest offsets first: a field near an object's start is the
        // likelier real link, and they're the ones kept if there are too many.
        const order = [];
        for (let i = 0; i < hits.length; i += 3) order.push(i);
        order.sort((x, y) => hits[x + 2] - hits[y + 2]);
        const next = [];
        for (const i of order) {
          const loc = hits[i];
          const idx = nodes.push({ addr: loc, parent: hits[i + 1], offset: hits[i + 2] }) - 1;
          const mod = modOf(loc);
          if (mod) {
            if (found.length < maxResults * 4) found.push({ idx, mod, level });
          } else if (!seen.has(loc) && next.length < maxTargets) {
            seen.add(loc);
            next.push(idx);
          }
        }
        frontier = next;
      }
    } catch (err) {
      if (err.message === 'cancelled') return { paths: [], levels, cancelled: true };
      throw err;
    } finally {
      this.busy = false;
      this._cancel = false;
    }

    const paths = found.map(({ idx, mod, level }) => {
      const offsets = [];
      let total = 0;
      for (let n = idx; nodes[n].parent !== -1; n = nodes[n].parent) {
        offsets.push(nodes[n].offset);
        total += nodes[n].offset;
      }
      return { base: `${mod.name}+${(nodes[idx].addr - mod.base).toString(16).toUpperCase()}`, offsets, level, total };
    });
    // Shortest first, then smallest offsets; the same path twice only once.
    paths.sort((a, b) => a.level - b.level || a.total - b.total);
    const unique = new Map();
    for (const p of paths) {
      const key = `${p.base}|${p.offsets.join(',')}`;
      if (!unique.has(key)) unique.set(key, { base: p.base, offsets: p.offsets });
    }
    return { paths: [...unique.values()].slice(0, maxResults), levels };
  }
}

module.exports = { PointerScanner };
