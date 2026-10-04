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
    const access = win32.C.PROCESS_VM_READ | win32.C.PROCESS_VM_WRITE |
      win32.C.PROCESS_VM_OPERATION | win32.C.PROCESS_QUERY_LIMITED_INFORMATION;
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
