'use strict';

const { EventEmitter } = require('events');
const QRCode = require('qrcode');
const { RemoteServer } = require('./server');
const { lanAddresses } = require('./network');

// Glue between settings, the server, and the pairing QR code. The desktop UI
// only ever talks to this.

class Remote extends EventEmitter {
  constructor({ controller, settings, webDir, sharedDir }) {
    super();
    this.settings = settings;
    this.server = new RemoteServer({
      controller, webDir, sharedDir,
      getToken: () => settings.remote.token,
      getAppearance: () => ({ accent: settings.general?.accent || 'keystone' }),
    });
    this.server.on('clients', () => this.emit('status'));
    this.error = null;
    this._qrCache = { url: null, dataUrl: null };
  }

  async init() {
    if (this.settings.remote.enabled) {
      try {
        await this.server.start(this.settings.remote.port);
      } catch (err) {
        // Don't block app start; show the problem in the Phone tab instead.
        this.error = err.message;
      }
    }
    this.emit('status');
  }

  async setEnabled(on) {
    this.error = null;
    if (on) {
      try {
        await this.server.start(this.settings.remote.port);
      } catch (err) {
        this.error = err.message;
        this.emit('status');
        throw err;
      }
    } else {
      await this.server.stop();
    }
    this.settings.updateRemote({ enabled: Boolean(on) });
    this.emit('status');
    return this.status();
  }

  async setPort(port) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error('Use a port between 1024 and 65535.');
    const wasRunning = Boolean(this.server.port);
    if (wasRunning) await this.server.stop();
    this.settings.updateRemote({ port: n });
    if (wasRunning) await this.setEnabled(true);
    this.emit('status');
    return this.status();
  }

  setHost(address) {
    this.settings.updateRemote({ host: address || null });
    this.emit('status');
    return this.status();
  }

  resetPairing() {
    this.settings.resetToken();
    this.server.disconnectAll();
    this.emit('status');
    return this.status();
  }

  async status() {
    const r = this.settings.remote;
    const addresses = lanAddresses();
    // Keep the user's chosen adapter if it still exists; otherwise best guess.
    const host = addresses.find((a) => a.address === r.host)?.address || addresses[0]?.address || null;
    const running = Boolean(this.server.port);
    const url = host ? `http://${host}:${r.port}/#t=${r.token}` : null;
    return {
      enabled: r.enabled,
      running,
      port: r.port,
      host,
      addresses,
      url,
      qr: running && url ? await this._qr(url) : null,
      clients: this.server.clientCount,
      error: this.error,
    };
  }

  async _qr(url) {
    if (this._qrCache.url !== url) {
      const dataUrl = await QRCode.toDataURL(url, {
        margin: 1,
        width: 512,
        errorCorrectionLevel: 'M',
        // Dark-on-light: some phone cameras won't read an inverted QR.
        color: { dark: '#0e1115', light: '#ffffff' },
      });
      this._qrCache = { url, dataUrl };
    }
    return this._qrCache.dataUrl;
  }

  async shutdown() {
    await this.server.stop();
  }
}

module.exports = { Remote };
