'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { TableStore, loadCatalog, parseTopicPage, unzipTables, safeName, topicId, CHECK_EVERY } = require('../src/main/table-store');
const { autoTables } = require('../src/main/tables');
const { loadPacks } = require('../src/main/packs');
const { Controller } = require('../src/main/controller');

const ROOT = path.join(__dirname, '..');
const PACKS = path.join(ROOT, 'packs');
const DEMO_CT = fs.readFileSync(path.join(PACKS, 'demo', 'demo.ct'));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'keystone-store-'));
const controllers = [];
test.after(() => { for (const c of controllers) c.shutdown(); });

const FAKE_PACKS = [
  { id: 'demo', name: 'Demo game' },
  { id: 'fallout-4', name: 'Fallout 4' },
  { id: 'far-cry-6', name: 'Far Cry 6', offlineOnly: true },
  { id: 'forza-motorsport', name: 'Forza Motorsport', memory: false },
];

function setup(tables, { now } = {}) {
  const dir = tmpDir();
  const catalogFile = path.join(dir, 'store.json');
  fs.writeFileSync(catalogFile, JSON.stringify({ sites: { 'fearlessrevolution.com': { name: 'FearLess', login: 'Log in' } }, tables }));
  const clock = { t: 1_000_000 };
  const store = new TableStore({
    catalogFile,
    dataDir: path.join(dir, 'data'),
    userTablesDir: path.join(dir, 'data', 'tables'),
    packs: () => FAKE_PACKS,
    now: now || (() => clock.t),
  });
  const file = (name, data) => { const f = path.join(dir, name); fs.writeFileSync(f, data); return f; };
  return { dir, store, clock, file, tablesDir: path.join(dir, 'data', 'tables') };
}

const FO4 = { id: 'fo4', pack: 'fallout-4', title: 'Fallout 4', url: 'https://fearlessrevolution.com/viewtopic.php?t=210' };
const FC6 = { id: 'fc6', pack: 'far-cry-6', title: 'Far Cry 6', url: 'https://fearlessrevolution.com/viewtopic.php?t=17719' };

// A minimal zip writer, so the reader is tested against real deflate data.
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let off = 0;
  for (const { name, data, store } of files) {
    const body = store ? data : zlib.deflateRawSync(data);
    const n = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(store ? 0 : 8, 8);
    lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(store ? 0 : 8, 10);
    ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, n, body);
    centrals.push(ch, n);
    off += 30 + n.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

function topicHtml({ loggedIn = true, author = 'Zanzer', files = [] } = {}) {
  const links = files.map(([id, name]) => `<dl class="file"><dt><a class="postlink" href="./download/file.php?id=${id}&amp;sid=abc">${name}</a></dt><dd>(12 KiB) Downloaded 9 times</dd></dl>`).join('');
  return `<html><head><title>Fallout 4 - FearLess Cheat Engine</title></head><body>
    <a href="./ucp.php?mode=${loggedIn ? 'logout' : 'login'}">x</a>
    <div id="p1001" class="post has-profile bg2"><p class="author"><a href="./memberlist.php?mode=viewprofile&amp;u=7" class="username-coloured">${author}</a></p>
      <div class="content">Table for 1.10</div>${links}</div>
    <div id="p1002" class="post bg1"><p class="author"><a class="username">someone</a></p>
      <a class="postlink" href="./download/file.php?id=999999">reply-upload.CT</a></div>
  </body></html>`;
}

// ---------- the real catalog ----------
test('store catalog: every table links a real, moddable pack on an https page', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'tables', 'store.json'), 'utf8'));
  const packs = loadPacks([PACKS]);
  const cat = loadCatalog(path.join(ROOT, 'tables', 'store.json'), packs);
  // Nothing in the file is silently dropped by validation.
  assert.equal(cat.tables.length, raw.tables.length);
  assert.ok(cat.tables.length >= 15);
  assert.equal(new Set(cat.tables.map((t) => t.id)).size, cat.tables.length);
  assert.equal(new Set(cat.tables.map((t) => t.topic)).size, cat.tables.length, 'one card per topic');
  for (const t of cat.tables) {
    assert.ok(t.topic, `${t.id} has a topic id`);
    assert.ok(cat.sites[t.host], `${t.id}: site ${t.host} has login help`);
  }
  assert.ok(!cat.tables.some((t) => t.packId === 'forza-motorsport'), 'online-only games get no tables');
});

