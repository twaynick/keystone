'use strict';

const fs = require('fs');
const path = require('path');

// Game art for the library and game pages, served to the UI as
// ksart://cover/<pack id> and ksart://hero/<pack id>.
//
// Packs either ship their own images ("art": { "cover": "cover.png",
// "hero": "hero.png" }) or name a Steam app ("art": { "steamAppId": 377160 }).
// Steam art is downloaded by the user's PC from Steam's public image CDN the
// first time it's shown, then cached, so Keystone never bundles game art and
// works offline after the first look.

const STEAM = {
  cover: (id) => `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/library_600x900.jpg`,
  hero: (id) => `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/library_hero.jpg`,
};
const MAX_BYTES = 8 * 1024 * 1024;

class ArtCache {
  constructor({ dataDir, fetchImpl }) {
    this.dir = path.join(dataDir, 'art');
    this.fetch = fetchImpl || ((url) => fetch(url));
    this.pending = new Map();
  }

  // Resolves to a local file path, or null when there's no art.
  async file(pack, kind) {
    if (!pack || !['cover', 'hero'].includes(kind)) return null;
    const local = pack.art?.[kind];
    if (local) {
      const abs = path.resolve(pack.folder, local);
      // Stay inside the pack folder.
      if (abs.startsWith(path.resolve(pack.folder) + path.sep) && fs.existsSync(abs)) return abs;
      return null;
    }
    const appId = Number(pack.art?.steamAppId);
    if (!Number.isInteger(appId) || appId <= 0) return null;
    const file = path.join(this.dir, `${appId}-${kind}.jpg`);
    if (fs.existsSync(file)) return file;
    if (fs.existsSync(`${file}.missing`)) return null;
    // One download per image even if the library asks for it twice at once.
    if (!this.pending.has(file)) this.pending.set(file, this._download(STEAM[kind](appId), file).finally(() => this.pending.delete(file)));
    return this.pending.get(file);
  }

  async _download(url, file) {
    try {
      const res = await this.fetch(url);
      if (!res.ok) {
        // Some games have no hero art; remember that so we don't ask again.
        if (res.status === 404) { fs.mkdirSync(this.dir, { recursive: true }); fs.writeFileSync(`${file}.missing`, ''); }
        return null;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > MAX_BYTES) return null;
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(`${file}.tmp`, buf);
      fs.renameSync(`${file}.tmp`, file);
      return file;
    } catch {
      return null; // offline: the UI shows the generated tile instead
    }
  }
}

module.exports = { ArtCache };
