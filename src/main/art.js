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
// Games released since about 2024 keep their art under hashed names
// ("steam/apps/2483190/711e.../library_capsule.jpg") and the plain URLs above
// 404. Steam's store API names the current files, so a 404 asks it once.
const STORE_ITEMS = (id) => `https://api.steampowered.com/IStoreBrowseService/GetItems/v1?input_json=${encodeURIComponent(JSON.stringify({
  ids: [{ appid: id }], context: { language: 'english', country_code: 'US' }, data_request: { include_assets: true },
}))}`;
const STORE_ASSETS = 'https://shared.akamai.steamstatic.com/store_item_assets/';
const STORE_KEYS = { cover: ['library_capsule_2x', 'library_capsule'], hero: ['library_hero_2x', 'library_hero'] };
const MAX_BYTES = 8 * 1024 * 1024;
// A game with no art may get some later (new releases often do), so "no art"
// is remembered for two weeks rather than for good.
const MISSING_RETRY_MS = 14 * 24 * 3600 * 1000;

class ArtCache {
  constructor({ dataDir, fetchImpl, now = () => Date.now() }) {
    this.dir = path.join(dataDir, 'art');
    this.fetch = fetchImpl || ((url) => fetch(url));
    this.now = now;
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
    try {
      if (this.now() - fs.statSync(`${file}.missing`).mtimeMs < MISSING_RETRY_MS) return null;
    } catch { /* no marker */ }
    // One download per image even if the library asks for it twice at once.
    if (!this.pending.has(file)) this.pending.set(file, this._steam(appId, kind, file).finally(() => this.pending.delete(file)));
    return this.pending.get(file);
  }

  async _steam(appId, kind, file) {
    let got = await this._download(STEAM[kind](appId), file);
    if (got === 'missing') {
      const alt = await this._storeAsset(appId, kind);
      if (alt) got = await this._download(alt, file);
    }
    // Some games have no hero art; remember that so we don't keep asking.
    if (got === 'missing') { fs.mkdirSync(this.dir, { recursive: true }); fs.writeFileSync(`${file}.missing`, ''); }
    return got === 'ok' ? file : null;
  }

  // The hashed art URL from Steam's store API, or null.
  async _storeAsset(appId, kind) {
    try {
      const res = await this.fetch(STORE_ITEMS(appId));
      if (!res.ok) return null;
      const assets = (await res.json())?.response?.store_items?.[0]?.assets;
      const format = assets?.asset_url_format;
      // Only ever this app's folder on Steam's CDN, whatever the reply says.
      if (typeof format !== 'string' || !format.startsWith(`steam/apps/${appId}/\${FILENAME}`)) return null;
      const name = STORE_KEYS[kind].map((k) => assets[k]).find((n) => typeof n === 'string' && /^[0-9a-f]{40}\/[\w.-]+\.(jpg|png)$/.test(n));
      return name ? STORE_ASSETS + format.replace('${FILENAME}', name) : null;
    } catch {
      return null;
    }
  }

  // 'ok' (saved), 'missing' (Steam has no such file) or 'error'.
  async _download(url, file) {
    try {
      const res = await this.fetch(url);
      if (!res.ok) return res.status === 404 ? 'missing' : 'error';
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > MAX_BYTES) return 'error';
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(`${file}.tmp`, buf);
      fs.renameSync(`${file}.tmp`, file);
      return 'ok';
    } catch {
      return 'error'; // offline: the UI shows the generated tile instead
    }
  }
}

module.exports = { ArtCache };
