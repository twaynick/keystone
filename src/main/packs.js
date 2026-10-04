'use strict';

const fs = require('fs');
const path = require('path');

// Game packs: optional per-game folders that bundle what Keystone should
// know about a game.
//
//   packs/<id>/pack.json
//   {
//     "name": "Demo game",
//     "exe": ["demo.exe"],                 // process names this pack applies to
//     "table": "demo.ct",                  // loaded automatically on attach
//     "map": { "image": "map.png",
//              "bounds": { "left": -3500, "right": 3500, "top": 2200, "bottom": -2200 } },
//     "position": { "x": "Position/X", "y": "Position/Y",   // mod names (group/name)
//                   "z": "Position/Z (height)", "facing": "Position/Facing (degrees)" },
//     "waypoints": [ { "name": "Quarry", "x": 1200, "y": -800 } ],
//     "info": [ { "title": "...", "body": "..." } ],
//     "commands": { ... },                 // see commands/model.js
//     "library": { ... }                   // see library.js
//   }
//
// Every field is optional. Anything the user changes in Keystone is saved per
// game and wins over the pack.

function loadPacks(dirs) {
  const packs = [];
  for (const dir of dirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const folder = path.join(dir, entry.name);
      const file = path.join(folder, 'pack.json');
      if (!fs.existsSync(file)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        packs.push(normalize(raw, folder, entry.name));
      } catch (err) {
        // One broken pack shouldn't hide the others.
        packs.push({ id: entry.name, folder, error: `pack.json: ${err.message}`, exe: [] });
      }
    }
  }
  return packs;
}

function normalize(raw, folder, id) {
  const rel = (p) => (p ? path.resolve(folder, p) : null);
  return {
    id,
    folder,
    name: String(raw.name || id),
    exe: (Array.isArray(raw.exe) ? raw.exe : [raw.exe]).filter(Boolean).map((e) => String(e).toLowerCase()),
    table: rel(raw.table),
    map: raw.map?.image ? { image: rel(raw.map.image), bounds: raw.map.bounds || null } : null,
    position: raw.position || null,
    waypoints: Array.isArray(raw.waypoints) ? raw.waypoints : [],
    info: Array.isArray(raw.info) ? raw.info.map((c) => ({ title: String(c.title || ''), body: String(c.body || '') })) : [],
    commands: raw.commands && typeof raw.commands === 'object' ? raw.commands : null,
    library: raw.library && typeof raw.library === 'object' ? raw.library : null,
  };
}

function findPack(packs, exe) {
  const key = String(exe).toLowerCase();
  return packs.find((p) => !p.error && p.exe.includes(key)) || null;
}

module.exports = { loadPacks, findPack };