test('store catalog: drops online-only games, unknown packs, bad links and duplicate ids', () => {
  const { store } = setup([
    FO4,
    { ...FO4 },
    { id: 'fm', pack: 'forza-motorsport', url: 'https://fearlessrevolution.com/viewtopic.php?t=1' },
    { id: 'nope', pack: 'not-a-pack', url: 'https://fearlessrevolution.com/viewtopic.php?t=2' },
    { id: 'http', pack: 'fallout-4', url: 'http://fearlessrevolution.com/viewtopic.php?t=3' },
    FC6,
  ]);
  const { tables } = store.catalog();
  assert.deepEqual(tables.map((t) => t.id), ['fo4', 'fc6']);
  assert.equal(tables[1].offlineOnly, true);
  assert.equal(tables[0].game, 'Fallout 4');
});

test('store: a download is matched to its table by the page it came from', () => {
  const { store, clock } = setup([FO4, FC6]);
  assert.equal(topicId('https://www.fearlessrevolution.com/viewtopic.php?f=4&t=210&start=30'), 'fearlessrevolution.com#210');
  assert.equal(store.entryForPage('https://fearlessrevolution.com/viewtopic.php?t=210&start=30').id, 'fo4');
  assert.equal(store.entryForPage('https://fearlessrevolution.com/viewtopic.php?t=17719').id, 'fc6');
  // Some other page with no card clicked: a normal download.
  assert.equal(store.entryForPage('https://fearlessrevolution.com/viewtopic.php?p=5555'), null);
  assert.equal(store.entryForPage('https://example.com/file'), null);
  // A link to one post (no topic in the address) after clicking a card.
  store.open('fc6');
  assert.equal(store.entryForPage('https://fearlessrevolution.com/viewtopic.php?p=5555').id, 'fc6');
  assert.equal(store.entryForPage('https://example.com/file'), null, 'other sites never match');
  clock.t += 3 * 60 * 60 * 1000;
  assert.equal(store.entryForPage('https://fearlessrevolution.com/viewtopic.php?p=5555'), null, 'the click is forgotten after a while');
  assert.throws(() => store.open('gone'), /isn’t in the store/);
});

// ---------- installing ----------
test('store install: a .CT lands in the game folder with credit, and loads by itself', () => {
  const { store, file, tablesDir } = setup([FO4]);
  assert.equal(store.status('fo4'), 'get');
  const res = store.install('fo4', { file: file('dl.tmp', DEMO_CT), fileName: 'Fallout4.CT', attachmentId: 500, author: 'Zanzer' });
  assert.equal(res.replaced, false);
  assert.deepEqual(res.files, [path.join(tablesDir, 'fallout-4', 'Fallout4.CT')]);
  assert.equal(store.status('fo4'), 'installed');
  const auto = autoTables({ bundledDir: null, userDir: tablesDir }, { id: 'fallout-4' }, null);
  assert.deepEqual(auto.map((t) => [t.name, t.author, t.url]), [['Fallout4', 'Zanzer', FO4.url]]);
  const listed = store.list().tables[0];
  assert.equal(listed.author, 'Zanzer');
  assert.equal(listed.installed.fileName, 'Fallout4.CT');
});

