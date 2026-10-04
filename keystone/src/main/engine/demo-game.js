'use strict';

// A fake game living entirely in Keystone's own memory, exposed through the
// same backend interface as WinMemory. It exists so every feature — pointer
// chains, freezing, profiles, the phone remote, the minimap — can be tried
// and tested without a real game (or without Windows at all).
//
// Layout (64-bit pointers):
//   demo.exe+0x2000           -> pointer to Player (heap+0x100)
//   Player+0x10 float health    Player+0x14 float stamina
//   Player+0x18 int32 ammo      Player+0x1C int32 gold
//   Player+0x30/34/38 float X/Y/Z   Player+0x3C float yaw (degrees)
//   Player+0x40               -> pointer to Inventory (heap+0x800)
//   Inventory+0x08 int32 wood   Inventory+0x0C int32 stone

const MODULE_BASE = 0x140000000n;
const HEAP_BASE = 0x20000000n;
const PLAYER = HEAP_BASE + 0x100n;
const INVENTORY = HEAP_BASE + 0x800n;
const PLAYER_PTR = MODULE_BASE + 0x2000n;

const P = { health: 0x10, stamina: 0x14, ammo: 0x18, gold: 0x1c, x: 0x30, y: 0x34, z: 0x38, yaw: 0x3c, inv: 0x40 };
const I = { wood: 0x08, stone: 0x0c };

class DemoGame {
  constructor({ tickMs = 50, loadingEveryMs = 45000, loadingForMs = 1500 } = {}) {
    this.pointerSize = 8;
    this.pid = 0;
    this.name = 'demo.exe';
    this.regions = [
      { base: MODULE_BASE, buf: Buffer.alloc(0x10000) },
      { base: HEAP_BASE, buf: Buffer.alloc(0x10000) },
    ];
    this.modules = new Map([['demo.exe', { base: MODULE_BASE, size: 0x10000, name: 'demo.exe' }]]);
    this.t = 0;
    this.loadingEveryMs = loadingEveryMs;
    this.loadingForMs = loadingForMs;
    this.alive = true;
    // Where the player has been moved to by someone else (Keystone's teleport
    // or a locked position), relative to the scripted path.
    this.moved = { x: 0, y: 0, z: 0 };
    this.lastPos = null;

    this._writePtr(PLAYER_PTR, PLAYER);
    this._writePtr(PLAYER + BigInt(P.inv), INVENTORY);
    this._f(PLAYER, P.health, 100);
    this._f(PLAYER, P.stamina, 100);
    this._i(PLAYER, P.ammo, 30);
    this._i(PLAYER, P.gold, 250);
    this._i(INVENTORY, I.wood, 40);
    this._i(INVENTORY, I.stone, 12);

    this._timer = tickMs > 0 ? setInterval(() => this.step(tickMs), tickMs) : null;
    if (this._timer?.unref) this._timer.unref();
  }

  // Advances the simulation. Public so tests can drive time deterministically.
  step(ms) {
    this.t += ms;
    const s = this.t / 1000;

    // Periodic "loading screen": the player pointer goes null, like real games
    // do between levels. Keystone should show the mod as waiting, not crash.
    const loading = this.loadingEveryMs > 0 && (this.t % this.loadingEveryMs) < this.loadingForMs && this.t > this.loadingForMs;
    this._writePtr(PLAYER_PTR, loading ? 0n : PLAYER);

    const hp = this._rf(PLAYER, P.health) - 2.5 * (ms / 1000) * 4;
    this._f(PLAYER, P.health, hp <= 0 ? 100 : hp);
    this._f(PLAYER, P.stamina, 50 + 50 * Math.sin(s * 0.8));

    if (Math.floor(this.t / 600) !== Math.floor((this.t - ms) / 600)) {
      const ammo = this._ri(PLAYER, P.ammo) - 1;
      this._i(PLAYER, P.ammo, ammo < 0 ? 30 : ammo);
    }
    if (Math.floor(this.t / 2000) !== Math.floor((this.t - ms) / 2000)) {
      this._i(PLAYER, P.gold, this._ri(PLAYER, P.gold) + 5);
      this._i(INVENTORY, I.wood, this._ri(INVENTORY, I.wood) + 1);
    }

    // Wander a figure-eight across a ±3000 unit world. A position written
    // from outside since the last step (a teleport) shifts the path, so the
    // player carries on from the new spot like in a real game.
    if (this.lastPos) {
      for (const k of ['x', 'y', 'z']) {
        const now = this._rf(PLAYER, P[k]);
        if (Math.abs(now - this.lastPos[k]) > 0.01) this.moved[k] += now - this.lastPos[k];
      }
    }
    const x = 3000 * Math.sin(s * 0.05) + this.moved.x;
    const y = 1800 * Math.sin(s * 0.1) + this.moved.y;
    const z = 120 + 30 * Math.sin(s * 0.3) + this.moved.z;
    const dx = 3000 * 0.05 * Math.cos(s * 0.05);
    const dy = 1800 * 0.1 * Math.cos(s * 0.1);
    this._f(PLAYER, P.x, x);
    this._f(PLAYER, P.y, y);
    this._f(PLAYER, P.z, z);
    // Read back rather than keep x/y/z: the stored floats are 32-bit, so
    // comparing against the doubles would see a "move" every step.
    this.lastPos = { x: this._rf(PLAYER, P.x), y: this._rf(PLAYER, P.y), z: this._rf(PLAYER, P.z) };
    this._f(PLAYER, P.yaw, (Math.atan2(dy, dx) * 180) / Math.PI);
  }

  // ---- backend interface ----
  getModule(name) { return this.modules.get(String(name).toLowerCase()) || null; }
  refreshModules() {}

  read(addr, size) {
    const r = this._region(addr, size);
    if (!r) return null;
    const off = Number(addr - r.base);
    return Buffer.from(r.buf.subarray(off, off + size));
  }

  write(addr, buf) {
    const r = this._region(addr, buf.length);
    if (!r) return false;
    buf.copy(r.buf, Number(addr - r.base));
    return true;
  }

  isAlive() { return this.alive; }

  close() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this.alive = false;
  }

  // ---- helpers ----
  _region(addr, size) {
    for (const r of this.regions) {
      if (addr >= r.base && addr + BigInt(size) <= r.base + BigInt(r.buf.length)) return r;
    }
    return null;
  }
  _writePtr(addr, value) { const b = Buffer.alloc(8); b.writeBigUInt64LE(value); this.write(addr, b); }
  _f(base, off, v) { const b = Buffer.alloc(4); b.writeFloatLE(v); this.write(base + BigInt(off), b); }
  _i(base, off, v) { const b = Buffer.alloc(4); b.writeInt32LE(v); this.write(base + BigInt(off), b); }
  _rf(base, off) { return this.read(base + BigInt(off), 4).readFloatLE(0); }
  _ri(base, off) { return this.read(base + BigInt(off), 4).readInt32LE(0); }
}

module.exports = { DemoGame, MODULE_BASE, HEAP_BASE, PLAYER, INVENTORY };
