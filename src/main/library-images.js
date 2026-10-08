'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Pictures for Library pages (creature dossiers, item icons, spawn maps),
// downloaded by the player's PC from the game's wiki the first time they're
// shown and cached, the same way game art comes from Steam (art.js). Keystone
// never bundles them: they belong to the wiki and the game's makers, and the
// page credits where they came from.
//
// pack.json, under "library":
//   "images": {
//     "source": "https://ark.wiki.gg/wiki/Special:FilePath/",
//     "credit": "Pictures: ARK Official Community Wiki", "creditUrl": "https://ark.wiki.gg/",
//     "catalogs": {
//       "creatures": { "thumb": ["{name}.png"], "hero": ["Dossier_{name}.png", "{name}.png"] }
//     },
//     "dropPrefixes": ["Alpha", "Aberrant"],      // "Alpha Rex" falls back to "Rex"'s picture
//     "spawnMaps": [ { "name": "The Island", "map": "The_Island_Topographic_Map.jpg",
//                      "overlay": "Spawning_{name}_The_Island.svg" } ]
//   }
//
// Wikis whose file names don't follow the page names (Fandom's Fallout
// wiki: "Fallout4_10mm_pistol.png") use the page's own main picture instead,
// looked up through the wiki's API:
//   "images": { "api": "https://fallout.fandom.com/api.php",
//               "catalogs": { "items": { "thumb": ["{page}", "{name}"], "hero": ["{page}", "{name}"] } } }
// There the templates name pages, and {page} is the entry's own wiki page.
// A template starting "File:" names a file instead ("File:{img}", where
// {img} is the entry's own picture file, from the catalog), looked up the
// same way; that's for wikis that refuse Special:FilePath (Fandom does).
//
// The renderer only ever names an entry, never a URL or a file name, so a
// compromised page can't make Keystone fetch anything the pack didn't list.

const SIZES = { thumb: 96, card: 240, hero: 720, map: 640, worldMap: 2048 };
const MAX_BYTES = 6 * 1024 * 1024;
// A picture the wiki doesn't have is asked for again after this long, in
// case someone uploads it.
const RETRY_MISSING_MS = 14 * 24 * 3600 * 1000;

// Name variants to try, best first: the exact name, then without a
// "(Alpha)"-style suffix, then the part after "Recipes: ", then without a
// variant prefix like "Abyssal" or "X-".
function nameVariants(name, dropPrefixes = []) {
  const out = [String(name).trim()];
  const add = (v) => { v = v.trim(); if (v && !out.includes(v)) out.push(v); };
  add(out[0].replace(/\s*\([^)]*\)$/, ''));
  if (out[0].includes(': ')) add(out[0].split(': ').pop());
  for (const v of [...out]) {
    for (const p of dropPrefixes) {
      const m = p.endsWith('-') ? v.startsWith(p) : v.startsWith(`${p} `);
      if (m) add(v.slice(p.length));
    }
  }
  return out;
}

