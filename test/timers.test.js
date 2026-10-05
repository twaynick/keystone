'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Timers, parseDuration, formatDuration } = require('../src/main/timers');
const { Settings } = require('../src/main/settings');
const { Controller } = require('../src/main/controller');

const PACKS = path.join(__dirname, '..', 'packs');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'keystone-timers-'));

// A clock and scheduler the test moves by hand.
function fakeTime(start = 1_000_000) {
  const t = { now: start, pending: [] };
  t.setTimer = (fn, ms) => { const h = { fn, at: t.now + ms }; t.pending.push(h); return h; };
  t.clearTimer = (h) => { t.pending = t.pending.filter((x) => x !== h); };
  t.advance = (ms) => {
    t.now += ms;
    for (;;) {
      const due = t.pending.filter((h) => h.at <= t.now).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      t.pending = t.pending.filter((h) => h !== due);
      due.fn();
    }
  };
  return t;
}

function make(dir = tmpDir(), time = fakeTime()) {
  const settings = new Settings(dir);
  const timers = new Timers({ settings, now: () => time.now, setTimer: time.setTimer, clearTimer: time.clearTimer });
  const done = [];
  timers.on('done', (d) => done.push(d));
  return { timers, settings, time, done, dir };
}

test('durations parse the ways people type them', () => {
  assert.equal(parseDuration('15m'), 15 * 60000);
  assert.equal(parseDuration('1h 30m'), 90 * 60000);
  assert.equal(parseDuration('90s'), 90000);
  assert.equal(parseDuration('2:30'), 150000);
  assert.equal(parseDuration('1:02:03'), 3723000);
  assert.equal(parseDuration('10'), 600000, 'a bare number is minutes');
  assert.equal(parseDuration(45), 45000, 'a JS number is seconds');
  assert.equal(parseDuration('1 hour 5 minutes'), 65 * 60000);
  for (const bad of ['', 'soon', '5 mins of fun', '2:75', '-3m']) assert.ok(Number.isNaN(parseDuration(bad)), bad);
  assert.equal(formatDuration(3723000), '1:02:03');
  assert.equal(formatDuration(59001), '1:00', 'rounds up so 0:00 means done');
  assert.equal(formatDuration(0), '0:00');
});

test('a timer counts down, pauses, resumes and goes off once', () => {
  const { timers, time, done } = make();
  const t = timers.add({ name: 'Egg', duration: '10m' });
  assert.equal(t.state, 'idle');
  assert.equal(t.remainingMs, 600000);
  timers.start(t.id);
  time.advance(4 * 60000);
  assert.equal(timers.list()[0].remainingMs, 6 * 60000);
  timers.pause(t.id);
  time.advance(60 * 60000);
  assert.equal(timers.list()[0].state, 'paused');
  assert.equal(timers.list()[0].remainingMs, 6 * 60000, 'paused time does not count');
  timers.toggle(t.id);
  time.advance(6 * 60000 + 100);
  assert.deepEqual(done, [{ id: t.id, name: 'Egg', repeat: false }]);
  assert.equal(timers.list()[0].state, 'done');
  time.advance(60 * 60000);
  assert.equal(done.length, 1);
  timers.reset(t.id);
  assert.equal(timers.list()[0].state, 'idle');
});

test('repeating timers roll over and keep going', () => {
  const { timers, time, done } = make();
  const t = timers.add({ name: 'Drop', duration: '5m', repeat: true });
  timers.start(t.id);
  time.advance(5 * 60000 + 100);
  time.advance(5 * 60000);
  assert.equal(done.length, 2);
  assert.equal(timers.list()[0].state, 'running');
});

