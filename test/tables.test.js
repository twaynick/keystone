'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Controller } = require('../src/main/controller');
const { autoTables, folderName } = require('../src/main/tables');

const PACKS = path.join(__dirname, '..', 'packs');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'keystone-tables-'));
const DEMO_CT = fs.readFileSync(path.join(PACKS, 'demo', 'demo.ct'), 'utf8');
const controllers = [];
test.after(() => { for (const c of controllers) c.shutdown(); });

test('folder names: the pack id, or the exe name for games without one', () => {
  assert.equal(folderName({ id: 'fallout-4' }, { key: 'fallout4.exe' }), 'fallout-4');
  assert.equal(folderName(null, { key: 'Some Game.exe' }), 'some_game');
});

test('bundled and personal tables load by themselves, with their credits', () => {
  const bundled = tmpDir();
  const data = tmpDir();
  fs.mkdirSync(path.join(bundled, 'demo'));
  fs.writeFileSync(path.join(bundled, 'demo', 'Community.CT'), DEMO_CT.replace(/"Gold"/, '"Gold (community)"'));
  fs.writeFileSync(path.join(bundled, 'demo', 'credits.json'), JSON.stringify({
    'Community.CT': { author: 'Table Maker', url: 'https://example.com/thread', note: 'Thanks!' },
  }));
  fs.writeFileSync(path.join(bundled, 'demo', 'notes.txt'), 'not a table');
  fs.mkdirSync(path.join(data, 'tables', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(data, 'tables', 'demo', 'mine.ct'), DEMO_CT.replace(/"Wood"/, '"Wood (mine)"'));

  const list = autoTables({ bundledDir: bundled, userDir: path.join(data, 'tables') }, { id: 'demo' }, { key: 'demo.exe' });
  assert.deepEqual(list.map((t) => [t.name, t.source, t.author]), [['Community', 'bundled', 'Table Maker'], ['mine', 'mine', null]]);

  const c = new Controller({ packsDir: PACKS, dataDir: data, tablesDir: bundled });
  controllers.push(c);
  c.listProcesses = () => [];
  c.attach({ demo: true });
  const snap = c.snapshot();
  const names = snap.records.map((r) => r.name);
  assert.ok(names.includes('Gold (community)'));
  assert.ok(names.includes('Wood (mine)'));
  assert.deepEqual(snap.autoTables.map((t) => [t.name, t.author, t.url, t.source]), [
    ['Community', 'Table Maker', 'https://example.com/thread', 'bundled'],
    ['mine', null, null, 'mine'],
  ]);
  // Not remembered as a table you loaded: it's found again every start.
  assert.ok(!c.store.load(c.game.key).tables.some((t) => /Community|mine/.test(t)));
  assert.equal(c.userTablesFolder(), path.join(data, 'tables', 'demo'));
});

test('a broken table is a notice, not a failed attach; bad credit links are dropped', () => {
  const bundled = tmpDir();
  fs.mkdirSync(path.join(bundled, 'demo'));
  fs.writeFileSync(path.join(bundled, 'demo', 'broken.ct'), '<not xml');
  fs.writeFileSync(path.join(bundled, 'demo', 'ok.ct'), DEMO_CT);
  fs.writeFileSync(path.join(bundled, 'demo', 'credits.json'), JSON.stringify({ 'ok.ct': { author: 'A', url: 'javascript:alert(1)' } }));
  const c = new Controller({ packsDir: PACKS, dataDir: tmpDir(), tablesDir: bundled });
  controllers.push(c);
  c.listProcesses = () => [];
  const { notices, snapshot } = c.attach({ demo: true });
  assert.ok(notices.some((n) => /^broken:/.test(n)));
  assert.deepEqual(snapshot.autoTables.map((t) => [t.name, t.url]), [['ok', null]]);
});

test('the installer includes the tables folder', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('tables/**'));
});
