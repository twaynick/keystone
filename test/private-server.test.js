'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Controller } = require('../src/main/controller');
const { DemoGame } = require('../src/main/engine/demo-game');
const { loadPacks } = require('../src/main/packs');

const PACKS = path.join(__dirname, '..', 'packs');
const controllers = [];
test.after(() => { for (const c of controllers) c.shutdown(); });

function setup() {
  const procs = [{ name: 'ArkAscended.exe', pid: 4242 }];
  const opened = [];
  const c = new Controller({
    packsDir: PACKS,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'keystone-private-')),
    openMemory: (pid) => { opened.push(pid); return new DemoGame({ tickMs: 0, loadingEveryMs: 0 }); },
  });
  c.listProcesses = () => procs;
  c.acGuardMs = 15;
  controllers.push(c);
  return { c, procs, opened };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('packs: ARK declares BattlEye and private servers; packs without anti-cheat can’t offer the mode', () => {
  const asa = loadPacks([PACKS]).find((p) => p.id === 'ark-survival-ascended');
  assert.deepEqual(asa.antiCheat, { name: 'BattlEye', processes: ['BEService.exe', 'BEService_x64.exe'] });
  assert.equal(asa.privateServers, true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keystone-pk-'));
  fs.mkdirSync(path.join(dir, 'x'));
  fs.writeFileSync(path.join(dir, 'x', 'pack.json'), JSON.stringify({ name: 'X', exe: ['x.exe'], privateServers: true }));
  assert.equal(loadPacks([dir]).find((p) => p.id === 'x').privateServers, false, 'no anti-cheat to check: no private-server mode');
});

test('private server: mods for one run, only while BattlEye isn’t running', async () => {
  const { c, procs, opened } = setup();
  c.attach({ pid: 4242, name: 'ArkAscended.exe' });
  let snap = c.snapshot();
  assert.equal(snap.modsBlocked, 'offline-off');
  assert.equal(snap.privateServers, true);
  assert.equal(snap.antiCheat, 'BattlEye');
  assert.deepEqual(opened, [], 'the game is never opened while mods are off');

  const res = c.startPrivateServer();
  snap = res.snapshot;
  assert.equal(snap.privateServer, true);
  assert.equal(snap.mods, true);
  assert.equal(snap.modsSwitch, false, 'the saved switch stays off');
  assert.deepEqual(opened, [4242]);

  // Turning the saved switch off doesn't end the session.
  c.setModsEnabled(false);
  assert.ok(c.session);

  // BattlEye starts (the player joined a protected server): let go at once.
  const notices = [];
  c.on('notice', (n) => notices.push(n));
  procs.push({ name: 'BEService_x64.exe', pid: 77 });
  await wait(60);
  assert.equal(c.session, null);
  snap = c.snapshot();
  assert.equal(snap.modsBlocked, 'anticheat');
  assert.equal(snap.privateServer, false);
  assert.match(notices[0], /BattlEye started, so Keystone let go of the game/);

  // Nothing turns mods back on while it runs.
  assert.throws(() => c.startPrivateServer(), /BattlEye is running/);
  c.setModsEnabled(true);
  assert.equal(c.session, null);
  assert.deepEqual(opened, [4242], 'not even an attempt to open it');

  // BattlEye gone: the saved switch works again.
  procs.pop();
  c.setModsEnabled(false);
  c.setModsEnabled(true);
  assert.ok(c.session);
  assert.equal(c.snapshot().modsSwitch, true);
});

test('private server: ends when the game closes, and needs the game running', () => {
  const { c } = setup();
  c.attach({ pid: 4242, name: 'ArkAscended.exe' });
  c.startPrivateServer();
  c._gameExited('ArkAscended.exe');
  const snap = c.snapshot();
  assert.equal(snap.privateServer, false);
  assert.equal(snap.mods, false);
  assert.throws(() => c.startPrivateServer(), /Start the game first/);
  // The next run starts with mods off again.
  c.attach({ pid: 5555, name: 'ArkAscended.exe' });
  assert.equal(c.snapshot().modsBlocked, 'offline-off');
});

test('private server: ending it by hand switches mods off', () => {
  const { c } = setup();
  c.attach({ pid: 4242, name: 'ArkAscended.exe' });
  c.startPrivateServer();
  const snap = c.stopPrivateServer().snapshot;
  assert.equal(snap.mods, false);
  assert.equal(snap.modsBlocked, 'offline-off');
});

test('anti-cheat already running: the game is never opened, switch or not', () => {
  const { c, procs, opened } = setup();
  procs.push({ name: 'BEService.exe', pid: 9 });
  c.attach({ pid: 4242, name: 'ArkAscended.exe' });
  c.setModsEnabled(true);
  assert.equal(c.snapshot().modsBlocked, 'anticheat');
  assert.match(c.snapshot().modsError, /BattlEye is running/);
  assert.deepEqual(opened, []);
});

test('games without private-server mode say so', () => {
  const { c } = setup();
  c.listProcesses = () => [{ name: 'Fallout4.exe', pid: 1 }];
  c.attach({ pid: 1, name: 'Fallout4.exe' });
  assert.throws(() => c.startPrivateServer(), /doesn’t have a private-server mode/);
});
