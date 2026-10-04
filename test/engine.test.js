'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const koffi = require('koffi');

const { parseCheatTable } = require('../src/main/engine/ct-parser');
const address = require('../src/main/engine/address');
const values = require('../src/main/engine/values');
const { DemoGame, PLAYER, INVENTORY } = require('../src/main/engine/demo-game');
const { Session } = require('../src/main/engine/session');
const win32 = require('../src/main/engine/win32');

const demoCt = fs.readFileSync(path.join(__dirname, '..', 'packs', 'demo', 'demo.ct'), 'utf8');

test('Win32 struct layouts match the Windows SDK (x64)', () => {
  // If these drift, Process32FirstW/Module32FirstW fail silently on Windows.
  assert.equal(koffi.sizeof(win32.PROCESSENTRY32W), 568);
  assert.equal(koffi.sizeof(win32.MODULEENTRY32W), 1080);
  assert.equal(koffi.offsetof(win32.MODULEENTRY32W, 'modBaseAddr'), 24);
  assert.equal(koffi.offsetof(win32.PROCESSENTRY32W, 'szExeFile'), 44);
});

test('values encode/decode round-trip and reject junk', () => {
  for (const [type, v] of [['byte', 200], ['int16', -1234], ['int32', 123456], ['int64', 2 ** 40], ['double', 3.25]]) {
    assert.equal(values.decode(type, values.encode(type, v)), v);
  }
  assert.ok(Math.abs(values.decode('float', values.encode('float', 72.3)) - 72.3) < 1e-4);
  assert.throws(() => values.encode('int32', 'abc'));
  assert.equal(values.decode('byte', values.encode('byte', 999)), 255, 'clamps instead of wrapping');
});

test('CT parser: groups, types, reversed offsets, scripts', () => {
  const recs = parseCheatTable(demoCt, { sourceName: 'demo' });
  const byName = Object.fromEntries(recs.map((r) => [r.name, r]));

  assert.equal(byName.Player.kind, 'group');
  assert.equal(byName.Health.kind, 'value');
  assert.equal(byName.Health.valueType, 'float');
  assert.deepEqual(byName.Health.groupPath, ['Player']);
  assert.equal(byName['Ammo in clip'].valueType, 'int32');
  // Stored as 8, 40 on disk; applied as 40 then 8.
  assert.deepEqual(byName.Wood.offsets, [0x40n, 0x8n]);
  assert.equal(byName['One-hit kills'].kind, 'script');
  assert.equal(byName.Health.id, 'ct:demo:2');
});

test('CT parser keeps hex offsets hex and flags script symbols', () => {
  const xml = `<CheatTable><CheatEntries>
    <CheatEntry><ID>1</ID><Description>"A"</Description><VariableType>4 Bytes</VariableType>
      <Address>game.exe+10</Address><Offsets><Offset>10</Offset><Offset>20</Offset></Offsets></CheatEntry>
    <CheatEntry><ID>2</ID><Description>"B"</Description><VariableType>Float</VariableType><Address>pPlayer</Address></CheatEntry>
    <CheatEntry><ID>3</ID><Description>"C"</Description><VariableType>String</VariableType><Address>game.exe+4</Address></CheatEntry>
  </CheatEntries></CheatTable>`;
  const [a, b, c] = parseCheatTable(xml);
  assert.deepEqual(a.offsets, [0x20n, 0x10n]);
  assert.equal(b.kind, 'unsupported');
  assert.match(b.reason, /pPlayer/);
  assert.equal(c.kind, 'unsupported');
  assert.throws(() => parseCheatTable('<nope/>'), /Cheat Engine/);
});

test('address expressions: modules, math, dereference', () => {
  const game = new DemoGame({ tickMs: 0 });
  assert.equal(address.evaluate(address.parse('demo.exe+2000'), game), 0x140002000n);
  assert.equal(address.evaluate(address.parse('"demo.exe"+2000-1000'), game), 0x140001000n);
  assert.equal(address.evaluate(address.parse('[demo.exe+2000]+30'), game), PLAYER + 0x30n);
  assert.throws(() => address.evaluate(address.parse('other.dll+1'), game), /not found/);
  assert.throws(() => address.parse('[demo.exe+2000'), /Missing \]/);
  game.close();
});

