'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Controller } = require('../src/main/controller');
const { loadPacks } = require('../src/main/packs');

const PACKS = path.join(__dirname, '..', 'packs');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'keystone-tp-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function demo() {
  const c = new Controller({ packsDir: PACKS, dataDir: tmpDir() });
  c.attach({ demo: true });
  c.session.readTick();
  return c;
}

function writePack(dataDir, id, pack) {
  const dir = path.join(dataDir, 'packs', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify(pack));
}

test('teleport by memory: moves the player, holds briefly, then lets go', async () => {
  const c = demo();
  assert.equal(c.overlay.teleportMethod(), 'memory');
  assert.equal(c.overlay.state().teleport, 'memory');
  const wp = c.overlay.addWaypoint({ name: 'Spot', x: 1234, y: -567 });
  const r = await c.overlay.teleport({ waypointId: wp.id });
  assert.equal(r.method, 'memory');
  assert.equal(r.name, 'Spot');
  c.session.readTick();
  const pos = c.overlay.position();
  assert.ok(Math.abs(pos.x - 1234) < 0.01 && Math.abs(pos.y + 567) < 0.01);
  const roles = c.overlay.roles();
  assert.equal(c.session.state.get(roles.x).enabled, true, 'held right after the teleport');
  await sleep(400);
  assert.equal(c.session.state.get(roles.x).enabled, false, 'released after the hold');
  // The demo game carries on from the new spot instead of snapping back.
  c.session.memory.step(50);
  c.session.readTick();
  assert.ok(Math.abs(c.overlay.position().x - 1234) < 50);
  c.shutdown();
});

test('teleport keeps the current height when the spot has none, and honors locks', async () => {
  const c = demo();
  const roles = c.overlay.roles();
  const zBefore = c.overlay.position().z;
  // Lock X: it should stay locked, at the new X.
  c.session.setTarget(roles.x, 10);
  c.session.setEnabled(roles.x, true);
  const r = await c.overlay.teleport({ x: 300, y: 400 });
  assert.ok(Math.abs(r.z - zBefore) < 0.01);
  await sleep(400);
  const st = c.session.state.get(roles.x);
  assert.equal(st.enabled, true);
  assert.equal(st.target, 300);
  assert.equal(c.session.state.get(roles.y).enabled, false);
  // A spot with its own height uses it.
  const r2 = await c.overlay.teleport({ x: 0, y: 0, z: 999 });
  assert.equal(r2.z, 999);
  await assert.rejects(c.overlay.teleport({ x: 'a', y: 1 }), /no usable coordinates/);
  await assert.rejects(c.overlay.teleport({ waypointId: 'gone' }), /no longer exists/);
  c.shutdown();
});

test('teleport by command fills in the pack template and skips height lines without a height', async () => {
  const dataDir = tmpDir();
  writePack(dataDir, 'tp', {
    name: 'TP Game', exe: 'tp.exe', memory: false,
    commands: { console: { key: 'Backquote', prefixes: ['admincheat'] } },
    teleport: { command: ['SetPos {x} {y}', 'SetHeight {z}'] },
  });
  const sent = [];
  const c = new Controller({ packsDir: PACKS, dataDir, commands: { consoleSend: async (pid, lines) => { sent.push({ pid, lines }); } } });
  c.attach({ pid: 77, name: 'tp.exe' });
  assert.equal(c.overlay.teleportMethod(), 'command');
  const wp = c.overlay.addWaypoint({ name: 'Cave', x: 10.555, y: -20 });
  const r = await c.overlay.teleport({ waypointId: wp.id });
  assert.equal(r.method, 'command');
  assert.deepEqual(sent[0], { pid: 77, lines: ['admincheat SetPos 10.56 -20'] });
  await c.overlay.teleport({ x: 1, y: 2, z: 3 });
  assert.deepEqual(sent[1].lines, ['admincheat SetPos 1 2', 'admincheat SetHeight 3']);
  assert.equal(c.commands.history()[0].label, 'Teleport');
  // The phone gets the waypoint list.
  assert.deepEqual(c.snapshot().teleport.waypoints, [{ id: wp.id, name: 'Cave' }]);
  c.shutdown();
});

test('no way to teleport gives a reason, and the phone gets no Teleport list', async () => {
  const c = new Controller({ packsDir: PACKS, dataDir: tmpDir() });
  c.listProcesses = () => [];
  c.attach({ packId: 'fallout-4' });
  assert.equal(c.overlay.teleportMethod(), null);
  assert.equal(c.snapshot().teleport, null);
  await assert.rejects(c.overlay.teleport({ x: 1, y: 2 }), /needs mods/);
  c.attach({ packId: 'ark-survival-ascended' });
  await assert.rejects(c.overlay.teleport({ x: 1, y: 2 }), /Turn mods on/);
  c.shutdown();
});

test('pack teleport settings are normalized', () => {
  const dir = tmpDir();
  writePack(dir, 'a', { name: 'A', exe: 'a.exe', teleport: { lift: '150', holdMs: 99999, command: 'Go {x} {y}', via: 'rcon' } });
  writePack(dir, 'b', { name: 'B', exe: 'b.exe' });
  const [a, b] = loadPacks([path.join(dir, 'packs')]).sort((p, q) => p.id.localeCompare(q.id));
  assert.deepEqual(a.teleport, { lift: 150, holdMs: 2000, command: ['Go {x} {y}'], via: 'rcon' });
  assert.deepEqual(b.teleport, { lift: 0, holdMs: 300, command: null, via: 'console' });
});
