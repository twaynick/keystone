'use strict';

const { BrowserWindow, globalShortcut, shell, screen } = require('electron');
const { EventEmitter } = require('events');
const path = require('path');

// Keystone's web browser: a small window that can float above the game so you
// can read a wiki without alt-tabbing. Ctrl+Shift+B shows or hides it.
//
// The page itself (src/browser/browser.html) is Keystone's toolbar; websites
// load inside a <webview> in a separate, persistent session, so logins stick
// and no website ever gets access to Keystone's own APIs.

const HOTKEY = 'CommandOrControl+Shift+B';
const PARTITION = 'persist:keystone-web';

class KeystoneBrowser extends EventEmitter {
  constructor({ settings, root, getLinks }) {
    super();
    this.settings = settings;
    this.root = root;
    this.getLinks = getLinks;
    this.win = null;
    this.pendingUrl = null;
    this.hotkeyError = null;
  }

  init() {
    if (!globalShortcut.register(HOTKEY, () => this.toggle())) {
      this.hotkeyError = 'Ctrl+Shift+B is used by another program';
    }
  }

  prefs() {
    const b = this.settings.data.browser || {};
    return { opacity: b.opacity ?? 1, onTop: b.onTop ?? true, bounds: b.bounds || null, home: b.home || null };
  }

  _savePrefs(patch) {
    this.settings.data.browser = { ...this.prefs(), ...patch };
    this.settings._save();
  }

  open(url) {
    if (url && !/^https:\/\//i.test(url)) throw new Error('Keystone’s browser only opens https:// pages.');
    if (!this.win) this._create(url);
    else if (url) this.win.webContents.send('browser:navigate', url);
    this.win.show();
    this.win.focus();
    return true;
  }

  toggle() {
    if (this.win && this.win.isVisible() && this.win.isFocused()) this.win.hide();
    else this.open(null);
  }

  _create(url) {
    const p = this.prefs();
    const area = screen.getPrimaryDisplay().workArea;
    const bounds = p.bounds || { width: 520, height: Math.min(820, area.height - 80), x: area.x + area.width - 560, y: area.y + 40 };
    const win = new BrowserWindow({
      ...bounds,
      minWidth: 360,
      minHeight: 320,
      title: 'Keystone browser',
      backgroundColor: '#0e1115',
      autoHideMenuBar: true,
      icon: path.join(this.root, 'assets', 'icon.png'),
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'browser-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: true,
      },
    });
    // Same top-most level as the overlay, or a borderless-fullscreen game
    // covers it the moment you click back into the game.
    win.setAlwaysOnTop(p.onTop, 'screen-saver');
    win.setOpacity(p.opacity);
    win.loadFile(path.join(this.root, 'src', 'browser', 'browser.html'));
    this.pendingUrl = url || p.home || this.getLinks()[0]?.url || 'https://ark.wiki.gg';
    win.once('ready-to-show', () => win.show());

    // Remember size and position between sessions.
    const remember = () => { if (!win.isDestroyed() && !win.isMinimized()) this._savePrefs({ bounds: win.getBounds() }); };
    win.on('resized', remember);
    win.on('moved', remember);
    // Closing just hides it, so the page (and your place in it) survives.
    win.on('close', (e) => {
      if (this.quitting) return;
      e.preventDefault();
      win.hide();
    });
    win.on('closed', () => { this.win = null; });
    this.win = win;
  }

  // Locks down every <webview> the browser page creates: no preload, no
  // Node, the persistent web session, https only. Called from main.js's
  // will-attach-webview hook.
  static hardenWebview(event, webPreferences, params) {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    params.partition = PARTITION;
    if (params.src && !/^(https:\/\/|about:blank)/i.test(params.src)) event.preventDefault();
  }

  // Pages inside the webview that try to open a new window load in place
  // instead (wikis use target=_blank a lot); non-https goes to the real browser.
  static wireWebviewContents(contents) {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//i.test(url)) contents.loadURL(url);
      else if (/^http:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (e, url) => {
      if (!/^https:\/\//i.test(url)) { e.preventDefault(); if (/^http:\/\//i.test(url)) shell.openExternal(url); }
    });
  }

  state() {
    return { ...this.prefs(), links: this.getLinks(), initialUrl: this.pendingUrl, hotkey: 'Ctrl+Shift+B', hotkeyError: this.hotkeyError };
  }

  setOpacity(v) {
    const n = Math.min(1, Math.max(0.35, Number(v) || 1));
    this.win?.setOpacity(n);
    this._savePrefs({ opacity: n });
    return n;
  }

  setOnTop(on) {
    this.win?.setAlwaysOnTop(Boolean(on), 'screen-saver');
    this._savePrefs({ onTop: Boolean(on) });
    return Boolean(on);
  }

  setHome(url) {
    if (url && !/^https:\/\//i.test(url)) throw new Error('Home page must start with https://');
    this._savePrefs({ home: url || null });
    return true;
  }

  hide() { this.win?.hide(); return true; }

  // A short message across the top of the browser (a table just installed
  // from the page you're on, say).
  notice(text, kind = 'info') {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('browser:notice', { text, kind });
  }

  shutdown() {
    this.quitting = true;
    globalShortcut.unregister(HOTKEY);
    if (this.win) this.win.destroy();
  }
}

module.exports = { KeystoneBrowser, PARTITION };
