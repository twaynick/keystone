'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { GameStore } = require('../src/main/store');
const { Controller } = require('../src/main/controller');

const PACKS = path.join(__dirname, '..', 'packs');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'keystone-test-'));

function demoController(dataDir = tmpDir()) {
  const c = new Controller({ packsDir: PACKS, dataDir });
  c.attach({ demo: true });
  return { c, dataDir };
}
const idOf = (c, name) => c.session.records.find((r) => r.name === name).id;

test('store round-trips and writes atomically (no .tmp left behind)', () => {
  const dir = tmpDir();
  const s = new GameStore(dir);
  s.update('Game.exe', (d) => { d.profiles.a = { toggles: {} }; });
  const fresh = new GameStore(dir);
  assert.ok(fresh.load('Game.exe').profiles.a);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'games')), ['game.exe.json']);
});

test('a corrupt settings file is set aside, not fatal', () => {
  const dir = tmpDir();
  const s = new GameStore(dir);
  fs.writeFileSync(s.file('x.exe'), '{ not json');
  const data = s.load('x.exe');
  assert.deepEqual(data.profiles, {});
  assert.ok(fs.readdirSync(path.join(dir, 'games')).some((f) => f.includes('.corrupt-')));
});

test('save and apply a profile', () => {
  const { c } = demoController();
  const gold = idOf(c, 'Gold');
  const hp = idOf(c, 'Health');
  c.setTarget(gold, 5000);
  c.setEnabled(gold, true);
  c.setTarget(hp, 100);
  c.setEnabled(hp, true);
  c.saveProfile('Rich and immortal');

  c.setEnabled(gold, false);
  c.setEnabled(hp, false);
  assert.equal(c.snapshot().profiles.dirty, true);

  c.applyProfile('Rich and immortal');
  const snap = c.snapshot();
  assert.equal(snap.records.find((r) => r.id === gold).enabled, true);
  assert.equal(snap.records.find((r) => r.id === gold).target, 5000);
  assert.equal(snap.profiles.active, 'Rich and immortal');
  assert.equal(snap.profiles.dirty, false);
  c.shutdown();
});

test('applying a profile turns off locks the profile does not have', () => {
  const { c } = demoController();
  c.setEnabled(idOf(c, 'Gold'), true);
  c.saveProfile('Gold only');
  c.setEnabled(idOf(c, 'Wood'), true);
  c.applyProfile('Gold only');
  assert.equal(c.snapshot().records.find((r) => r.name === 'Wood').enabled, false);
  c.shutdown();
});

test('active profile auto-applies on the next attach', () => {
  const { c, dataDir } = demoController();
  c.setTarget(idOf(c, 'Ammo in clip'), 30);
  c.setEnabled(idOf(c, 'Ammo in clip'), true);
  c.saveProfile('Infinite ammo');
  c.shutdown();

  const c2 = new Controller({ packsDir: PACKS, dataDir });
  const { notices, snapshot } = c2.attach({ demo: true });
  assert.ok(notices.some((n) => n.includes('Infinite ammo')));
  assert.equal(snapshot.records.find((r) => r.name === 'Ammo in clip').enabled, true);

  c2.setAutoApply(false);
  c2.shutdown();
  const c3 = new Controller({ packsDir: PACKS, dataDir });
  const res = c3.attach({ demo: true });
  assert.equal(res.snapshot.records.find((r) => r.name === 'Ammo in clip').enabled, false);
  c3.shutdown();
});

test('loaded tables are remembered and reloaded on attach', () => {
  const dataDir = tmpDir();
  const extra = path.join(dataDir, 'extra.ct');
  fs.writeFileSync(extra, `<CheatTable><CheatEntries><CheatEntry><ID>1</ID><Description>"Extra gold"</Description>
    <VariableType>4 Bytes</VariableType><Address>demo.exe+2000</Address><Offsets><Offset>1C</Offset></Offsets></CheatEntry></CheatEntries></CheatTable>`);
  const { c } = demoController(dataDir);
  c.loadTableFile(extra);
  c.shutdown();

  const c2 = new Controller({ packsDir: PACKS, dataDir });
  const { snapshot } = c2.attach({ demo: true });
  assert.ok(snapshot.records.some((r) => r.name === 'Extra gold'));
  c2.shutdown();
});

test('profile mods missing from the tables are skipped and counted', () => {
  const { c } = demoController();
  c.store.update('demo.exe', (d) => {
    d.profiles.old = { toggles: { 'ct:gone:1': { enabled: true, target: 1 }, [idOf(c, 'Gold')]: { enabled: true, target: 7 } } };
  });
  const res = c.applyProfile('old');
  assert.equal(res.skipped, 1);
  assert.equal(c.snapshot().records.find((r) => r.name === 'Gold').target, 7);
  c.shutdown();
});

test('rename, delete, clear and name validation', () => {
  const { c } = demoController();
  c.saveProfile('  Speed   run ');
  assert.deepEqual(c.snapshot().profiles.names, ['Speed run']);
  c.saveProfile('Other');
  assert.throws(() => c.renameProfile('Other', 'Speed run'), /already exists/);
  c.renameProfile('Other', 'Casual');
  assert.equal(c.snapshot().profiles.active, 'Casual');
  c.clearActiveProfile();
  assert.equal(c.snapshot().profiles.active, null);
  c.deleteProfile('Casual');
  assert.deepEqual(c.snapshot().profiles.names, ['Speed run']);
  assert.throws(() => c.saveProfile('   '), /name/);
  assert.throws(() => c.saveProfile('x'.repeat(41)), /under 40/);
  assert.throws(() => c.saveProfile('Speed run', { overwrite: false }), /already exists/);
  c.shutdown();
});
