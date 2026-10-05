'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ArtCache } = require('../src/main/art');

const pack = (appId) => ({ id: 'g', folder: '/nowhere', art: { steamAppId: appId } });
const jpg = Buffer.from('fake jpeg');
const reply = (status, body) => ({ ok: status === 200, status, arrayBuffer: async () => body, json: async () => body });

function cache(routes) {
  const asked = [];
  const now = { t: 1_000_000_000_000 };
  const art = new ArtCache({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'keystone-art-')),
    now: () => now.t,
    fetchImpl: async (url) => {
      asked.push(url);
      for (const [match, res] of routes) if (url.includes(match)) return typeof res === 'function' ? res() : res;
      return reply(404);
    },
  });
  return { art, asked, now };
}

test('classic Steam art is used when it exists', async () => {
  const { art, asked } = cache([['/1551360/library_600x900.jpg', reply(200, jpg)]]);
  const f = await art.file(pack(1551360), 'cover');
  assert.equal(fs.readFileSync(f, 'utf8'), 'fake jpeg');
  assert.equal(asked.length, 1);
  await art.file(pack(1551360), 'cover');
  assert.equal(asked.length, 1, 'cached');
});

test('new games: a 404 asks the store API for the hashed file', async () => {
  const assets = { asset_url_format: 'steam/apps/2483190/${FILENAME}?t=1', library_capsule: `${'a'.repeat(40)}/library_capsule.jpg`, library_hero: `${'b'.repeat(40)}/library_hero.jpg` };
  const { art, asked } = cache([
    ['IStoreBrowseService', reply(200, { response: { store_items: [{ assets }] } })],
    [`store_item_assets/steam/apps/2483190/${'a'.repeat(40)}/library_capsule.jpg`, reply(200, jpg)],
  ]);
  assert.ok(await art.file(pack(2483190), 'cover'));
  assert.equal(asked[2], `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2483190/${'a'.repeat(40)}/library_capsule.jpg?t=1`);
});

test('the store reply can only point at that game\'s own folder', async () => {
  const assets = { asset_url_format: 'steam/apps/999/${FILENAME}', library_capsule: `${'a'.repeat(40)}/library_capsule.jpg` };
  const { art, asked } = cache([['IStoreBrowseService', reply(200, { response: { store_items: [{ assets }] } })]]);
  assert.equal(await art.file(pack(2483190), 'cover'), null);
  assert.equal(asked.length, 2, 'no download from another app\'s folder');
});

test('no art anywhere is remembered for two weeks, then asked again', async () => {
  const { art, asked, now } = cache([]);
  assert.equal(await art.file(pack(42), 'hero'), null);
  const n = asked.length;
  assert.equal(await art.file(pack(42), 'hero'), null);
  assert.equal(asked.length, n);
  // The marker's age is its file time, so move that back instead of the clock.
  const marker = path.join(art.dir, '42-hero.jpg.missing');
  const old = new Date(Date.now() - 15 * 24 * 3600 * 1000);
  fs.utimesSync(marker, old, old);
  now.t = Date.now();
  await art.file(pack(42), 'hero');
  assert.ok(asked.length > n);
});

test('offline: nothing is remembered as missing', async () => {
  const { art } = cache([['steamstatic', () => { throw new Error('offline'); }]]);
  assert.equal(await art.file(pack(7), 'cover'), null);
  assert.ok(!fs.existsSync(path.join(art.dir, '7-cover.jpg.missing')));
});
