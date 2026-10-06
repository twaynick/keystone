'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { parseTopicPage, safeName, topicId } = require('./table-store');

// The Electron half of the Tables tab (table-store.js is the rest):
//
// - Downloads: when a table file is downloaded in Keystone's browser from a
//   page in the store, it goes straight into that game's tables folder
//   instead of a save dialog. Every other download behaves as normal.
// - Update checks: about once a day, each installed table's page is opened
//   in a hidden window that shares the browser's logins, and its first post
//   is compared with what's installed. A login wall or a Cloudflare check
//   that doesn't pass on its own just means "try again tomorrow".

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE_HTML = 'document.documentElement.outerHTML';

class TableFetcher extends EventEmitter {
  constructor({ store, session, BrowserWindow, partition, tmpDir }) {
    super();
    this.store = store;
    this.session = session;
    this.BrowserWindow = BrowserWindow;
    this.partition = partition;
    this.tmpDir = tmpDir;
    this.checking = null;
    this.timers = [];
  }

  init() {
    this.session.on('will-download', (_e, item, contents) => this._onDownload(item, contents));
    // First look a couple of minutes after start (not while Keystone and
    // the game are both starting up), then hourly to see what's due.
    const first = setTimeout(() => this.checkAll(false), 2 * 60 * 1000);
    const every = setInterval(() => this.checkAll(false), 60 * 60 * 1000);
    first.unref?.(); every.unref?.();
    this.timers.push(first, every);
  }

  _onDownload(item, contents) {
    let pageUrl = '';
    try { pageUrl = contents?.getURL() || ''; } catch { /* page closed */ }
    const entry = this.store.entryForPage(pageUrl);
    if (!entry) return;
    const name = item.getFilename();
    if (!/\.(ct|zip)$/i.test(name)) {
      // Leave it to the normal save dialog.
      this.emit('notice', `${name} isn't a .CT or .zip file, so Keystone can't install it. Save it, take the .CT out, and put it in the game's Tables folder (Mods tab).`, 'error');
      return;
    }
    const attachmentId = Number((item.getURL().match(/[?&]id=(\d+)/) || [])[1]) || null;
    fs.mkdirSync(this.tmpDir, { recursive: true });
    const tmp = path.join(this.tmpDir, `${Date.now()}-${safeName(name)}`);
    item.setSavePath(tmp);
    item.once('done', async (_e, state) => {
      try {
        if (state !== 'completed') throw new Error(`Downloading ${name} didn't finish.`);
        // The author's name is on the page the download came from, if
        // that's the table's own topic.
        let author = null;
        if (topicId(pageUrl) && topicId(pageUrl) === entry.topic) {
          try { author = parseTopicPage(await contents.executeJavaScript(PAGE_HTML, false)).author || null; } catch { /* page gone */ }
        }
        const res = this.store.install(entry.id, { file: tmp, fileName: name, attachmentId, author });
        this.emit('installed', res);
      } catch (err) {
        this.emit('notice', err.message, 'error');
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    });
  }

  // One check at a time; asking again while one runs waits for it.
  checkAll(force) {
    if (!this.checking) {
      this.checking = this._checkAll(force).finally(() => { this.checking = null; });
    }
    return this.checking;
  }

  async _checkAll(force) {
    const ids = this.store.due(force);
    for (const [i, id] of ids.entries()) {
      const entry = this.store.entry(id);
      const page = await this._page(entry.url);
      const fresh = this.store.checked(id, page);
      if (fresh) this.emit('update', fresh);
      // Gentle on the site: one page every few seconds.
      if (i < ids.length - 1) await sleep(4000);
    }
    return ids.length;
  }

  async _page(url) {
    const win = new this.BrowserWindow({
      show: false,
      width: 1100,
      height: 900,
      webPreferences: { partition: this.partition, sandbox: true, contextIsolation: true, nodeIntegration: false, images: false },
    });
    win.webContents.setAudioMuted(true);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    let failed = false;
    win.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
      // -3 is a navigation replaced by another (Cloudflare's redirect back
      // to the page), not a failure.
      if (isMainFrame && code !== -3) failed = true;
    });
    try {
      await win.loadURL(url).catch(() => {});
      // A Cloudflare check usually passes by itself within a few seconds.
      let page = { status: 'error' };
      for (let i = 0; i < 10; i++) {
        for (let w = 0; w < 20 && win.webContents.isLoading(); w++) await sleep(500);
        if (failed) return { status: 'error' };
        page = parseTopicPage(await win.webContents.executeJavaScript(PAGE_HTML, false));
        if (page.status !== 'challenge') break;
        await sleep(2000);
      }
      return page;
    } catch {
      return { status: 'error' };
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  }

  shutdown() {
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
  }
}

module.exports = { TableFetcher };
