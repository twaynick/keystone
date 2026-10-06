'use strict';

const fs = require('fs');
const path = require('path');
const { Marked } = require('marked');
const { LibraryImages, candidates, spawnCandidates, SIZES } = require('./library-images');

// The Library: per-game knowledge pages.
//
// Sources, merged into one searchable list:
//   - catalog sections: entries from the pack's catalogs (creatures, items)
//   - pack guides:      Markdown files shipped in the pack's guides/ folder
//   - your guides:      Markdown files you drop in %APPDATA%\Keystone\guides\<pack id>\
// Plus personal notes on any entry, saved per game.
//
// pack.json:
//   "library": {
//     "sections": [{ "id": "creatures", "label": "Creatures", "catalog": "creatures" }, ...],
//     "guides": "guides",
//     "wiki": { "label": "ARK Wiki", "page": "https://ark.wiki.gg/wiki/{name}" },
//     "links": [{ "label": "...", "url": "https://..." }],
//     "images": { ... }   // pictures from the wiki, see library-images.js
//   }

const MAX_NOTE = 4000;

// Guides come from files anyone could have edited, and get shown with
// innerHTML. So: raw HTML in Markdown is escaped, links must be http(s),
// and images become plain links (no remote loads from inside the app).
const md = new Marked({
  gfm: true,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, tokens }) {
      const label = this.parser.parseInline(tokens);
      if (!/^https?:\/\//i.test(href || '')) return label;
      return `<a href="${escapeAttr(href)}" data-external="1">${label}</a>`;
    },
    image({ href, text }) {
      if (!/^https?:\/\//i.test(href || '')) return escapeHtml(text || '');
      return `<a href="${escapeAttr(href)}" data-external="1">${escapeHtml(text || 'image')}</a>`;
    },
  },
});

class LibraryModel {
  constructor(controller, { dataDir }) {
    this.c = controller;
    this.guidesRoot = path.join(dataDir, 'guides');
    // LibraryImages instance, set by main (it downloads with Electron's net).
    this.images = null;
  }

  // ---------- pictures ----------
  _imgSpec() {
    const s = this.spec?.images;
    return this.images && LibraryImages.valid(s) ? s : null;
  }

  // What pictures a catalog has, for the renderer to decide what to show.
  pictures(catalog) {
    const s = this._imgSpec();
    const c = s?.catalogs?.[catalog];
    if (!c) return null;
    return {
      thumb: Array.isArray(c.thumb) && c.thumb.length > 0,
      hero: Array.isArray(c.hero) && c.hero.length > 0,
      // A second picture style worth switching the grid to: ARK's dossier
      // drawings. Where the big picture is the same file as the small one,
      // there's nothing to switch.
      altStyle: Array.isArray(c.hero) && /dossier/i.test(String(c.hero[0] || '')) ? 'Dossiers' : null,
      spawnMaps: c.spawnMaps ? (s.spawnMaps || []).map((m, index) => ({ index, name: String(m.name) })) : [],
      credit: s.credit ? String(s.credit) : null,
      creditUrl: /^https:\/\//.test(s.creditUrl || '') ? s.creditUrl : null,
    };
  }

  _entry(catalog, id) {
    const e = this._catalog(catalog).find((x) => x.id === id);
    if (!e) throw new Error('That entry isn\u2019t in the list.');
    return e;
  }

  _entryName(catalog, id) {
    return this._entry(catalog, id).name;
  }

  // Local file for kslib:// requests, or null. 'card' and 'carddossier'
  // are the thumb and hero pictures at the Library grid's card size: the
  // list's 96 px thumbs look soft that big, and full heroes are wasteful.
  async pictureFile(kind, catalog, id) {
    const s = this._imgSpec();
    const KIND = { thumb: ['thumb', SIZES.thumb], hero: ['hero', SIZES.hero], card: ['thumb', SIZES.card], carddossier: ['hero', SIZES.card] };
    if (!s || !KIND[kind] || !this.c.game) return null;
    const [templates, size] = KIND[kind];
    return this.images.first(s, candidates(s, catalog, templates, this._entry(catalog, id)), size);
  }

  async spawnFile(part, index, catalog, id) {
    const s = this._imgSpec();
    const m = s?.spawnMaps?.[index];
    if (!m || !this.c.game || !s.catalogs?.[catalog]?.spawnMaps) return null;
    if (part === 'map') return this.images.file(s, String(m.map).replace(/ /g, '_'), SIZES.map);
    return this.images.first(s, spawnCandidates(s, index, this._entryName(catalog, id)), null);
  }

  get pack() { return this.c.pack; }
  get spec() { return this.pack?.library || null; }

  _require() {
    if (!this.c.game) throw new Error('Choose a game first.');
  }

  // Folder for your own guides for the current game.
  userGuidesDir() {
    this._require();
    const id = this.pack?.id || this.c.game.key.replace(/[^a-z0-9._-]/g, '_');
    return path.join(this.guidesRoot, id);
  }

