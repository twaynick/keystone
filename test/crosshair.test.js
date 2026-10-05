'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Crosshair = require('../src/shared/crosshair');
const { PcStats } = require('../src/main/pcstats');
const { Controller } = require('../src/main/controller');

const PACKS = path.join(__dirname, '..', 'packs');

test('crosshair settings are clamped and odd values fall back', () => {
  const c = Crosshair.normalize({ on: 1, style: 'star', size: 99, thickness: 0, gap: -4, color: 'pink', opacity: 5, dx: 9999, dy: 'x' });
  assert.deepEqual(c, { on: true, style: 'cross', size: 40, thickness: 1, gap: 0, color: 'accent', opacity: 1, outline: true, dx: 400, dy: 0 });
  assert.equal(Crosshair.normalize({ color: '#12ab34' }).color, '#12ab34');
  assert.equal(Crosshair.extent(Crosshair.DEFAULTS), 2 * (10 + 4 + 2 + 3));
});

test('crosshair draws each style without throwing, in the chosen colour', () => {
  const calls = [];
  const ctx = new Proxy({}, {
    get: (_t, k) => (k === 'fillStyle' || k === 'strokeStyle' || k === 'globalAlpha' || k === 'lineWidth' ? undefined : (...a) => calls.push([k, ...a])),
    set: (_t, k, v) => { calls.push(['set', k, v]); return true; },
  });
  for (const style of Crosshair.STYLES) Crosshair.draw(ctx, Crosshair.normalize({ style, color: 'green' }), 50, 50, '#c48aff');
  assert.ok(calls.some((c) => c[0] === 'set' && c[1] === 'fillStyle' && c[2] === '#4dff7c'));
  calls.length = 0;
  Crosshair.draw(ctx, Crosshair.normalize({ color: 'accent', outline: false }), 50, 50, '#c48aff');
  assert.ok(calls.some((c) => c[1] === 'fillStyle' && c[2] === '#c48aff'));
  assert.ok(!calls.some((c) => c[1] === 'strokeStyle' && c[2] === 'rgba(0,0,0,0.85)'), 'no outline when off');
});

test('PC stats: CPU from the change in OS counters, memory in bytes', () => {
  let times = { user: 100, nice: 0, sys: 100, idle: 800, irq: 0 };
  const pc = new PcStats({ cpus: () => [{ times }, { times }], totalmem: () => 16e9, freemem: () => 6e9 });
  times = { user: 400, nice: 0, sys: 100, idle: 900, irq: 0 }; // +300 busy, +100 idle per core
  assert.deepEqual(pc.sample(), { cpu: 75, ramUsed: 10e9, ramTotal: 16e9 });
  assert.equal(pc.sample().cpu, 0, 'no change since last sample');
});

test('crosshair and PC stat choices are saved per game; play time starts when the game runs', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keystone-xh-'));
  const c = new Controller({ packsDir: PACKS, dataDir });
  c.listProcesses = () => [];
  c.attach({ packId: 'fallout-4' });
  assert.equal(c.overlay.state().crosshair.on, false, 'off by default');
  assert.equal(c.overlay.state().since, null, 'not running, no play time');
  c.overlay.setCrosshair({ on: true, style: 'dot', size: 12 });
  c.overlay.setPcStats({ clock: false, bogus: true });
  assert.deepEqual(c.overlay.state().pcstats, { cpu: true, ram: true, clock: false, session: true });
  c.attach({ demo: true });
  assert.equal(c.overlay.state().crosshair.on, false, 'another game has its own');
  assert.ok(c.overlay.state().since <= Date.now());
  c.attach({ packId: 'fallout-4' });
  assert.equal(c.overlay.state().crosshair.style, 'dot');
  assert.equal(c.overlay.state().panels.pcstats.visible, false, 'PC stats panel starts hidden');
  c.shutdown();
});
