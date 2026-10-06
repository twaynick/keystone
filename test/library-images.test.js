'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { LibraryImages, nameVariants, candidates, spawnCandidates, mimeOf } = require('../src/main/library-images');
const { Controller } = require('../src/main/controller');

const PACKS = path.join(__dirname, '..', 'packs');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'keystone-libimg-'));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const SPEC = {
  source: 'https://wiki.example/wiki/Special:FilePath/',
  catalogs: { creatures: { thumb: ['{name}.png'], hero: ['Dossier_{name}.png', '{name}.png'], spawnMaps: true } },
  dropPrefixes: ['Abyssal', 'Alpha', 'X-'],
  spawnMaps: [{ name: 'The Island', map: 'The_Island_Map.jpg', overlay: 'Spawning_{name}_The_Island.svg' }],
};

// A fake wiki: knows some files, counts requests.
function fakeWiki(files) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, ua: opts?.headers?.['User-Agent'] });
    const name = decodeURIComponent(url.split('/').pop().split('?')[0]);
    if (files[name] === 'offline') throw new Error('ENOTFOUND');
    if (files[name] === 'html') return { ok: true, status: 200, headers: { get: () => 'text/html' }, arrayBuffer: async () => Buffer.from('<html>') };
    if (!files[name]) return { ok: false, status: 404, headers: { get: () => 'text/html' } };
    return { ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => files[name] };
  };
  return { fetchImpl, calls };
}

test('name variants: suffixes, recipes and variant prefixes fall back to the base name', () => {
  assert.deepEqual(nameVariants('Abyssal Rex', SPEC.dropPrefixes), ['Abyssal Rex', 'Rex']);
  assert.deepEqual(nameVariants('Cymathoa (Alpha)', SPEC.dropPrefixes), ['Cymathoa (Alpha)', 'Cymathoa']);
  assert.deepEqual(nameVariants('Rockwell Recipes: Energy Brew'), ['Rockwell Recipes: Energy Brew', 'Energy Brew']);
  assert.deepEqual(nameVariants('X-Rex', SPEC.dropPrefixes), ['X-Rex', 'Rex']);
  assert.deepEqual(nameVariants('Alphabet Soup', SPEC.dropPrefixes), ['Alphabet Soup'], 'only whole-word prefixes');
});

test('candidates try templates first, then variants, with wiki underscores', () => {
  assert.deepEqual(candidates(SPEC, 'creatures', 'hero', 'Alpha Raptor'), ['Dossier_Alpha_Raptor.png', 'Dossier_Raptor.png', 'Alpha_Raptor.png', 'Raptor.png']);
  assert.deepEqual(candidates(SPEC, 'items', 'thumb', 'Stone'), [], 'catalog without pictures');
  assert.deepEqual(spawnCandidates(SPEC, 0, 'Abyssal Rex'), ['Spawning_Abyssal_Rex_The_Island.svg', 'Spawning_Rex_The_Island.svg']);
  assert.deepEqual(spawnCandidates(SPEC, 5, 'Rex'), []);
});

test('downloads once, caches, falls back on 404 and remembers what is missing', async () => {
  const dir = tmpDir();
  const wiki = fakeWiki({ 'Raptor.png': PNG });
  const imgs = new LibraryImages({ dataDir: dir, fetchImpl: wiki.fetchImpl, userAgent: 'Keystone/test' });
  const files = candidates(SPEC, 'creatures', 'hero', 'Alpha Raptor');
  const f = await imgs.first(SPEC, files, 720);
  assert.ok(f && fs.readFileSync(f).equals(PNG));
  assert.equal(wiki.calls.length, 4, 'three misses, then the icon');
  assert.match(wiki.calls[0].url, /Dossier_Alpha_Raptor\.png\?width=720$/);
  assert.equal(wiki.calls[0].ua, 'Keystone/test');
  await imgs.first(SPEC, files, 720);
  assert.equal(wiki.calls.length, 4, 'second look: all from disk (files and missing markers)');
});

test('missing pictures are asked for again after two weeks', async () => {
  let now = 1e12;
  const wiki = fakeWiki({});
  const imgs = new LibraryImages({ dataDir: tmpDir(), fetchImpl: wiki.fetchImpl, now: () => now });
  assert.equal(await imgs.file(SPEC, 'Nope.png', 96), null);
  assert.equal(await imgs.file(SPEC, 'Nope.png', 96), null);
  assert.equal(wiki.calls.length, 1);
  now += 15 * 24 * 3600 * 1000;
  await imgs.file(SPEC, 'Nope.png', 96);
  assert.equal(wiki.calls.length, 2);
});

test('offline and non-image answers leave no marker and no file', async () => {
  const wiki = fakeWiki({ 'A.png': 'offline', 'B.png': 'html' });
  const imgs = new LibraryImages({ dataDir: tmpDir(), fetchImpl: wiki.fetchImpl });
  assert.equal(await imgs.file(SPEC, 'A.png', 96), null);
  assert.equal(await imgs.file(SPEC, 'A.png', 96), null);
  assert.equal(await imgs.file(SPEC, 'B.png', 96), null);
  assert.equal(wiki.calls.length, 3, 'offline is retried next time');
});