  info() {
    if (!this.c.game) return { available: false, reason: 'Choose a game first.' };
    const spec = this.spec || {};
    const sections = (spec.sections || []).filter((s) => this.pack?.commands?.catalogs?.[s.catalog] || this.pack?.library?.catalogs?.[s.catalog]);
    return {
      available: true,
      game: this.c.snapshot().displayName,
      sections: sections.map((s) => ({ id: s.id, label: s.label, catalog: s.catalog, idLabel: s.idLabel || 'ID', pictures: this.pictures(s.catalog) })),
      guides: this.guideList(),
      wiki: spec.wiki ? { label: spec.wiki.label } : null,
      links: (spec.links || []).filter((l) => /^https:\/\//.test(l.url)),
      tools: this.c.identify?.spec ? [{ id: 'identify', title: String(this.c.identify.spec.title || 'Identifier') }] : [],
      userGuidesDir: this.userGuidesDir(),
    };
  }

  // ---------- catalogs ----------
  _catalog(name) {
    // Catalogs are shared with the command center when the pack has one.
    const file = this.pack?.library?.catalogs?.[name] || this.pack?.commands?.catalogs?.[name];
    if (!file) throw new Error(`No ${name} list for this game.`);
    if (this.pack.commands?.catalogs?.[name]) return this.c.commands.catalog(name);
    const abs = path.resolve(this.pack.folder, file);
    this._cache = this._cache || new Map();
    if (!this._cache.has(abs)) this._cache.set(abs, JSON.parse(fs.readFileSync(abs, 'utf8')));
    return this._cache.get(abs);
  }

  entries(catalog) {
    this._require();
    return this._catalog(catalog);
  }

  entry(catalog, id) {
    this._require();
    const e = this._catalog(catalog).find((x) => x.id === id);
    if (!e) throw new Error('That entry isn’t in the list.');
    const notes = this.c.store.load(this.c.game.key).library?.notes || {};
    const commandActions = (this.pack?.commands?.actions || []).filter((a) => a.catalog === catalog).map((a) => ({ id: a.id, label: a.label }));
    return {
      ...e,
      catalog,
      pictures: this.pictures(catalog),
      wikiUrl: this._wikiUrl(e),
      note: notes[`${catalog}:${id}`] || '',
      commandActions,
    };
  }

  _wikiUrl(e) {
    // Entries that know their exact wiki page (games whose wiki titles carry
    // suffixes like "(Fallout 4)") link straight to it.
    const base = this.spec?.wiki?.base;
    if (base && typeof e.page === 'string' && /^\/wiki\/[^\s]+$/.test(e.page)) return base + e.page;
    const tpl = this.spec?.wiki?.page;
    if (!tpl) return null;
    // Wiki page titles use underscores; variants like "(Alpha)" stay as-is.
    return tpl.replace('{name}', encodeURIComponent(e.name.replace(/ /g, '_')).replace(/%2F/g, '/'));
  }

  setNote(catalog, id, text) {
    this._require();
    const note = String(text ?? '').slice(0, MAX_NOTE);
    this.c.store.update(this.c.game.key, (d) => {
      d.library = d.library || { notes: {} };
      d.library.notes = d.library.notes || {};
      if (note.trim()) d.library.notes[`${catalog}:${id}`] = note;
      else delete d.library.notes[`${catalog}:${id}`];
    });
    return true;
  }

  // ---------- guides ----------
  _guideDirs() {
    const dirs = [];
    if (this.pack && this.spec?.guides) dirs.push({ dir: path.resolve(this.pack.folder, this.spec.guides), source: 'pack' });
    if (this.c.game) dirs.push({ dir: this.userGuidesDir(), source: 'mine' });
    return dirs;
  }

  guideList() {
    const out = [];
    for (const { dir, source } of this._guideDirs()) {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter((x) => /\.md$/i.test(x)).sort()) {
        const text = fs.readFileSync(path.join(dir, f), 'utf8');
        out.push({ id: `${source}:${f}`, title: titleOf(text, f), source, summary: summaryOf(text) });
      }
    }
    return out;
  }

  guide(id) {
    this._require();
    const [source, file] = String(id).split(/:(.+)/);
    const base = this._guideDirs().find((d) => d.source === source);
    // The id comes from the renderer; refuse anything that isn't a plain
    // .md file name inside the guides folder.
    if (!base || !/^[^\\/]+\.md$/i.test(file || '')) throw new Error('That guide doesn’t exist.');
    const abs = path.join(base.dir, file);
    if (!fs.existsSync(abs)) throw new Error('That guide doesn’t exist any more.');
    const text = fs.readFileSync(abs, 'utf8');
    return { id, title: titleOf(text, file), source, html: md.parse(text) };
  }

  // ---------- search ----------
  search(query, { limit = 40 } = {}) {
    this._require();
    const q = String(query || '').trim().toLowerCase();
    if (q.length < 2) return [];
    const hits = [];
    for (const s of this.info().sections) {
      for (const e of this._catalog(s.catalog)) {
        const n = e.name.toLowerCase();
        if (n.includes(q)) hits.push({ kind: 'entry', catalog: s.catalog, section: s.label, id: e.id, title: e.name, sub: [e.category, e.map].filter(Boolean).join(', '), rank: n === q ? 0 : n.startsWith(q) ? 1 : 2 });
      }
    }
    for (const g of this.guideList()) {
      const t = g.title.toLowerCase();
      if (t.includes(q) || g.summary.toLowerCase().includes(q)) hits.push({ kind: 'guide', id: g.id, title: g.title, sub: g.source === 'mine' ? 'Your guide' : 'Guide', rank: t.includes(q) ? 1 : 3 });
    }
    hits.sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title));
    return hits.slice(0, limit).map(({ rank, ...h }) => h);
  }
}

function titleOf(text, file) {
  const m = text.match(/^#\s+(.+)$/m);
  return (m ? m[1] : file.replace(/\.md$/i, '').replace(/[-_]/g, ' ')).trim();
}

function summaryOf(text) {
  const para = text.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !p.startsWith('#'));
  return (para || '').replace(/[*_`>#[\]()]/g, '').slice(0, 160);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const escapeAttr = escapeHtml;

module.exports = { LibraryModel };
