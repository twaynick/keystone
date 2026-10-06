'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { EventEmitter } = require('events');
const { parseCheatTable } = require('./engine/ct-parser');

// The Tables tab: a catalog of links to community cheat tables on their
// creators' own pages (tables/store.json). Keystone never hosts the files.
// The user downloads a table in Keystone's browser, logged in with their own
// account, and Keystone puts it in that game's personal tables folder
// (%APPDATA%\Keystone\tables\<pack>\), where it loads by itself (tables.js).
//
// This file is the Electron-free part, so it can be tested: the catalog,
// installing a downloaded file, reading a table page for updates, and
// remembering what's installed. table-fetch.js does the Electron side.

const DAY = 24 * 60 * 60 * 1000;
// A little under a day, so a once-a-day check doesn't slowly drift later
// each day because of the check timer's own interval.
const CHECK_EVERY = 20 * 60 * 60 * 1000;
// A card click is remembered this long, for downloads from a page whose
// address doesn't name the table's topic (a link to one post, say).
const PENDING_FOR = 2 * 60 * 60 * 1000;
const MAX_FILE = 25 * 1024 * 1024;

// ---------- catalog ----------

// phpBB topic id, from ?t=123. Pages are matched by it because the same
// topic has many addresses (pages, sort order, session ids).
function topicId(url) {
  try {
    const u = new URL(url);
    const t = u.searchParams.get('t');
    return t && /^\d+$/.test(t) ? `${u.hostname.replace(/^www\./, '')}#${t}` : null;
  } catch {
    return null;
  }
}

function loadCatalog(file, packs) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { sites: {}, tables: [] };
  }
  const byId = new Map(packs.map((p) => [p.id, p]));
  const seen = new Set();
  const tables = [];
  for (const t of Array.isArray(raw.tables) ? raw.tables : []) {
    const pack = byId.get(t.pack);
    // Only games Keystone can mod: an online-only game gets no tables.
    if (!pack || pack.memory === false) continue;
    if (typeof t.id !== 'string' || seen.has(t.id)) continue;
    if (typeof t.url !== 'string' || !/^https:\/\//.test(t.url)) continue;
    seen.add(t.id);
    tables.push({
      id: t.id,
      packId: pack.id,
      game: pack.name,
      offlineOnly: Boolean(pack.offlineOnly),
      title: String(t.title || pack.name).slice(0, 100),
      url: t.url,
      host: new URL(t.url).hostname.replace(/^www\./, ''),
      topic: topicId(t.url),
      author: typeof t.author === 'string' ? t.author.slice(0, 80) : null,
      note: typeof t.note === 'string' ? t.note.slice(0, 200) : null,
    });
  }
  return { sites: raw.sites && typeof raw.sites === 'object' ? raw.sites : {}, tables };
}

// ---------- reading a table's page ----------

const decode = (s) => String(s)
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
  .trim();

// What Keystone needs from a phpBB topic page: who made it, and which table
// files the first post offers. Table authors update the first post when a
// game patches, so a newer attachment there means an update. phpBB gives
// each upload a new, higher id, which is how "newer" is told apart.
function parseTopicPage(html) {
  const s = String(html || '');
  const title = decode((s.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '');
  // Cloudflare's "checking your browser" page. Keystone waits for it to pass
  // on its own and never tries to get around it.
  if (/^just a moment/i.test(title) || /challenge-platform|cf-chl-|cf_chl_opt/.test(s)) return { status: 'challenge' };

  const loggedIn = /mode=logout/.test(s);
  const posts = s.split(/<div[^>]+id="p\d+"[^>]*class="[^"]*\bpost\b/i);
  const first = posts.length > 1 ? posts[1] : '';
  if (!first) return { status: loggedIn ? 'error' : 'login', title };

  const author = (first.match(/class="username(?:-coloured)?"[^>]*>([^<]+)</) || [])[1];
  const attachments = [];
  const re = /<a[^>]+href="[^"]*download\/file\.php\?id=(\d+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(first))) {
    const name = decode(m[2].replace(/<[^>]+>/g, ''));
    if (/\.(ct|zip)$/i.test(name) && !attachments.some((a) => a.id === Number(m[1]))) attachments.push({ id: Number(m[1]), name });
  }
  // Guests see "You do not have the required permissions to view the files
  // attached to this post" instead of the files.
  if (!attachments.length && !loggedIn) return { status: 'login', title, author: author ? decode(author) : null };
  return { status: 'ok', title, author: author ? decode(author) : null, attachments };
}

