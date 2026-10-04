'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const MapMath = require('../shared/map-math');

// Overlay data for the attached game: where the player is, the map, waypoints,
// live readouts and info cards. Pure Node so it can be tested without
// Electron; the overlay window and the desktop Overlay tab both read from it.
//
// Pack values are defaults; anything the user sets is stored per game and wins.

const ROLES = ['x', 'y', 'z', 'facing'];
const MAX_WAYPOINTS = 200;

class OverlayModel {
  constructor(controller, { dataDir }) {
    this.c = controller;
    this.mapsDir = path.join(dataDir, 'maps');
  }

  get session() { return this.c.session; }
  get pack() { return this.c.pack; }

  get game() { return this.c.game; }

  _data() {
    return this.c.store.load(this.game.key).overlay;
  }

  _update(fn) {
    this.c.store.update(this.game.key, (d) => fn(d.overlay));
    this.c.emit('overlay');
  }

  // Map, waypoints, notes and layout only need a selected game; position and
  // stats also need a memory session (see _requireSession).
  _require() {
    if (!this.game) throw new Error('Choose a game first.');
  }

  _requireSession() {
    this._require();
    if (!this.session) throw new Error('Position and stats need mods, which aren\u2019t available for this game.');
  }

  // Called by the controller right after a game is attached and its tables load.
  onAttach() {
    const ov = this._data();
    if (ov.waypoints === null && this.pack?.waypoints.length) {
      // Copy pack waypoints into the game's settings once, so the user can
      // rename or delete them like their own.
      this.c.store.update(this.game.key, (d) => {
        d.overlay.waypoints = this.pack.waypoints.slice(0, MAX_WAYPOINTS).map((w) => ({
          id: newId(), name: String(w.name || 'Waypoint'), x: Number(w.x) || 0, y: Number(w.y) || 0, z: w.z ?? null,
        }));
      });
    }
  }

  // ---------- position ----------
  roles() {
    const ov = this._data();
    if (ov.roles) return { ...ov.roles };
    if (!this.session) return {};
    // Pack roles are mod names like "Position/X"; match them against the
    // loaded tables' group path + name.
    const out = {};
    const byPath = new Map(this.session.records.filter((r) => r.kind === 'value')
      .map((r) => [r.groupPath.concat(r.name).join('/').toLowerCase(), r.id]));
    for (const role of ROLES) {
      const name = this.pack?.position?.[role];
      if (name) out[role] = byPath.get(String(name).toLowerCase()) || null;
    }
    return out;
  }

  setRole(role, recordId) {
    this._requireSession();
    if (!ROLES.includes(role)) throw new Error(`Unknown position field "${role}".`);
    if (recordId) {
      const rec = this.session.getRecord(recordId);
      if (!rec || rec.kind !== 'value') throw new Error('Pick a mod with a number value.');
    }
    const current = this.roles();
    this._update((ov) => { ov.roles = { ...current, [role]: recordId || null }; });
    return true;
  }

  position() {
    if (!this.session) return null;
    const roles = this.roles();
    const read = (id) => {
      const st = id ? this.session.state.get(id) : null;
      return st && st.status === 'ok' && Number.isFinite(st.current) ? st.current : null;
    };
    const x = read(roles.x);
    const y = read(roles.y);
    if (x === null || y === null) return null;
    return { x, y, z: read(roles.z), facing: read(roles.facing) };
  }

  // ---------- map ----------
  map() {
    const ov = this._data();
    const m = ov.map || this.pack?.map || null;
    if (!m?.image || !fs.existsSync(m.image)) return null;
    return { image: m.image, bounds: MapMath.validBounds(m.bounds) ? m.bounds : null, custom: Boolean(ov.map) };
  }

