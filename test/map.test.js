'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Controller } = require('../src/main/controller');
const { loadPacks } = require('../src/main/packs');
const { parseCoords, ueToMap } = require('../src/main/overlay-model');

const PACKS = path.join(__dirname, '..', 'packs');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'keystone-map-'));

// A fake game: typing "admincheat ccc" makes it copy its position, like ARK.
function ark({ pos = { x: 120000, y: -96000, z: 3500 }, copies = true } = {}) {
  let clip = 'my own clipboard text';
  const typed = [];
  const clipboard = { readText: () => clip, writeText: (t) => { clip = t; } };
  const consoleSend = async (pid, lines, opts) => {
    typed.push({ lines, mode: opts.mode });
    if (copies && lines.some((l) => /\bccc$/.test(l))) setTimeout(() => { clip = `${pos.x} ${pos.y} ${pos.z} 12.5 -3.0`; }, 30);
  };
  const c = new Controller({ packsDir: PACKS, dataDir: tmpDir(), clipboard, commands: { consoleSend } });
  c.listProcesses = () => [{ pid: 99, name: 'ArkAscended.exe' }];
  c.attach({ packId: 'ark-survival-ascended' });
  return { c, typed, clip: () => clip };
}

test('ccc output parses; angles are ignored', () => {
  assert.deepEqual(parseCoords('-12345.5 6789 -100.25 45.0 -12.0'), { x: -12345.5, y: 6789, z: -100.25 });
  assert.equal(parseCoords('hello'), null);
  assert.equal(parseCoords(''), null);
  const conv = { lat: { shift: 50, div: 8000 }, lon: { shift: 50, div: 8000 } };
  assert.deepEqual(ueToMap({ x: 80000, y: -40000 }, conv), { x: 60, y: 45 });
});

test('ARK pack: map variants, lat/lon edges without an image, Island markers', () => {
  const { c } = ark();
  const st = c.overlay.state();
  assert.equal(st.variant.id, 'the-island');
  assert.equal(st.variant.units, 'latlon');
  assert.ok(st.variants.length >= 5);
  assert.equal(st.map.url, null, 'no bundled picture');
  assert.deepEqual(st.map.bounds, { left: 0, right: 100, top: 0, bottom: 100 });
  const caves = st.layers.find((l) => l.id === 'caves');
  assert.equal(caves.points.length, 10);
  const lava = caves.points.find((p) => p.name === 'Lava Cave');
  assert.deepEqual([lava.y, lava.x], [74.1, 92.2], 'lat is Y, lon is X');
  assert.ok(st.findMe);
  assert.match(st.markerCredits, /ark\.wiki\.gg/);

  c.overlay.setLayer('caves', false);
  assert.equal(c.overlay.layers().find((l) => l.id === 'caves').on, false);
  assert.throws(() => c.overlay.setLayer('nope', true), /isn.t in this map/);

  c.overlay.setVariant('ragnarok');
  assert.equal(c.overlay.state().layers.length, 0);
  assert.throws(() => c.overlay.setVariant('mars'), /isn.t in this game/);
  c.overlay.setVariant('the-island');
  assert.equal(c.overlay.layers().find((l) => l.id === 'caves').on, false, 'layer choice kept per map');
  c.shutdown();
});

test('"I\'m here" works without mods, and waypoints use it', () => {
  const { c } = ark();
  assert.equal(c.session, null, 'ARK mods are off');
  assert.throws(() => c.overlay.addWaypoint({}), /I.m here/);
  c.overlay.setHere({ x: 46.6, y: 40.2 });
  const p = c.overlay.position();
  assert.equal(p.manual, true);
  assert.deepEqual([p.x, p.y], [46.6, 40.2]);
  assert.equal(c.overlay.values().pos, null, 'the live feed stays memory-only');
  const wp = c.overlay.addWaypoint({ name: 'Base' });
  assert.deepEqual([wp.x, wp.y, wp.variant], [46.6, 40.2, 'the-island']);

  // Another map: neither the marker nor the waypoint follows.
  c.overlay.setVariant('scorched-earth');
  assert.equal(c.overlay.here(), null);
  assert.equal(c.overlay.waypoints().length, 0);
  c.overlay.addWaypoint({ name: 'SE spot', x: 10, y: 10 });
  c.overlay.setVariant('the-island');
  assert.deepEqual(c.overlay.waypoints().map((w) => w.name), ['Base']);
  // Removing one keeps the other map's waypoints.
  c.overlay.removeWaypoint(wp.id);
  c.overlay.setVariant('scorched-earth');
  assert.deepEqual(c.overlay.waypoints().map((w) => w.name), ['SE spot']);

  c.overlay.clearHere();
  assert.equal(c.overlay.here(), null);
  assert.throws(() => c.overlay.setHere({ x: 'a', y: 1 }), /usable/);
  c.shutdown();
});

test('Find me types ccc, reads the clipboard, converts, and puts the clipboard back', async () => {
  const { c, typed, clip } = ark();
  const h = await c.overlay.findMe({ pollMs: 10 });
  assert.deepEqual(typed[0], { lines: ['admincheat ccc'], mode: 'type' });
  assert.equal(h.source, 'findme');
  assert.ok(Math.abs(h.x - (50 + 120000 / 6857)) < 1e-9);
  assert.ok(Math.abs(h.y - (50 - 96000 / 6857)) < 1e-9);
  assert.equal(h.z, 3500);
  assert.equal(clip(), 'my own clipboard text');
  assert.equal(c.commands.history()[0].label, 'Find me');
  c.shutdown();
});

