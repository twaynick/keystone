'use strict';

// Checks every bundled game pack the same way, so a new pack can't ship
// with a command that won't build, a catalog with duplicate IDs, or a
// picture source Keystone would refuse.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadPacks } = require('../src/main/packs');
const { Controller } = require('../src/main/controller');
const { LibraryImages, candidates } = require('../src/main/library-images');

const PACKS = path.join(__dirname, '..', 'packs');
const packs = loadPacks([PACKS]);

// Values for fields that have no default, the way a person would fill them.
function sample(fields = []) {
  const v = {};
  for (const f of fields) {
    if (f.default !== undefined) continue;
    if (f.type === 'choice') v[f.key] = f.options[0].value;
    else if (f.type === 'text') v[f.key] = f.pattern && /0-9/.test(f.pattern) ? '123456' : 'test';
    else if (f.type === 'number') v[f.key] = f.min ?? 1;
  }
  return v;
}

test('every pack loads without errors and names its executable', () => {
  assert.ok(packs.length >= 4);
  for (const p of packs) {
    assert.equal(p.error, undefined, `${p.id}: ${p.error}`);
    assert.ok(p.exe.length, `${p.id} has no exe`);
    assert.ok(p.exe.every((e) => /^[\w .()'-]+\.exe$/i.test(e)), `${p.id} exe names`);
  }
  const exes = packs.flatMap((p) => p.exe);
  assert.equal(new Set(exes).size, exes.length, 'two packs claim the same exe');
});

for (const p of packs) {
  test(`${p.id}: catalogs, commands, Library and checklists hold together`, () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `keystone-pack-${p.id}-`));
    const c = new Controller({ packsDir: PACKS, dataDir });
    c.listProcesses = () => [];
    c.attach({ packId: p.id });

    const catalogs = { ...(p.commands?.catalogs || {}), ...(p.library?.catalogs || {}) };
    for (const name of Object.keys(catalogs)) {
      const list = c.library.entries(name);
      assert.ok(list.length > 0, `${p.id}/${name} is empty`);
      const ids = list.map((e) => e.id);
      assert.equal(new Set(ids).size, ids.length, `${p.id}/${name} has duplicate IDs`);
      for (const e of list) {
        assert.ok(e.name && typeof e.name === 'string' && !/^File:/i.test(e.name), `${p.id}/${name}: bad name ${JSON.stringify(e.name)}`);
        assert.ok(!/["\r\n]/.test(e.id), `${p.id}/${name}: ${e.name} has an ID commands can't use`);
      }
    }

    if (p.commands) {
      for (const a of p.commands.actions || []) {
        const entry = a.catalog ? c.library.entries(a.catalog)[0] : null;
        const built = c.commands.build('action', a.id, { entryId: entry?.id, values: sample(a.fields) });
        assert.ok(built.lines.length && built.lines.every((l) => l.length < 300), `${p.id}/${a.id}`);
      }
      for (const q of p.commands.quick || []) {
        const built = c.commands.build('quick', q.id, { values: sample(q.fields) });
        assert.ok(built.lines[0].trim(), `${p.id}/${q.id} builds an empty command`);
      }
    }

    if (p.library?.images) {
      assert.ok(LibraryImages.valid(p.library.images), `${p.id}: picture source must be https`);
      for (const name of Object.keys(p.library.images.catalogs || {})) {
        const e = c.library.entries(name)[0];
        assert.ok(candidates(p.library.images, name, 'thumb', e).length > 0, `${p.id}/${name}: no picture candidates`);
      }
    }

    for (const l of c.overlay.checklists()) assert.ok(l.items.length > 0 && l.items.every((i) => i.text), `${p.id}: checklist ${l.name}`);
    for (const g of c.library.guideList()) assert.ok(c.library.guide(g.id).html.length > 100, `${p.id}: guide ${g.id}`);
    c.shutdown();
  });
}

test('Forza: Motorsport is online-only, the Horizons are offline-only, and car facts read right', () => {
  const byId = Object.fromEntries(packs.map((p) => [p.id, p]));
  // Motorsport needs a connection for any progression, so no mods at all.
  assert.equal(byId['forza-motorsport'].memory, false);
  for (const id of ['forza-horizon-4', 'forza-horizon-5', 'forza-horizon-6']) {
    assert.equal(byId[id].memory, true, id);
    assert.equal(byId[id].offlineOnly, true, id);
    assert.match(byId[id].offlineNote, /syncs/, `${id} warns that progress syncs`);
  }
  const car = (id, name) => {
    const list = JSON.parse(fs.readFileSync(path.join(PACKS, id, 'cars.json'), 'utf8'));
    const c = list.find((x) => x.name === name);
    assert.ok(c, `${id}: ${name}`);
    return { ...c, f: Object.fromEntries(c.facts) };
  };
  // The wiki's "aus" is Austria; Australia is "ast"/"oz".
  assert.equal(car('forza-horizon-5', '2013 KTM X-Bow R').f.Country, 'Austria');
  assert.equal(car('forza-horizon-5', '1977 Holden Torana A9X').f.Country, 'Australia');
  // Horizon 6 bands sit 100 lower than Horizon 5's.
  assert.equal(car('forza-horizon-5', '2013 KTM X-Bow R').f.Class, 'S1 802');
  assert.match(car('forza-horizon-6', '2018 KTM X-Bow GT4').f.Class, /^S1 7\d\d$/);
  assert.match(car('forza-motorsport', '2013 KTM X-Bow R').f.Class, /^A 6\d\d$/);
  // Unlocks come out as the wiki words them, details filled in.
  assert.equal(car('forza-horizon-6', '1981 BMW M1').f['How to get it'], 'Treasure Car: North Hokubu');
  // A bar inside <nowiki> is part of the name.
  car('forza-horizon-5', '2022 Extreme E #55 ACCIONA / Sainz XE Team');
  // Horizon 4's own car-select picture first.
  const fh4 = byId['forza-horizon-4'];
  assert.equal(candidates(fh4.library.images, 'cars', 'thumb', car('forza-horizon-4', '1968 Abarth 595 esseesse'))[0], 'File:HOR_XB1_Abarth_595.png');
});
