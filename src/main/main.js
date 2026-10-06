'use strict';

const { app, BrowserWindow, ipcMain, dialog, nativeTheme, shell, protocol, net, safeStorage, clipboard, Notification, globalShortcut, session } = require('electron');
const { pathToFileURL } = require('url');
const fs = require('fs');
const path = require('path');
const { Controller } = require('./controller');
const { Settings } = require('./settings');
const { Remote } = require('./remote');
const { OverlayWindow } = require('./overlay-window');
const { createTray } = require('./tray');
const { KeystoneBrowser, PARTITION } = require('./browser-window');
const { TableStore } = require('./table-store');
const { TableFetcher } = require('./table-fetch');
const { ArtCache } = require('./art');
const { Timers } = require('./timers');
const { LibraryImages, mimeOf } = require('./library-images');
const { HotkeyRegistry } = require('./hotkeys');
const { loadPacks } = require('./packs');

const ROOT = path.join(__dirname, '..', '..');
let controller = null; // created once app paths are ready (needs userData)
let remote = null;
let overlayWin = null;
let settings = null;
let timers = null;
let tray = null;
let browser = null;
let tableStore = null;
let tableFetch = null;
let art = null;
let hotkeyReg = null;
let quitting = false;

// One Keystone at a time: a second copy would fight the first over the
// overlay hotkeys and the phone remote's port. Launching again just brings
// the running one forward.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}
app.on('second-instance', () => showMain());

// Started by Windows at login (see setStartWithWindows): stay in the tray.
const startHidden = process.argv.includes('--hidden');

// The overlay is a full-screen window above everything, including Keystone's
// own main window. Chromium treats a covered window as hidden and stops
// painting it, so the app froze whenever the overlay was on. These switches
// keep every window rendering regardless of what's on top.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// Every <webview> (only Keystone's browser window makes them) is locked down
// before it attaches, and its pages can't open new windows or leave https.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (event, webPreferences, params) => KeystoneBrowser.hardenWebview(event, webPreferences, params));
  if (contents.getType() === 'webview') KeystoneBrowser.wireWebviewContents(contents);
});

