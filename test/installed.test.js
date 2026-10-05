'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseVdf, steamLibraries, steamApp, epicApp, gogApps, findExe, nameLike, InstalledGames, launchFor,
} = require('../src/main/installed');
const { Controller } = require('../src/main/controller');

const PACKS = path.join(__dirname, '..', 'packs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'keystone-inst-'));

const LIBRARY_VDF = `
"libraryfolders"
{
  "0"
  {
    "path"    "C:\\\\Program Files (x86)\\\\Steam"
    "apps" { "228980" "1" }
  }
  "1"
  {
    "path"    "D:\\\\SteamLibrary"
    "apps" { "377160" "29000000000" }
  }
}`;

const ACF = `
"AppState"
{
  "appid"   "377160"
  "name"    "Fallout 4"
  "installdir"  "Fallout 4"
  "StateFlags"  "4"
}`;

test('VDF parser reads nested keys and escaped backslashes', () => {
  const v = parseVdf(LIBRARY_VDF);
  assert.equal(v.libraryfolders['1'].path, 'D:\\SteamLibrary');
  assert.equal(v.libraryfolders['1'].apps['377160'], '29000000000');
  assert.deepEqual(steamLibraries(LIBRARY_VDF), ['C:\\Program Files (x86)\\Steam', 'D:\\SteamLibrary']);
  // The old format listed libraries as plain "1" "D:\\Games" pairs.
  assert.deepEqual(steamLibraries('"LibraryFolders" { "TimeNextStatsReport" "1" "1" "E:\\\\Games" }'), ['E:\\Games']);
});

test('Steam app manifests become install records', () => {
  const app = steamApp(ACF, 'D:\\SteamLibrary');
  assert.equal(app.store, 'steam');
  assert.equal(app.id, '377160');
  assert.equal(app.name, 'Fallout 4');
  assert.ok(app.path.endsWith(path.win32.join('steamapps', 'common', 'Fallout 4')));
  assert.equal(steamApp('"AppState" { "name" "x" }', 'D:\\'), null);
});

test('Epic manifests: full launch id when the catalog ids are there, skip half-installs', () => {
  const app = epicApp({
    AppName: 'Tamarind', DisplayName: 'Far Cry 6', InstallLocation: 'C:\\Games\\FarCry6',
    LaunchExecutable: 'bin/FarCry6.exe', CatalogNamespace: 'ns1', CatalogItemId: 'item9',
  });
  assert.equal(app.exe, 'FarCry6.exe');
  assert.equal(app.launchId, 'ns1:item9:Tamarind');
  assert.equal(launchFor(app).uri, 'com.epicgames.launcher://apps/ns1%3Aitem9%3ATamarind?action=launch&silent=true');
  assert.equal(epicApp({ AppName: 'x', InstallLocation: 'C:\\x', bIsIncompleteInstall: true }), null);
});

test('GOG registry output becomes install records with a runnable exe', () => {
  const reg = [
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\Games',
    '',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1454587428',
    '    gameID    REG_SZ    1454587428',
    '    gameName    REG_SZ    Fallout: New Vegas Ultimate Edition',
    '    path    REG_SZ    C:\\GOG Games\\Fallout New Vegas',
    '    exe    REG_SZ    C:\\GOG Games\\Fallout New Vegas\\FalloutNV.exe',
    '',
  ].join('\r\n');
  const [g, ...rest] = gogApps(reg);
  assert.equal(rest.length, 0);
  assert.equal(g.name, 'Fallout: New Vegas Ultimate Edition');
  assert.equal(g.exe, 'FalloutNV.exe');
  assert.deepEqual(launchFor(g), { kind: 'path', path: 'C:\\GOG Games\\Fallout New Vegas\\FalloutNV.exe' });
});

test('findExe looks a few folders deep and skips redistributables', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'ShooterGame', 'Binaries', 'Win64'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ShooterGame', 'Binaries', 'Win64', 'ArkAscended.exe'), '');
  fs.mkdirSync(path.join(dir, '_CommonRedist'), { recursive: true });
  fs.writeFileSync(path.join(dir, '_CommonRedist', 'Other.exe'), '');
  assert.ok((await findExe(dir, 'arkascended.exe')).endsWith('ArkAscended.exe'));
  assert.equal(await findExe(dir, 'Other.exe'), null);
  assert.equal(await findExe(dir, 'ArkAscended.exe', 1), null);
});

test('name matching is loose enough for folder names, strict enough to skip other games', () => {
  assert.equal(nameLike('LEGO Batman: The Videogame', 'LEGOBatman'), true);
  assert.equal(nameLike('ARK: Survival Ascended', 'ARK Survival Ascended'), true);
  assert.equal(nameLike('Fallout 4', 'Fallout 76'), false);
  assert.equal(nameLike('Phasmophobia', 'Lethal Company'), false);
});