// File names for one entry and kind, in the order to try them. Templates
// first, then name variants, so an exact dossier beats the base creature's
// dossier, which beats an icon.
function candidates(spec, catalog, kind, entry) {
  const templates = spec?.catalogs?.[catalog]?.[kind];
  if (!Array.isArray(templates)) return [];
  const e = typeof entry === 'string' ? { name: entry } : entry;
  const variants = nameVariants(e.name, spec.dropPrefixes || []);
  // "/wiki/Addictol_(Fallout_4)" -> "Addictol_(Fallout_4)"
  let page = null;
  if (typeof e.page === 'string' && /^\/wiki\/[^\s?#]+$/.test(e.page)) {
    try { page = decodeURIComponent(e.page.slice(6)); } catch { page = null; }
  }
  const files = [];
  const add = (f) => { f = f.replace(/ /g, '_'); if (!files.includes(f)) files.push(f); };
  const img = typeof e.img === 'string' && /^[^/\\?#|]{1,200}\.(png|jpe?g|gif|webp|svg)$/i.test(e.img) ? e.img : null;
  for (const t of templates) {
    if (String(t).includes('{page}')) { if (page) add(String(t).replace('{page}', page)); continue; }
    if (String(t).includes('{img}')) { if (img) add(String(t).replace('{img}', img)); continue; }
    // {lname}: sentence case ("10mm Pistol" -> "10mm pistol"), how many
    // wikis title their pages.
    for (const v of variants) add(String(t).replace('{name}', v).replace('{lname}', v.charAt(0) + v.slice(1).toLowerCase()));
  }
  return files;
}

function spawnCandidates(spec, index, name) {
  const m = spec?.spawnMaps?.[index];
  if (!m) return [];
  return nameVariants(name, spec.dropPrefixes || []).map((v) => m.overlay.replace('{name}', v).replace(/ /g, '_'));
}

class LibraryImages {
  constructor({ dataDir, fetchImpl, userAgent = 'Keystone', concurrency = 4, now = () => Date.now() }) {
    this.dir = path.join(dataDir, 'libimg');
    this.fetch = fetchImpl || ((url, opts) => fetch(url, opts));
    this.userAgent = userAgent;
    this.now = now;
    this.pending = new Map();
    // Politeness: a long list scrolling past shouldn't fire a hundred
    // requests at the wiki at once.
    this.limit = concurrency;
    this.active = 0;
    this.queue = [];
  }

  static valid(spec) {
    if (!spec) return false;
    if (typeof spec.api === 'string') return /^https:\/\/[^\s?#]+\/api\.php$/.test(spec.api);
    return typeof spec.source === 'string' && /^https:\/\/[^\s]+\/$/.test(spec.source);
  }

  // First file that exists, as a local path; null when none do (or offline).
  async first(spec, files, size) {
    if (!LibraryImages.valid(spec)) return null;
    for (const f of files) {
      const p = await this.file(spec, f, size);
      if (p) return p;
    }
    return null;
  }

  _path(spec, name, size) {
    const key = crypto.createHash('sha1').update(spec.api || spec.source).digest('hex').slice(0, 10);
    const safe = `${name.replace(/[^A-Za-z0-9._-]/g, '_')}-${crypto.createHash('sha1').update(name).digest('hex').slice(0, 6)}`;
    return path.join(this.dir, key, String(size || 'full'), safe);
  }

  // The local copy if it's been downloaded already, else null (no fetching).
  cached(spec, name, size) {
    if (!LibraryImages.valid(spec)) return null;
    const file = this._path(spec, name, size);
    return fs.existsSync(file) ? file : null;
  }

  async file(spec, name, size) {
    const file = this._path(spec, name, size);
    if (fs.existsSync(file)) return file;
    const miss = `${file}.missing`;
    if (fs.existsSync(miss)) {
      const at = Number(fs.readFileSync(miss, 'utf8')) || 0;
      if (this.now() - at < RETRY_MISSING_MS) return null;
    }
    if (!this.pending.has(file)) {
      // No size: the original file. Spawn overlays need that, because asking
      // for an SVG at a width gets a PNG back.
      const target = spec.api
        ? () => this._pageImage(spec.api, name, size)
        : `${spec.source}${encodeURIComponent(name)}${size ? `?width=${size}` : ''}`;
      this.pending.set(file, this._queued(() => this._download(target, file)).finally(() => this.pending.delete(file)));
    }
    return this.pending.get(file);
  }

  _queued(job) {
    return new Promise((resolve) => {
      const run = async () => {
        this.active++;
        try { resolve(await job()); } finally {
          this.active--;
          const next = this.queue.shift();
          if (next) next();
        }
      };
      if (this.active < this.limit) run(); else this.queue.push(run);
    });
  }

  // A page's main picture through the MediaWiki API (PageImages). Resolves
  // to the picture's URL, 'missing' when the page has none, or null when the
  // wiki couldn't be asked (offline).
  async _pageImage(api, title, size) {
    const isFile = /^File:/i.test(title);
    const q = new URLSearchParams(isFile
      ? { action: 'query', titles: title.replace(/_/g, ' '), prop: 'imageinfo', iiprop: 'url', ...(size ? { iiurlwidth: String(size) } : {}), redirects: '1', format: 'json' }
      : { action: 'query', titles: title.replace(/_/g, ' '), prop: 'pageimages', pithumbsize: String(size || 640), redirects: '1', format: 'json' });
    try {
      const res = await this.fetch(`${api}?${q}`, { headers: { 'User-Agent': this.userAgent } });
      if (!res.ok) return null;
      const data = JSON.parse(Buffer.from(await res.arrayBuffer()).toString('utf8'));
      const page = Object.values(data?.query?.pages || {})[0];
      const info = page?.imageinfo?.[0];
      const src = isFile ? (info?.thumburl || info?.url) : page?.thumbnail?.source;
      return typeof src === 'string' && /^https:\/\//.test(src) ? src : 'missing';
    } catch {
      return null;
    }
  }

  async _download(target, file) {
    let res;
    try {
      const url = typeof target === 'function' ? await target() : target;
      if (url === null) return null;
      if (url === 'missing') { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(`${file}.missing`, String(this.now())); return null; }
      res = await this.fetch(url, { headers: { 'User-Agent': this.userAgent } });
    } catch {
      return null; // offline: try again next time, no marker
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (res.status === 404) { fs.writeFileSync(`${file}.missing`, String(this.now())); return null; }
      const type = res.headers?.get?.('content-type') || '';
      if (!res.ok || !/^image\//i.test(type)) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > MAX_BYTES) return null;
      fs.writeFileSync(`${file}.tmp`, buf);
      fs.renameSync(`${file}.tmp`, file);
      fs.rmSync(`${file}.missing`, { force: true });
      return file;
    } catch {
      return null;
    }
  }
}

// Cached files keep the wiki's name, but the bytes may differ (a resized
// SVG comes back as PNG), so the type served is read from the file itself.
function mimeOf(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.slice(0, 3).toString() === 'GIF') return 'image/gif';
  const head = buf.slice(0, 256).toString('utf8').trimStart();
  if (head.startsWith('<?xml') || head.startsWith('<svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

module.exports = { LibraryImages, nameVariants, candidates, spawnCandidates, mimeOf, SIZES };