// ksmap:// serves the selected game's map image to the overlay and the
// Overlay tab. A custom scheme keeps the pages' CSP tight ('self' + ksmap:)
// instead of opening file:// access to the whole disk.
protocol.registerSchemesAsPrivileged([
  { scheme: 'ksmap', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  // ksart://cover/<pack id> and ksart://hero/<pack id>: game art (see art.js).
  { scheme: 'ksart', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  // kslib://thumb|hero/<catalog>/<entry id>, kslib://spawn|spawnmap/<map #>/<catalog>/<entry id>:
  // Library pictures from the game's wiki (see library-images.js).
  { scheme: 'kslib', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
let mainWindow = null;

function createMainWindow() {
  nativeTheme.themeSource = 'dark';
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#0e1115',
    autoHideMenuBar: true,
    title: 'Keystone',
    icon: path.join(ROOT, 'assets', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));

  // Links in the UI open in the real browser, never inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.once('ready-to-show', () => { if (!startHidden) mainWindow.show(); });

  // Closing the window hides it to the tray (unless turned off in Settings),
  // so the overlay and phone remote keep working mid-game.
  mainWindow.on('close', (e) => {
    if (quitting || !settings.general.closeToTray) return;
    e.preventDefault();
    mainWindow.hide();
    if (!settings.general.trayHintShown && Notification.isSupported()) {
      new Notification({ title: 'Keystone is still running', body: 'It\u2019s in the system tray. Right-click the icon to quit.' }).show();
      settings.updateGeneral({ trayHintShown: true });
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    // The overlay and browser are windows too (the browser only hides when
    // closed); without closing them, closing the main window would leave
    // Keystone running with no way back in.
    overlayWin?.shutdown();
    browser?.shutdown();
  });
}

function showMain() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function quit() {
  quitting = true;
  app.quit();
}

// Windows "start at login". Only meaningful for the installed app: in dev,
// the login entry would launch bare Electron without Keystone.
function setStartWithWindows(on) {
  if (!app.isPackaged) throw new Error('Start with Windows works in the installed app, not when running from source.');
  app.setLoginItemSettings({ openAtLogin: Boolean(on), args: ['--hidden'] });
  settings.updateGeneral({ startWithWindows: Boolean(on) });
  return appSettings();
}

function appSettings() {
  return {
    ...settings.general,
    startWithWindows: app.isPackaged ? app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin : false,
    canStartWithWindows: app.isPackaged,
    version: app.getVersion(),
    dataDir: app.getPath('userData'),
  };
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function createController() {
  controller = new Controller({
    clipboard,
    packsDir: path.join(ROOT, 'packs'),
    dataDir: app.getPath('userData'),
    commands: {
      // Admin and RCON passwords are encrypted with the OS's per-user key
      // (DPAPI on Windows), so the settings file alone doesn't reveal them.
      secrets: {
        encrypt: (text) => (safeStorage.isEncryptionAvailable()
          ? `ss:${safeStorage.encryptString(text).toString('base64')}`
          : `plain:${text}`),
        decrypt: (stored) => {
          const v = String(stored);
          if (v.startsWith('ss:')) return safeStorage.decryptString(Buffer.from(v.slice(3), 'base64'));
          return v.replace(/^plain:/, '');
        },
      },
      consoleSend: (pid, lines, opts) => require('./commands/console-sender').sendToConsole(pid, lines, { ...opts, clipboard }),
    },
  });
  controller.on('structure', (snap) => send('session:structure', snap));
  controller.on('values', (v) => send('session:values', v));
  controller.on('detached', (info) => send('session:detached', info));
  controller.on('commands', () => send('commands:info', controller.commands.info()));
  // Value finder: progress at most ~8 times a second; results when a scan ends.
  let finderAt = 0;
  controller.on('finder', (why) => {
    if (why === 'progress' && Date.now() - finderAt < 120) return;
    finderAt = Date.now();
    send('finder:info', controller.finder.info());
  });
  controller.on('structure', () => send('commands:info', controller.commands.info()));

  settings = new Settings(app.getPath('userData'));
  timers = new Timers({ settings });
  controller.timers = timers;
  // The overlay, the desktop and the phone all redraw from 'overlay' events.
  timers.on('change', () => controller.emit('overlay'));
  remote = new Remote({
    controller,
    settings,
    webDir: path.join(ROOT, 'src', 'remote-web'),
    sharedDir: path.join(ROOT, 'src', 'shared'),
  });
  remote.on('status', async () => send('remote:status', await remote.status()));
  remote.init();

  overlayWin = new OverlayWindow({ controller, settings, root: ROOT });
  overlayWin.on('status', () => send('overlay:status', overlayWin.status()));
  controller.on('overlay', () => send('overlay:data', controller.overlay.state()));
  controller.on('structure', () => send('overlay:data', controller.overlay.state()));
  controller.on('values', () => send('overlay:live', controller.overlay.values()));
  overlayWin.init();

  // A timer ran out: flash and beep in the overlay, toast on a connected
  // phone, and a Windows notification, which makes its own sound only when
  // the overlay couldn't beep (hidden, or turned off).
  timers.on('done', (t) => {
    const text = t.repeat ? `${t.name}: time's up (starting again)` : `${t.name}: time's up`;
    const beeped = overlayWin.alert(text);
    remote.server.broadcast({ type: 'alert', text });
    if (Notification.isSupported()) new Notification({ title: 'Keystone', body: text, silent: beeped }).show();
  });

  // Mod hotkeys: registered while the open game has mods connected, and
  // re-synced on every change. Each press flashes the result in the overlay.
  hotkeyReg = new HotkeyRegistry({
    globalShortcut,
    onFire: (id) => {
      try {
        const r = controller.quickAction(id);
        overlayWin.flash(`${r.label}: ${r.state}`);
      } catch (err) {
        overlayWin.flash(err.message);
      }
    },
  });
  controller.on('structure', () => hotkeyReg.sync(controller.activeHotkeys()));

  // Auto-attach: pick up games started from Steam, a shortcut, anywhere.
  if (process.platform === 'win32') {
    const timer = setInterval(() => {
      if (!settings.general.autoAttach) return;
      let res = null;
      try { res = controller.autoAttachTick(); } catch (err) { send('app:notice', err.message); return; }
      if (!res) return;
      send('app:autoAttached', { packId: controller.pack?.id || null, game: res.game, notices: res.notices });
      overlayWin.flash(`Keystone: ${res.game} detected`);
    }, 2000);
    timer.unref?.();
  }

  // Quick links in the browser come from the selected game's pack.
  browser = new KeystoneBrowser({ settings, root: ROOT, getLinks: () => (controller.game ? controller.library.info().links || [] : []) });
  browser.init();

  // Sites see Keystone's browser as the Chrome it is. Electron's default
  // user agent adds "Electron/.." and "keystone/..", which some sites (and
  // Cloudflare's browser check, in front of FearLess) treat as a bot.
  const web = session.fromPartition(PARTITION);
  web.setUserAgent(web.getUserAgent().replace(/\s+(Electron|keystone)\/\S+/gi, ''));

  // Tables tab: catalog, downloads into the tables folder, update checks.
  tableStore = new TableStore({
    catalogFile: path.join(ROOT, 'tables', 'store.json'),
    dataDir: app.getPath('userData'),
    userTablesDir: controller.userTablesDir,
    packs: () => loadPacks([path.join(ROOT, 'packs'), path.join(app.getPath('userData'), 'packs')]),
  });
  tableStore.on('changed', () => send('tables:changed', tableStore.list()));
  tableFetch = new TableFetcher({
    store: tableStore,
    session: web,
    BrowserWindow,
    partition: PARTITION,
    tmpDir: path.join(app.getPath('temp'), 'keystone-tables'),
  });
  tableFetch.on('installed', ({ entry, files, replaced }) => {
    const open = controller.session && controller.pack?.id === entry.packId;
    let where = `It loads when you open ${entry.game}.`;
    // The old version's mods are already loaded; swapping tables under a
    // running session would orphan their frozen values and scripts.
    if (replaced && open) where = `Reopen ${entry.game} in Keystone to switch to it.`;
    else if (open) {
      try { controller.loadInstalledTables(entry.packId, files); where = 'Its mods are on the Mods tab now.'; } catch (err) { where = `It couldn't load: ${err.message}`; }
    }
    const text = `${replaced ? 'Updated' : 'Installed'} ${entry.title}. ${where}`;
    browser.notice(text);
    send('tables:notice', { text, kind: 'info' });
  });
  tableFetch.on('notice', (text) => { browser.notice(text, 'error'); send('tables:notice', { text, kind: 'error' }); });
  // One Windows notification per new file; clicking it opens the Tables tab.
  tableFetch.on('update', (entry) => {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: `${entry.game}: table update`, body: `A newer version of "${entry.title}" is out. Open Keystone's Tables tab to get it.` });
    n.on('click', () => { showMain(); send('app:goto', 'tables'); });
    n.show();
  });
  tableFetch.init();

  art = new ArtCache({ dataDir: app.getPath('userData'), fetchImpl: (url) => net.fetch(url) });
  protocol.handle('ksart', async (req) => {
    const u = new URL(req.url);
    const kind = u.hostname;
    const packId = decodeURIComponent(u.pathname.replace(/^\//, ''));
    const pack = loadPacks([path.join(ROOT, 'packs'), path.join(app.getPath('userData'), 'packs')]).find((p) => p.id === packId);
    const file = await art.file(pack, kind);
    if (!file) return new Response('No art', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  controller.library.images = new LibraryImages({
    dataDir: app.getPath('userData'),
    fetchImpl: (url, opts) => net.fetch(url, opts),
    // Wikis ask tools to say who they are.
    userAgent: `Keystone/${app.getVersion()} (game companion app; https://github.com/twaynick/keystone)`,
  });
  protocol.handle('kslib', async (req) => {
    try {
      const u = new URL(req.url);
      const [a, b, c] = u.pathname.replace(/^\//, '').split('/').map(decodeURIComponent);
      const kind = u.hostname;
      const file = kind === 'thumb' || kind === 'hero' ? await controller.library.pictureFile(kind, a, b)
        : kind === 'spawn' ? await controller.library.spawnFile('overlay', Number(a), b, c)
          : kind === 'spawnmap' ? await controller.library.spawnFile('map', Number(a), b, c)
            : null;
      if (!file) return new Response('No picture', { status: 404 });
      const buf = await fs.promises.readFile(file);
      return new Response(buf, { headers: { 'content-type': mimeOf(buf), 'cache-control': 'max-age=86400' } });
    } catch {
      return new Response('No picture', { status: 404 });
    }
  });

  protocol.handle('ksmap', () => {
    // Needs only a selected game, not mods: ASA on a BattlEye server has a
    // map and waypoints but no memory session.
    const m = controller.game ? controller.overlay.map() : null;
    if (!m?.image) return new Response('No map', { status: 404 });
    return net.fetch(pathToFileURL(m.image).toString());
  });
}

// Electron turns thrown errors into "Error invoking remote method ..." noise,
// so every handler returns { ok, data } / { ok: false, error } instead and
// the renderer shows the real message.
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
}

handle('processes:list', () => controller.listProcesses());
handle('games:list', () => controller.listGamesWithInstalled());
handle('session:get', () => controller.snapshot());
handle('session:attach', (target) => controller.attach(target));
handle('session:detach', () => controller.detach());
handle('mod:setEnabled', (id, on) => controller.setEnabled(id, on));
handle('mod:setTarget', (id, value) => controller.setTarget(id, value));
handle('mod:apply', (id, value) => controller.applyValue(id, value));
handle('table:open', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Load a Cheat Engine table',
    filters: [{ name: 'Cheat Engine table', extensions: ['ct', 'CT'] }],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  return controller.loadTableFile(res.filePaths[0]);
});
// Value finder and My mods
handle('finder:info', () => controller.finder.info());
handle('finder:first', (opts) => controller.finder.first(opts || {}));
handle('finder:next', (opts) => controller.finder.next(opts || {}));
handle('finder:undo', () => controller.finder.undo());
handle('finder:reset', () => controller.finder.reset());
handle('finder:cancel', () => controller.finder.cancel());
handle('finder:addMod', (m) => controller.finder.addMod(m || {}));
handle('finder:renameMod', (id, name) => controller.finder.renameMod(String(id), name));
handle('finder:removeMod', (id) => controller.finder.removeMod(String(id)));
handle('finder:export', async () => {
  controller.finder.tableXml(); // says so before the dialog if there's nothing to share
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Share your mods as a table',
    defaultPath: controller.finder.suggestedFileName(),
    filters: [{ name: 'Cheat Engine table', extensions: ['ct'] }],
  });
  if (res.canceled || !res.filePath) return null;
  return controller.finder.exportTable(res.filePath);
});
handle('tables:openFolder', async () => {
  const dir = controller.userTablesFolder();
  const err = await shell.openPath(dir);
  if (err) throw new Error(err);
  return dir;
});
handle('profile:save', (name, opts) => controller.saveProfile(name, opts));
handle('profile:apply', (name) => controller.applyProfile(name));
handle('profile:delete', (name) => controller.deleteProfile(name));
handle('profile:rename', (from, to) => controller.renameProfile(from, to));
handle('profile:clear', () => controller.clearActiveProfile());
handle('profile:autoApply', (on) => controller.setAutoApply(on));
handle('remote:status', () => remote.status());
handle('remote:enable', (on) => remote.setEnabled(on));
handle('remote:port', (port) => remote.setPort(port));
handle('remote:host', (host) => remote.setHost(host));
handle('remote:reset', () => remote.resetPairing());
// Overlay (shared by the desktop Overlay tab and the overlay window itself)
const ov = () => controller.overlay;
handle('overlay:status', () => overlayWin.status());
handle('overlay:enable', (on) => overlayWin.setEnabled(on));
handle('overlay:onlyOverGame', (on) => overlayWin.setOnlyOverGame(on));
handle('overlay:display', (id) => overlayWin.setDisplay(id));
handle('overlay:edit', (on) => overlayWin.setEditing(on));
handle('overlay:data', () => ov().state());
handle('overlay:live', () => ov().values());
handle('overlay:setRole', (role, id) => ov().setRole(role, id));
handle('overlay:chooseMap', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a map image',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  return ov().setMapImage(res.filePaths[0]);
});
handle('overlay:setBounds', (b) => ov().setMapBounds(b));
handle('overlay:calibrate', (a, b, w, h) => ov().calibrate(a, b, w, h));
handle('overlay:resetMap', () => ov().resetMap());
handle('overlay:addWaypoint', (wp) => ov().addWaypoint(wp));
handle('overlay:updateWaypoint', (id, patch) => ov().updateWaypoint(id, patch));
handle('overlay:removeWaypoint', (id) => ov().removeWaypoint(id));
handle('overlay:setTracked', (id) => ov().setTracked(id));
handle('overlay:teleport', (target) => ov().teleport(target));
handle('overlay:setVariant', (id) => ov().setVariant(String(id)));
handle('overlay:setCrosshair', (patch) => ov().setCrosshair(patch || {}));
handle('overlay:setPcStats', (patch) => ov().setPcStats(patch || {}));
handle('identify:info', () => controller.identify.info());
handle('identify:cycle', (id) => controller.identify.cycle(String(id)));
handle('identify:set', (id, mark) => controller.identify.setTrait(String(id), mark ?? null));
handle('identify:given', (n) => controller.identify.setGiven(n));
handle('identify:strike', (id, on) => controller.identify.strike(String(id), on));
handle('identify:reset', () => controller.identify.reset());
handle('timers:add', (t) => timers.add(t || {}));
// Presets come from the selected game's pack, by position, so a page can't
// make up its own.
handle('timers:preset', (i) => {
  const p = controller.pack?.timerPresets?.[Number(i)];
  if (!p) throw new Error('That timer isn\u2019t in this game\u2019s list.');
  return timers.startPreset(p);
});
handle('timers:update', (id, patch) => timers.update(String(id), patch || {}));
handle('timers:start', (id) => timers.start(String(id)));
handle('timers:pause', (id) => timers.pause(String(id)));
handle('timers:toggle', (id) => timers.toggle(String(id)));
handle('timers:reset', (id) => timers.reset(String(id)));
handle('timers:remove', (id) => timers.remove(String(id)));
handle('list:add', (name) => ov().addList(name));
handle('list:rename', (id, name) => ov().renameList(String(id), name));
handle('list:remove', (id) => ov().removeList(String(id)));
handle('list:active', (id) => ov().setActiveList(id ? String(id) : null));
handle('list:addItem', (id, text) => ov().addItem(String(id), text));
handle('list:check', (id, itemId, done) => ov().checkItem(String(id), String(itemId), done));
handle('list:removeItem', (id, itemId) => ov().removeItem(String(id), String(itemId)));
handle('list:reset', (id) => ov().resetList(String(id)));
handle('overlay:setLayer', (id, on) => ov().setLayer(String(id), on));
handle('overlay:setHere', (pos) => ov().setHere(pos));
handle('overlay:clearHere', () => ov().clearHere());
handle('overlay:findMe', () => ov().findMe());
handle('overlay:lineUpFindMe', (shown) => ov().lineUpFindMe(shown || {}));
handle('overlay:resetFindMe', () => ov().resetFindMe());
// From the overlay's own map: the result shows as a flash in the overlay.
handle('overlay:teleportTo', (pos) => overlayWin.teleportTo(pos));
handle('overlay:setReadouts', (ids) => ov().setReadouts(ids));
handle('overlay:setNotes', (text) => ov().setNotes(text));
handle('overlay:setPanel', (id, patch) => ov().setPanel(id, patch));
handle('overlay:setZoom', (z) => ov().setZoom(z));
// Commands
const cmd = () => controller.commands;
handle('commands:info', () => cmd().info());
handle('commands:catalog', (name) => cmd().catalog(name));
handle('commands:build', (kind, id, opts) => cmd().build(kind, id, opts));
handle('commands:run', (kind, id, opts) => cmd().run(kind, id, opts));
handle('commands:raw', (text, via) => cmd().runRaw(text, via));
handle('commands:enableAdmin', () => cmd().enableAdmin());
handle('commands:settings', (patch) => cmd().setSettings(patch));
handle('commands:rcon', (cfg) => cmd().setRcon(cfg));
handle('commands:testRcon', () => cmd().testRcon());
handle('commands:clearHistory', () => cmd().clearHistory());
handle('platform', () => ({ platform: process.platform, version: app.getVersion() }));

// Library
const lib = () => controller.library;
handle('library:info', () => lib().info());
handle('library:entries', (catalog) => lib().entries(catalog));
handle('library:entry', (catalog, id) => lib().entry(catalog, id));
handle('library:note', (catalog, id, text) => lib().setNote(catalog, id, text));
handle('library:guide', (id) => lib().guide(id));
handle('library:search', (q) => lib().search(q));
handle('library:openGuidesFolder', () => {
  const dir = lib().userGuidesDir();
  require('fs').mkdirSync(dir, { recursive: true });
  return shell.openPath(dir);
});
// Browser window
handle('browser:open', (url) => browser.open(url));
handle('browser:state', () => browser.state());
handle('browser:opacity', (v) => browser.setOpacity(v));
handle('browser:onTop', (on) => browser.setOnTop(on));
handle('browser:home', (url) => browser.setHome(url));
handle('browser:hide', () => browser.hide());

// Games: library, launching, per-game mod switch
handle('tables:list', () => tableStore.list());
// A card was clicked: the table's page opens in Keystone's browser, where a
// download from it lands in the game's tables folder.
handle('tables:open', (id) => {
  const entry = tableStore.open(String(id));
  browser.open(entry.url);
  return true;
});
handle('tables:remove', (id) => tableStore.remove(String(id)));
handle('tables:check', async () => { await tableFetch.checkAll(true); return tableStore.list(); });

handle('game:launch', async (packId) => {
  const target = await controller.launchTarget(packId);
  if (target.kind === 'path') {
    const err = await shell.openPath(target.path);
    if (err) throw new Error(`Couldn't start the game: ${err}`);
  } else if (target.kind === 'appx') {
    // Xbox app games. Explorer exits with code 1 even when it worked, so its
    // result says nothing; waitForLaunch below reports a game that never came up.
    if (!/^[\w.-]+![\w.-]+$/.test(target.id)) throw new Error('That Xbox game has an unexpected app id.');
    require('child_process').execFile('explorer.exe', [`shell:AppsFolder\\${target.id}`], () => {});
  } else {
    await shell.openExternal(target.uri);
  }
  // Attach once it's up; the result arrives as a normal structure update.
  controller.waitForLaunch(packId).then((res) => { if (res?.error) send('app:notice', res.error); else send('app:notice', null); });
  return true;
});
handle('game:modsEnabled', (on) => controller.setModsEnabled(on));
handle('mod:hotkey', (id, accel) => {
  const clean = controller.setHotkey(id, accel);
  if (clean && hotkeyReg.sync(controller.activeHotkeys()).includes(clean)) {
    controller.setHotkey(id, null);
    throw new Error(`Another program is already using ${clean}. Pick a different key.`);
  }
  return clean;
});
handle('mod:pin', (id, on) => controller.setPinned(id, on));
handle('mod:quick', (id) => controller.quickAction(id));

function broadcastAppearance() {
  const a = { accent: settings.general.accent };
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('app:appearance', a);
  remote?.server.broadcast({ type: 'appearance', data: a });
}
handle('app:appearance', () => ({ accent: settings.general.accent }));
handle('app:setAccent', (id) => {
  if (!/^[a-z]{2,20}$/.test(String(id))) throw new Error('Unknown color.');
  settings.updateGeneral({ accent: id });
  broadcastAppearance();
  return appSettings();
});

handle('app:settings', () => appSettings());
handle('app:closeToTray', (on) => { settings.updateGeneral({ closeToTray: Boolean(on) }); return appSettings(); });
handle('app:autoAttach', (on) => { settings.updateGeneral({ autoAttach: Boolean(on) }); return appSettings(); });
handle('app:startWithWindows', (on) => setStartWithWindows(on));
handle('app:openFolder', (which) => {
  const dirs = { data: app.getPath('userData'), packs: path.join(app.getPath('userData'), 'packs') };
  if (!dirs[which]) throw new Error('Unknown folder.');
  require('fs').mkdirSync(dirs[which], { recursive: true });
  return shell.openPath(dirs[which]);
});

app.whenReady().then(() => {
  createController();
  createMainWindow();
  tray = createTray({
    root: ROOT,
    onOpen: showMain,
    onQuit: quit,
    getState: async () => ({
      game: controller.snapshot().displayName || null,
      overlay: settings.overlay.enabled,
      phone: (await remote.status()).running,
    }),
    setOverlay: (on) => overlayWin.setEnabled(on),
    setPhone: (on) => remote.setEnabled(on).catch(() => {}),
  });
  // Keep the tray menu's checkmarks and game name current.
  for (const ev of ['structure']) controller.on(ev, () => tray.rebuild());
  overlayWin.on('status', () => tray.rebuild());
  remote.on('status', () => tray.rebuild());
});

app.on('before-quit', () => { quitting = true; browser?.shutdown(); tableFetch?.shutdown(); hotkeyReg?.clear(); });

app.on('window-all-closed', async () => {
  overlayWin?.shutdown();
  timers?.shutdown();
  controller?.shutdown();
  await remote?.shutdown();
  tray?.destroy();
  app.quit();
});