test('pointer chains resolve through the demo game, two levels deep', () => {
  const game = new DemoGame({ tickMs: 0 });
  const recs = parseCheatTable(demoCt, { sourceName: 'demo' });
  const wood = recs.find((r) => r.name === 'Wood');
  assert.equal(address.resolve(wood, game), INVENTORY + 0x8n);
  game.close();
});

test('session freezes values against a game that keeps changing them', () => {
  const game = new DemoGame({ tickMs: 0, loadingEveryMs: 0 });
  const s = new Session({ memory: game, processName: 'demo.exe', pid: 0 });
  s.addRecords(parseCheatTable(demoCt, { sourceName: 'demo' }), 'demo.ct');
  const id = s.records.find((r) => r.name === 'Health').id;

  game.step(1000); // health drains
  s.readTick();
  const drained = s.state.get(id).current;
  assert.ok(drained < 100);

  s.setTarget(id, 100);
  s.setEnabled(id, true);
  for (let i = 0; i < 20; i++) { game.step(50); s.freezeTick(); }
  s.readTick();
  assert.equal(s.state.get(id).current, 100);

  s.setEnabled(id, false);
  game.step(1000);
  s.readTick();
  assert.ok(s.state.get(id).current < 100, 'stops freezing when off');
  s.close();
});

test('enabling with no target freezes the current value', () => {
  const game = new DemoGame({ tickMs: 0, loadingEveryMs: 0 });
  const s = new Session({ memory: game, processName: 'demo.exe', pid: 0 });
  s.addRecords(parseCheatTable(demoCt, { sourceName: 'demo' }), 'demo.ct');
  const id = s.records.find((r) => r.name === 'Gold').id;
  s.setEnabled(id, true);
  assert.equal(s.state.get(id).target, 250);
  s.close();
});

test('loading screens leave mods waiting instead of throwing', () => {
  const game = new DemoGame({ tickMs: 0, loadingEveryMs: 10000, loadingForMs: 2000 });
  const s = new Session({ memory: game, processName: 'demo.exe', pid: 0 });
  s.addRecords(parseCheatTable(demoCt, { sourceName: 'demo' }), 'demo.ct');
  const hp = s.records.find((r) => r.name === 'Health').id;
  const x = s.records.find((r) => r.name === 'X').id;
  s.setTarget(hp, 100);
  s.setEnabled(hp, true);

  game.step(10500); // inside the loading window
  s.freezeTick();
  s.readTick();
  assert.equal(s.state.get(hp).status, 'waiting');
  assert.equal(s.state.get(x).status, 'waiting');
  assert.equal(s.state.get(hp).enabled, true, 'stays enabled through the load');

  game.step(2000);
  s.freezeTick();
  s.readTick();
  assert.equal(s.state.get(hp).status, 'ok');
  assert.equal(s.state.get(hp).current, 100);
  s.close();
});

test('reloading a table replaces its records instead of duplicating', () => {
  const game = new DemoGame({ tickMs: 0 });
  const s = new Session({ memory: game, processName: 'demo.exe', pid: 0 });
  s.addRecords(parseCheatTable(demoCt, { sourceName: 'demo' }), 'demo.ct');
  const n = s.records.length;
  s.addRecords(parseCheatTable(demoCt, { sourceName: 'demo' }), 'demo.ct');
  assert.equal(s.records.length, n);
  s.close();
});

test('snapshot is plain JSON (safe for IPC and WebSocket)', () => {
  const game = new DemoGame({ tickMs: 0 });
  const s = new Session({ memory: game, processName: 'demo.exe', pid: 0 });
  s.addRecords(parseCheatTable(demoCt, { sourceName: 'demo' }), 'demo.ct');
  assert.doesNotThrow(() => JSON.stringify(s.snapshot()));
  assert.doesNotThrow(() => JSON.stringify(s.valuesSnapshot()));
  s.close();
});

test('detaches when the game exits', () => {
  const game = new DemoGame({ tickMs: 0 });
  const s = new Session({ memory: game, processName: 'demo.exe', pid: 0 });
  let detached = false;
  s.on('detached', () => { detached = true; });
  game.alive = false;
  s.readTick();
  assert.ok(detached);
  s.close();
});