test('timers survive a restart; ones that ended meanwhile are done without an alert', () => {
  const time = fakeTime();
  const first = make(tmpDir(), time);
  const a = first.timers.add({ name: 'Long', duration: '2h' });
  const b = first.timers.add({ name: 'Short', duration: '1m' });
  first.timers.start(a.id);
  first.timers.start(b.id);
  first.timers.shutdown();
  time.now += 30 * 60000; // Keystone closed for half an hour
  const second = make(first.dir, time);
  const [long, short] = second.timers.list();
  assert.equal(long.state, 'running');
  assert.equal(long.remainingMs, 90 * 60000);
  assert.equal(short.state, 'done');
  assert.equal(second.done.length, 0);
  second.time.advance(90 * 60000 + 100);
  assert.deepEqual(second.done.map((d) => d.name), ['Long']);
});

test('timer input is checked', () => {
  const { timers } = make();
  assert.throws(() => timers.add({ name: 'x', duration: 'soon' }), /length/);
  assert.throws(() => timers.add({ name: 'x', duration: '25h' }), /24 hours/);
  const t = timers.add({ name: '   ', duration: '1m' });
  assert.equal(t.name, 'Timer 1');
  timers.update(t.id, { name: 'Crop', duration: '3m', repeat: true });
  assert.deepEqual(timers.list()[0].durationMs, 180000);
  timers.remove(t.id);
  assert.throws(() => timers.start(t.id), /no longer exists/);
  for (let i = 0; i < 20; i++) timers.add({ duration: '1m' });
  assert.throws(() => timers.add({ duration: '1m' }), /limit/);
});

test('checklists: pack starters, tick, add, reset, and they reach the overlay and phone', () => {
  const c = new Controller({ packsDir: PACKS, dataDir: tmpDir() });
  c.listProcesses = () => [];
  c.attach({ packId: 'ark-survival-ascended' });
  const lists = c.overlay.checklists();
  assert.ok(lists.length >= 2);
  const arts = lists.find((l) => /artifact/i.test(l.name));
  assert.equal(arts.items.length, 10);
  assert.equal(c.overlay.activeList().id, lists[0].id);

  const item = arts.items[0];
  assert.equal(c.overlay.checkItem(arts.id, item.id), true, 'no value flips it');
  assert.equal(c.overlay.checkItem(arts.id, item.id, true), true);
  c.overlay.setActiveList(arts.id);
  const st = c.overlay.state();
  assert.equal(st.checklist.id, arts.id);
  assert.equal(st.checklists.find((l) => l.id === arts.id).done, 1);
  assert.equal(c.snapshot().checklist.items[0].done, true);

  const extra = c.overlay.addItem(arts.id, '  Artifact of the Gatekeeper  ');
  assert.equal(extra.text, 'Artifact of the Gatekeeper');
  c.overlay.removeItem(arts.id, extra.id);
  c.overlay.resetList(arts.id);
  assert.ok(c.overlay.activeList().items.every((i) => !i.done));

  const mine = c.overlay.addList('Tames');
  assert.equal(c.overlay.activeList().id, mine.id, 'a new list becomes the one shown');
  c.overlay.renameList(mine.id, 'My tames');
  c.overlay.removeList(mine.id);
  assert.notEqual(c.overlay.activeList()?.id, mine.id);
  assert.throws(() => c.overlay.addItem(mine.id, 'x'), /no longer exists/);
  assert.throws(() => c.overlay.addItem(arts.id, '   '), /Type something/);

  // Deleting a starter list sticks: packs seed only once.
  c.overlay.removeList(arts.id);
  c.attach({ packId: 'ark-survival-ascended' });
  assert.ok(!c.overlay.checklists().some((l) => l.id === arts.id || /artifact/i.test(l.name)));
  c.shutdown();
});

test('timers show in the overlay state and phone snapshot when wired', () => {
  const dir = tmpDir();
  const { timers } = make(dir);
  const c = new Controller({ packsDir: PACKS, dataDir: dir });
  c.timers = timers;
  c.attach({ demo: true });
  timers.add({ name: 'Egg', duration: '1m' });
  assert.equal(c.overlay.state().timers[0].name, 'Egg');
  assert.equal(c.snapshot().timers[0].name, 'Egg');
  c.shutdown();
});
