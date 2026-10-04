'use strict';

const { app, BrowserWindow, ipcMain, dialog, nativeTheme, shell, protocol, net, safeStorage, clipboard, Notification, globalShortcut } = require('electron');
const { pathToFileURL } = require('url');
const path = require('path');
const { Controller } = require('./controller');
const { Settings } = require('./settings');
const { Remote } = require('./remote');
const { OverlayWindow } = require('./overlay-window');
const { createTray } = require('./tray');
const { KeystoneBrowser } = require('./browser-window');
const { ArtCache } = require('./art');
const { HotkeyRegistry } = require('./hotkeys');
const { loadPacks } = require('./packs');

const ROOT = path.join(__dirname, '..', '..');
let controller = null; // created once app paths are ready (needs userData)
let remote = null;
let overlayWin = null;
let settings = null;
let tray = null;
let browser = null;
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
  controller.on('structure', () => send('commands:info', controller.commands.info()));

  settings = new Settings(app.getPath('userData'));
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

  protocol.handle('ksmap', () => {
    // Needs only a selected game, not mods: ASA on a BattlEye server has a
    // map and waypoints but no memory session.
    const m = controller.game ? controller.overlay.map() : null;
    if (!m) return new Response('No map', { status: 404 });
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

app.on('before-quit', () => { quitting = true; browser?.shutdown(); hotkeyReg?.clear(); });

app.on('window-all-closed', async () => {
  overlayWin?.shutdown();
  controller?.shutdown();
  await remote?.shutdown();
  tray?.destroy();
  app.quit();
});