test('spawn overlays are fetched full size; only https sources are used', async () => {
  const wiki = fakeWiki({ 'Spawning_Rex_The_Island.svg': Buffer.from('<?xml version="1.0"?><svg/>') });
  const imgs = new LibraryImages({ dataDir: tmpDir(), fetchImpl: wiki.fetchImpl });
  const f = await imgs.first(SPEC, spawnCandidates(SPEC, 0, 'Rex'), null);
  assert.ok(f);
  assert.doesNotMatch(wiki.calls[0].url, /width=/);
  assert.equal(mimeOf(fs.readFileSync(f)), 'image/svg+xml');
  assert.equal(mimeOf(PNG), 'image/png');
  assert.equal(await imgs.first({ ...SPEC, source: 'http://wiki.example/' }, ['Rex.png'], 96), null);
});

test('at most four downloads run at once', async () => {
  let active = 0;
  let peak = 0;
  const fetchImpl = async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 10));
    active--;
    return { ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => PNG };
  };
  const imgs = new LibraryImages({ dataDir: tmpDir(), fetchImpl });
  await Promise.all(Array.from({ length: 12 }, (_, i) => imgs.file(SPEC, `F${i}.png`, 96)));
  assert.equal(peak, 4);
});

test('ARK Library: sections and entries say what pictures they have; files come by entry id only', async () => {
  const dataDir = tmpDir();
  const c = new Controller({ packsDir: PACKS, dataDir });
  c.listProcesses = () => [];
  const wiki = fakeWiki({ 'Dossier_Rex.png': PNG });
  c.library.images = new LibraryImages({ dataDir, fetchImpl: wiki.fetchImpl });
  c.attach({ packId: 'ark-survival-ascended' });
  const sec = c.library.info().sections.find((s) => s.catalog === 'creatures');
  assert.equal(sec.pictures.thumb, true);
  assert.ok(sec.pictures.spawnMaps.length >= 5);
  assert.match(sec.pictures.credit, /ARK/);
  const rex = c.library.entries('creatures').find((e) => e.name === 'Rex');
  assert.equal(c.library.entry('creatures', rex.id).pictures.hero, true);
  assert.ok(await c.library.pictureFile('hero', 'creatures', rex.id));
  assert.match(wiki.calls[0].url, /^https:\/\/ark\.wiki\.gg\/wiki\/Special:FilePath\/Dossier_Rex\.png/);
  await assert.rejects(c.library.pictureFile('hero', 'creatures', '../../etc/passwd'), /isn.t in the list/);
  assert.equal(await c.library.pictureFile('evil', 'creatures', rex.id), null);
  // The Library grid's card sizes: dossiers for creatures, nothing to switch for items.
  assert.equal(sec.pictures.altStyle, 'Dossiers');
  assert.equal(c.library.info().sections.find((s) => s.catalog === 'items').pictures.altStyle, null);
  assert.ok(await c.library.pictureFile('carddossier', 'creatures', rex.id));
  assert.ok(wiki.calls.some((x) => /Dossier_Rex\.png\?width=240/.test(x.url)), 'card pictures come at card size');
  assert.equal(c.commands.info().thumbs.includes('creatures'), true);
  c.shutdown();
});

test('page-picture wikis: the page\'s main picture through the API, trying titles in order', async () => {
  const spec = { api: 'https://wiki.example/api.php', catalogs: { items: { thumb: ['{page}', '{name} (Fallout 4)', '{name}'] } } };
  assert.deepEqual(candidates(spec, 'items', 'thumb', { name: 'Psycho', page: '/wiki/Psycho_(Fallout_4)' }), ['Psycho_(Fallout_4)', 'Psycho_(Fallout_4)', 'Psycho'].filter((v, i, a) => a.indexOf(v) === i));
  assert.deepEqual(candidates(spec, 'items', 'thumb', { name: 'Jet' }), ['Jet_(Fallout_4)', 'Jet'], 'no page: {page} skipped');
  assert.deepEqual(candidates(spec, 'items', 'thumb', { name: 'X', page: 'https://evil/' }), ['X_(Fallout_4)', 'X'], 'only /wiki/ paths count as pages');
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.startsWith('https://wiki.example/api.php')) {
      const title = new URL(url).searchParams.get('titles');
      const pages = title === 'Jet' ? { 1: { title, thumbnail: { source: 'https://img.example/jet.png' } } } : { 2: { title } };
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, arrayBuffer: async () => Buffer.from(JSON.stringify({ query: { pages } })) };
    }
    return { ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => PNG };
  };
  const imgs = new LibraryImages({ dataDir: tmpDir(), fetchImpl });
  assert.equal(LibraryImages.valid(spec), true);
  assert.equal(LibraryImages.valid({ api: 'http://wiki.example/api.php' }), false);
  const f = await imgs.first(spec, candidates(spec, 'items', 'thumb', { name: 'Jet' }), 96);
  assert.ok(f);
  assert.match(calls[0], /titles=Jet\+%28Fallout\+4%29/);
  assert.match(calls[0], /pithumbsize=96/);
  assert.equal(calls[2], 'https://img.example/jet.png');
  await imgs.first(spec, candidates(spec, 'items', 'thumb', { name: 'Jet' }), 96);
  assert.equal(calls.length, 3, 'a page without a picture is remembered too');
});