test('Find me says what to check when nothing gets copied', async () => {
  const { c, clip } = ark({ copies: false });
  await assert.rejects(c.overlay.findMe({ timeoutMs: 100, pollMs: 10 }), /admin/);
  assert.equal(clip(), 'my own clipboard text', 'clipboard restored on failure too');
  c.shutdown();
});

test('lining up Find me solves the scale from what the in-game map shows', async () => {
  const { c } = ark({ pos: { x: 160000, y: -120000, z: 0 } });
  await assert.rejects(Promise.resolve().then(() => c.overlay.lineUpFindMe({ lat: 30, lon: 70 })), /Find me first/);
  await c.overlay.findMe({ pollMs: 10 });
  // Suppose the real scale is 8000: the map shows lat 35, lon 70.
  const fixed = c.overlay.lineUpFindMe({ lat: 35, lon: 70 });
  assert.equal(fixed.lat.div, 8000);
  assert.ok(Math.abs(c.overlay.here().x - 70) < 1e-9 && Math.abs(c.overlay.here().y - 35) < 1e-9);
  assert.equal(c.overlay.state().findMeFixed, true);
  // Next Find me uses the fixed scale.
  const h = await c.overlay.findMe({ pollMs: 10 });
  assert.ok(Math.abs(h.x - 70) < 1e-9);
  c.overlay.resetFindMe();
  assert.equal(c.overlay.coords().lat.div, 6857);
  assert.ok(Math.abs(c.overlay.here().x - (50 + 160000 / 6857)) < 1e-9, 'marker recomputed with pack values');
  assert.throws(() => c.overlay.lineUpFindMe({ lat: 'x', lon: 1 }), /both numbers/);
  c.shutdown();
});

test('lining up refuses spots too near the map centre', async () => {
  const { c } = ark({ pos: { x: 6000, y: -9000, z: 0 } });
  await c.overlay.findMe({ pollMs: 10 });
  assert.throws(() => c.overlay.lineUpFindMe({ lat: 48.7, lon: 50.9 }), /farther from the middle/);
  c.shutdown();
});

test('custom map per variant; older single custom map belongs to the first variant', () => {
  const dataDir = tmpDir();
  const img = path.join(dataDir, 'shot.png');
  fs.copyFileSync(path.join(PACKS, 'demo', 'map.png'), img);
  fs.mkdirSync(path.join(dataDir, 'games'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'games', 'arkascended.exe.json'), JSON.stringify({ overlay: { map: { image: img, bounds: { left: 1, right: 99, top: 1, bottom: 99 } } } }));
  const c = new Controller({ packsDir: PACKS, dataDir });
  c.listProcesses = () => [];
  c.attach({ packId: 'ark-survival-ascended' });
  assert.equal(c.overlay.map().image, img);
  assert.deepEqual(c.overlay.map().bounds, { left: 1, right: 99, top: 1, bottom: 99 });
  c.overlay.setVariant('the-center');
  assert.equal(c.overlay.map().image, null);
  const m = c.overlay.setMapImage(img);
  assert.deepEqual(m.bounds, { left: 0, right: 100, top: 0, bottom: 100 }, 'lat/lon maps keep their edges');
  c.overlay.setVariant('the-island');
  assert.equal(c.overlay.map().image, img, 'Island image untouched');
  c.overlay.resetMap();
  assert.equal(c.overlay.map().image, null);
  c.overlay.setVariant('the-center');
  assert.ok(c.overlay.map().image, 'The Center image untouched');
  c.shutdown();
});

test('marker files are read from the pack folder only, and bad points are dropped', () => {
  const dir = tmpDir();
  const pack = path.join(dir, 'p');
  fs.mkdirSync(pack);
  fs.writeFileSync(path.join(dir, 'secret.json'), '{"layers":[{"id":"x","points":[{"x":1,"y":1}]}]}');
  fs.writeFileSync(path.join(pack, 'm.json'), JSON.stringify({ layers: [
    { id: 'a', name: 'A', color: 'red', shape: 'blob', points: [{ name: 'ok', x: 1, y: 2 }, { name: 'bad', x: 'q', y: 1 }] },
    { id: 'a', name: 'dupe' },
  ] }));
  fs.writeFileSync(path.join(pack, 'pack.json'), JSON.stringify({ name: 'P', exe: 'p.exe', maps: [
    { id: 'one', markers: 'm.json' }, { id: 'two', markers: '../secret.json' }, { id: 'bad id!' },
  ] }));
  const [p] = loadPacks([dir]);
  assert.deepEqual(p.maps.map((m) => m.id), ['one', 'two']);
  const [layer] = p.maps[0].markers.layers;
  assert.equal(p.maps[0].markers.layers.length, 1);
  assert.deepEqual([layer.color, layer.shape, layer.points.length], ['#ffffff', 'circle', 1]);
  assert.equal(p.maps[1].markers.layers.length, 0);
});
