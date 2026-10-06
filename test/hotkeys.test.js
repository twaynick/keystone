'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { normalize, HotkeyRegistry } = require('../src/main/hotkeys');
const { Controller } = require('../src/main/controller');

const PACKS = path.join(__dirname, '..', 'packs');
const cleanups = [];
test.after(async () => { for (const fn of cleanups.reverse()) await fn(); });

function demo() {
  const c = new Controller({ packsDir: PACKS, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'keystone-hk-')) });
  cleanups.push(() => c.shutdown());
  c.attach({ packId: 'demo' });
  const id = (name) => c.session.records.find((r) => r.name === name).id;
  return { c, id };
}

test('hotkey rules: solo F-keys and numpad, letters need Ctrl or Alt, reserved combos refused', () => {
  assert.equal(normalize('F6'), 'F6');
  assert.equal(normalize('NUM1'), 'num1');
  assert.equal(normalize('shift+ctrl+num1'), 'Ctrl+Shift+num1');
  assert.equal(normalize('Alt+h'), 'Alt+H');
  assert.throws(() => normalize('H'), /Add Ctrl or Alt/);
  assert.throws(() => normalize('Shift+1'), /Add Ctrl or Alt/);
  assert.throws(() => normalize('Ctrl+Shift+O'), /Keystone's own/);
  assert.throws(() => normalize('Super+F1'), /can't be part/);
  assert.throws(() => normalize('Ctrl+Escape'), /can't be used/);
  assert.throws(() => normalize(''), /Press a key/);
});

test('registry registers, releases and reports keys another program holds', () => {
  const held = new Set(['F9']);
  const registered = new Map();
  const gs = {
    register: (a, fn) => { if (held.has(a)) return false; registered.set(a, fn); return true; },
    unregister: (a) => registered.delete(a),
  };
  const fired = [];
  const reg = new HotkeyRegistry({ globalShortcut: gs, onFire: (id) => fired.push(id) });
  assert.deepEqual(reg.sync({ a: 'F6', b: 'F9' }), ['F9']);
  registered.get('F6')();
  assert.deepEqual(fired, ['a']);
  reg.sync({ a: 'F7' });
  assert.deepEqual([...registered.keys()], ['F7'], 'old key released, new one taken');
  reg.clear();
  assert.equal(registered.size, 0);
});

test('setting hotkeys: saved per game, unique within the game, shown on records', () => {
  const { c, id } = demo();
  assert.equal(c.setHotkey(id('Health'), 'f5'), 'F5');
  assert.throws(() => c.setHotkey(id('Gold'), 'F5'), /already used by "Health"/);
  assert.deepEqual(c.activeHotkeys(), { [id('Health')]: 'F5' });
  assert.equal(c.snapshot().records.find((r) => r.name === 'Health').hotkey, 'F5');
  c.setHotkey(id('Health'), null);
  assert.deepEqual(c.activeHotkeys(), {});
  // Scripts switch on and off, so they can have hotkeys; group headers can't.
  const script = c.session.records.find((r) => r.kind === 'script').id;
  assert.equal(c.setHotkey(script, 'F2'), 'F2');
  const group = c.session.records.find((r) => r.kind === 'group').id;
  assert.throws(() => c.setHotkey(group, 'F3'), /Only mods that can be switched/);
});

test('hotkeys are only active while mods are connected', () => {
  const { c, id } = demo();
  c.setHotkey(id('Gold'), 'F8');
  c.session.memory.alive = false;
  c.session.readTick();
  assert.deepEqual(c.activeHotkeys(), {});
});

test('quick actions follow each control type', () => {
  const { c, id } = demo();
  // toggle: On locks at the pack's value
  assert.deepEqual(c.quickAction(id('Stamina')), { label: 'Unlimited stamina', state: 'On' });
  assert.equal(c.session.state.get(id('Stamina')).target, 100);
  assert.deepEqual(c.quickAction(id('Stamina')), { label: 'Unlimited stamina', state: 'Off' });
  // steps: cycle 1K -> 10K -> 100K -> off
  assert.equal(c.quickAction(id('Gold')).state, '1K');
  assert.equal(c.quickAction(id('Gold')).state, '10K');
  assert.equal(c.quickAction(id('Gold')).state, '100K');
  assert.equal(c.quickAction(id('Gold')).state, 'Off');
  // apply: writes once, never locks
  assert.equal(c.quickAction(id('Wood')).state, 'Applied');
  assert.equal(c.session.state.get(id('Wood')).enabled, false);
  // default: freezes the current value
  assert.equal(c.quickAction(id('Stone')).state, 'On');
  assert.equal(c.session.state.get(id('Stone')).target, 12);
});

test('pins are saved per game and feed the overlay Mods panel', () => {
  const { c, id } = demo();
  c.setPinned(id('Stamina'), true);
  c.setHotkey(id('Stamina'), 'num1');
  assert.equal(c.snapshot().records.find((r) => r.name === 'Stamina').pinned, true);
  const ov = c.overlay.state();
  assert.deepEqual(ov.mods, [{ id: id('Stamina'), label: 'Unlimited stamina', hotkey: 'num1', control: 'toggle' }]);
  c.quickAction(id('Stamina'));
  assert.equal(c.overlay.values().mods[id('Stamina')].enabled, true);
  assert.ok(ov.panels.mods, 'panel position exists, also for older settings files');
  c.setPinned(id('Stamina'), false);
  assert.deepEqual(c.overlay.state().mods, []);
});
