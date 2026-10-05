'use strict';

const os = require('os');

// CPU and memory for the overlay's PC stats panel. Whole-PC numbers from the
// OS, never from the game: reading another process (even just its memory
// use) means opening it, which is exactly what Keystone avoids for games
// with anti-cheat.
class PcStats {
  constructor({ cpus = () => os.cpus(), totalmem = () => os.totalmem(), freemem = () => os.freemem() } = {}) {
    this.cpus = cpus;
    this.totalmem = totalmem;
    this.freemem = freemem;
    this.last = this._times();
  }

  _times() {
    let idle = 0;
    let total = 0;
    for (const c of this.cpus()) {
      const t = c.times;
      idle += t.idle;
      total += t.user + t.nice + t.sys + t.idle + t.irq;
    }
    return { idle, total };
  }

  // CPU use since the previous sample, as a whole percent; memory in bytes.
  sample() {
    const now = this._times();
    const dTotal = now.total - this.last.total;
    const dIdle = now.idle - this.last.idle;
    this.last = now;
    const cpu = dTotal > 0 ? Math.round(Math.min(100, Math.max(0, (1 - dIdle / dTotal) * 100))) : 0;
    const total = this.totalmem();
    return { cpu, ramUsed: total - this.freemem(), ramTotal: total };
  }
}

module.exports = { PcStats };
