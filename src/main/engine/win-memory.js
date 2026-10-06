'use strict';

const win32 = require('./win32');

// Memory backend for a real Windows process.
// Interface shared with MockMemory: pointerSize, getModule, refreshModules,
// read, write, isAlive, close.

class WinMemory {
  constructor(pid) {
    const k = win32.load();
    this.pid = pid;
    this.k = k;
    // QUERY_INFORMATION (not just the LIMITED kind) is what VirtualQueryEx
    // needs, for the value finder's list of memory regions.
    const access = win32.C.PROCESS_VM_READ | win32.C.PROCESS_VM_WRITE |
      win32.C.PROCESS_VM_OPERATION | win32.C.PROCESS_QUERY_INFORMATION;
    const h = k.OpenProcess(access, false, pid);
    if (win32.isInvalidHandle(h)) {
      const err = k.GetLastError();
      if (err === win32.C.ERROR_ACCESS_DENIED) {
        throw new Error('Windows denied access to that process. If the game runs as administrator, run Keystone as administrator too. Games protected by anti-cheat will always refuse.');
      }
      throw new Error(`Couldn't open process ${pid} (Windows error ${err}).`);
    }
    this.handle = h;

    const wow = [false];
    k.IsWow64Process(h, wow);
    // A WOW64 process is a 32-bit game on 64-bit Windows: pointers are 4 bytes.
    this.pointerSize = wow[0] ? 4 : 8;

    this.modules = new Map();
    this._lastRefresh = 0;
    this.refreshModules(true);
  }

  refreshModules(force = false) {
    // Module snapshots are slow-ish; a missing module during a pointer walk can
    // trigger a refresh every tick, so rate-limit to once a second.
    const now = Date.now();
    if (!force && now - this._lastRefresh < 1000) return;
    this._lastRefresh = now;

    const snap = this.k.CreateToolhelp32Snapshot(win32.C.TH32CS_SNAPMODULE | win32.C.TH32CS_SNAPMODULE32, this.pid);
    if (win32.isInvalidHandle(snap)) return;
    try {
      const entry = { dwSize: require('koffi').sizeof(win32.MODULEENTRY32W) };
      const mods = new Map();
      if (this.k.Module32FirstW(snap, entry)) {
        do {
          mods.set(entry.szModule.toLowerCase(), { base: BigInt(entry.modBaseAddr), size: entry.modBaseSize, name: entry.szModule });
        } while (this.k.Module32NextW(snap, entry));
      }
      if (mods.size) this.modules = mods;
    } finally {
      this.k.CloseHandle(snap);
    }
  }

  getModule(name) {
    const key = String(name).toLowerCase();
    let mod = this.modules.get(key);
    if (!mod) {
      this.refreshModules();
      mod = this.modules.get(key);
    }
    return mod || null;
  }

  // Blocks of memory a game keeps its changing values in: committed,
  // writable, and either the game's own allocations (heap) or a loaded
  // module's data. File mappings (MEM_MAPPED) are left out, as Cheat Engine
  // does by default: they're mostly shared files, not game state.
  regions() {
    const C = win32.C;
    const writable = C.PAGE_READWRITE | C.PAGE_WRITECOPY | C.PAGE_EXECUTE_READWRITE | C.PAGE_EXECUTE_WRITECOPY;
    const max = this.pointerSize === 4 ? 0xFFFF0000n : 0x7FFFFFFF0000n;
    const size = require('koffi').sizeof(win32.MEMORY_BASIC_INFORMATION);
    const out = [];
    let addr = 0x10000n;
    while (addr < max) {
      const mbi = {};
      if (!Number(this.k.VirtualQueryEx(this.handle, addr, mbi, size))) break;
      const base = BigInt(mbi.BaseAddress);
      const len = BigInt(mbi.RegionSize);
      if (len <= 0n) break;
      const ok = mbi.State === C.MEM_COMMIT && (mbi.Protect & writable) && !(mbi.Protect & (C.PAGE_GUARD | C.PAGE_NOACCESS))
        && (mbi.Type === C.MEM_PRIVATE || mbi.Type === C.MEM_IMAGE);
      if (ok) out.push({ base, size: Number(len) });
      addr = base + len;
    }
    return out;
  }

