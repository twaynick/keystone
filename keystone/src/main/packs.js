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
//     "library": { ... },                  // see library.js
//     "art": { "steamAppId": 377160 } or { "cover": "cover.png", "hero": "hero.png" },
//     "launch": { "steamAppId": 377160 } or { "uri": "com.epicgames.launcher://apps/..." },
//     "offlineOnly": true, "offlineNote": "...", "memory": false,
//     "modsUi": { "Player/Health": { "control": "slider", "min": 0, "max": 100 } },
//     "teleport": { "lift": 200, "holdMs": 300 }            // tuning for memory teleports
//              or { "command": ["SetPlayerPos {x} {y} {z}"], "via": "console" }
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
    art: raw.art && typeof raw.art === 'object' ? raw.art : null,
    // How a game is launched from the Play button. Defaults to Steam when the
    // pack names a Steam app.
    launch: launchOf(raw),
    // Mod safety. "memory": false means Keystone never opens the game's
    // memory (online-only games). "offlineOnly" games have mods, but they're
    // off until the player turns them on for that game and acknowledges the
    // warning; reading memory while connected to an anti-cheat server is what
    // gets accounts banned.
    memory: raw.memory !== false,
    offlineOnly: Boolean(raw.offlineOnly),
    offlineNote: raw.offlineNote ? String(raw.offlineNote) : null,
    // Presentation for known mods, keyed by "Group/Name" as in the table:
    // { label, control: toggle|slider|steps|apply, value, min, max, step, values }
    modsUi: raw.modsUi && typeof raw.modsUi === 'object' ? raw.modsUi : {},
    teleport: teleportOf(raw.teleport),
  };
}

// Teleport settings. Without a pack entry, teleports write the position mods
// with the defaults below.
//   lift:    added to the current height when a waypoint has no height of its
//            own, so the player lands on top of terrain instead of inside it
//   holdMs:  how long the new position is held; many games snap the player
//            back to where physics last had them if it's written only once
//   command: for games with a teleport command (works without mods); lines
//            with {z} are skipped when the waypoint has no height
function teleportOf(t) {
  const out = { lift: 0, holdMs: 300, command: null, via: 'console' };
  if (!t || typeof t !== 'object') return out;
  if (Number.isFinite(Number(t.lift))) out.lift = Number(t.lift);
  if (Number.isFinite(Number(t.holdMs))) out.holdMs = Math.min(2000, Math.max(0, Number(t.holdMs)));
  const lines = (Array.isArray(t.command) ? t.command : [t.command]).filter((l) => typeof l === 'string' && l.trim());
  if (lines.length) out.command = lines.map((l) => l.trim());
  if (t.via === 'rcon') out.via = 'rcon';
  return out;
}

function launchOf(raw) {
  const steam = Number(raw.launch?.steamAppId ?? raw.art?.steamAppId);
  if (Number.isInteger(steam) && steam > 0) return { kind: 'steam', uri: `steam://rungameid/${steam}` };
  // Other stores: a launcher URI the pack spells out (Epic, Xbox, GOG Galaxy).
  if (typeof raw.launch?.uri === 'string' && /^(com\.epicgames\.launcher|steam|goggalaxy|ms-xbl-[0-9a-f]+|xbox):\/\//i.test(raw.launch.uri)) {
    return { kind: 'uri', uri: raw.launch.uri };
  }
  return null;
}

function findPack(packs, exe) {
  const key = String(exe).toLowerCase();
  return packs.find((p) => !p.error && p.exe.includes(key)) || null;
}

module.exports = { loadPacks, findPack };
