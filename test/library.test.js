'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Controller } = require('../src/main/controller');

const PACKS = path.join(__dirname, '..', 'packs');
const cleanups = [];
test.after(async () => { for (const fn of cleanups.reverse()) await fn(); });

function asa() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keystone-lib-'));
  const c = new Controller({ packsDir: PACKS, dataDir });
  cleanups.push(() => c.shutdown());
  c.attach({ packId: 'ark-survival-ascended' });
  return { c, dataDir };
}

test('library info lists sections, pack guides, links and the user guides folder', () => {
  const { c, dataDir } = asa();
  const info = c.library.info();
  assert.equal(info.available, true);
  assert.deepEqual(info.sections.map((s) => s.id), ['creatures', 'items']);
  assert.ok(info.guides.length >= 4);
  assert.equal(info.guides[0].title, 'Admin command cheat sheet');
  assert.ok(info.guides.every((g) => g.source === 'pack'));
  assert.ok(info.links.every((l) => l.url.startsWith('https://')));
  assert.equal(info.userGuidesDir, path.join(dataDir, 'guides', 'ark-survival-ascended'));
});

test('entry pages carry IDs, a wiki link, command shortcuts and notes', () => {
  const { c } = asa();
  const rex = c.library.entry('creatures', 'Rex_Character_BP_C');
  assert.equal(rex.name, 'Rex');
  assert.equal(rex.wikiUrl, 'https://ark.wiki.gg/wiki/Rex');
  assert.deepEqual(rex.commandActions.map((a) => a.id), ['summon-tamed', 'summon-wild']);
  const alpha = c.library.entries('creatures').find((x) => x.name === 'Alpha T-Rex');
  assert.equal(c.library.entry('creatures', alpha.id).wikiUrl, 'https://ark.wiki.gg/wiki/Alpha_T-Rex');

  c.library.setNote('creatures', rex.id, 'Mutton or raw prime works best');
  assert.equal(c.library.entry('creatures', rex.id).note, 'Mutton or raw prime works best');
  c.library.setNote('creatures', rex.id, '   ');
  assert.equal(c.library.entry('creatures', rex.id).note, '', 'blank notes are removed');
  assert.throws(() => c.library.entry('creatures', 'Nope_C'), /isn.t in the list/);
});

test('guides render to HTML with raw HTML escaped and only http(s) links', () => {
  const { c } = asa();
  const dir = c.library.userGuidesDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mine.md'), [
    '# My taming notes',
    '',
    'Hello <script>alert(1)</script> <img src=x onerror=alert(1)>',
    '',
    '[good](https://ark.wiki.gg) [bad](javascript:alert(1)) [file](file:///C:/x)',
    '',
    '![pic](https://example.com/a.png)',
  ].join('\n'));
  const g = c.library.guideList().find((x) => x.source === 'mine');
  assert.equal(g.title, 'My taming notes');
  const { html } = c.library.guide(g.id);
  // No live tags. The escaped text may still spell "onerror=", harmlessly.
  assert.doesNotMatch(html, /<script|<img/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /<a href="https:\/\/ark\.wiki\.gg" data-external="1">good<\/a>/);
  assert.doesNotMatch(html, /javascript:|file:/);
  assert.match(html, /<a href="https:\/\/example\.com\/a\.png" data-external="1">pic<\/a>/, 'images become links');
});

test('guide ids cannot escape the guides folders', () => {
  const { c } = asa();
  for (const bad of ['pack:../pack.json', 'pack:..\\pack.json', 'mine:../../settings.json', 'other:01-admin-commands.md', 'pack:', 'pack:notes.txt']) {
    assert.throws(() => c.library.guide(bad), /doesn.t exist/, bad);
  }
  assert.ok(c.library.guide('pack:01-admin-commands.md').html.includes('<h1>'));
});

test('search ranks exact and prefix matches first and includes guides', () => {
  const { c } = asa();
  const hits = c.library.search('rex');
  assert.equal(hits[0].title, 'Rex');
  assert.equal(hits[0].kind, 'entry');
  assert.ok(c.library.search('rcon').some((h) => h.kind === 'guide'));
  assert.deepEqual(c.library.search('r'), [], 'needs two letters');
  assert.ok(c.library.search('metal ingot').some((h) => h.catalog === 'items'));
});

test('games without a library still get a guides section for your own notes', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keystone-lib-'));
  const c = new Controller({ packsDir: PACKS, dataDir });
  cleanups.push(() => c.shutdown());
  c.attach({ demo: true });
  const info = c.library.info();
  assert.equal(info.available, true);
  assert.deepEqual(info.sections, []);
  assert.equal(c.library.info().guides.length, 0);
});
