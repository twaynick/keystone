'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PointerScanner } = require('../src/main/engine/pointer-scan');
const { DemoGame } = require('../src/main/engine/demo-game');
const address = require('../src/main/engine/address');
const { Controller } = require('../src/main/controller');

const PACKS = path.join(__dirname, '..', 'packs');
const controllers = [];
test.after(() => { for (const c of controllers) c.shutdown(); });

const resolve = (game, p) => address.resolve({ address: p.base, offsets: p.offsets.map(BigInt) }, game);

test('pointer scan: finds paths from the game’s files to a heap value, shortest first', async () => {
  const game = new DemoGame({ tickMs: 0, loadingEveryMs: 0 });
  const gold = game.player + 0x1cn;
  const r = await new PointerScanner(game).scan(gold);
  assert.deepEqual(r.paths.map((p) => [p.base, p.offsets]), [
    ['demo.exe+2100', [4]],          // the stale pointer: works this run only
    ['demo.exe+2000', [0x1c]],       // Player
    ['demo.exe+2200', [8, 0x1c]],    // World -> Player
  ]);
  for (const p of r.paths) assert.equal(resolve(game, p), gold);

  // Deeper values: Wood is behind Player -> Inventory.
  const wood = await new PointerScanner(game).scan(game.inventory + 8n);
  assert.ok(wood.paths.some((p) => p.base === 'demo.exe+2000' && p.offsets.join() === '64,8'));
  // One step only: no two-step paths.
  const shallow = await new PointerScanner(game).scan(gold, { maxDepth: 1 });
  assert.ok(shallow.paths.every((p) => p.offsets.length === 1));
  // Nothing within reach: no paths, no error.
  assert.deepEqual((await new PointerScanner(game).scan(game.heapBase + 0x9000n)).paths, []);
});

test('pointer scan: after a restart only the real paths still work', async () => {
  const before = new DemoGame({ tickMs: 0, loadingEveryMs: 0 });
  const { paths } = await new PointerScanner(before).scan(before.player + 0x1cn);
  const after = new DemoGame({ tickMs: 0, loadingEveryMs: 0, heapShift: 0x500000n });
  const ok = paths.filter((p) => { try { return resolve(after, p) === after.player + 0x1cn; } catch { return false; } });
  assert.deepEqual(ok.map((p) => p.base), ['demo.exe+2000', 'demo.exe+2200']);
});

test('pointer scan: can be cancelled', async () => {
  const game = new DemoGame({ tickMs: 0, loadingEveryMs: 0 });
  const s = new PointerScanner(game);
  s.on('progress', () => s.cancel());
  const r = await s.scan(game.player + 0x1cn);
  assert.equal(r.cancelled, true);
  assert.equal(s.busy, false);
});

test('finder: Make it last saves a heap mod, and Check after a restart keeps the right path', async () => {
  let shift = 0n;
  const c = new Controller({ packsDir: PACKS, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'keystone-ptr-')), demoMovesHeap: () => shift });
  controllers.push(c);
  c.attach({ demo: true });
  const game = c.session.memory;
  const mod = c.finder.addMod({ address: (game.player + 0x1cn).toString(16), type: 'int32', name: 'Gold' });
  assert.equal(mod.kept, false, 'heap: until the game closes');

  const progress = [];
  c.on('finder', (why) => { if (why === 'progress') progress.push(c.finder.info().pointer); });
  const r = await c.finder.makeLast(mod.id);
  assert.equal(r.paths, 3);
  assert.ok(progress.some((p) => p && p.name === 'Gold' && p.progress.level === 1));
  assert.equal(c.finder.info().pointer, null);
  let mine = c.finder.myMods().find((m) => m.id === mod.id);
  assert.equal(mine.kept, true);
  assert.deepEqual(mine.pointer, { paths: 3, checks: 0, canCheck: false, waiting: true });
  assert.throws(() => c.finder.checkMod(mod.id, '250'), /Restart the game first/);
  assert.equal(c.snapshot().records.find((r2) => r2.id === mod.id).sessionOnly, undefined);

  // Restart the game somewhere else in memory.
  c.detach();
  shift = 0x700000n;
  c.attach({ demo: true });
  const g2 = c.session.memory;
  mine = c.finder.myMods().find((m) => m.id === mod.id);
  assert.equal(mine.pointer.canCheck, true);
  const now = g2.read(g2.player + 0x1cn, 4).readInt32LE(0);
  assert.throws(() => c.finder.checkMod(mod.id, '123456'), /None of the 3 paths lead to 123456/);
  const res = c.finder.checkMod(mod.id, String(now));
  assert.deepEqual(res, { paths: 2, dropped: 1 });
  mine = c.finder.myMods().find((m) => m.id === mod.id);
  assert.equal(mine.address, 'demo.exe+2000');
  assert.deepEqual(mine.pointer, { paths: 2, checks: 1, canCheck: false, waiting: true });
  // The mod reads the new run's gold.
  c.session.readTick();
  assert.equal(c.session.state.get(mod.id).current, now);

  // Another restart: both paths hold, so it stops asking.
  c.detach();
  shift = 0x900000n;
  c.attach({ demo: true });
  const g3 = c.session.memory;
  assert.deepEqual(c.finder.checkMod(mod.id, String(g3.read(g3.player + 0x1cn, 4).readInt32LE(0))), { paths: 2, dropped: 0 });
  mine = c.finder.myMods().find((m) => m.id === mod.id);
  assert.deepEqual(mine.pointer, { paths: 2, checks: 2, canCheck: false, waiting: false });

  // Shared as a table, the pointer path goes with it.
  assert.match(c.finder.tableXml(), /<Address>demo\.exe\+2000<\/Address>\s*<Offsets><Offset>1C<\/Offset><\/Offsets>/);
  await assert.rejects(c.finder.makeLast(mod.id), /already saved/);
});