  setMapImage(srcPath) {
    this._require();
    const ext = path.extname(srcPath).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) throw new Error('Use a PNG, JPG or WebP image.');
    fs.mkdirSync(this.mapsDir, { recursive: true });
    // Copy the image into Keystone's own folder so moving or deleting the
    // original screenshot doesn't break the minimap.
    const dest = path.join(this.mapsDir, `${this.game.key.replace(/[^a-z0-9._-]/g, '_')}-${Date.now()}${ext}`);
    fs.copyFileSync(srcPath, dest);
    const old = this._data().map?.image;
    this._update((ov) => { ov.map = { image: dest, bounds: null }; });
    if (old && old.startsWith(this.mapsDir) && old !== dest) fs.rm(old, { force: true }, () => {});
    return this.map();
  }

  setMapBounds(bounds) {
    this._require();
    const b = { left: Number(bounds.left), right: Number(bounds.right), top: Number(bounds.top), bottom: Number(bounds.bottom) };
    if (!MapMath.validBounds(b)) throw new Error('Each edge needs a number, and opposite edges can’t be equal.');
    const m = this.map();
    if (!m) throw new Error('Choose a map image first.');
    this._update((ov) => { ov.map = { image: m.image, bounds: b }; });
    return b;
  }

  calibrate(a, b, width, height) {
    this._require();
    return this.setMapBounds(MapMath.boundsFromTwoPoints(a, b, width, height));
  }

  resetMap() {
    this._require();
    const old = this._data().map?.image;
    this._update((ov) => { ov.map = null; });
    if (old && old.startsWith(this.mapsDir)) fs.rm(old, { force: true }, () => {});
    return this.map();
  }

  // ---------- waypoints ----------
  waypoints() {
    return this._data().waypoints || [];
  }

  addWaypoint({ name, x, y, z } = {}) {
    this._require();
    let pos = { x: Number(x), y: Number(y), z: z ?? null };
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
      const here = this.position();
      if (!here) throw new Error('Keystone doesn’t know where you are. Set the position mods in the Overlay tab first.');
      pos = { x: here.x, y: here.y, z: here.z };
    }
    const list = this.waypoints();
    if (list.length >= MAX_WAYPOINTS) throw new Error(`That's the limit of ${MAX_WAYPOINTS} waypoints. Delete some first.`);
    const wp = { id: newId(), name: cleanText(name, 40) || `Waypoint ${list.length + 1}`, ...pos };
    this._update((ov) => { ov.waypoints = [...list, wp]; });
    return wp;
  }

  updateWaypoint(id, patch) {
    this._require();
    const list = this.waypoints();
    const wp = list.find((w) => w.id === id);
    if (!wp) throw new Error('That waypoint no longer exists.');
    const next = { ...wp };
    if (patch.name !== undefined) next.name = cleanText(patch.name, 40) || wp.name;
    for (const k of ['x', 'y']) if (patch[k] !== undefined) {
      const n = Number(patch[k]);
      if (!Number.isFinite(n)) throw new Error(`${k.toUpperCase()} must be a number.`);
      next[k] = n;
    }
    this._update((ov) => { ov.waypoints = list.map((w) => (w.id === id ? next : w)); });
    return next;
  }

  removeWaypoint(id) {
    this._require();
    this._update((ov) => {
      ov.waypoints = this.waypoints().filter((w) => w.id !== id);
      if (ov.tracked === id) ov.tracked = null;
    });
    return true;
  }

  setTracked(id) {
    this._require();
    if (id && !this.waypoints().some((w) => w.id === id)) throw new Error('That waypoint no longer exists.');
    this._update((ov) => { ov.tracked = id || null; });
    return true;
  }

  // ---------- readouts, notes, layout ----------
  setReadouts(ids) {
    this._requireSession();
    const valid = (ids || []).filter((id) => this.session.getRecord(id)?.kind === 'value').slice(0, 12);
    this._update((ov) => { ov.readouts = valid; });
    return valid;
  }

  setNotes(text) {
    this._require();
    this._update((ov) => { ov.notes = String(text ?? '').slice(0, 4000); });
    return true;
  }

  setPanel(id, patch) {
    this._require();
    const ov = this._data();
    if (!ov.panels[id]) throw new Error(`Unknown panel "${id}".`);
    const next = { ...ov.panels[id] };
    if (patch.x !== undefined) next.x = clamp01(patch.x);
    if (patch.y !== undefined) next.y = clamp01(patch.y);
    if (patch.visible !== undefined) next.visible = Boolean(patch.visible);
    if (patch.size !== undefined && ['s', 'm', 'l'].includes(patch.size)) next.size = patch.size;
    this._update((o) => { o.panels = { ...o.panels, [id]: next }; });
    return next;
  }

  setZoom(z) {
    this._require();
    const n = Math.min(8, Math.max(0.25, Number(z) || 1));
    this._update((ov) => { ov.zoom = n; });
    return n;
  }

  // ---------- what the overlay renders ----------
  state() {
    if (!this.game) return { attached: false };
    const ov = this._data();
    const map = this.map();
    const recs = new Map((this.session?.records || []).map((r) => [r.id, r]));
    return {
      attached: true,
      mods: Boolean(this.session),
      game: this.game.demo ? 'Demo game' : this.game.name.replace(/\.exe$/i, ''),
      pack: this.pack ? this.pack.name : null,
      roles: this.roles(),
      map: map ? {
        // Served by the ksmap:// protocol in main.js; mtime busts the image cache
        // when the user picks a new map.
        url: `ksmap://map/${encodeURIComponent(this.game.key)}?v=${fs.statSync(map.image).mtimeMs}`,
        bounds: map.bounds,
        custom: map.custom,
      } : null,
      waypoints: this.waypoints(),
      tracked: ov.tracked,
      readouts: ov.readouts.filter((id) => recs.has(id)).map((id) => ({ id, name: recs.get(id).name, valueType: recs.get(id).valueType })),
      info: this.pack?.info || [],
      notes: ov.notes,
      panels: ov.panels,
      zoom: ov.zoom,
    };
  }

  values() {
    if (!this.game || !this.session) return { pos: null, readouts: {} };
    const out = {};
    for (const id of this._data().readouts) {
      const st = this.session.state.get(id);
      if (st) out[id] = { current: st.current, status: st.status, enabled: st.enabled };
    }
    return { pos: this.position(), readouts: out };
  }
}

function newId() {
  return crypto.randomBytes(6).toString('base64url');
}

function cleanText(s, max) {
  return String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function clamp01(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(0.98, Math.max(0, n)) : 0;
}

module.exports = { OverlayModel, ROLES };