const newest = (attachments) => attachments.reduce((a, b) => (!a || b.id > a.id ? b : a), null);

// ---------- downloaded files ----------

// Just the file's own name, safe on Windows; a zip entry can't climb out of
// the tables folder with "../".
function safeName(name) {
  const base = String(name || '').split(/[\\/]/).pop().replace(/[<>:"|?*\u0000-\u001f]/g, '_').trim().replace(/^\.+/, '');
  return base.slice(0, 120) || 'table.CT';
}

// Reads .CT files out of a .zip. Only "stored" and "deflate" entries, which
// is what Windows and 7-Zip write for zips; anything else is skipped.
function unzipTables(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('That .zip file is damaged or not really a zip.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (!/\.ct$/i.test(name) || /(^|\/)__MACOSX\//.test(name) || (flags & 1)) continue;
    if (size > MAX_FILE || local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: MAX_FILE });
    else continue;
    out.push({ name: safeName(name), data });
  }
  return out;
}

// ---------- the store ----------

class TableStore extends EventEmitter {
  constructor({ catalogFile, dataDir, userTablesDir, packs, now = Date.now }) {
    super();
    this.catalogFile = catalogFile;
    this.userTablesDir = userTablesDir;
    this.file = path.join(dataDir, 'table-store.json');
    this.packs = packs; // () => pack list
    this.now = now;
    this.pending = null; // { id, at }: the card clicked last
    this.data = this._read();
  }

  _read() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { installed: d.installed && typeof d.installed === 'object' ? d.installed : {}, authors: d.authors || {} };
    } catch {
      return { installed: {}, authors: {} };
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    this.emit('changed');
  }

  catalog() {
    if (!this._catalog) this._catalog = loadCatalog(this.catalogFile, this.packs());
    return this._catalog;
  }

  entry(id) {
    return this.catalog().tables.find((t) => t.id === id) || null;
  }

  // An install whose files have all been deleted (by hand, from the tables
  // folder) counts as not installed.
  _installed(id) {
    const rec = this.data.installed[id];
    if (!rec) return null;
    const dir = path.join(this.userTablesDir, rec.packId);
    return rec.files.some((f) => fs.existsSync(path.join(dir, f))) ? rec : null;
  }

  status(id) {
    const rec = this._installed(id);
    if (!rec) return 'get';
    return rec.latestId && rec.latestId > (rec.attachmentId || 0) ? 'update' : 'installed';
  }

  // Everything the Tables tab shows.
  list() {
    const { tables, sites } = this.catalog();
    return {
      sites,
      tables: tables.map((t) => {
        const rec = this._installed(t.id);
        return {
          ...t,
          author: this.data.authors[t.id] || t.author,
          status: this.status(t.id),
          installed: rec ? {
            files: rec.files,
            fileName: rec.fileName,
            at: rec.installedAt,
            latestName: rec.latestName || null,
            lastChecked: rec.lastChecked || null,
            check: rec.check || null,
          } : null,
        };
      }),
      updates: tables.filter((t) => this.status(t.id) === 'update').length,
    };
  }

  // A card was clicked: its page is about to open.
  open(id) {
    const t = this.entry(id);
    if (!t) throw new Error('That table isn’t in the store any more.');
    this.pending = { id, at: this.now() };
    return t;
  }

  // Which catalog table a download belongs to, from the page it was
  // started on, or else the card clicked last.
  entryForPage(pageUrl) {
    const topic = topicId(pageUrl);
    if (topic) {
      const t = this.catalog().tables.find((x) => x.topic === topic);
      if (t) return t;
    }
    let host = null;
    try { host = new URL(pageUrl).hostname.replace(/^www\./, ''); } catch { /* no page */ }
    if (this.pending && this.now() - this.pending.at < PENDING_FOR) {
      const t = this.entry(this.pending.id);
      if (t && (!host || host === t.host)) return t;
    }
    return null;
  }

  // Puts a downloaded .CT (or the .CTs in a .zip) in the game's tables
  // folder. Replaces the files of an earlier install of the same table,
  // which may have had a different name ("FH5 v1.2.CT" -> "FH5 v1.3.CT"):
  // left behind, both versions would load.
  install(id, { file, fileName, attachmentId = null, author = null }) {
    const t = this.entry(id);
    if (!t) throw new Error('That table isn’t in the store any more.');
    const buf = fs.readFileSync(file);
    const name = safeName(fileName || path.basename(file));
    let tables;
    if (/\.zip$/i.test(name)) {
      tables = unzipTables(buf);
      if (!tables.length) throw new Error(`${name} has no Cheat Engine table (.CT) in it.`);
    } else if (/\.ct$/i.test(name)) {
      tables = [{ name, data: buf }];
    } else {
      throw new Error(`${name} isn't a .CT or .zip file, so Keystone can't install it.`);
    }
    for (const x of tables) {
      if (x.data.length > MAX_FILE) throw new Error(`${x.name} is too big to be a cheat table.`);
      // Refuse anything that isn't really a table before it lands where it
      // would load next time the game starts.
      parseCheatTable(x.data.toString('utf8'), { sourceName: x.name });
    }

    const dir = path.join(this.userTablesDir, t.packId);
    fs.mkdirSync(dir, { recursive: true });
    const prev = this.data.installed[id];
    for (const f of prev?.files || []) fs.rmSync(path.join(dir, f), { force: true });
    // Another store table (or your own) with the same file name stays put.
    const owned = new Set(Object.entries(this.data.installed).filter(([k, r]) => k !== id && r.packId === t.packId).flatMap(([, r]) => r.files));
    const files = [];
    for (const x of tables) {
      let out = x.name;
      if (owned.has(out) || files.includes(out) || (fs.existsSync(path.join(dir, out)) && !(prev?.files || []).includes(out))) {
        out = out.replace(/(\.ct)$/i, ` (${id})$1`);
      }
      fs.writeFileSync(path.join(dir, out), x.data);
      files.push(out);
    }

    // Credit shows on the Mods tab (tables.js reads credits.json).
    const by = author || this.data.authors[id] || t.author;
    const credFile = path.join(dir, 'credits.json');
    let credits = {};
    try { credits = JSON.parse(fs.readFileSync(credFile, 'utf8')) || {}; } catch { /* first one */ }
    for (const f of prev?.files || []) delete credits[f];
    for (const f of files) credits[f] = { author: by || undefined, url: t.url, note: 'From the Tables tab' };
    fs.writeFileSync(credFile, JSON.stringify(credits, null, 2));

    if (author) this.data.authors[id] = author;
    this.data.installed[id] = {
      packId: t.packId,
      files,
      fileName: name,
      attachmentId: attachmentId || null,
      installedAt: this.now(),
      // What the page offered last time it was checked; a fresh install is
      // the newest by definition until the next check says otherwise.
      latestId: attachmentId || null,
      latestName: name,
      lastChecked: prev?.lastChecked || null,
      check: prev?.check || null,
      notifiedId: prev?.notifiedId || null,
    };
    this._save();
    return { entry: t, files: files.map((f) => path.join(dir, f)), replaced: Boolean(prev) };
  }

  remove(id) {
    const rec = this.data.installed[id];
    if (!rec) return false;
    const dir = path.join(this.userTablesDir, rec.packId);
    for (const f of rec.files) fs.rmSync(path.join(dir, f), { force: true });
    const credFile = path.join(dir, 'credits.json');
    try {
      const credits = JSON.parse(fs.readFileSync(credFile, 'utf8'));
      for (const f of rec.files) delete credits[f];
      fs.writeFileSync(credFile, JSON.stringify(credits, null, 2));
    } catch { /* no credits file */ }
    delete this.data.installed[id];
    this._save();
    return true;
  }

  // Installed tables whose page is due a look for updates.
  due(force = false) {
    return Object.keys(this.data.installed)
      .filter((id) => this.entry(id) && this._installed(id))
      .filter((id) => force || !this.data.installed[id].lastChecked || this.now() - this.data.installed[id].lastChecked >= CHECK_EVERY);
  }

  // Records what a table's page showed. Returns the entry when this is a
  // newly seen update (so the caller notifies once per new file, not once
  // per check).
  checked(id, page) {
    const rec = this.data.installed[id];
    if (!rec) return null;
    rec.lastChecked = this.now();
    rec.check = page.status;
    if (page.author) this.data.authors[id] = page.author;
    let fresh = null;
    if (page.status === 'ok') {
      const top = newest(page.attachments);
      // A table installed by hand-picking the file has no attachment id;
      // the newest one on the page at the first check stands in for it.
      if (top && !rec.attachmentId) rec.attachmentId = top.id;
      if (top) { rec.latestId = top.id; rec.latestName = top.name; }
      if (top && top.id > rec.attachmentId && rec.notifiedId !== top.id) {
        rec.notifiedId = top.id;
        fresh = this.entry(id);
      }
    }
    this._save();
    return fresh;
  }
}

module.exports = { TableStore, loadCatalog, parseTopicPage, unzipTables, safeName, topicId, CHECK_EVERY, DAY };
