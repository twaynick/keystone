'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const MapMath = require('../shared/map-math');
const Crosshair = require('../shared/crosshair');

// Overlay data for the attached game: where the player is, the map, waypoints,
// live readouts and info cards. Pure Node so it can be tested without
// Electron; the overlay window and the desktop Overlay tab both read from it.
//
// Pack values are defaults; anything the user sets is stored per game and wins.

const ROLES = ['x', 'y', 'z', 'facing'];
const MAX_WAYPOINTS = 200;
const MAX_LISTS = 20;
const MAX_ITEMS = 100;

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
    if (ov.checklists === null) {
      const lists = (this.pack?.checklists || []).slice(0, MAX_LISTS).map((l) => ({
        id: newId(), name: l.name, items: l.items.slice(0, MAX_ITEMS).map((text) => ({ id: newId(), text, done: false })),
      }));
      this.c.store.update(this.game.key, (d) => { d.overlay.checklists = lists; d.overlay.activeList = lists[0]?.id || null; });
    }
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

  // Live position from the game's memory, or null. livePosition() in
  // values() is this; position() falls back to "I'm here" for things like
  // dropping a waypoint where you are.
  position() {
    const live = this.livePosition();
    if (live) return live;
    const h = this.game ? this.here() : null;
    return h ? { x: h.x, y: h.y, z: h.z, facing: null, manual: true } : null;
  }

  livePosition() {
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

  // ---------- map variants ----------
  // Games with several worlds (ARK) have one variant per map; everything else
  // has a single variant. Packless games get a blank one so a custom map
  // image still works.
  variants() {
    const list = this.pack?.maps || [];
    return list.length ? list : [{ id: 'default', name: 'Map', units: 'xy', image: null, bounds: null, coords: null, markers: { credits: null, layers: [] } }];
  }

  variant() {
    const list = this.variants();
    return list.find((v) => v.id === this._data().variant) || list[0];
  }

  setVariant(id) {
    this._require();
    if (!this.variants().some((v) => v.id === id)) throw new Error('That map isn’t in this game’s pack.');
    this._update((ov) => { ov.variant = id; });
    return this.variant();
  }

  // Custom map images are kept per variant. Older settings files had one
  // custom map per game (ov.map); it belongs to the first variant.
  _custom(vid) {
    const ov = this._data();
    if (ov.customMaps && vid in ov.customMaps) return ov.customMaps[vid];
    return vid === this.variants()[0].id ? ov.map : null;
  }

  _setCustom(fn) {
    const vid = this.variant().id;
    const first = this.variants()[0].id;
    this._update((ov) => {
      const all = { ...(ov.customMaps || {}) };
      if (ov.map && !(first in all)) all[first] = ov.map;
      ov.map = null;
      all[vid] = fn(all[vid] || null);
      ov.customMaps = all;
    });
  }

  // ---------- map ----------
  // { image (path or null), bounds, custom } or null. A lat/lon map has
  // bounds without an image, so the minimap can draw a grid, markers and
  // your position before you add a picture.
  map() {
    const v = this.variant();
    const c = this._custom(v.id);
    const image = [c?.image, v.image].find((p) => p && fs.existsSync(p)) || null;
    const custom = Boolean(c?.image && image === c.image);
    // A custom image has its own edges (none until it's lined up): the
    // pack's edges describe the pack's picture, not the player's screenshot.
    const b = custom ? c.bounds : v.bounds;
    const bounds = MapMath.validBounds(b) ? b : null;
    if (!image && !bounds) return null;
    return { image, bounds, custom };
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
    const old = this._custom(this.variant().id)?.image;
    // A lat/lon map keeps its edges: a screenshot of the whole in-game map
    // usually lines up already, and "Line up the map" can fix it if not.
    const keep = this.variant().units === 'latlon' ? this.variant().bounds : null;
    this._setCustom(() => ({ image: dest, bounds: keep }));
    if (old && old.startsWith(this.mapsDir) && old !== dest) fs.rm(old, { force: true }, () => {});
    return this.map();
  }

  setMapBounds(bounds) {
    this._require();
    const b = { left: Number(bounds.left), right: Number(bounds.right), top: Number(bounds.top), bottom: Number(bounds.bottom) };
    if (!MapMath.validBounds(b)) throw new Error('Each edge needs a number, and opposite edges can’t be equal.');
    const m = this.map();
    if (!m?.image) throw new Error('Choose a map image first.');
    this._setCustom((c) => ({ image: c?.image || m.image, bounds: b }));
    return b;
  }

  calibrate(a, b, width, height) {
    this._require();
    return this.setMapBounds(MapMath.boundsFromTwoPoints(a, b, width, height));
  }

  resetMap() {
    this._require();
    const old = this._custom(this.variant().id)?.image;
    this._setCustom(() => null);
    if (old && old.startsWith(this.mapsDir)) fs.rm(old, { force: true }, () => {});
    return this.map();
  }

  // ---------- marker layers ----------
  layers() {
    const v = this.variant();
    const shown = this._data().layers?.[v.id] || {};
    return v.markers.layers.map((l) => ({ ...l, on: shown[l.id] ?? l.on }));
  }

  setLayer(layerId, on) {
    this._require();
    const v = this.variant();
    if (!v.markers.layers.some((l) => l.id === layerId)) throw new Error('That marker layer isn’t in this map.');
    this._update((ov) => {
      const all = { ...(ov.layers || {}) };
      all[v.id] = { ...(all[v.id] || {}), [layerId]: Boolean(on) };
      ov.layers = all;
    });
    return true;
  }

  // ---------- "I'm here" ----------
  // A position set by hand (clicking the map) or by Find me. It's for games
  // where Keystone can't read your position: online games, or offline-only
  // games with mods off. It stays where it was put; it doesn't follow you.
  here() {
    const h = this._data().here;
    return h && h.variant === this.variant().id ? h : null;
  }

  setHere({ x, y } = {}) {
    this._require();
    const p = { x: Number(x), y: Number(y) };
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error('That spot has no usable coordinates.');
    const here = { variant: this.variant().id, x: p.x, y: p.y, z: null, source: 'click', at: Date.now(), raw: null };
    this._update((ov) => { ov.here = here; });
    return here;
  }

  clearHere() {
    this._require();
    this._update((ov) => { ov.here = null; });
    return true;
  }

  // ---------- Find me (ARK's ccc) ----------
  coords() {
    const v = this.variant();
    return this._data().coordFix?.[v.id] || v.coords;
  }

  // Runs the pack's command (ccc), which makes the game copy "X Y Z ..." to
  // the clipboard, reads it back and converts it to this map's lat/lon.
  // The clipboard is put back afterwards: borrowing it is a side effect the
  // player didn't ask for.
  async findMe({ timeoutMs = 3000, pollMs = 100 } = {}) {
    this._require();
    const spec = this.pack?.findMe;
    if (!spec) throw new Error('This game has no Find me command.');
    const conv = this.coords();
    if (!conv) throw new Error(`Find me doesn’t know ${this.variant().name}’s coordinates.`);
    const clip = this.c.clipboard;
    if (!clip) throw new Error('Find me needs the clipboard, which isn’t available here.');
    const saved = clip.readText();
    clip.writeText('');
    let raw = null;
    try {
      // Typed, never pasted: paste mode puts the old clipboard back after
      // pressing Enter, which can land on top of what ccc just copied.
      await this.c.commands.runBuilt([spec.command], 'console', 'Find me', { mode: 'type' });
      const until = Date.now() + timeoutMs;
      while (!raw && Date.now() < until) {
        await new Promise((r) => setTimeout(r, pollMs));
        raw = parseCoords(clip.readText());
      }
    } finally {
      clip.writeText(saved);
    }
    if (!raw) throw new Error('The game didn’t copy a position. Check you’re logged in as admin (the command needs cheat access), then try again.');
    const pos = ueToMap(raw, conv);
    const here = { variant: this.variant().id, x: pos.x, y: pos.y, z: raw.z, source: 'findme', at: Date.now(), raw };
    this._update((ov) => { ov.here = here; });
    return here;
  }

  // "Line it up": the player types the lat/lon their in-game map shows for
  // the spot Find me just read. Shifts stay as the pack has them; only the
  // scale is solved, per axis.
  lineUpFindMe({ lat, lon }) {
    this._require();
    const h = this.here();
    if (!h?.raw) throw new Error('Press Find me first, then type the latitude and longitude your in-game map shows for that spot.');
    const conv = this.coords();
    const shown = { lat: Number(lat), lon: Number(lon) };
    if (!Number.isFinite(shown.lat) || !Number.isFinite(shown.lon)) throw new Error('Type both numbers.');
    const div = (rawVal, shownVal, shift) => {
      // Near the map's centre a tiny typing difference swings the scale a
      // lot, and the raw value is near zero too.
      if (Math.abs(shownVal - shift) < 5 || Math.abs(rawVal) < 1000) return null;
      const d = rawVal / (shownVal - shift);
      return d > 0 ? d : null;
    };
    const latDiv = div(h.raw.y, shown.lat, conv.lat.shift);
    const lonDiv = div(h.raw.x, shown.lon, conv.lon.shift);
    if (!latDiv || !lonDiv) throw new Error('Stand somewhere farther from the middle of the map (at least 5 away from its centre on both numbers), press Find me, then try again.');
    // Averaging the axes: the game uses one scale for both on every map we
    // know, and the average halves the effect of the shown values' rounding.
    const fixed = conv.lat.div === conv.lon.div
      ? { lat: { ...conv.lat, div: (latDiv + lonDiv) / 2 }, lon: { ...conv.lon, div: (latDiv + lonDiv) / 2 } }
      : { lat: { ...conv.lat, div: latDiv }, lon: { ...conv.lon, div: lonDiv } };
    const vid = this.variant().id;
    const pos = ueToMap(h.raw, fixed);
    this._update((ov) => {
      ov.coordFix = { ...(ov.coordFix || {}), [vid]: fixed };
      ov.here = { ...h, x: pos.x, y: pos.y };
    });
    return fixed;
  }

  resetFindMe() {
    this._require();
    const vid = this.variant().id;
    const h = this.here();
    this._update((ov) => {
      const all = { ...(ov.coordFix || {}) };
      delete all[vid];
      ov.coordFix = all;
    });
    if (h?.raw) {
      const pos = ueToMap(h.raw, this.coords());
      this._update((ov) => { ov.here = { ...h, x: pos.x, y: pos.y }; });
    }
    return this.coords();
  }

  // ---------- waypoints ----------
  // Waypoints belong to the map they were made on (ARK's maps share one
  // game). Ones without a map (older files, pack starters) show on every map.
  waypoints() {
    const vid = this.variant().id;
    return this._all().filter((w) => !w.variant || w.variant === vid);
  }

  _all() {
    return this._data().waypoints || [];
  }

  addWaypoint({ name, x, y, z } = {}) {
    this._require();
    let pos = { x: Number(x), y: Number(y), z: z ?? null };
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
      const here = this.position();
      if (!here) throw new Error('Keystone doesn’t know where you are. Set the position mods, or click "I\u2019m here" on the map, first.');
      pos = { x: here.x, y: here.y, z: here.z };
    }
    const all = this._all();
    if (all.length >= MAX_WAYPOINTS) throw new Error(`That's the limit of ${MAX_WAYPOINTS} waypoints. Delete some first.`);
    const wp = { id: newId(), name: cleanText(name, 40) || `Waypoint ${this.waypoints().length + 1}`, ...pos, variant: this.variant().id };
    this._update((ov) => { ov.waypoints = [...all, wp]; });
    return wp;
  }

  updateWaypoint(id, patch) {
    this._require();
    const list = this._all();
    const wp = this.waypoints().find((w) => w.id === id);
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
      ov.waypoints = this._all().filter((w) => w.id !== id);
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

  // ---------- crosshair, PC stats ----------
  crosshair() {
    return Crosshair.normalize(this._data().crosshair || Crosshair.DEFAULTS);
  }

  setCrosshair(patch = {}) {
    this._require();
    const next = Crosshair.normalize({ ...this.crosshair(), ...patch });
    this._update((ov) => { ov.crosshair = next; });
    return next;
  }

  setPcStats(patch = {}) {
    this._require();
    const cur = this._data().pcstats || {};
    const next = { ...cur };
    for (const k of ['cpu', 'ram', 'clock', 'session']) if (patch[k] !== undefined) next[k] = Boolean(patch[k]);
    this._update((ov) => { ov.pcstats = next; });
    return next;
  }

  // ---------- checklists ----------
  checklists() {
    return this._data().checklists || [];
  }

  activeList() {
    const lists = this.checklists();
    return lists.find((l) => l.id === this._data().activeList) || lists[0] || null;
  }

  _list(id) {
    const l = this.checklists().find((x) => x.id === id);
    if (!l) throw new Error('That checklist no longer exists.');
    return l;
  }

  // Lists are small, so every change rewrites the whole array: simpler than
  // patching in place, and the store saves the whole file anyway.
  _setLists(fn) {
    this._update((ov) => { ov.checklists = fn((ov.checklists || []).map((l) => ({ ...l, items: l.items.map((i) => ({ ...i })) }))); });
  }

  addList(name) {
    this._require();
    if (this.checklists().length >= MAX_LISTS) throw new Error(`That's the limit of ${MAX_LISTS} checklists.`);
    const list = { id: newId(), name: cleanText(name, 40) || `Checklist ${this.checklists().length + 1}`, items: [] };
    this._setLists((ls) => [...ls, list]);
    this._update((ov) => { ov.activeList = list.id; });
    return list;
  }

  renameList(id, name) {
    this._require();
    this._list(id);
    const n = cleanText(name, 40);
    if (!n) throw new Error('Give the checklist a name.');
    this._setLists((ls) => ls.map((l) => (l.id === id ? { ...l, name: n } : l)));
    return true;
  }

  removeList(id) {
    this._require();
    this._list(id);
    this._setLists((ls) => ls.filter((l) => l.id !== id));
    this._update((ov) => { if (ov.activeList === id) ov.activeList = ov.checklists[0]?.id || null; });
    return true;
  }

  setActiveList(id) {
    this._require();
    if (id) this._list(id);
    this._update((ov) => { ov.activeList = id || null; });
    return true;
  }

  addItem(listId, text) {
    this._require();
    const l = this._list(listId);
    const t = cleanText(text, 80);
    if (!t) throw new Error('Type something to add.');
    if (l.items.length >= MAX_ITEMS) throw new Error(`That's the limit of ${MAX_ITEMS} items in one checklist.`);
    const item = { id: newId(), text: t, done: false };
    this._setLists((ls) => ls.map((x) => (x.id === listId ? { ...x, items: [...x.items, item] } : x)));
    return item;
  }

  // done omitted: flip it (one tap on the phone or the overlay).
  checkItem(listId, itemId, done) {
    this._require();
    const item = this._list(listId).items.find((i) => i.id === itemId);
    if (!item) throw new Error('That item no longer exists.');
    const next = done === undefined ? !item.done : Boolean(done);
    this._setLists((ls) => ls.map((x) => (x.id === listId ? { ...x, items: x.items.map((i) => (i.id === itemId ? { ...i, done: next } : i)) } : x)));
    return next;
  }

  removeItem(listId, itemId) {
    this._require();
    this._list(listId);
    this._setLists((ls) => ls.map((x) => (x.id === listId ? { ...x, items: x.items.filter((i) => i.id !== itemId) } : x)));
    return true;
  }

  // Untick everything, for a fresh run.
  resetList(listId) {
    this._require();
    this._list(listId);
    this._setLists((ls) => ls.map((x) => (x.id === listId ? { ...x, items: x.items.map((i) => ({ ...i, done: false })) } : x)));
    return true;
  }

  // ---------- teleport ----------
  // How this game can teleport right now: 'memory' (writing the position
  // mods), 'command' (the pack's teleport command), or null.
  //
  // Memory wins when both work: it's instant and needs no console. Commands
  // need the pack to have a console or RCON set up.
  teleportMethod() {
    if (!this.game) return null;
    const roles = this.roles();
    if (this.session && roles.x && roles.y) return 'memory';
    if (this.pack?.teleport?.command && this.pack.commands) return 'command';
    return null;
  }

  async teleport(target = {}) {
    this._require();
    let to;
    if (target.waypointId) {
      const wp = this.waypoints().find((w) => w.id === target.waypointId);
      if (!wp) throw new Error('That waypoint no longer exists.');
      to = { x: wp.x, y: wp.y, z: wp.z ?? null, name: wp.name };
    } else {
      to = { x: Number(target.x), y: Number(target.y), z: target.z === undefined || target.z === null || target.z === '' ? null : Number(target.z), name: null };
    }
    if (![to.x, to.y].every(Number.isFinite) || (to.z !== null && !Number.isFinite(to.z))) throw new Error('That spot has no usable coordinates.');

    const method = this.teleportMethod();
    if (method === 'memory') return { method, ...this._teleportByMemory(to) };
    if (method === 'command') return { method, ...(await this._teleportByCommand(to)) };
    if (this.session) throw new Error('Set the X and Y position mods in the Overlay tab first, so Keystone knows what to write.');
    throw new Error(this.c.modsBlocked() === 'offline-off'
      ? 'Teleporting writes your position, which needs mods. Turn mods on for this game first.'
      : 'Teleporting needs mods with position values, and they aren’t available for this game.');
  }

  _teleportByMemory(to) {
    const s = this.session;
    const roles = this.roles();
    const opts = this.pack?.teleport || { lift: 0, holdMs: 300 };
    let z = to.z;
    if (z === null && roles.z) {
      // No height saved: keep the current height (plus the pack's lift).
      const cur = this.livePosition()?.z;
      z = Number.isFinite(cur) ? cur + (opts.lift || 0) : null;
    }
    const writes = [[roles.x, to.x], [roles.y, to.y]];
    if (roles.z && z !== null) writes.push([roles.z, z]);

    // Hold the new position for a moment (see holdMs in packs.js). A value
    // the person had locked stays locked, at the new spot, or their own lock
    // would pull them straight back.
    const restore = [];
    for (const [id, v] of writes) {
      const st = s.state.get(id);
      restore.push({ id, wasEnabled: st.enabled, oldTarget: st.target });
      s.setTarget(id, v);
      s.setEnabled(id, true);
    }
    const release = () => {
      if (this.session !== s) return; // game closed or switched meanwhile
      for (const r of restore) {
        if (r.wasEnabled) continue;
        try { s.setEnabled(r.id, false); s.setTarget(r.id, r.oldTarget); } catch { /* record gone */ }
      }
    };
    if (opts.holdMs > 0) setTimeout(release, opts.holdMs).unref?.(); else release();
    return { x: to.x, y: to.y, z, name: to.name };
  }

  async _teleportByCommand(to) {
    const t = this.pack.teleport;
    const num = (n) => String(Math.round(n * 100) / 100);
    const vars = { x: num(to.x), y: num(to.y), z: to.z === null ? null : num(to.z) };
    const lines = t.command
      .filter((l) => vars.z !== null || !l.includes('{z}'))
      .map((l) => l.replace(/\{(x|y|z)\}/g, (_, k) => vars[k]));
    if (!lines.length) throw new Error('This game’s teleport command needs a height, and this spot doesn’t have one.');
    await this.c.commands.runBuilt(lines, t.via, to.name ? `Teleport: ${to.name}` : 'Teleport');
    return { x: to.x, y: to.y, z: to.z, name: to.name };
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

  // ---------- the phone's map ----------
  // Everything the phone's Map tab draws except the marker points, which are
  // pack data that only change with the map (see phoneMapPoints). Rides on
  // every snapshot, so it stays small.
  phoneMap() {
    if (!this.game) return null;
    const map = this.map();
    const v = this.variant();
    const waypoints = this.waypoints().map((w) => ({ id: w.id, name: w.name, x: w.x, y: w.y }));
    if (!map && !waypoints.length && this.variants().length < 2) return null;
    let image = null;
    if (map?.image) {
      try {
        // Changes when the picture does, so the phone knows to fetch it again.
        image = { key: `${Math.round(fs.statSync(map.image).mtimeMs)}-${v.id}`, custom: map.custom };
      } catch { /* deleted under us: no picture */ }
    }
    const layers = this.layers();
    return {
      variants: this.variants().map((x) => ({ id: x.id, name: x.name })),
      variant: { id: v.id, name: v.name, units: v.units },
      bounds: map?.bounds || null,
      image,
      layers: layers.map((l) => ({ id: l.id, name: l.name, color: l.color, shape: l.shape, on: l.on, count: l.points.length })),
      // Changes when the points do: a different map, or a pack update.
      pointsKey: `${v.id}:${layers.map((l) => `${l.id}.${l.points.length}`).join(',')}`,
      credits: v.markers.credits,
      waypoints,
      tracked: this._data().tracked || null,
      here: this.here(),
      teleport: this.teleportMethod(),
      findMe: Boolean(this.pack?.findMe && this.coords()),
    };
  }

  phoneMapPoints() {
    this._require();
    const v = this.variant();
    return { variant: v.id, layers: this.layers().map((l) => ({ id: l.id, points: l.points.map((p) => ({ name: p.name, x: p.x, y: p.y, note: p.note || null })) })) };
  }

  // The current map picture for the phone: { file, type } or null.
  phoneMapImage() {
    const image = this.game ? this.map()?.image : null;
    if (!image) return null;
    const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[path.extname(image).toLowerCase()];
    return type ? { file: image, type } : null;
  }

  // ---------- what the overlay renders ----------
  state() {
    if (!this.game) return { attached: false };
    const ov = this._data();
    const map = this.map();
    const recs = new Map((this.session?.records || []).map((r) => [r.id, r]));
    return {
      attached: true,
      // (Was also called "mods", which the pinned-mods list below overwrote.)
      session: Boolean(this.session),
      game: this.game.demo ? 'Demo game' : this.game.name.replace(/\.exe$/i, ''),
      pack: this.pack ? this.pack.name : null,
      roles: this.roles(),
      teleport: this.teleportMethod(),
      map: map ? {
        // Served by the ksmap:// protocol in main.js; mtime busts the image cache
        // when the user picks a new map. No image: a lat/lon map with edges only.
        url: map.image ? `ksmap://map/${encodeURIComponent(this.game.key)}?v=${fs.statSync(map.image).mtimeMs}-${encodeURIComponent(this.variant().id)}` : null,
        bounds: map.bounds,
        custom: map.custom,
      } : null,
      variants: this.variants().map((v) => ({ id: v.id, name: v.name })),
      variant: { id: this.variant().id, name: this.variant().name, units: this.variant().units },
      layers: this.layers(),
      markerCredits: this.variant().markers.credits,
      here: this.here(),
      findMe: Boolean(this.pack?.findMe && this.coords()),
      findMeFixed: Boolean(this._data().coordFix?.[this.variant().id]),
      waypoints: this.waypoints(),
      tracked: ov.tracked,
      readouts: ov.readouts.filter((id) => recs.has(id)).map((id) => ({ id, name: recs.get(id).name, valueType: recs.get(id).valueType })),
      info: this.pack?.info || [],
      // Pinned mods for the overlay's Mods panel.
      mods: this._pinnedMods(),
      checklists: this.checklists().map((l) => ({ id: l.id, name: l.name, total: l.items.length, done: l.items.filter((i) => i.done).length })),
      checklist: this.activeList(),
      timers: this.c.timers ? this.c.timers.list() : [],
      identify: this.c._identifyBrief(),
      timerPresets: (this.pack?.timerPresets || []).map((t) => t.name),
      crosshair: this.crosshair(),
      pcstats: ov.pcstats,
      // When the game started running (for "playing for"), or null.
      since: this.game.since || null,
      notes: ov.notes,
      panels: ov.panels,
      zoom: ov.zoom,
    };
  }

  _pinnedMods() {
    if (!this.session) return [];
    const snap = this.c.snapshot();
    return snap.records.filter((r) => r.pinned && (r.kind === 'value' || r.kind === 'script'))
      .map((r) => ({ id: r.id, label: r.label || r.name, hotkey: r.hotkey || null, control: r.kind === 'script' ? 'toggle' : (r.ui?.control || 'default') }));
  }

  values() {
    if (!this.game || !this.session) return { pos: null, readouts: {}, mods: {} };
    const mods = {};
    for (const id of this.c.store.load(this.game.key).pinned || []) {
      const st = this.session.state.get(id);
      if (st) mods[id] = { enabled: st.enabled, current: st.current, status: st.status };
    }
    const out = {};
    for (const id of this._data().readouts) {
      const st = this.session.state.get(id);
      if (st) out[id] = { current: st.current, status: st.status, enabled: st.enabled };
    }
    return { pos: this.livePosition(), readouts: out, mods };
  }
}

// ccc copies "X Y Z Yaw Pitch" (game units, then angles). Only X, Y and Z
// are used: sources disagree on the order of the two angles, and a wrong
// facing arrow is worse than none.
function parseCoords(text) {
  const m = String(text || '').trim().match(/^(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)(?:\s|$)/);
  return m ? { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) } : null;
}

// Game units -> map lat/lon (world x = lon, y = lat).
function ueToMap(raw, conv) {
  return { x: raw.x / conv.lon.div + conv.lon.shift, y: raw.y / conv.lat.div + conv.lat.shift };
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

module.exports = { OverlayModel, ROLES, parseCoords, ueToMap };
