'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MapMath = require('../src/shared/map-math');
const { loadPacks, findPack } = require('../src/main/packs');
const { Controller } = require('../src/main/controller');
const { GameStore } = require('../src/main/store');

const PACKS = path.join(__dirname, '..', 'packs');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'keystone-ov-'));

function demo(dataDir = tmpDir()) {
  const c = new Controller({ packsDir: PACKS, dataDir });
  c.attach({ demo: true });
  return { c, dataDir };
}

test('map math round-trips and handles Y-up worlds', () => {
  const b = { left: -3500, right: 3500, top: 2200, bottom: -2200 };
  const p = MapMath.worldToImage(b, 1400, 880, 0, 0);
  assert.deepEqual(p, { x: 700, y: 440 });
  const corner = MapMath.worldToImage(b, 1400, 880, -3500, 2200);
  assert.ok(Math.abs(corner.x) < 1e-9 && Math.abs(corner.y) < 1e-9); // may be -0
  const w = MapMath.imageToWorld(b, 1400, 880, 350, 660);
  assert.deepEqual(MapMath.worldToImage(b, 1400, 880, w.x, w.y), { x: 350, y: 660 });
});

test('two-point calibration recovers the true bounds', () => {
  const truth = { left: -3500, right: 3500, top: 2200, bottom: -2200 };
  const at = (x, y) => ({ world: { x, y }, px: MapMath.worldToImage(truth, 1400, 880, x, y) });
  const got = MapMath.boundsFromTwoPoints(at(-2000, 1500), at(2500, -1200), 1400, 880);
  for (const k of Object.keys(truth)) assert.ok(Math.abs(got[k] - truth[k]) < 1e-6, k);
  assert.throws(() => MapMath.boundsFromTwoPoints(at(0, 0), at(10, 10), 1400, 880), /farther apart/);
});

test('packs load, match by exe case-insensitively, and survive a broken pack', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'broken'));
  fs.writeFileSync(path.join(dir, 'broken', 'pack.json'), '{ nope');
  fs.mkdirSync(path.join(dir, 'mine'));
  fs.writeFileSync(path.join(dir, 'mine', 'pack.json'), JSON.stringify({ name: 'Mine', exe: 'MyGame.exe' }));
  const packs = loadPacks([PACKS, dir, path.join(dir, 'missing')]);
  assert.equal(findPack(packs, 'DEMO.EXE').name, 'Demo game');
  assert.equal(findPack(packs, 'mygame.exe').name, 'Mine');
  assert.ok(packs.find((p) => p.id === 'broken').error);
  assert.equal(findPack(packs, 'other.exe'), null);
});

test('demo pack: table, roles, map and waypoints come through on attach', () => {
  const { c } = demo();
  const st = c.overlay.state();
  assert.equal(st.pack, 'Demo game');
  assert.ok(st.roles.x && st.roles.y && st.roles.facing);
  assert.match(st.map.url, /^ksmap:\/\/map\/demo\.exe\?v=/);
  assert.deepEqual(st.map.bounds, { left: -3500, right: 3500, top: 2200, bottom: -2200 });
  assert.equal(st.waypoints.length, 5);
  assert.equal(st.info.length, 4);
  const pos = c.overlay.position();
  assert.ok(Number.isFinite(pos.x) && Number.isFinite(pos.y));
  c.shutdown();
});

test('waypoints: add at current position, rename, track, delete', () => {
  const { c } = demo();
  const here = c.overlay.position();
  const wp = c.overlay.addWaypoint({ name: '  Base  camp ' });
  assert.equal(wp.name, 'Base camp');
  assert.equal(wp.x, here.x);
  c.overlay.updateWaypoint(wp.id, { name: 'Home', x: '12.5' });
  assert.equal(c.overlay.waypoints().find((w) => w.id === wp.id).x, 12.5);
  c.overlay.setTracked(wp.id);
  assert.equal(c.overlay.state().tracked, wp.id);
  c.overlay.removeWaypoint(wp.id);
  assert.equal(c.overlay.state().tracked, null, 'tracking clears with the waypoint');
  assert.throws(() => c.overlay.updateWaypoint(wp.id, { name: 'x' }), /no longer exists/);
  assert.throws(() => c.overlay.updateWaypoint(c.overlay.waypoints()[0].id, { x: 'abc' }), /number/);
  c.shutdown();
});