test('store install: an update replaces the old file even when the name changed', () => {
  const { store, file, tablesDir } = setup([FO4]);
  store.install('fo4', { file: file('a', DEMO_CT), fileName: 'FO4 v1.2.CT', attachmentId: 500 });
  // Your own table with the name the next version will have stays put.
  fs.writeFileSync(path.join(tablesDir, 'fallout-4', 'Mine.CT'), DEMO_CT);
  const res = store.install('fo4', { file: file('b', DEMO_CT), fileName: 'FO4 v1.3.CT', attachmentId: 600 });
  assert.equal(res.replaced, true);
  assert.deepEqual(fs.readdirSync(path.join(tablesDir, 'fallout-4')).sort(), ['FO4 v1.3.CT', 'Mine.CT', 'credits.json']);
  const credits = JSON.parse(fs.readFileSync(path.join(tablesDir, 'fallout-4', 'credits.json'), 'utf8'));
  assert.deepEqual(Object.keys(credits), ['FO4 v1.3.CT']);
  // A name clash with a file that isn't this table's gets a suffix instead of overwriting it.
  const clash = store.install('fo4', { file: file('c', DEMO_CT), fileName: 'Mine.CT', attachmentId: 700 });
  assert.equal(path.basename(clash.files[0]), 'Mine (fo4).CT');
  assert.equal(fs.readFileSync(path.join(tablesDir, 'fallout-4', 'Mine.CT')).equals(DEMO_CT), true);
});

