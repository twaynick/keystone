'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const { Controller } = require('../src/main/controller');
const { Settings } = require('../src/main/settings');
const { Remote } = require('../src/main/remote');
const { lanAddresses } = require('../src/main/remote/network');

const ROOT = path.join(__dirname, '..');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'keystone-remote-'));

// A failed assertion skips a test's own shutdown; without this the leftover
// server keeps the process alive and the whole suite hangs instead of failing.
const cleanups = [];
test.after(async () => { for (const fn of cleanups.reverse()) await fn(); });

async function setup(opts = {}) {
  const dataDir = tmpDir();
  const controller = new Controller({ packsDir: path.join(ROOT, 'packs'), dataDir, ...opts });
  const settings = new Settings(dataDir);
  settings.updateRemote({ port: 0 }); // any free port
  const remote = new Remote({
    controller, settings,
    webDir: path.join(ROOT, 'src', 'remote-web'),
    sharedDir: path.join(ROOT, 'src', 'shared'),
  });
  const port = await remote.server.start(0, '127.0.0.1');
  cleanups.push(async () => { controller.shutdown(); await remote.shutdown(); });
  return { controller, settings, remote, port, dataDir };
}

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    // Raw request so "../" isn't normalised away by a URL parser first.
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// Collects messages from the moment the socket exists, so a snapshot sent
// right after the handshake can't slip past before a listener is attached.
function connect(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?t=${encodeURIComponent(token)}`);
  ws.inbox = [];
  ws.waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    ws.inbox.push(msg);
    ws.waiters = ws.waiters.filter((w) => !(w.pred(msg) && (w.resolve(msg), true)));
  });
  return ws;
}

function waitFor(ws, pred, ms = 2000) {
  const hit = ws.inbox.find(pred);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out waiting for message')), ms);
    ws.waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
  });
}

const closed = (ws) => new Promise((resolve) => ws.on('close', (code) => resolve(code)));

test('serves the phone app and shared assets', async () => {
  const { remote, port } = await setup();
  const index = await get(port, '/');
  assert.equal(index.status, 200);
  assert.match(index.type, /text\/html/);
  assert.match(index.body, /remote\.js/);
  assert.equal((await get(port, '/manifest.webmanifest')).status, 200);
  assert.equal((await get(port, '/shared/base.css')).status, 200);
  assert.match((await get(port, '/shared/fonts/Geist-Variable.woff2')).type, /font\/woff2/);
  await remote.shutdown();
});

test('blocks path traversal out of the web folder', async () => {
  const { remote, port } = await setup();
  for (const p of ['/../package.json', '/shared/../../package.json', '/%2e%2e/package.json', '/shared/%2e%2e%2f%2e%2e%2fpackage.json']) {
    const res = await get(port, p);
    assert.ok([403, 404].includes(res.status), `${p} -> ${res.status}`);
    assert.doesNotMatch(res.body, /"koffi"/);
  }
  await remote.shutdown();
});

test('rejects a wrong pairing token with close code 4401', async () => {
  const { remote, port } = await setup();
  const ws = connect(port, 'not-the-token');
  assert.equal(await closed(ws), 4401);
  await remote.shutdown();
});

test('rate-limits repeated bad tokens', async () => {
  const { remote, port } = await setup();
  for (let i = 0; i < 10; i++) await closed(connect(port, `bad${i}`));
  assert.equal(await closed(connect(port, remote.settings.remote.token)), 4429, 'even the right token waits it out');
  await remote.shutdown();
});

test('paired phone gets a snapshot and can lock a mod', async () => {
  const { controller, remote, port, settings } = await setup();
  controller.attach({ demo: true });
  const ws = connect(port, settings.remote.token);
  const first = await waitFor(ws, (m) => m.type === 'snapshot');
  assert.equal(first.data.game.name, 'demo.exe');

  const gold = first.data.records.find((r) => r.name === 'Gold');
  ws.send(JSON.stringify({ type: 'toggle', id: gold.id, enabled: true, target: 4242, reqId: 1 }));
  const res = await waitFor(ws, (m) => m.type === 'result' && m.reqId === 1);
  assert.equal(res.ok, true);

  const after = await waitFor(ws, (m) => m.type === 'snapshot' && m.data.records.find((r) => r.id === gold.id).enabled);
  assert.equal(after.data.records.find((r) => r.id === gold.id).target, 4242);
  assert.equal(controller.snapshot().records.find((r) => r.id === gold.id).enabled, true, 'desktop sees the same state');

  await waitFor(ws, (m) => m.type === 'values');
  ws.close();
  controller.shutdown();
  await remote.shutdown();
});

test('phone errors come back as messages, not crashes', async () => {
  const { remote, port, settings } = await setup();
  const ws = connect(port, settings.remote.token);
  await waitFor(ws, (m) => m.type === 'snapshot');
  ws.send(JSON.stringify({ type: 'toggle', id: 'nope', enabled: true, reqId: 7 }));
  const res = await waitFor(ws, (m) => m.reqId === 7);
  assert.equal(res.ok, false);
  assert.match(res.error, /Attach to a game first/);
  ws.send('not json at all');
  ws.send(JSON.stringify({ type: 'explode', reqId: 8 }));
  assert.match((await waitFor(ws, (m) => m.reqId === 8)).error, /Unknown command/);
  ws.close();
  await remote.shutdown();
});

test('phone can apply a saved profile', async () => {
  const { controller, remote, port, settings } = await setup();
  controller.attach({ demo: true });
  const hp = controller.session.records.find((r) => r.name === 'Health').id;
  controller.setTarget(hp, 100);
  controller.setEnabled(hp, true);
  controller.saveProfile('God mode');
  controller.setEnabled(hp, false);

  const ws = connect(port, settings.remote.token);
  await waitFor(ws, (m) => m.type === 'snapshot');
  ws.send(JSON.stringify({ type: 'applyProfile', name: 'God mode', reqId: 2 }));
  assert.equal((await waitFor(ws, (m) => m.reqId === 2)).ok, true);
  assert.equal(controller.snapshot().records.find((r) => r.id === hp).enabled, true);
  ws.close();
  controller.shutdown();
  await remote.shutdown();
});

test('resetting pairing disconnects phones and changes the code', async () => {
  const { remote, port, settings } = await setup();
  const old = settings.remote.token;
  const ws = connect(port, old);
  await waitFor(ws, (m) => m.type === 'snapshot');
  const done = closed(ws);
  remote.resetPairing();
  assert.equal(await done, 4401);
  assert.notEqual(settings.remote.token, old);
  assert.equal(await closed(connect(port, old)), 4401);
  await remote.shutdown();
});

test('status includes a QR code once running', async () => {
  const { remote } = await setup();
  const s = await remote.status();
  assert.equal(s.running, true);
  if (s.host) {
    assert.match(s.url, /^http:\/\/[\d.]+:\d+\/#t=/);
    assert.match(s.qr, /^data:image\/png;base64,/);
  }
  await remote.shutdown();
  assert.equal((await remote.status()).running, false);
});

test('settings persist the token across restarts', () => {
  const dir = tmpDir();
  const a = new Settings(dir);
  const b = new Settings(dir);
  assert.equal(a.remote.token, b.remote.token);
  assert.ok(a.remote.token.length >= 20);
});

test('LAN address ranking puts virtual adapters last', () => {
  const list = lanAddresses();
  const firstVirtual = list.findIndex((a) => a.virtual);
  if (firstVirtual >= 0) assert.ok(list.slice(firstVirtual).every((a) => a.virtual));
});

function getWithToken(port, urlPath, token) {
  return new Promise((resolve, reject) => {
    const headers = token === undefined ? {} : { 'X-Keystone-Token': token };
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('phone map: snapshot, marker points, layers, waypoints and "I\'m here"', async () => {
  const { controller, remote, port, settings } = await setup();
  controller.listProcesses = () => [];
  controller.attach({ packId: 'ark-survival-ascended' });
  const ws = connect(port, settings.remote.token);
  const snap = await waitFor(ws, (m) => m.type === 'snapshot');
  const map = snap.data.map;
  assert.equal(map.variant.units, 'latlon');
  assert.ok(map.variants.length > 1, 'ARK has several maps');
  assert.ok(map.layers.length && map.layers.every((l) => !('points' in l)), 'points stay out of the snapshot');
  assert.equal(map.findMe, true);

  let n = 0;
  const ask = async (msg) => {
    const reqId = ++n + 100;
    ws.send(JSON.stringify({ ...msg, reqId }));
    return waitFor(ws, (m) => m.type === 'result' && m.reqId === reqId);
  };
  const pts = await ask({ type: 'mapPoints' });
  assert.equal(pts.data.variant, map.variant.id);
  const caves = pts.data.layers.find((l) => l.id === map.layers[0].id);
  assert.equal(caves.points.length, map.layers[0].count);
  assert.ok(caves.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));

  assert.equal((await ask({ type: 'setLayer', id: map.layers[0].id, on: false })).ok, true);
  const added = await ask({ type: 'addWaypoint', name: 'Phone pin', x: 40.5, y: 60.25 });
  assert.equal(added.data.name, 'Phone pin');
  assert.equal((await ask({ type: 'setTracked', id: added.data.id })).ok, true);
  assert.equal((await ask({ type: 'setHere', x: 50, y: 50 })).ok, true);
  const after = await waitFor(ws, (m) => m.type === 'snapshot' && m.data.map.here && m.data.map.tracked === added.data.id);
  assert.equal(after.data.map.layers[0].on, false, 'the filter is shared with the desktop');
  assert.ok(after.data.map.waypoints.some((w) => w.name === 'Phone pin' && w.x === 40.5));
  assert.equal(controller.overlay.waypoints().find((w) => w.id === added.data.id).y, 60.25, 'the desktop has it too');

  // ARK teleports by memory only, which needs mods: a clear refusal, no crash.
  const tp = await ask({ type: 'teleportTo', x: 10, y: 10 });
  assert.equal(tp.ok, false);
  assert.match(tp.error, /mods/i);

  const other = map.variants.find((v) => v.id !== map.variant.id);
  assert.equal((await ask({ type: 'setVariant', id: other.id })).ok, true);
  const switched = await waitFor(ws, (m) => m.type === 'snapshot' && m.data.map.variant.id === other.id);
  assert.ok(!switched.data.map.waypoints.some((w) => w.id === added.data.id), 'waypoints belong to their map');
  assert.equal((await ask({ type: 'removeWaypoint', id: added.data.id })).ok, true);
  ws.close();
  await remote.shutdown();
});

test('phone map picture: needs the token in a header, and comes back as the image', async () => {
  const { controller, remote, port, settings } = await setup();
  controller.attach({ demo: true });
  const token = settings.remote.token;
  assert.equal((await getWithToken(port, '/api/map-image')).status, 401, 'no token');
  assert.equal((await getWithToken(port, '/api/map-image', 'wrong')).status, 401);
  assert.equal((await getWithToken(port, `/api/map-image?t=${token}`)).status, 401, 'a token in the URL is not accepted');
  const ok = await getWithToken(port, '/api/map-image?k=1', token);
  assert.equal(ok.status, 200);
  assert.match(ok.type, /^image\//);
  assert.ok(ok.body.length > 1000);
  assert.equal((await getWithToken(port, '/api/other', token)).status, 404);

  // A game with no picture: 404, not a crash.
  controller.listProcesses = () => [];
  controller.attach({ packId: 'fallout-shelter' });
  assert.equal((await getWithToken(port, '/api/map-image', token)).status, 404);
  assert.equal(controller.snapshot().map, null, 'no map, no Map tab');

  // Wrong guesses count toward the same lockout as the socket.
  for (let i = 0; i < 10; i++) await getWithToken(port, '/api/map-image', `bad${i}`);
  assert.equal((await getWithToken(port, '/api/map-image', token)).status, 429);
  await remote.shutdown();
});

test('phone gets the live position with values', async () => {
  const { controller, remote, port, settings } = await setup();
  controller.attach({ demo: true });
  const ws = connect(port, settings.remote.token);
  const snap = await waitFor(ws, (m) => m.type === 'snapshot');
  assert.ok(snap.data.map.image, 'the demo has a picture');
  assert.equal(snap.data.map.teleport, 'memory');
  const v = await waitFor(ws, (m) => m.type === 'values' && m.pos, 4000);
  assert.ok(Number.isFinite(v.pos.x) && Number.isFinite(v.pos.y));
  ws.close();
  controller.shutdown();
  await remote.shutdown();
});

test('phone Library: info, entries, entry, search, guides and notes', async () => {
  const { controller, remote, port, settings } = await setup();
  controller.listProcesses = () => [];
  controller.attach({ packId: 'lego-star-wars-complete-saga' });
  const ws = connect(port, settings.remote.token);
  const snap = await waitFor(ws, (m) => m.type === 'snapshot');
  assert.equal(snap.data.library, true);
  let n = 500;
  const lib = async (extra) => {
    const reqId = ++n;
    ws.send(JSON.stringify({ type: 'lib', reqId, ...extra }));
    const r = await waitFor(ws, (m) => m.type === 'result' && m.reqId === reqId);
    return r;
  };
  const info = (await lib({ action: 'info' })).data;
  assert.ok(!('userGuidesDir' in info), 'no PC folder paths go to the phone');
  const sec = info.sections[0];
  const list = (await lib({ action: 'entries', catalog: sec.catalog })).data;
  assert.equal(list.length, 61);
  assert.deepEqual(Object.keys(list[0]).sort(), ['category', 'id', 'map', 'name']);
  const e = (await lib({ action: 'entry', catalog: sec.catalog, id: list[0].id })).data;
  assert.equal(e.name, list[0].name);
  assert.equal((await lib({ action: 'note', catalog: sec.catalog, id: e.id, text: 'got it' })).ok, true);
  assert.equal(controller.library.entry(sec.catalog, e.id).note, 'got it', 'the desktop sees the note');
  const hits = (await lib({ action: 'search', q: 'boba' })).data;
  assert.ok(hits.some((h) => h.title === 'Boba Fett'));
  const g = (await lib({ action: 'guide', id: info.guides[0].id })).data;
  assert.match(g.html, /<h1/);
  const bad = await lib({ action: 'guide', id: 'pack:../../package.json' });
  assert.equal(bad.ok, false, 'guides stay in their folder');
  assert.equal((await lib({ action: 'explode' })).ok, false);
  ws.close();
  await remote.shutdown();
});

test('phone Library pictures need the token; missing ones are a 404', async () => {
  const { controller, remote, port, settings } = await setup();
  controller.listProcesses = () => [];
  controller.attach({ packId: 'lego-star-wars-complete-saga' });
  const q = '/api/lib-image?kind=thumb&c=codes&id=LA811Y';
  assert.equal((await getWithToken(port, q)).status, 401);
  // No picture downloader in tests: the PC has nothing to give, so 404.
  assert.equal((await getWithToken(port, q, settings.remote.token)).status, 404);
  assert.equal((await getWithToken(port, '/api/lib-image?kind=../../x&c=codes&id=1', settings.remote.token)).status, 404);
  // With a cached picture it comes back with its real type.
  const pngs = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const file = path.join(os.tmpdir(), `ks-pic-${Date.now()}.png`);
  fs.writeFileSync(file, Buffer.concat([pngs, Buffer.alloc(64)]));
  controller.library.pictureFile = async () => file;
  const ok = await getWithToken(port, q, settings.remote.token);
  assert.equal(ok.status, 200);
  assert.equal(ok.type, 'image/png');
  await remote.shutdown();
});

test('phone can switch checklists, and the overlay follows', async () => {
  const { controller, remote, port, settings } = await setup();
  controller.listProcesses = () => [];
  controller.attach({ packId: 'ark-survival-ascended' });
  const ws = connect(port, settings.remote.token);
  const snap = await waitFor(ws, (m) => m.type === 'snapshot');
  assert.ok(snap.data.checklists.length >= 2);
  const other = snap.data.checklists.find((l) => l.id !== snap.data.checklist.id);
  ws.send(JSON.stringify({ type: 'setActiveList', id: other.id, reqId: 900 }));
  assert.equal((await waitFor(ws, (m) => m.reqId === 900)).ok, true);
  const after = await waitFor(ws, (m) => m.type === 'snapshot' && m.data.checklist?.id === other.id);
  assert.equal(after.data.checklist.name, other.name);
  assert.equal(controller.overlay.state().checklist.id, other.id);
  ws.send(JSON.stringify({ type: 'setActiveList', id: 'nope', reqId: 901 }));
  assert.equal((await waitFor(ws, (m) => m.reqId === 901)).ok, false);
  ws.close();
  await remote.shutdown();
});

test('phone commands: info without secrets, spawn from an entry, quick and typed commands', async () => {
  const typed = [];
  const { controller, remote, port, settings } = await setup({ commands: { consoleSend: async (pid, lines) => { typed.push(...lines); } } });
  controller.listProcesses = () => [];
  controller.attach({ pid: 4242, name: 'ArkAscended.exe' });
  controller.commands.setSettings({ adminPassword: 'hunter2' });
  const ws = connect(port, settings.remote.token);
  const snap = await waitFor(ws, (m) => m.type === 'snapshot');
  assert.equal(snap.data.hasCommands, true);
  let n = 700;
  const ask = async (msg) => {
    const reqId = ++n;
    ws.send(JSON.stringify({ ...msg, reqId }));
    return waitFor(ws, (m) => m.type === 'result' && m.reqId === reqId);
  };
  const info = (await ask({ type: 'cmdInfo' })).data;
  assert.equal(info.available, true);
  assert.equal(info.hasAdminPassword, true);
  assert.doesNotMatch(JSON.stringify(info), /hunter2/, 'the password never goes to the phone');
  assert.ok(!('history' in info));

  // Library entry -> its actions -> run one with the form's values.
  const rex = controller.library.entries('creatures').find((e) => e.name === 'Rex');
  const entry = (await ask({ type: 'lib', action: 'entry', catalog: 'creatures', id: rex.id })).data;
  assert.ok(entry.commandActions.some((a) => a.id === 'summon-tamed'));
  const run = await ask({ type: 'cmdRun', kind: 'action', id: 'summon-tamed', entryId: rex.id, values: { level: '200', count: '2' } });
  assert.equal(run.ok, true, run.error);
  assert.equal(typed.filter((l) => l.includes(`GMSummon "${rex.id}" 200`)).length, 2);

  const bad = await ask({ type: 'cmdRun', kind: 'action', id: 'summon-tamed', entryId: rex.id, values: { level: '5000' } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /above 1000/);

  assert.equal((await ask({ type: 'cmdRun', kind: 'quick', id: 'god' })).ok, true);
  assert.equal((await ask({ type: 'cmdRaw', text: 'SetTimeOfDay 12:00', via: 'console' })).ok, true);
  assert.ok(typed.some((l) => /SetTimeOfDay 12:00$/.test(l)));
  assert.equal((await ask({ type: 'cmdAdmin' })).ok, true);
  assert.ok(typed.includes('EnableCheats hunter2'));
  assert.equal((await ask({ type: 'cmdRaw', text: '   ' })).ok, false);
  ws.close();
  await remote.shutdown();
});
