'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const koffi = require('koffi');

const { RconClient, encode, decode } = require('../src/main/commands/rcon');
const { plan, INPUT, KEYBDINPUT } = require('../src/main/commands/console-sender');
const { Controller } = require('../src/main/controller');

const PACKS = path.join(__dirname, '..', 'packs');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'keystone-cmd-'));
const cleanups = [];
// Last in, first out: controllers (and their RCON sockets) close before the
// fake servers they're connected to.
test.after(async () => { for (const fn of cleanups.reverse()) await fn(); });

// Fake ARK RCON server: checks the password, echoes commands.
function fakeRcon(password = 'secret') {
  const received = [];
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      let packets;
      [packets, buf] = decode(buf);
      for (const p of packets) {
        if (p.type === 3) {
          sock.write(encode(0, 0, '')); // some servers send this first
          sock.write(encode(p.body === password ? p.id : -1, 2, ''));
        } else {
          received.push(p.body);
          // Split the reply across two writes to exercise reassembly.
          const reply = encode(p.id, 0, `ok: ${p.body}\n`);
          sock.write(reply.subarray(0, 7));
          setTimeout(() => sock.write(reply.subarray(7)), 5);
        }
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    cleanups.push(() => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }));
    resolve({ port: server.address().port, received, server });
  }));
}

test('RCON packets encode and decode, including partial reads', () => {
  const a = encode(7, 2, 'SaveWorld');
  const b = encode(8, 0, 'hello');
  const both = Buffer.concat([a, b]);
  const [p1, rest1] = decode(both.subarray(0, a.length + 3));
  assert.deepEqual(p1, [{ id: 7, type: 2, body: 'SaveWorld' }]);
  assert.equal(rest1.length, 3);
  const [p2] = decode(both);
  assert.equal(p2[1].body, 'hello');
});

test('RCON client authenticates, runs commands in order, reports bad passwords', async () => {
  const { port, received } = await fakeRcon('secret');
  const c = new RconClient({ host: '127.0.0.1', port, password: 'secret' });
  const [r1, r2] = await Promise.all([c.command('ListPlayers'), c.command('SaveWorld')]);
  assert.equal(r1, 'ok: ListPlayers');
  assert.equal(r2, 'ok: SaveWorld');
  assert.deepEqual(received, ['ListPlayers', 'SaveWorld']);
  c.close();

  const bad = new RconClient({ host: '127.0.0.1', port, password: 'nope' });
  await assert.rejects(bad.command('ListPlayers'), /rejected the RCON password/);
});

test('RCON gives a useful error when nothing is listening', async () => {
  const srv = net.createServer();
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  await new Promise((r) => srv.close(r));
  const c = new RconClient({ host: '127.0.0.1', port, password: 'x', timeoutMs: 2000 });
  await assert.rejects(c.command('ListPlayers'), /Nothing is answering/);
});

test('SendInput structs match the Windows SDK (x64)', () => {
  assert.equal(koffi.sizeof(KEYBDINPUT), 24);
  assert.equal(koffi.sizeof(INPUT), 40);
});

test('console plan: open console, type or paste, Enter; rejects non-ASCII', () => {
  const typed = plan(['admincheat God'], { consoleKey: 'Tab' });
  assert.deepEqual(typed.filter((s) => !s.wait), [{ key: 'Tab' }, { text: 'admincheat God' }, { key: 'Enter' }]);
  const pasted = plan(['a', 'b'], { consoleKey: 'Backquote', mode: 'paste' });
  assert.deepEqual(pasted.filter((s) => !s.wait).slice(0, 3), [{ key: 'Backquote' }, { clipboard: 'a' }, { chord: ['Ctrl', 'V'] }]);
  assert.equal(pasted.filter((s) => s.key === 'Enter').length, 2);
  assert.throws(() => plan(['GMSummon “Rex”']), /character/);
  assert.throws(() => plan(['x'], { consoleKey: 'F13' }), /Unknown console key/);
});