  _query(addr) {
    const mbi = {};
    const size = require('koffi').sizeof(win32.MEMORY_BASIC_INFORMATION);
    if (!Number(this.k.VirtualQueryEx(this.handle, addr, mbi, size))) return null;
    return { base: BigInt(mbi.BaseAddress), size: BigInt(mbi.RegionSize), state: mbi.State, protect: mbi.Protect, type: mbi.Type };
  }

  // Every readable block between start and end (clipped to them), code
  // included: what Cheat Engine scripts search for their byte patterns.
  readableRegions(start = 0x10000n, end = null) {
    const C = win32.C;
    const max = end ?? (this.pointerSize === 4 ? 0xFFFF0000n : 0x7FFFFFFF0000n);
    const out = [];
    let addr = start;
    while (addr < max) {
      const q = this._query(addr);
      if (!q || q.size <= 0n) break;
      const readable = q.state === C.MEM_COMMIT && !(q.protect & (C.PAGE_GUARD | C.PAGE_NOACCESS)) && q.protect !== 0;
      if (readable) {
        const from = q.base < start ? start : q.base;
        const to = q.base + q.size > max ? max : q.base + q.size;
        if (to > from) out.push({ base: from, size: Number(to - from) });
      }
      addr = q.base + q.size;
    }
    return out;
  }

  // Memory for a script's code cave. "near" matters: the game jumps there
  // with a 5-byte jump, which only reaches 2 GB either way, so this looks
  // for a free block within that distance first.
  alloc(size, near = null) {
    const C = win32.C;
    const type = C.MEM_COMMIT | C.MEM_RESERVE;
    const RWX = C.PAGE_EXECUTE_READWRITE;
    const len = Math.ceil(size / 4096) * 4096;
    if (near === null || near === undefined) {
      const a = BigInt(this.k.VirtualAllocEx(this.handle, 0, len, type, RWX));
      if (!a) throw new Error('Windows wouldn\u2019t give the game more memory for this script.');
      return a;
    }
    const GRAN = 0x10000n;
    const RANGE = 0x7FFF0000n;
    const lo = near > RANGE + 0x10000n ? near - RANGE : 0x10000n;
    const hi = near + RANGE;
    // Walk free blocks outward from the target, closest first.
    const free = [];
    let addr = lo;
    while (addr < hi) {
      const q = this._query(addr);
      if (!q || q.size <= 0n) break;
      if (q.state === C.MEM_FREE) free.push(q);
      addr = q.base + q.size;
    }
    const dist = (q) => (q.base > near ? q.base - near : near - (q.base + q.size));
    free.sort((a, b) => (dist(a) < dist(b) ? -1 : 1));
    for (const q of free) {
      // Allocations start on 64 KB boundaries.
      const start = ((q.base + GRAN - 1n) / GRAN) * GRAN;
      const tries = q.base > near ? [start] : [((q.base + q.size - BigInt(len)) / GRAN) * GRAN, start];
      for (const t of tries) {
        if (t < q.base || t + BigInt(len) > q.base + q.size) continue;
        const d = t > near ? t - near : near - t;
        if (d > RANGE) continue;
        const a = BigInt(this.k.VirtualAllocEx(this.handle, t, len, type, RWX));
        if (a) return a;
      }
    }
    throw new Error('Couldn\u2019t find free memory close enough to the game\u2019s code for this script.');
  }

  free(addr) {
    this.k.VirtualFreeEx(this.handle, addr, 0, win32.C.MEM_RELEASE);
  }

  // Returns the old protection, or null if it couldn't be changed.
  protect(addr, size, prot) {
    const old = [0];
    return this.k.VirtualProtectEx(this.handle, addr, size, prot, old) ? old[0] : null;
  }

  flush(addr, size) {
    this.k.FlushInstructionCache(this.handle, addr, size);
  }

  read(addr, size) {
    const buf = Buffer.alloc(size);
    const got = [0];
    const ok = this.k.ReadProcessMemory(this.handle, addr, buf, size, got);
    if (!ok || Number(got[0]) !== size) return null;
    return buf;
  }

  write(addr, buf) {
    const wrote = [0];
    const ok = this.k.WriteProcessMemory(this.handle, addr, buf, buf.length, wrote);
    return Boolean(ok) && Number(wrote[0]) === buf.length;
  }

  isAlive() {
    const code = [0];
    if (!this.k.GetExitCodeProcess(this.handle, code)) return false;
    return code[0] === win32.C.STILL_ACTIVE;
  }

  close() {
    if (this.handle) this.k.CloseHandle(this.handle);
    this.handle = null;
  }
}

module.exports = { WinMemory };