test('pack waypoints are copied once; deleting one sticks after reattach', () => {
  const { c, dataDir } = demo();
  const first = c.overlay.waypoints()[0];
  c.overlay.removeWaypoint(first.id);
  c.shutdown();
  const c2 = new Controller({ packsDir: PACKS, dataDir });
  c2.attach({ demo: true });
  assert.equal(c2.overlay.waypoints().length, 4);
  c2.shutdown();
});

test('no position mods means a clear error when dropping a waypoint', () => {
  const { c } = demo();
  c.overlay.setRole('x', null);
  assert.equal(c.overlay.position(), null);
  assert.throws(() => c.overlay.addWaypoint({}), /doesn.t know where you are/);
  assert.ok(c.overlay.addWaypoint({ x: 1, y: 2 }), 'explicit coordinates still work');
  c.shutdown();
});

test('custom map image is copied into Keystone and calibration saves bounds', () => {
  const { c, dataDir } = demo();
  const img = path.join(dataDir, 'shot.png');
  fs.copyFileSync(path.join(PACKS, 'demo', 'map.png'), img);
  const m = c.overlay.setMapImage(img);
  assert.ok(m.image.startsWith(path.join(dataDir, 'maps')));
  assert.equal(m.bounds, null, 'a new image needs calibrating');
  fs.rmSync(img);
  assert.ok(c.overlay.map(), 'still works after the original is deleted');

  const truth = { left: -100, right: 100, top: 50, bottom: -50 };
  const at = (x, y) => ({ world: { x, y }, px: MapMath.worldToImage(truth, 1400, 880, x, y) });
  const b = c.overlay.calibrate(at(-60, 30), at(70, -40), 1400, 880);
  assert.ok(Math.abs(b.left - truth.left) < 1e-6);
  assert.throws(() => c.overlay.setMapImage(path.join(dataDir, 'x.gif')), /PNG/);

  c.overlay.resetMap();
  assert.deepEqual(c.overlay.map().bounds, { left: -3500, right: 3500, top: 2200, bottom: -2200 }, 'back to the pack map');
  c.shutdown();
});

test('readouts, panels, zoom and notes are validated and saved', () => {
  const { c } = demo();
  const hp = c.session.records.find((r) => r.name === 'Health').id;
  const script = c.session.records.find((r) => r.kind === 'script').id;
  assert.deepEqual(c.overlay.setReadouts([hp, script, 'nope']), [hp]);
  const v = c.overlay.values();
  assert.ok(v.readouts[hp]);
  assert.ok(v.pos);
  const p = c.overlay.setPanel('minimap', { x: 5, y: -1, size: 'l', visible: false });
  assert.deepEqual(p, { x: 0.98, y: 0, visible: false, size: 'l' });
  assert.throws(() => c.overlay.setPanel('nope', {}), /Unknown panel/);
  assert.equal(c.overlay.setZoom(100), 8);
  c.overlay.setNotes('x'.repeat(5000));
  assert.equal(c.overlay.state().notes.length, 4000);
  c.shutdown();
});

test('older settings files gain overlay defaults without losing profiles', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'games'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'games', 'old.exe.json'), JSON.stringify({
    profiles: { keep: { toggles: {} } }, overlay: { panels: { minimap: { x: 0.5 } } },
  }));
  const d = new GameStore(dir).load('old.exe');
  assert.ok(d.profiles.keep);
  assert.equal(d.overlay.panels.minimap.x, 0.5);
  assert.equal(d.overlay.panels.minimap.size, 'm');
  assert.ok(d.overlay.panels.info);
  assert.deepEqual(d.overlay.readouts, []);
});

test('overlay state is JSON-safe and reports detached', () => {
  const { c } = demo();
  assert.doesNotThrow(() => JSON.stringify(c.overlay.state()));
  assert.doesNotThrow(() => JSON.stringify(c.overlay.values()));
  c.detach();
  assert.deepEqual(c.overlay.state(), { attached: false });
  c.shutdown();
});