test('packs match installs by Steam id, then exe name, then exe on disk', async () => {
  const gogDir = tmp();
  fs.mkdirSync(path.join(gogDir, 'bin'));
  fs.writeFileSync(path.join(gogDir, 'bin', 'Phasmophobia.exe'), '');
  const inst = new InstalledGames({
    scanners: [
      async () => [{ store: 'steam', id: '377160', name: 'Fallout 4', path: 'D:\\x' }],
      async () => [{ store: 'epic', id: 'Tam', name: 'Far Cry 6', path: 'C:\\fc6', exe: 'FarCry6.exe' }],
      async () => [{ store: 'gog', id: '9', name: 'Phasmophobia', path: gogDir, exe: null }],
      async () => { throw new Error('a broken scanner never breaks the others'); },
    ],
  });
  const packs = [
    { id: 'fo4', name: 'Fallout 4', exe: ['fallout4.exe'], art: { steamAppId: 377160 } },
    { id: 'fc6', name: 'Far Cry 6', exe: ['farcry6.exe'] },
    { id: 'phas', name: 'Phasmophobia', exe: ['phasmophobia.exe'] },
    { id: 'none', name: 'Not Installed', exe: ['nope.exe'] },
  ];
  const hits = await inst.match(packs);
  assert.equal(hits.get('fo4').store, 'steam');
  assert.equal(hits.get('fc6').store, 'epic');
  assert.equal(hits.get('phas').store, 'gog');
  assert.ok(hits.get('phas').exePath.endsWith('Phasmophobia.exe'));
  assert.equal(hits.has('none'), false);
  assert.deepEqual(launchFor(hits.get('fo4')), { kind: 'uri', uri: 'steam://rungameid/377160' });
  assert.equal(launchFor(null), null);
});

test('scan results are cached so the library can refresh often', async () => {
  let calls = 0;
  const inst = new InstalledGames({ scanners: [async () => { calls++; return []; }] });
  await inst.list();
  await inst.list();
  assert.equal(calls, 1);
  await inst.list({ maxAgeMs: 0 });
  assert.equal(calls, 2);
});

function ctl(scanned = [], running = []) {
  const c = new Controller({ packsDir: PACKS, dataDir: tmp(), installed: { scanners: [async () => scanned] } });
  c.listProcesses = () => running;
  return c;
}

test('library marks installed games, sorts them first and lets Play start them', async () => {
  const c = ctl([{ store: 'steam', id: '377160', name: 'Fallout 4', path: 'D:\\Fallout 4' }]);
  const games = await c.listGamesWithInstalled();
  const fo4 = games.find((g) => g.id === 'fallout-4');
  assert.deepEqual(fo4.installed, { store: 'steam', path: 'D:\\Fallout 4' });
  assert.equal(fo4.canLaunch, true);
  assert.equal(games[0].id, 'fallout-4');
  assert.equal(games.find((g) => g.id === 'ark-survival-ascended').installed, null);
  assert.equal(games[games.length - 1].id, 'demo');
  c.shutdown();
});

test('auto-attach waits out the grace period, then attaches', () => {
  const procs = [];
  const c = ctl([], procs);
  assert.equal(c.autoAttachTick({ now: 0 }), null);
  procs.push({ pid: 4242, name: 'Fallout4.exe' });
  assert.equal(c.autoAttachTick({ now: 1000 }), null); // just seen
  assert.equal(c.autoAttachTick({ now: 3000 }), null); // still in grace
  const res = c.autoAttachTick({ now: 5500 });
  assert.equal(res.game, 'Fallout 4');
  assert.equal(c.game.pid, 4242);
  assert.equal(c.game.offline, false);
  // Already attached: nothing more to do.
  assert.equal(c.autoAttachTick({ now: 9000 }), null);
  c.shutdown();
});

test('auto-attach never switches away from the open game, and respects a manual detach', () => {
  const procs = [{ pid: 7, name: 'Fallout4.exe' }];
  const c = ctl([], procs);
  // ARK picked from the library while not running.
  c.attach({ packId: 'ark-survival-ascended' });
  c.autoAttachTick({ now: 0 });
  assert.equal(c.autoAttachTick({ now: 10_000 }), null);
  assert.equal(c.game.name.toLowerCase(), 'arkascended.exe');

  // Fallout 4 picked by hand, then detached by hand: left alone.
  c.attach({ packId: 'fallout-4' });
  c.detach();
  c.autoAttachTick({ now: 20_000 });
  assert.equal(c.autoAttachTick({ now: 30_000 }), null);
  assert.equal(c.game, null);

  // It restarts with a new pid: picked up again.
  procs[0] = { pid: 8, name: 'Fallout4.exe' };
  c.autoAttachTick({ now: 40_000 });
  assert.equal(c.autoAttachTick({ now: 50_000 }).game, 'Fallout 4');
  c.shutdown();
});

test('Play uses the installed copy before the pack\'s Steam app (other editions, other stores)', async () => {
  const c = ctl([{ store: 'gog', id: '1', name: 'Fallout 4 GOTY', path: 'C:\\GOG\\Fallout 4', exe: 'Fallout4.exe', exePath: 'C:\\GOG\\Fallout 4\\Fallout4.exe' }]);
  assert.deepEqual(await c.launchTarget('fallout-4'), { kind: 'path', path: 'C:\\GOG\\Fallout 4\\Fallout4.exe' });
  const none = ctl([]);
  assert.deepEqual(await none.launchTarget('fallout-4'), { kind: 'uri', uri: 'steam://rungameid/377160' }, 'not found installed: the pack\'s Steam app');
  c.shutdown();
  none.shutdown();
});
