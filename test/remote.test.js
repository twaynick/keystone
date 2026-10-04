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

async function setup() {
  const dataDir = tmpDir();
  const controller = new Controller({ packsDir: path.join(ROOT, 'packs'), dataDir });
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
