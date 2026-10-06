'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Scanner, makeTest } = require('../src/main/engine/scanner');
const { DemoGame, PLAYER, INVENTORY, DAY } = require('../src/main/engine/demo-game');
const { Controller } = require('../src/main/controller');
const { parseCheatTable } = require('../src/main/engine/ct-parser');
const { loadPacks } = require('../src/main/packs');

const PACKS = path.join(__dirname, '..', 'packs');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'keystone-finder-'));
// A failed assert skips a test's own shutdown, and a live session's timers
// would keep the run from ever finishing.
const controllers = [];
test.after(() => { for (const c of controllers) c.shutdown(); });

// A bigger fake memory than the demo: many blocks, a value straddling a 4 MB
// chunk edge, and a block that stops being readable.
class FakeMemory {
  constructor() {
    this.pointerSize = 8;
    this.blocks = [
      { base: 0x10000000n, buf: Buffer.alloc(9 * 1024 * 1024) },
      { base: 0x7f0000000000n, buf: Buffer.alloc(64 * 1024) },
    ];
    this.modules = new Map([['game.exe', { base: 0x140000000n, size: 0x1000, name: 'game.exe' }]]);
    this.blocks.push({ base: 0x140000000n, buf: Buffer.alloc(0x1000) });
  }
  regions() { return this.blocks.map((b) => ({ base: b.base, size: b.buf.length })); }
  _b(addr, n) { return this.blocks.find((b) => addr >= b.base && addr + BigInt(n) <= b.base + BigInt(b.buf.length)); }
  read(addr, n) { const b = this._b(addr, n); if (!b || b.dead) return null; const o = Number(addr - b.base); return Buffer.from(b.buf.subarray(o, o + n)); }
  write(addr, buf) { const b = this._b(addr, buf.length); if (!b) return false; buf.copy(b.buf, Number(addr - b.base)); return true; }
  i32(addr, v) { const b = Buffer.alloc(4); b.writeInt32LE(v); this.write(addr, b); }
  f32(addr, v) { const b = Buffer.alloc(4); b.writeFloatLE(v); this.write(addr, b); }
  f64(addr, v) { const b = Buffer.alloc(8); b.writeDoubleLE(v); this.write(addr, b); }
}

test('match rules: exact, rounding for decimals, ranges and changes', () => {
  assert.equal(makeTest('int32', { compare: 'exact', value: '1,250' })(1250), true, 'thousands commas are fine');
  assert.throws(() => makeTest('int32', { compare: 'exact', value: '7.5' }), /decimals/);
  assert.throws(() => makeTest('int32', { compare: 'exact', value: '' }), /Type a value/);
  const f = makeTest('float', { compare: 'exact', value: '72.3' });
  assert.equal(f(72.34), true);
  assert.equal(f(72.36), false);
  assert.equal(makeTest('float', { compare: 'exact', value: '100' })(99.6), true, 'a whole number shown for a decimal value');
  assert.equal(makeTest('float', { compare: 'between', value: '0', value2: '1' })(3.9e-44), false, 'tiny junk floats are skipped');
  assert.equal(makeTest('int32', { compare: 'between', value: '10', value2: '5' })(7), true, 'either order');
  assert.equal(makeTest('int32', { compare: 'increased' })(5, 4), true);
  assert.equal(makeTest('int32', { compare: 'decreasedBy', value: '25' })(75, 100), true);
  assert.equal(makeTest('int32', { compare: 'unchanged' })(5, 5), true);
  assert.equal(makeTest('float', { compare: 'changed' })(NaN, NaN), false);
});

test('first and next scans narrow down to the value, across chunk edges and types', async () => {
  const m = new FakeMemory();
  const target = 0x10000000n + BigInt(4 * 1024 * 1024 - 4); // last int32 before a 4 MB chunk edge
  const decoys = [0x10000100n, 0x10500000n, 0x7f0000000040n];
  m.i32(target, 1250);
  for (const d of decoys) m.i32(d, 1250);
  const s = new Scanner(m);
  const r1 = await s.first({ type: 'int32', value: '1250' });
  assert.equal(r1.count, 4);
  m.i32(target, 1100);
  m.i32(decoys[0], 1300);
  const r2 = await s.next({ compare: 'decreased' });
  assert.equal(r2.count, 1);
  assert.equal(s.results()[0].address, target);
  assert.equal(s.results()[0].previous, 1100);
  // Undo goes back one scan.
  assert.equal(s.undo(), 4);
  assert.throws(() => s.undo(), /no earlier scan/);

  // A double straddling the chunk edge is still found.
  const d = 0x10000000n + BigInt(4 * 1024 * 1024 - 4);
  m.f64(d, 1234.5);
  const s2 = new Scanner(m);
  assert.equal((await s2.first({ type: 'double', value: '1234.5' })).count, 1);
});

test('a block that goes away between scans drops its hits instead of failing', async () => {
  const m = new FakeMemory();
  m.i32(0x7f0000000010n, 77);
  m.i32(0x10000010n, 77);
  const s = new Scanner(m);
  assert.equal((await s.first({ value: '77' })).count, 2);
  m.blocks[1].dead = true;
  assert.equal((await s.next({ compare: 'unchanged' })).count, 1);
});

test('a scan can be cancelled, and the scanner refuses two scans at once', async () => {
  const m = new FakeMemory();
  const s = new Scanner(m);
  const p = s.first({ value: '0' });
  await assert.rejects(s.first({ value: '1' }), /already running/);
  s.cancel();
  const r = await p;
  assert.equal(r.cancelled, true);
  assert.equal(s.busy, false);
});

