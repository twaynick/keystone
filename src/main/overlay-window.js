'use strict';

const { BrowserWindow, globalShortcut, screen } = require('electron');
const { EventEmitter } = require('events');
const path = require('path');

// The in-game overlay: a transparent, click-through window that sits above the
// game. It draws HUD panels (minimap, readouts, info) and never takes focus
// unless you switch to edit mode.
//
// Why a separate window instead of drawing inside the game: drawing inside
// needs code injected into the game's renderer, which is exactly what
// anti-cheat looks for. A top-most window needs nothing from the game, at the
// cost of not showing over exclusive fullscreen (borderless/windowed works).

const HOTKEYS = {
  toggle: 'CommandOrControl+Shift+O',
  edit: 'CommandOrControl+Shift+E',
  waypoint: 'CommandOrControl+Shift+W',
};

class OverlayWindow extends EventEmitter {
  constructor({ controller, settings, root }) {
    super();
    this.c = controller;
    this.settings = settings;
    this.root = root;
    this.win = null;
    this.userHidden = false;  // hidden with the hotkey
    this.editing = false;
    this.hotkeyErrors = [];
    this._fgTimer = null;
    this._lastValues = 0;

    controller.on('overlay', () => this.pushState());
    controller.on('structure', () => this.pushState());
    controller.on('values', () => this.pushValues());
  }

  init() {
    if (this.settings.overlay.enabled) this._open();
  }

  setEnabled(on) {
    this.settings.updateOverlay({ enabled: Boolean(on) });
    if (on) this._open(); else this._close();
    this.emit('status');
    return this.status();
  }

  setOnlyOverGame(on) {
    this.settings.updateOverlay({ onlyOverGame: Boolean(on) });
    this._updateVisibility();
    this.emit('status');
    return this.status();
  }

  setDisplay(id) {
    this.settings.updateOverlay({ display: id ? Number(id) : null });
    this._placeOnDisplay();
    this.emit('status');
    return this.status();
  }

  status() {
    const displays = screen.getAllDisplays().map((d, i) => ({
      id: d.id,
      label: `Display ${i + 1}: ${d.size.width}×${d.size.height}${d.id === screen.getPrimaryDisplay().id ? ' (main)' : ''}`,
    }));
    return {
      enabled: this.settings.overlay.enabled,
      onlyOverGame: this.settings.overlay.onlyOverGame,
      display: this._display().id,
      displays,
      visible: Boolean(this.win && this.win.isVisible()),
      userHidden: this.userHidden,
      editing: this.editing,
      hotkeys: { toggle: 'Ctrl+Shift+O', edit: 'Ctrl+Shift+E', waypoint: 'Ctrl+Shift+W' },
      hotkeyErrors: this.hotkeyErrors,
    };
  }

  toggleVisible() {
    if (!this.win) return;
    this.userHidden = !this.userHidden;
    if (this.userHidden && this.editing) this.setEditing(false);
    this._updateVisibility();
    this.emit('status');
  }

  setEditing(on) {
    if (!this.win) return this.status();
    this.editing = Boolean(on);
    if (this.editing) this.userHidden = false;
    // Edit mode makes the overlay a normal clickable window; leaving it puts
    // clicks straight back through to the game.
    this.win.setIgnoreMouseEvents(!this.editing, { forward: true });
    this.win.setFocusable(this.editing);
    this._updateVisibility();
    if (this.editing) this.win.focus();
    this._send('overlay:mode', { editing: this.editing });
    this.emit('status');
    return this.status();
  }

  dropWaypoint() {
    try {
      const wp = this.c.overlay.addWaypoint({});
      this._send('overlay:flash', `Waypoint added: ${wp.name}`);
    } catch (err) {
      this._send('overlay:flash', err.message);
    }
  }

  pushState() {
    if (!this.win) return;
    this._send('overlay:state', this.c.overlay.state());
    this._updateVisibility();
  }

  pushValues() {
    if (!this.win) return;
    this._send('overlay:values', this.c.overlay.values());
  }

  // ---------- internals ----------
  _display() {
    const id = this.settings.overlay.display;
    return screen.getAllDisplays().find((d) => d.id === id) || screen.getPrimaryDisplay();
  }

  _placeOnDisplay() {
    if (!this.win) return;
    this.win.setBounds(this._display().bounds);
  }

  _open() {
    if (this.win) return;
    const { bounds } = this._display();
    const win = new BrowserWindow({
      ...bounds,
      transparent: true,
      backgroundColor: '#00000000',
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      show: false,
      title: 'Keystone overlay',
      webPreferences: {
        preload: path.join(__dirname, 'overlay-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false, // keep the minimap moving while the game has focus
      },
    });
    // 'screen-saver' is the highest z-level Electron offers; lower levels can
    // end up under borderless-fullscreen games.
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true, { forward: true });
    win.loadFile(path.join(this.root, 'src', 'overlay', 'overlay.html'));
    win.webContents.once('did-finish-load', () => {
      this.pushState();
      this.pushValues();
      this._send('overlay:mode', { editing: this.editing });
    });
    win.on('closed', () => { this.win = null; });
    this.win = win;
    this._registerHotkeys();
    this._fgTimer = setInterval(() => this._updateVisibility(), 500);
    this._updateVisibility();
  }

  _close() {
    clearInterval(this._fgTimer);
    this._fgTimer = null;
    for (const accel of Object.values(HOTKEYS)) globalShortcut.unregister(accel);
    this.hotkeyErrors = [];
    this.editing = false;
    if (this.win) this.win.destroy();
    this.win = null;
  }

  _registerHotkeys() {
    this.hotkeyErrors = [];
    const actions = {
      toggle: () => this.toggleVisible(),
      edit: () => this.setEditing(!this.editing),
      waypoint: () => this.dropWaypoint(),
    };
    for (const [name, accel] of Object.entries(HOTKEYS)) {
      globalShortcut.unregister(accel);
      // register() returns false when another program already owns the combo.
      if (!globalShortcut.register(accel, actions[name])) {
        this.hotkeyErrors.push(`${accel.replace('CommandOrControl', 'Ctrl')} is used by another program`);
      }
    }
  }

  _shouldShow() {
    if (!this.win || this.userHidden) return false;
    if (!this.c.game) return false;
    if (this.editing) return true;
    if (!this.settings.overlay.onlyOverGame) return true;
    const pid = this.c.game.pid;
    if (!pid) return true; // demo game has no window of its own
    try {
      const fg = require('./engine/win32').foregroundPid();
      // Our own windows count too, so clicking Keystone doesn't blink it away.
      return fg === null || fg === pid || fg === process.pid;
    } catch {
      return true;
    }
  }

  _updateVisibility() {
    if (!this.win) return;
    const show = this._shouldShow();
    if (show && !this.win.isVisible()) this.win.showInactive();
    else if (!show && this.win.isVisible()) this.win.hide();
  }

  _send(channel, payload) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  shutdown() {
    this._close();
  }
}

module.exports = { OverlayWindow };
