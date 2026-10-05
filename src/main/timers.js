'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');

// Countdown timers for the overlay: egg hatching, crop growth, a supply drop,
// a boss cooldown. App-wide rather than per game, so a timer started in one
// game still goes off after switching to another page.
//
// Stored with absolute end times, so they keep counting while Keystone is
// closed; ones that ended meanwhile show as done without a late alert.

const MAX_TIMERS = 20;
const MAX_MS = 24 * 3600 * 1000;
// setTimeout misbehaves past ~24.8 days, and an hour keeps a sleeping PC's
// clock drift in check: wake up at least this often and re-check.
const MAX_WAIT = 3600 * 1000;

// "15m", "1h 30m", "90s", "2:30" (m:ss), "1:02:03" (h:mm:ss), or a bare
// number, which means minutes: that's how people think about game timers.
function parseDuration(input) {
  if (typeof input === 'number') return input > 0 ? Math.round(input * 1000) : NaN;
  const s = String(input || '').trim().toLowerCase();
  if (!s) return NaN;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 60000);
  const clock = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (clock) {
    const [, h, m, sec] = clock;
    if (Number(sec) > 59 || (h !== undefined && Number(m) > 59)) return NaN;
    return ((Number(h || 0) * 60 + Number(m)) * 60 + Number(sec)) * 1000;
  }
  const re = /(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|min|mins|minutes?|s|sec|secs|seconds?)\b/g;
  let total = 0;
  let used = '';
  let m;
  while ((m = re.exec(s))) {
    const unit = m[2][0];
    total += Number(m[1]) * (unit === 'h' ? 3600000 : unit === 'm' ? 60000 : 1000);
    used += m[0];
  }
  // Every non-space character has to belong to a number+unit pair, so
  // "5 mins of fun" isn't read as five minutes.
  if (!total || used.replace(/\s/g, '').length !== s.replace(/\s/g, '').length) return NaN;
  return Math.round(total);
}

function formatDuration(ms) {
  const t = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

class Timers extends EventEmitter {
  constructor({ settings, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    super();
    this.settings = settings;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.handle = null;
    if (!Array.isArray(this.settings.data.timers)) this.settings.data.timers = [];
    // Anything that ran out while Keystone was closed: done, quietly.
    this._expire({ quiet: true });
    this._schedule();
  }

  get _list() {
    return this.settings.data.timers;
  }

  list() {
    const now = this.now();
    return this._list.map((t) => ({
      id: t.id,
      name: t.name,
      durationMs: t.durationMs,
      repeat: t.repeat,
      endsAt: t.endsAt,
      state: t.endsAt ? 'running' : t.pausedLeft ? 'paused' : t.doneAt ? 'done' : 'idle',
      remainingMs: t.endsAt ? Math.max(0, t.endsAt - now) : t.pausedLeft || (t.doneAt ? 0 : t.durationMs),
    }));
  }

  add({ name, duration, repeat = false } = {}) {
    if (this._list.length >= MAX_TIMERS) throw new Error(`That's the limit of ${MAX_TIMERS} timers. Delete one first.`);
    const durationMs = this._duration(duration);
    const t = { id: crypto.randomBytes(5).toString('base64url'), name: cleanName(name) || `Timer ${this._list.length + 1}`, durationMs, repeat: Boolean(repeat), endsAt: null, pausedLeft: null, doneAt: null };
    this._list.push(t);
    this._changed();
    return this.list().find((x) => x.id === t.id);
  }

  update(id, patch = {}) {
    const t = this._get(id);
    if (patch.name !== undefined) t.name = cleanName(patch.name) || t.name;
    if (patch.repeat !== undefined) t.repeat = Boolean(patch.repeat);
    if (patch.duration !== undefined) {
      t.durationMs = this._duration(patch.duration);
      // A new length applies from the next start; a running one keeps going.
      t.pausedLeft = null;
    }
    this._changed();
    return this.list().find((x) => x.id === id);
  }

  start(id) {
    const t = this._get(id);
    if (t.endsAt) return this.list().find((x) => x.id === id);
    t.endsAt = this.now() + (t.pausedLeft || t.durationMs);
    t.pausedLeft = null;
    t.doneAt = null;
    this._changed();
    return this.list().find((x) => x.id === id);
  }

  pause(id) {
    const t = this._get(id);
    if (!t.endsAt) return this.list().find((x) => x.id === id);
    t.pausedLeft = Math.max(1000, t.endsAt - this.now());
    t.endsAt = null;
    this._changed();
    return this.list().find((x) => x.id === id);
  }

  // Start/pause in one, for a single button or hotkey.
  toggle(id) {
    return this._get(id).endsAt ? this.pause(id) : this.start(id);
  }

  reset(id) {
    const t = this._get(id);
    Object.assign(t, { endsAt: null, pausedLeft: null, doneAt: null });
    this._changed();
    return this.list().find((x) => x.id === id);
  }

  remove(id) {
    this._get(id);
    this.settings.data.timers = this._list.filter((t) => t.id !== id);
    this._changed();
    return true;
  }

  shutdown() {
    if (this.handle) this.clearTimer(this.handle);
    this.handle = null;
  }

  _get(id) {
    const t = this._list.find((x) => x.id === id);
    if (!t) throw new Error('That timer no longer exists.');
    return t;
  }

  _duration(input) {
    const ms = parseDuration(input);
    if (!Number.isFinite(ms) || ms < 1000) throw new Error('Give the timer a length, like 15m, 1h 30m or 2:30.');
    if (ms > MAX_MS) throw new Error('Timers can run for up to 24 hours.');
    return ms;
  }

  _changed() {
    this.settings._save();
    this._schedule();
    this.emit('change');
  }

  _schedule() {
    if (this.handle) this.clearTimer(this.handle);
    this.handle = null;
    const next = Math.min(...this._list.filter((t) => t.endsAt).map((t) => t.endsAt));
    if (!Number.isFinite(next)) return;
    const wait = Math.min(MAX_WAIT, Math.max(0, next - this.now()));
    this.handle = this.setTimer(() => this._fire(), wait + 20);
    this.handle?.unref?.();
  }

  _fire() {
    this.handle = null;
    if (this._expire({ quiet: false })) { this.settings._save(); this.emit('change'); }
    this._schedule();
  }

  // Ends every running timer whose time is up. Repeating ones roll over to
  // their next end time (skipping any rounds missed while asleep).
  _expire({ quiet }) {
    const now = this.now();
    let any = false;
    for (const t of this._list) {
      if (!t.endsAt || t.endsAt > now) continue;
      any = true;
      if (t.repeat && !quiet) {
        while (t.endsAt <= now) t.endsAt += t.durationMs;
      } else {
        t.endsAt = null;
        t.doneAt = now;
      }
      if (!quiet) this.emit('done', { id: t.id, name: t.name, repeat: t.repeat });
    }
    return any;
  }
}

function cleanName(s) {
  return String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, 30);
}

module.exports = { Timers, parseDuration, formatDuration, MAX_TIMERS };