function demoController() {
  const c = new Controller({ packsDir: PACKS, dataDir: tmpDir() });
  controllers.push(c);
  c.listProcesses = () => [];
  c.attach({ demo: true });
  return c;
}

test('the demo: find gold (heap, until the game closes) and the day (static, saved)', async () => {
  const c = demoController();
  const game = c.session.memory;
  // Gold: 250, then +5 every 2 s of game time.
  const gold = game._ri(PLAYER, 0x1c);
  await c.finder.first({ type: 'int32', value: String(gold) });
  game.step(2000);
  await c.finder.next({ compare: 'increasedBy', value: '5' });
  const info = c.finder.info();
  assert.equal(info.count, 1);
  assert.equal(info.results[0].where, null, 'gold is on the heap');
  const goldMod = c.finder.addMod({ address: info.results[0].address, type: 'int32', name: '  Gold  ' });
  assert.equal(goldMod.kept, false);
  assert.equal(goldMod.name, 'Gold');

  // The day counter lives in demo.exe itself.
  c.finder.reset();
  await c.finder.first({ type: 'int32', compare: 'between', value: '1', value2: '1' });
  game.step(10000);
  await c.finder.next({ compare: 'increased' });
  const day = c.finder.info().results.find((r) => r.where === 'demo.exe+3000');
  assert.ok(day, 'the static day counter is found and named by module');
  const dayMod = c.finder.addMod({ address: day.address, type: 'int32', name: 'Day' });
  assert.equal(dayMod.kept, true);

  // Both show in the mods list under My mods and can be locked.
  const recs = c.snapshot().records.filter((r) => r.groupPath[0] === 'My mods');
  assert.deepEqual(recs.map((r) => r.name).sort(), ['Day', 'Gold']);
  assert.equal(recs.find((r) => r.name === 'Gold').sessionOnly, true);
  c.setTarget(dayMod.id, 99);
  c.setEnabled(dayMod.id, true);
  c.session.freezeTick();
  assert.equal(game._ri(DAY, 0), 99);

  // Restart: the saved one comes back (and still works), the heap one doesn't.
  c.detach();
  c.attach({ demo: true });
  const after = c.snapshot().records.filter((r) => r.groupPath[0] === 'My mods');
  assert.deepEqual(after.map((r) => r.name), ['Day']);
  c.session.readTick();
  assert.equal(c.snapshot().records.find((r) => r.name === 'Day').status, 'ok');

  // Rename and delete.
  c.finder.renameMod(dayMod.id, 'Day counter');
  assert.equal(c.finder.myMods()[0].name, 'Day counter');
  assert.throws(() => c.finder.addMod({ address: day.address, type: 'int32', name: '' }), /Give the mod a name/);
  c.finder.removeMod(dayMod.id);
  assert.equal(c.finder.myMods().length, 0);
  assert.ok(!c.snapshot().records.some((r) => r.groupPath[0] === 'My mods'), 'the empty group goes too');
  c.shutdown();
});

test('My mods keep their on/off state when another mod is added', async () => {
  const c = demoController();
  const a = c.finder.addMod({ address: (DAY).toString(16), type: 'int32', name: 'Day' });
  c.setTarget(a.id, 5);
  c.setEnabled(a.id, true);
  c.finder.addMod({ address: (INVENTORY + 8n).toString(16), type: 'int32', name: 'Wood' });
  assert.equal(c.snapshot().records.find((r) => r.id === a.id).enabled, true);
  c.shutdown();
});

test('sharing: the table loads back with the same mods, and a pack folder\'s mods.ct loads by itself', async () => {
  const c = demoController();
  assert.throws(() => c.finder.tableXml(), /no saved mods/);
  c.finder.addMod({ address: DAY.toString(16), type: 'int32', name: 'Day <&> "count"' });
  const xml = c.finder.tableXml();
  const recs = parseCheatTable(xml, { sourceName: 'mods' }).filter((r) => r.kind === 'value');
  assert.equal(recs.length, 1);
  assert.equal(recs[0].name, 'Day <&> "count"');
  assert.equal(recs[0].address, 'demo.exe+3000');
  assert.equal(recs[0].valueType, 'int32');
  const file = path.join(tmpDir(), 'mods.ct');
  assert.equal(c.finder.exportTable(file).count, 1);
  c.shutdown();

  // A pack with mods.ct and no "table": the file is its table.
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'mygame'));
  fs.writeFileSync(path.join(dir, 'mygame', 'pack.json'), JSON.stringify({ name: 'My game', exe: 'mygame.exe' }));
  fs.copyFileSync(file, path.join(dir, 'mygame', 'mods.ct'));
  const [p] = loadPacks([dir]);
  assert.equal(p.table, path.join(dir, 'mygame', 'mods.ct'));
});

test('the finder explains itself when there are no mods', () => {
  const c = new Controller({ packsDir: PACKS, dataDir: tmpDir() });
  c.listProcesses = () => [];
  assert.match(c.finder.info().reason, /Choose a game/);
  c.attach({ packId: 'phasmophobia' });
  assert.equal(c.finder.info().available, false);
  assert.throws(() => c.finder.addMod({ address: '1000', type: 'int32', name: 'x' }), /Start the game/);
  c.shutdown();
});