function asa({ consoleSend } = {}) {
  const dataDir = tmpDir();
  const calls = [];
  const c = new Controller({
    packsDir: PACKS,
    dataDir,
    commands: { consoleSend: consoleSend || (async (pid, lines, opts) => { calls.push({ pid, lines, opts }); }) },
  });
  cleanups.push(() => c.shutdown());
  return { c, calls, dataDir };
}

test('a game whose memory is off-limits is still selected, minus mods', () => {
  const { c } = asa();
  // Fallout 4 allows mods, so Keystone tries; on Linux WinMemory always
  // throws, standing in for a game that refuses access.
  const { snapshot, notices } = c.attach({ pid: 4242, name: 'Fallout4.exe' });
  assert.equal(snapshot.attached, true);
  assert.equal(snapshot.mods, false);
  assert.equal(snapshot.pack, 'Fallout 4');
  assert.equal(snapshot.hasCommands, true);
  assert.ok(notices[0].includes('Commands, the map and waypoints still work'));
  assert.throws(() => c.saveProfile('x'), /Mods aren't available/);
  assert.ok(c.overlay.addWaypoint({ name: 'Base', x: 1, y: 2 }), 'waypoints work without mods');
  assert.throws(() => c.overlay.setRole('x', 'anything'), /need mods/);
});

test('pack games can be picked offline for RCON-only use', () => {
  const { c } = asa();
  const games = c.listGames();
  const ark = games.find((g) => g.id === 'ark-survival-ascended');
  assert.ok(ark && !ark.running);
  const { snapshot } = c.attach({ packId: 'ark-survival-ascended' });
  assert.equal(snapshot.game.offline, true);
  assert.equal(snapshot.displayName, 'ARK: Survival Ascended');
  assert.equal(c.commands.info().available, true);
});

test('ASA catalogs load and creature/item IDs look right', () => {
  const { c } = asa();
  c.attach({ packId: 'ark-survival-ascended' });
  const creatures = c.commands.catalog('creatures');
  const items = c.commands.catalog('items');
  assert.ok(creatures.length > 300);
  assert.ok(items.length > 800);
  const rex = creatures.find((x) => x.name === 'Rex');
  assert.equal(rex.id, 'Rex_Character_BP_C');
  assert.ok(creatures.every((x) => /_C$/.test(x.id) && !/["|]/.test(x.id)), 'ids are safe to put in quotes');
  assert.ok(items.every((x) => x.blueprint && !/['"|]/.test(x.blueprint)), 'blueprint paths are safe');
  assert.equal(new Set(creatures.map((x) => x.id)).size, creatures.length, 'no duplicate ids');
});

test('building commands: tamed spawn with prefix and repeat, items with blueprint path', () => {
  const { c } = asa();
  c.attach({ packId: 'ark-survival-ascended' });
  const b = c.commands.build('action', 'summon-tamed', { entryId: 'Rex_Character_BP_C', values: { level: 225, count: 2 } });
  assert.equal(b.via, 'console');
  assert.deepEqual(b.lines, ['admincheat GMSummon "Rex_Character_BP_C" 225', 'admincheat GMSummon "Rex_Character_BP_C" 225']);
  assert.equal(b.label, 'Spawn tamed: Rex');

  const metal = c.commands.catalog('items').find((x) => x.name === 'Metal Ingot');
  const g = c.commands.build('action', 'give-item', { entryId: metal.id, values: { qty: 500, quality: 0, blueprintOnly: false } });
  assert.equal(g.lines[0], `admincheat GiveItem "Blueprint'${metal.blueprint}'" 500 0 0`);

  const r = c.commands.build('action', 'give-item-player', { entryId: metal.id, values: { playerId: '123456789', qty: 1, quality: 0, blueprintOnly: true } });
  assert.equal(r.via, 'rcon');
  assert.ok(r.lines[0].startsWith('GiveItemToPlayer 123456789 "Blueprint'), 'no console prefix over RCON');
  assert.ok(r.lines[0].endsWith(' 1 0 1'));

  c.commands.setSettings({ prefix: 'cheat' });
  assert.equal(c.commands.build('quick', 'god').lines[0], 'cheat God');
  c.commands.setSettings({ prefix: '' });
  assert.equal(c.commands.build('quick', 'god').lines[0], 'God');
});

test('form validation blocks bad values and command injection', () => {
  const { c } = asa();
  c.attach({ packId: 'ark-survival-ascended' });
  const rex = { entryId: 'Rex_Character_BP_C' };
  assert.throws(() => c.commands.build('action', 'summon-tamed', { ...rex, values: { level: 0, count: 1 } }), /below 1/);
  assert.throws(() => c.commands.build('action', 'summon-tamed', { ...rex, values: { level: 10.5, count: 1 } }), /whole number/);
  assert.throws(() => c.commands.build('action', 'summon-tamed', { ...rex, values: { level: 10, count: 50 } }), /above 20/);
  assert.throws(() => c.commands.build('action', 'summon-tamed', { entryId: 'Nope_C', values: {} }), /isn.t in the list/);
  assert.throws(() => c.commands.build('action', 'give-item-player', { entryId: c.commands.catalog('items')[0].id, values: { playerId: 'abc' } }), /number/);
  assert.throws(() => c.commands.build('quick', 'chat', { values: { message: 'hi | DestroyWildDinos' } }), /quotes or \|/);
  assert.throws(() => c.commands.build('quick', 'time', { values: { time: '25:00' } }), /24-hour/);
  assert.equal(c.commands.build('quick', 'wipe-wild').confirm.length > 10, true, 'destructive commands carry a confirmation');
});

test('console commands go to the game window with the saved key and mode', async () => {
  const { c, calls } = asa();
  c.attach({ pid: 4242, name: 'ArkAscended.exe' });
  c.commands.setSettings({ consoleKey: 'Backquote', mode: 'paste' });
  await c.commands.run('quick', 'fly');
  assert.deepEqual(calls[0], { pid: 4242, lines: ['admincheat Fly'], opts: { consoleKey: 'Backquote', mode: 'paste', keepsOpen: false } });
  assert.equal(c.commands.history()[0].label, 'Fly');
  assert.equal(c.commands.history()[0].ok, true);
});

test('console commands explain themselves when the game is not running', async () => {
  const { c } = asa();
  c.attach({ packId: 'ark-survival-ascended' });
  await assert.rejects(c.commands.run('quick', 'god'), /Start the game/);
  assert.equal(c.commands.history()[0].ok, false, 'failures are logged too');
});

test('admin login types EnableCheats but never stores the password in plain text', async () => {
  const { c, calls, dataDir } = asa();
  c.attach({ pid: 4242, name: 'ArkAscended.exe' });
  await assert.rejects(c.commands.enableAdmin(), /Save your admin password/);
  c.commands.setSettings({ adminPassword: 'hunter2' });
  await c.commands.enableAdmin();
  assert.deepEqual(calls[0].lines, ['EnableCheats hunter2'], 'no admincheat prefix on the login itself');
  assert.doesNotMatch(JSON.stringify(c.commands.history()), /hunter2/);
  const onDisk = fs.readFileSync(path.join(dataDir, 'games', 'arkascended.exe.json'), 'utf8');
  assert.doesNotMatch(onDisk.replace('plain:hunter2', ''), /hunter2/);
  assert.equal(c.commands.settings().hasAdminPassword, true);
});

test('RCON commands run against the server and log the reply', async () => {
  const { port, received } = await fakeRcon('pw');
  const { c } = asa();
  c.attach({ packId: 'ark-survival-ascended' });
  await assert.rejects(c.commands.run('quick', 'save'), /Set up RCON first/);
  assert.throws(() => c.commands.setRcon({ host: 'bad host!', port, password: 'pw' }), /address/);
  assert.throws(() => c.commands.setRcon({ host: '127.0.0.1', port: 99999, password: 'pw' }), /port/);
  c.commands.setRcon({ host: '127.0.0.1', port, password: 'pw' });
  assert.equal(c.commands.settings().rcon.hasPassword, true);
  const res = await c.commands.run('quick', 'time', { values: { time: '07:30' } });
  assert.equal(res.output, 'ok: SetTimeOfDay 07:30');
  assert.deepEqual(received, ['SetTimeOfDay 07:30']);
  assert.equal((await c.commands.testRcon()).ok, true);
  const raw = await c.commands.runRaw('ListPlayers', 'rcon');
  assert.equal(raw.output, 'ok: ListPlayers');

  // Changing the port without retyping the password keeps the saved one.
  c.commands.setRcon({ host: '127.0.0.1', port, password: '' });
  assert.equal((await c.commands.testRcon()).ok, true);
});

test('history is capped and can be cleared', async () => {
  const { c } = asa();
  c.attach({ pid: 1, name: 'ArkAscended.exe' });
  for (let i = 0; i < 45; i++) await c.commands.run('quick', 'god');
  assert.equal(c.commands.history().length, 40);
  c.commands.clearHistory();
  assert.equal(c.commands.history().length, 0);
});

test('games without a commands section say so', () => {
  const { c } = asa();
  c.attach({ demo: true });
  assert.equal(c.commands.info().available, false);
  assert.throws(() => c.commands.build('quick', 'god'), /no commands for this game/);
});

test('console plan for games whose console stays open: open once, close at the end', () => {
  const steps = plan(['tgm', 'tcl'], { consoleKey: 'Backquote', keepsOpen: true }).filter((s) => !s.wait);
  assert.deepEqual(steps, [
    { key: 'Backquote' }, { text: 'tgm' }, { key: 'Enter' }, { text: 'tcl' }, { key: 'Enter' }, { key: 'Backquote' },
  ]);
});

test('Fallout 4 pack: item commands, quick commands with choices, no paste', async () => {
  const { c, calls } = asa();
  c.attach({ pid: 777, name: 'Fallout4.exe' });
  const info = c.commands.info();
  assert.equal(info.pack, 'Fallout 4');
  assert.equal(info.settings.consoleKey, 'Backquote');
  assert.equal(info.settings.pasteSupported, false);
  assert.equal(info.settings.canEnable, false);
  assert.throws(() => c.commands.setSettings({ mode: 'paste' }), /can.t paste/);

  const items = c.commands.catalog('items');
  assert.ok(items.length > 500);
  assert.ok(items.every((i) => /^00[0-9A-F]{6}$/.test(i.id)), 'base-game Form IDs only');
  assert.equal(new Set(items.map((i) => i.id)).size, items.length);
  const stim = items.find((i) => i.name === 'Stimpak');
  assert.equal(stim.id, '00023736');

  assert.deepEqual(c.commands.build('action', 'give-item', { entryId: stim.id, values: { qty: 10 } }).lines, ['player.additem 00023736 10']);
  assert.deepEqual(c.commands.build('quick', 'perks', { values: { points: 3 } }).lines, ['CGF "Game.AddPerkPoints" 3']);
  assert.deepEqual(c.commands.build('quick', 'special', { values: { stat: 'luck', value: 10 } }).lines, ['player.setav luck 10']);
  assert.throws(() => c.commands.build('quick', 'special', { values: { stat: 'charm', value: 10 } }), /Pick a stat/);
  assert.throws(() => c.commands.build('quick', 'time', { values: { hour: 24 } }), /above 23/);

  await c.commands.run('quick', 'tgm');
  assert.deepEqual(calls[0], { pid: 777, lines: ['tgm'], opts: { consoleKey: 'Backquote', mode: 'type', keepsOpen: true } });
});

test('ARK: Survival Ascended opens its console with the tilde key; an old saved Tab gives way', () => {
  const { Controller } = require('../src/main/controller');
  const c = new Controller({ packsDir: path.join(__dirname, '..', 'packs'), dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'keystone-key-')) });
  c.listProcesses = () => [];
  c.attach({ packId: 'ark-survival-ascended' });
  assert.equal(c.commands.settings().consoleKey, 'Backquote');
  // Saved by an older Keystone, back when Tab was everyone's default.
  c.store.update(c.game.key, (d) => { d.commands = { ...(d.commands || {}), consoleKey: 'Tab' }; });
  assert.equal(c.commands.settings().consoleKey, 'Backquote');
  // Picked by hand now: kept.
  c.commands.setSettings({ consoleKey: 'Tab' });
  assert.equal(c.commands.settings().consoleKey, 'Tab');
  c.shutdown();
});
