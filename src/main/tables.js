'use strict';

const fs = require('fs');
const path = require('path');

// Cheat tables that load by themselves when their game starts:
//
//   <app>/tables/<game>/*.ct          bundled: in the repo, shipped in the installer
//   %APPDATA%\Keystone\tables\<game>\ your own: this PC only, never in a build
//
// <game> is the game pack's folder name (fallout-4, ark-survival-ascended),
// or the exe name without ".exe" for games without a pack.
//
// Credit for a table goes in credits.json next to it:
//   { "Fallout4.CT": { "author": "Someone", "url": "https://...", "note": "Shared with permission" } }
// and shows on the Mods tab.

function folderName(pack, game) {
  if (pack?.id) return pack.id;
  return String(game?.key || game?.name || '').toLowerCase().replace(/\.exe$/, '').replace(/[^a-z0-9._-]/g, '_');
}

function readCredits(dir) {
  const f = path.join(dir, 'credits.json');
  if (!fs.existsSync(f)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

// [{ file, name, source: 'bundled'|'mine', author, url, note }]
function autoTables({ bundledDir, userDir }, pack, game) {
  const name = folderName(pack, game);
  if (!name) return [];
  const out = [];
  for (const [root, source] of [[bundledDir, 'bundled'], [userDir, 'mine']]) {
    if (!root) continue;
    const dir = path.join(root, name);
    if (!fs.existsSync(dir)) continue;
    const credits = readCredits(dir);
    for (const f of fs.readdirSync(dir).filter((x) => /\.ct$/i.test(x)).sort()) {
      const c = credits[f] || {};
      out.push({
        file: path.join(dir, f),
        name: f.replace(/\.ct$/i, ''),
        source,
        author: typeof c.author === 'string' ? c.author.slice(0, 80) : null,
        // Only web links: the Mods tab opens them in Keystone's browser.
        url: typeof c.url === 'string' && /^https?:\/\//.test(c.url) ? c.url : null,
        note: typeof c.note === 'string' ? c.note.slice(0, 200) : null,
      });
    }
  }
  return out;
}

module.exports = { autoTables, folderName };
