'use strict';

const fs = require('fs');
const path = require('path');

// Per-game settings on disk: <dataDir>/games/<exe>.json
// Holds saved profiles, remembered tables, and overlay settings.

const DEFAULTS = () => ({
  version: 1,
  profiles: {},        // name -> { toggles: { [recordId]: { enabled, target } }, updatedAt }
  activeProfile: null, // last profile applied or saved
  autoApply: true,     // apply activeProfile when this game is attached
  tables: [],          // absolute paths of .CT files to reload on attach
  overlay: OVERLAY_DEFAULTS(),
  library: { notes: {} },  // "catalog:id" -> your note
  hotkeys: {},         // record id -> accelerator ("Ctrl+num1")
  pinned: [],          // record ids shown first and in the overlay's Mods panel
  myMods: [],          // mods made with the value finder: [{ id, name, type, address, offsets }]
});

// null means "use the game pack's value" until the user changes it.
const OVERLAY_DEFAULTS = () => ({
  roles: null,         // { x, y, z, facing } -> record ids
  map: null,           // { image: abs path, bounds } ; bounds may be null until calibrated
  waypoints: null,     // [{ id, name, x, y, z }] ; seeded from the pack on first attach
  checklists: null,    // [{ id, name, items: [{ id, text, done }] }] ; seeded from the pack once
  activeList: null,    // checklist shown in the overlay
  crosshair: null,     // see shared/crosshair.js; null = defaults (off)
  pcstats: { cpu: true, ram: true, clock: true, session: true },
  tracked: null,       // waypoint id shown with distance/direction on the minimap
  readouts: [],        // record ids shown as live values in the overlay
  notes: '',
  zoom: 1,
  // Positions are fractions of the screen so a resolution change doesn't
  // push panels off-screen.
  panels: {
    readouts: { x: 0.015, y: 0.03, visible: true },
    minimap: { x: 0.80, y: 0.03, visible: true, size: 'm' },
    info: { x: 0.015, y: 0.32, visible: true },
    mods: { x: 0.80, y: 0.45, visible: true },
    timers: { x: 0.80, y: 0.62, visible: true },
    checklist: { x: 0.015, y: 0.62, visible: true },
    identify: { x: 0.40, y: 0.80, visible: true },
    // Off until asked for: most people only want it while troubleshooting.
    pcstats: { x: 0.80, y: 0.80, visible: false },
  },
});

class GameStore {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'games');
    fs.mkdirSync(this.dir, { recursive: true });
    this.cache = new Map();
  }

  file(key) {
    // Exe names are user-controlled text; keep the filename boring.
    return path.join(this.dir, `${String(key).toLowerCase().replace(/[^a-z0-9._-]/g, '_')}.json`);
  }

  load(key) {
    if (this.cache.has(key)) return this.cache.get(key);
    const f = this.file(key);
    let data = DEFAULTS();
    if (fs.existsSync(f)) {
      try {
        const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
        data = { ...DEFAULTS(), ...raw };
        // Files from older versions lack newer overlay keys; fill them in
        // one level deep so a missing panel doesn't break the overlay.
        const ov = OVERLAY_DEFAULTS();
        data.overlay = { ...ov, ...(raw.overlay || {}), panels: { ...ov.panels } };
        for (const [k, v] of Object.entries(raw.overlay?.panels || {})) data.overlay.panels[k] = { ...ov.panels[k], ...v };
      } catch {
        // A broken file shouldn't stop the game attaching. Keep it aside so
        // nothing is lost, and start clean.
        fs.renameSync(f, `${f}.corrupt-${Date.now()}`);
      }
    }
    this.cache.set(key, data);
    return data;
  }

  save(key, data) {
    this.cache.set(key, data);
    const f = this.file(key);
    const tmp = `${f}.tmp`;
    // Write-then-rename so a crash mid-write leaves the old file intact
    // instead of a half-written one that loses every profile.
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, f);
  }

  update(key, fn) {
    const data = this.load(key);
    fn(data);
    this.save(key, data);
    return data;
  }
}

module.exports = { GameStore, OVERLAY_DEFAULTS };
