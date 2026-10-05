'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// App-wide settings (not per game): <dataDir>/settings.json

const DEFAULT_PORT = 47800;

function newToken() {
  // 128 bits: far beyond guessing over a LAN, and short enough for a QR code.
  return crypto.randomBytes(16).toString('base64url');
}

class Settings {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'settings.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.data = this._load();
    // Persist the generated token right away so a phone paired on first run
    // still works after a restart.
    if (!fs.existsSync(this.file)) this._save();
  }

  _load() {
    const defaults = {
      remote: { enabled: false, port: DEFAULT_PORT, token: newToken(), host: null },
      overlay: { enabled: false, onlyOverGame: true },
      general: { closeToTray: true, startWithWindows: false, trayHintShown: false, accent: 'keystone', autoAttach: true },
    };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        ...defaults,
        ...raw,
        remote: { ...defaults.remote, ...(raw.remote || {}) },
        overlay: { ...defaults.overlay, ...(raw.overlay || {}) },
        general: { ...defaults.general, ...(raw.general || {}) },
      };
    } catch {
      return defaults;
    }
  }

  get remote() {
    return this.data.remote;
  }

  updateRemote(patch) {
    Object.assign(this.data.remote, patch);
    this._save();
    return this.data.remote;
  }

  get overlay() {
    return this.data.overlay;
  }

  updateOverlay(patch) {
    Object.assign(this.data.overlay, patch);
    this._save();
    return this.data.overlay;
  }

  get general() {
    return this.data.general;
  }

  updateGeneral(patch) {
    Object.assign(this.data.general, patch);
    this._save();
    return this.data.general;
  }

  resetToken() {
    return this.updateRemote({ token: newToken() }).token;
  }

  _save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Settings, DEFAULT_PORT };