test('store install: refuses files that are not cheat tables', () => {
  const { store, file, tablesDir } = setup([FO4]);
  assert.throws(() => store.install('fo4', { file: file('x', 'MZ...'), fileName: 'Trainer.exe' }), /isn't a \.CT or \.zip/);
  assert.throws(() => store.install('fo4', { file: file('y', '<html>nope</html>'), fileName: 'Fake.CT' }), /Cheat Engine table/);
  assert.throws(() => store.install('fo4', { file: file('z', makeZip([{ name: 'readme.txt', data: Buffer.from('hi') }])), fileName: 'pack.zip' }), /no Cheat Engine table/);
  assert.equal(fs.existsSync(path.join(tablesDir, 'fallout-4')), false, 'nothing written');
  assert.equal(store.status('fo4'), 'get');
});

test('zip: reads stored and deflated tables, skips the rest, and keeps names inside the folder', () => {
  const zip = makeZip([
    { name: 'Table/FC6.CT', data: DEMO_CT },
    { name: 'Old.ct', data: DEMO_CT, store: true },
    { name: '__MACOSX/Table/._FC6.CT', data: Buffer.from('junk') },
    { name: '../../evil.CT', data: DEMO_CT },
    { name: 'readme.txt', data: Buffer.from('read me') },
  ]);
  const out = unzipTables(zip);
  assert.deepEqual(out.map((x) => x.name), ['FC6.CT', 'Old.ct', 'evil.CT']);
  assert.ok(out.every((x) => x.data.equals(DEMO_CT)));
  assert.throws(() => unzipTables(Buffer.from('not a zip at all, really not')), /damaged/);
  assert.equal(safeName('..\\..\\Windows\\x.CT'), 'x.CT');
  assert.equal(safeName('a:b?.CT'), 'a_b_.CT');

  const { store, file, tablesDir } = setup([FC6]);
  const res = store.install('fc6', { file: file('dl', zip), fileName: 'FarCry6.zip', attachmentId: 9 });
  assert.equal(res.files.length, 3);
  assert.deepEqual(fs.readdirSync(path.join(tablesDir, 'far-cry-6')).sort(), ['FC6.CT', 'Old.ct', 'credits.json', 'evil.CT']);
});

test('store remove: deletes the files and their credits; deleting by hand counts too', () => {
  const { store, file, tablesDir } = setup([FO4, FC6]);
  store.install('fo4', { file: file('a', DEMO_CT), fileName: 'FO4.CT' });
  store.install('fc6', { file: file('b', DEMO_CT), fileName: 'FC6.CT' });
  assert.equal(store.remove('fo4'), true);
  assert.equal(store.status('fo4'), 'get');
  assert.deepEqual(fs.readdirSync(path.join(tablesDir, 'fallout-4')), ['credits.json']);
  assert.equal(store.remove('fo4'), false);
  fs.rmSync(path.join(tablesDir, 'far-cry-6', 'FC6.CT'));
  assert.equal(store.status('fc6'), 'get');
  assert.equal(store.list().tables.find((t) => t.id === 'fc6').installed, null);
});

// ---------- updates ----------
test('topic page: reads the author and the first post’s table files', () => {
  const page = parseTopicPage(topicHtml({ files: [[500, 'FO4 v1.2.CT'], [610, 'FO4 v1.3.zip'], [611, 'screenshot.png']] }));
  assert.equal(page.status, 'ok');
  assert.equal(page.author, 'Zanzer');
  // Replies' uploads don't count, and pictures aren't tables.
  assert.deepEqual(page.attachments, [{ id: 500, name: 'FO4 v1.2.CT' }, { id: 610, name: 'FO4 v1.3.zip' }]);

  assert.equal(parseTopicPage(topicHtml({ loggedIn: false })).status, 'login');
  assert.equal(parseTopicPage('<html><head><title>Just a moment...</title></head></html>').status, 'challenge');
  assert.equal(parseTopicPage('<html><head><title>Oops</title></head><body>error</body></html>').status, 'login');
  assert.equal(parseTopicPage('<a href="ucp.php?mode=logout"></a><title>Oops</title>').status, 'error');
});

test('store checks: an update is flagged, notified once, and cleared by installing it', () => {
  const { store, file, clock } = setup([FO4, FC6]);
  store.install('fo4', { file: file('a', DEMO_CT), fileName: 'FO4 v1.2.CT', attachmentId: 500 });
  assert.deepEqual(store.due(), ['fo4'], 'never checked: due');

  const same = parseTopicPage(topicHtml({ files: [[500, 'FO4 v1.2.CT']] }));
  assert.equal(store.checked('fo4', same), null);
  assert.equal(store.status('fo4'), 'installed');
  assert.deepEqual(store.due(), [], 'checked just now');
  assert.deepEqual(store.due(true), ['fo4'], 'Check for updates ignores the schedule');
  clock.t += CHECK_EVERY;
  assert.deepEqual(store.due(), ['fo4']);

  const newer = parseTopicPage(topicHtml({ files: [[500, 'FO4 v1.2.CT'], [610, 'FO4 v1.3.CT']] }));
  assert.equal(store.checked('fo4', newer).id, 'fo4', 'first sighting notifies');
  assert.equal(store.checked('fo4', newer), null, 'the same file never notifies twice');
  assert.equal(store.status('fo4'), 'update');
  const listed = store.list();
  assert.equal(listed.updates, 1);
  assert.equal(listed.tables[0].installed.latestName, 'FO4 v1.3.CT');

  store.install('fo4', { file: file('b', DEMO_CT), fileName: 'FO4 v1.3.CT', attachmentId: 610 });
  assert.equal(store.status('fo4'), 'installed');
  assert.equal(store.list().updates, 0);
});

test('store checks: a login wall or failed check changes nothing but the note', () => {
  const { store, file } = setup([FO4]);
  store.install('fo4', { file: file('a', DEMO_CT), fileName: 'FO4.CT', attachmentId: 500 });
  assert.equal(store.checked('fo4', { status: 'login' }), null);
  assert.equal(store.list().tables[0].installed.check, 'login');
  assert.equal(store.status('fo4'), 'installed');
  store.checked('fo4', { status: 'challenge' });
  assert.equal(store.list().tables[0].installed.check, 'challenge');
  assert.equal(store.checked('nothing-installed', { status: 'ok', attachments: [] }), null);
});

test('store checks: a download without a known file id is pinned at the first check', () => {
  const { store, file } = setup([FO4]);
  store.install('fo4', { file: file('a', DEMO_CT), fileName: 'FO4.CT' });
  assert.equal(store.checked('fo4', parseTopicPage(topicHtml({ files: [[500, 'FO4.CT']] }))), null);
  assert.equal(store.status('fo4'), 'installed');
  assert.equal(store.checked('fo4', parseTopicPage(topicHtml({ files: [[700, 'FO4 new.CT']] }))).id, 'fo4');
  assert.equal(store.status('fo4'), 'update');
});

test('store state survives a restart', () => {
  const { store, file, dir } = setup([FO4]);
  store.install('fo4', { file: file('a', DEMO_CT), fileName: 'FO4.CT', attachmentId: 5, author: 'Zanzer' });
  const again = new TableStore({ catalogFile: path.join(dir, 'store.json'), dataDir: path.join(dir, 'data'), userTablesDir: path.join(dir, 'data', 'tables'), packs: () => FAKE_PACKS });
  assert.equal(again.status('fo4'), 'installed');
  assert.equal(again.list().tables[0].author, 'Zanzer');
});

// ---------- with the app ----------
test('controller: a table installed for the open game loads straight away', () => {
  const { store, file, dir } = setup([{ id: 'demo-extra', pack: 'demo', title: 'Demo extras', url: 'https://fearlessrevolution.com/viewtopic.php?t=1' }]);
  const c = new Controller({ packsDir: PACKS, dataDir: path.join(dir, 'data') });
  controllers.push(c);
  c.attach({ demo: true });
  const before = c.snapshot().records.length;
  const res = store.install('demo-extra', { file: file('a', DEMO_CT), fileName: 'Extras.CT', author: 'Someone' });
  assert.equal(c.loadInstalledTables('fallout-4', res.files), false, 'only for the game that is open');
  assert.equal(c.loadInstalledTables('demo', res.files), true);
  const snap = c.snapshot();
  assert.ok(snap.records.length > before);
  assert.ok(snap.autoTables.some((t) => t.name === 'Extras' && t.author === 'Someone'));
});

// ---------- the Electron side, with stand-ins ----------
const { EventEmitter } = require('events');
const { TableFetcher } = require('../src/main/table-fetch');

function fakeItem(url, filename, content) {
  const item = new EventEmitter();
  item.getURL = () => url;
  item.getFilename = () => filename;
  item.setSavePath = (p) => { item.savePath = p; };
  item.finish = (state = 'completed') => { if (state === 'completed') fs.writeFileSync(item.savePath, content); item.emit('done', {}, state); };
  return item;
}

test('fetcher: a table downloaded from its page installs itself; other downloads are left alone', async () => {
  const { store, dir, tablesDir } = setup([FO4]);
  const session = new EventEmitter();
  const f = new TableFetcher({ store, session, BrowserWindow: null, partition: 'x', tmpDir: path.join(dir, 'tmp') });
  f.session.on('will-download', (_e, item, contents) => f._onDownload(item, contents));
  const page = (url, html = topicHtml({ author: 'Zanzer' })) => ({ getURL: () => url, executeJavaScript: async () => html });
  const events = [];
  f.on('installed', (r) => events.push(['installed', r.entry.id, r.files.map((x) => path.basename(x))]));
  f.on('notice', (t) => events.push(['notice', t]));

  // Unrelated download: no save path set, so Electron's own dialog handles it.
  const other = fakeItem('https://example.com/a.zip', 'a.zip', 'x');
  session.emit('will-download', {}, other, page('https://example.com/'));
  assert.equal(other.savePath, undefined);

  // A .rar from the table's page: explained, and left to the save dialog.
  const rar = fakeItem('https://fearlessrevolution.com/download/file.php?id=7', 'FO4.rar', 'x');
  session.emit('will-download', {}, rar, page(FO4.url));
  assert.equal(rar.savePath, undefined);
  assert.match(events.pop()[1], /FO4\.rar isn't a \.CT or \.zip/);

  const ct = fakeItem('https://fearlessrevolution.com/download/file.php?id=812&sid=1', 'FO4 v2.CT', DEMO_CT);
  session.emit('will-download', {}, ct, page(`${FO4.url}&start=15`));
  assert.ok(ct.savePath.startsWith(path.join(dir, 'tmp')));
  ct.finish();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(events.pop(), ['installed', 'fo4', ['FO4 v2.CT']]);
  assert.equal(fs.existsSync(ct.savePath), false, 'the temp copy is cleaned up');
  assert.ok(fs.existsSync(path.join(tablesDir, 'fallout-4', 'FO4 v2.CT')));
  const listed = store.list().tables[0];
  assert.equal(listed.author, 'Zanzer');
  assert.equal(store.data.installed.fo4.attachmentId, 812);

  // A cancelled download says so.
  const cancelled = fakeItem('https://fearlessrevolution.com/download/file.php?id=900', 'FO4 v3.CT', DEMO_CT);
  session.emit('will-download', {}, cancelled, page(FO4.url));
  cancelled.finish('cancelled');
  await new Promise((r) => setImmediate(r));
  assert.match(events.pop()[1], /didn't finish/);
});

test('fetcher: checks wait out a browser check, and report updates', async () => {
  const { store, file, dir } = setup([FO4]);
  store.install('fo4', { file: file('a', DEMO_CT), fileName: 'FO4.CT', attachmentId: 500 });
  const pages = ['<title>Just a moment...</title>', topicHtml({ files: [[500, 'FO4.CT'], [640, 'FO4 v2.CT']] })];
  let destroyed = 0;
  class FakeWindow {
    constructor(opts) {
      assert.equal(opts.show, false);
      assert.equal(opts.webPreferences.partition, 'persist:test', 'shares the browser’s logins');
      this.webContents = {
        setAudioMuted() {}, setWindowOpenHandler() {}, on() {}, isLoading: () => false,
        executeJavaScript: async () => pages.shift() || pages[0],
      };
    }
    async loadURL(u) { assert.equal(u, FO4.url); }
    isDestroyed() { return false; }
    destroy() { destroyed++; }
  }
  const f = new TableFetcher({ store, session: new EventEmitter(), BrowserWindow: FakeWindow, partition: 'persist:test', tmpDir: dir });
  const updates = [];
  f.on('update', (e) => updates.push(e.id));
  // Skip the 2-second waits between Cloudflare polls.
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn) => realSetTimeout(fn, 0);
  try {
    const both = [f.checkAll(true), f.checkAll(true)];
    assert.equal(both[0], both[1], 'one check at a time');
    assert.equal(await both[0], 1);
  } finally {
    global.setTimeout = realSetTimeout;
  }
  assert.deepEqual(updates, ['fo4']);
  assert.equal(destroyed, 1);
  assert.equal(store.status('fo4'), 'update');
});

// ---------- what works ----------
const { summarizeTable, describeSummary } = require('../src/main/table-store');

test('store: says how much of a table runs in Keystone', () => {
  const entry = (id, inner) => `<CheatEntry><ID>${id}</ID><Description>"E${id}"</Description>${inner}</CheatEntry>`;
  const aa = (body) => `<VariableType>Auto Assembler Script</VariableType><AssemblerScript>${body}</AssemblerScript>`;
  const ct = `<CheatTable><CheatEntries>
    ${entry(1, '<VariableType>4 Bytes</VariableType><Address>game.exe+10</Address>')}
    ${entry(2, '<VariableType>Float</VariableType><Address>game.exe+14</Address>')}
    ${entry(3, aa('[ENABLE]\ngame.exe+100:\nnop 2\n[DISABLE]\n'))}
    ${entry(4, aa('{$lua}\n[ENABLE]\nLaunchMonoDataCollector()\n[DISABLE]\n'))}
    ${entry(5, aa('[ENABLE]\ncreatethread(x)\n[DISABLE]\n'))}
    ${entry(6, '<VariableType>String</VariableType><Address>game.exe+20</Address>')}
  </CheatEntries><LuaScript>print(1)</LuaScript></CheatTable>`;
  const s = summarizeTable(ct);
  assert.deepEqual(s, { mods: 2, scripts: 1, needsCE: 2, types: 1, luaStartup: true });
  assert.equal(describeSummary(s), '2 mods and 1 script work in Keystone; 3 need Cheat Engine.');
  assert.equal(describeSummary({ mods: 0, scripts: 0, needsCE: 0, types: 0, luaStartup: true }), 'It makes its mods with Lua when it opens.');

  const { store, file, tablesDir } = setup([FO4]);
  const res = store.install('fo4', { file: file('a', ct), fileName: 'FO4.CT' });
  assert.deepEqual(res.summary, s);
  assert.deepEqual(store.list().tables[0].installed.summary, s);
  assert.deepEqual(store.files('fo4'), [path.join(tablesDir, 'fallout-4', 'FO4.CT')]);
  // An install from before summaries existed gets one when listed.
  delete store.data.installed.fo4.summary;
  assert.deepEqual(store.list().tables[0].installed.summary, s);
  assert.throws(() => store.files('nope'), /isn’t installed/);
});
