'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Controller } = require('../src/main/controller');
const { ArtCache } = require('../src/main/art');
const { loadPacks } = require('../src/main/packs');

const PACKS = path.join(__dirname, '..', 'packs');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'keystone-games-'));
const cleanups = [];
test.after(async () => { for (const fn of cleanups.reverse()) await fn(); });

function ctl(extraPacks) {
  const dataDir = tmpDir();
  if (extraPacks) {
    for (const [id, pack] of Object.entries(extraPacks)) {
      const dir = path.join(dataDir, 'packs', id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify(pack));
    }
  }
  const c = new Controller({ packsDir: PACKS, dataDir });
  cleanups.push(() => c.shutdown());
  return { c, dataDir };
}

test('library lists every pack, demo last, with flags for the tiles', () => {
  const { c } = ctl();
  const games = c.listGames();
  assert.equal(games[games.length - 1].id, 'demo');
  const ark = games.find((g) => g.id === 'ark-survival-ascended');
  assert.equal(ark.offlineOnly, true);
  assert.equal(ark.canLaunch, true);
  assert.equal(games.find((g) => g.id === 'fallout-4').offlineOnly, false);
});

test('picking the demo from the library attaches with mods and pack labels', () => {
  const { c } = ctl();
  const { snapshot } = c.attach({ packId: 'demo' });
  assert.equal(snapshot.mods, true);
  assert.equal(snapshot.packId, 'demo');
  const stamina = snapshot.records.find((r) => r.name === 'Stamina');
  assert.equal(stamina.label, 'Unlimited stamina');
  assert.deepEqual(stamina.ui, { label: 'Unlimited stamina', control: 'toggle', value: 100 });
  assert.equal(snapshot.records.find((r) => r.name === 'Stone').ui, undefined, 'mods without UI keep the default control');
});

test('offline-only games never open memory until mods are turned on', () => {
  const { c } = ctl();
  // On Linux, opening a real process throws; if Keystone tried, modsError
  // would carry that message instead of the "off" reason.
  const { snapshot } = c.attach({ pid: 4242, name: 'ArkAscended.exe' });
  assert.equal(snapshot.modsBlocked, 'offline-off');
  assert.equal(snapshot.modsError, 'mods are off for this game');
  assert.equal(snapshot.mods, false);

  const on = c.setModsEnabled(true);
  assert.equal(on.snapshot.modsBlocked, null);
  assert.notEqual(on.snapshot.modsError, 'mods are off for this game', 'it now tries to attach');
  // The choice sticks for the next session of that game.
  c.detach();
  assert.equal(c.attach({ pid: 4242, name: 'ArkAscended.exe' }).snapshot.modsBlocked, null);
  c.setModsEnabled(false);
  assert.equal(c.snapshot().modsBlocked, 'offline-off');
});

test('online-only packs (memory: false) can never have mods', () => {
  const { c } = ctl({ online: { name: 'Online Game', exe: ['online.exe'], memory: false } });
  const { snapshot } = c.attach({ pid: 99, name: 'online.exe' });
  assert.equal(snapshot.modsBlocked, 'online-only');
  assert.equal(snapshot.modsError, 'this game is online-only');
  c.setModsEnabled(true);
  assert.equal(c.snapshot().modsBlocked, 'online-only', 'the per-game switch cannot override it');
});

test('when the demo game exits, the game stays selected without mods', () => {
  const { c } = ctl();
  c.attach({ packId: 'demo' });
  c.session.memory.alive = false;
  c.session.readTick();
  const snap = c.snapshot();
  assert.equal(snap.attached, true);
  assert.equal(snap.game.offline, true);
  assert.equal(snap.mods, false);
});

test('launch targets come from the pack (Steam by default) and only allowed schemes', async () => {
  const { c } = ctl({
    epic: { name: 'Epic Game', exe: ['epic.exe'], launch: { uri: 'com.epicgames.launcher://apps/abc?action=launch' } },
    bad: { name: 'Bad', exe: ['bad.exe'], launch: { uri: 'file:///C:/Windows/System32/cmd.exe' } },
  });
  assert.deepEqual(await c.launchTarget('fallout-4'), { kind: 'uri', uri: 'steam://rungameid/377160' });
  assert.equal((await c.launchTarget('epic')).uri, 'com.epicgames.launcher://apps/abc?action=launch');
  await assert.rejects(c.launchTarget('bad'), /doesn.t know how to start/);
});

test('art cache: pack files stay inside the pack, Steam art downloads once and caches', async () => {
  const dataDir = tmpDir();
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    if (url.includes('library_hero')) return { ok: false, status: 404 };
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('jpegdata') };
  };
  const cache = new ArtCache({ dataDir, fetchImpl: fakeFetch });
  const packs = loadPacks([PACKS]);
  const demo = packs.find((p) => p.id === 'demo');
  assert.equal(await cache.file(demo, 'cover'), path.join(demo.folder, 'cover.jpg'));
  assert.equal(await cache.file({ ...demo, art: { cover: '../fallout-4/pack.json' } }, 'cover'), null, 'no escaping the pack folder');

  const fo4 = packs.find((p) => p.id === 'fallout-4');
  const [a, b] = await Promise.all([cache.file(fo4, 'cover'), cache.file(fo4, 'cover')]);
  assert.equal(a, b);
  assert.equal(fs.readFileSync(a, 'utf8'), 'jpegdata');
  assert.equal(calls.length, 1, 'one download for two simultaneous asks');
  assert.match(calls[0], /steam\/apps\/377160\/library_600x900\.jpg$/);
  await cache.file(fo4, 'cover');
  assert.equal(calls.length, 1, 'cached after that');

  assert.equal(await cache.file(fo4, 'hero'), null);
  assert.match(calls[2], /IStoreBrowseService/, 'a 404 asks the store API once');
  await cache.file(fo4, 'hero');
  assert.equal(calls.length, 3, 'a missing hero is remembered, not re-requested');
  assert.equal(await cache.file(fo4, 'thumbnail'), null);
});
