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
//              or { "command": ["SetPlayerPos {x} {y} {z}"], "via": "console" },
//     "markers": "markers.json",          // marker layers for "map" (see markersOf)
//     "maps": [ { "id": "the-island", "name": "The Island", "units": "latlon",
//                 "bounds": { "left": 0, "right": 100, "top": 0, "bottom": 100 },
//                 "coords": { "lat": { "shift": 50, "div": 6850 }, "lon": { "shift": 50, "div": 6850 } },
//                 "markers": "markers/the-island.json", "image": "optional.png" } ],
//     "findMe": { "command": "ccc" }      // ARK-style: the command copies "X Y Z ..." to the clipboard
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
    maps: mapsOf(raw, folder),
    findMe: raw.findMe && typeof raw.findMe.command === 'string' && raw.findMe.command.trim()
      ? { command: raw.findMe.command.trim() } : null,
  };
}

// Map variants. Games with several worlds (ARK's maps) list them in "maps";
// a pack with a single "map" becomes one variant called "default", so the
// rest of Keystone only deals with variants.
//
// units "latlon": world X is longitude and Y is latitude, which is what the
// game shows its players. Waypoints and markers are then in lat/lon too.
// coords: how the game's own units (what ccc copies) turn into those:
//   lat = y / div + shift, lon = x / div + shift
function mapsOf(raw, folder) {
  const rel = (p) => (p ? path.resolve(folder, p) : null);
  const list = Array.isArray(raw.maps) ? raw.maps
    : raw.map?.image || raw.markers ? [{ id: 'default', name: raw.map?.name || 'Map', image: raw.map?.image, bounds: raw.map?.bounds, markers: raw.markers }]
      : [];
  const seen = new Set();
  const out = [];
  for (const m of list) {
    const id = String(m?.id || '').trim();
    if (!id || seen.has(id) || !/^[a-z0-9._-]{1,40}$/i.test(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: String(m.name || id),
      units: m.units === 'latlon' ? 'latlon' : 'xy',
      image: rel(m.image),
      bounds: m.bounds || null,
      coords: coordsOf(m.coords),
      markers: markersOf(m.markers, folder, m.units === 'latlon'),
    });
  }
  return out;
}

function coordsOf(c) {
  const axis = (a) => (a && Number.isFinite(Number(a.shift)) && Number(a.div) ? { shift: Number(a.shift), div: Number(a.div) } : null);
  const lat = axis(c?.lat);
  const lon = axis(c?.lon);
  return lat && lon ? { lat, lon } : null;
}

// Marker layers, inline or from a JSON file next to pack.json:
//   { "credits": "...", "layers": [ { "id": "caves", "name": "Caves", "color": "#7cc4ff",
//       "shape": "circle|square|diamond|triangle", "points": [ { "name": "...", "x": 1, "y": 2, "note": "..." } ] } ] }
// Lat/lon maps may write points as { "lat": .., "lon": .. }.
const SHAPES = new Set(['circle', 'square', 'diamond', 'triangle']);
function markersOf(spec, folder, latlon) {
  if (!spec) return { credits: null, layers: [] };
  let data = spec;
  if (typeof spec === 'string') {
    const file = path.resolve(folder, spec);
    // Same rule as other pack files: nothing outside the pack's folder.
    if (!file.startsWith(path.resolve(folder) + path.sep)) return { credits: null, layers: [] };
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { credits: null, layers: [], error: `${spec} couldn't be read` }; }
  }
  const layers = [];
  for (const l of Array.isArray(data?.layers) ? data.layers : []) {
    const id = String(l?.id || '').trim();
    if (!id || layers.some((x) => x.id === id)) continue;
    const points = (Array.isArray(l.points) ? l.points : []).map((pt) => {
      const x = Number(latlon && pt.lon !== undefined ? pt.lon : pt.x);
      const y = Number(latlon && pt.lat !== undefined ? pt.lat : pt.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { name: String(pt.name || '').slice(0, 60), x, y, note: pt.note ? String(pt.note).slice(0, 200) : null };
    }).filter(Boolean);
    layers.push({
      id,
      name: String(l.name || id),
      color: /^#[0-9a-f]{6}$/i.test(l.color || '') ? l.color : '#ffffff',
      shape: SHAPES.has(l.shape) ? l.shape : 'circle',
      // Layers can start hidden when they'd crowd the map.
      on: l.on !== false,
      points,
    });
  }
  return { credits: data?.credits ? String(data.credits) : null, layers };
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
