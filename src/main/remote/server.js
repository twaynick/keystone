'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');
const { mimeOf } = require('../library-images');

// Phone remote: a small web server on the home network.
//
//   GET /            the phone web app (static files, no secrets in them)
//   GET /shared/...  shared CSS and fonts
//   WS  /ws?t=TOKEN  live state + commands; the token is the only gate
//   GET /api/map-image   the current map picture; token in X-Keystone-Token
//   GET /api/lib-image   a Library picture (?kind=thumb|hero|spawn|spawnmap&c=&id=&i=)
//
// The token comes from the pairing QR code. It travels in the URL fragment
// (#t=...) on the page, which browsers never send to the server, and only goes
// over the wire on the WebSocket handshake.

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

const CLOSE_BAD_TOKEN = 4401;
const CLOSE_TOO_MANY = 4429;
const MAX_FAILS = 10;           // bad tokens per address...
const FAIL_WINDOW_MS = 60_000;  // ...per minute before we stop listening to it

class RemoteServer extends EventEmitter {
  constructor({ controller, webDir, sharedDir, getToken, getAppearance }) {
    super();
    this.controller = controller;
    this.webDir = webDir;
    this.sharedDir = sharedDir;
    this.getToken = getToken;
    this.getAppearance = getAppearance || (() => null);
    this.server = null;
    this.wss = null;
    this.port = null;
    this.fails = new Map();
    this._structureTimer = null;

    this._onStructure = () => this._scheduleSnapshot();
    // Live position rides with the values, for the phone's map.
    this._onValues = (v) => this._broadcast({ type: 'values', data: v, pos: this.controller.overlay?.livePosition() || null });
  }

  get clientCount() {
    if (!this.wss) return 0;
    let n = 0;
    for (const c of this.wss.clients) if (c.authed && c.readyState === 1) n++;
    return n;
  }

  start(port, host = '0.0.0.0') {
    if (this.server) return Promise.resolve(this.port);
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this._serve(req, res));
      const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
      wss.on('connection', (ws, req) => this._onConnection(ws, req));
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') reject(new Error(`Port ${port} is already in use. Pick another port.`));
        else reject(err);
      });
      server.listen(port, host, () => {
        this.server = server;
        this.wss = wss;
        this.port = server.address().port;
        this.controller.on('structure', this._onStructure);
        // Waypoint changes come as 'overlay' events; the phone's Teleport
        // list rides on the snapshot.
        this.controller.on('overlay', this._onStructure);
        this.controller.on('values', this._onValues);
        // Phones drop off Wi-Fi when the screen locks without closing the
        // socket. Ping every 20 s and drop the ones that stop answering so the
        // "connected phones" count stays honest.
        this._heartbeat = setInterval(() => {
          for (const c of wss.clients) {
            if (!c.isAlive) { c.terminate(); continue; }
            c.isAlive = false;
            c.ping();
          }
        }, 20_000);
        this._heartbeat.unref?.();
        resolve(this.port);
      });
    });
  }

  stop() {
    this.controller.off('structure', this._onStructure);
    this.controller.off('overlay', this._onStructure);
    this.controller.off('values', this._onValues);
    clearTimeout(this._structureTimer);
    clearInterval(this._heartbeat);
    if (!this.server) return Promise.resolve();
    for (const c of this.wss.clients) c.terminate();
    const server = this.server;
    this.server = null;
    this.wss.close();
    this.wss = null;
    this.port = null;
    this.emit('clients', 0);
    return new Promise((resolve) => server.close(() => resolve()));
  }

  // Drops every phone, e.g. after the pairing token is reset.
  disconnectAll(code = CLOSE_BAD_TOKEN, reason = 'Pairing reset') {
    if (!this.wss) return;
    for (const c of this.wss.clients) c.close(code, reason);
  }

  // ---------- HTTP ----------
  _serve(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (urlPath.startsWith('/api/')) return this._api(req, res, urlPath);
    let root = this.webDir;
    let rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
    if (rel.startsWith('shared/')) {
      root = this.sharedDir;
      rel = rel.slice('shared/'.length);
    }
    const file = path.resolve(root, rel);
    // Block ../ escapes: the resolved file must stay inside its root.
    if (!file.startsWith(path.resolve(root) + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        // The phone should always get the current app after an update.
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    });
  }

  // The map picture is too big for the socket (megabytes), so it's a GET.
  // The token goes in a header, never the URL, so it can't end up in the
  // phone's history; same lockout as the socket for wrong guesses.
  _api(req, res, urlPath) {
    const ip = req.socket.remoteAddress || 'unknown';
    if (this._isBlocked(ip)) return res.writeHead(429).end();
    if (!tokenMatches(req.headers['x-keystone-token'] || '', this.getToken())) {
      this._recordFail(ip);
      return res.writeHead(401).end();
    }
    if (urlPath === '/api/lib-image') return this._libImage(req, res);
    if (urlPath !== '/api/map-image') return res.writeHead(404).end();
    const img = this.controller.overlay?.phoneMapImage();
    if (!img) return res.writeHead(404).end();
    fs.readFile(img.file, (err, body) => {
      if (err) return res.writeHead(404).end();
      res.writeHead(200, {
        'Content-Type': img.type,
        // The phone asks with ?k=<key>, which changes with the picture, so a
        // cached copy is always the right one.
        'Cache-Control': 'private, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      return res.end(req.method === 'HEAD' ? undefined : body);
    });
    return undefined;
  }

  // Library pictures, the same ones the desktop shows (downloaded from the
  // wiki by the PC and cached there; the phone never talks to the wiki).
  async _libImage(req, res) {
    const q = new URL(req.url, 'http://x').searchParams;
    const lib = this.controller.library;
    const kind = q.get('kind');
    const catalog = String(q.get('c') || '');
    const id = String(q.get('id') || '');
    let file = null;
    try {
      if (kind === 'thumb' || kind === 'hero') file = await lib.pictureFile(kind, catalog, id);
      else if (kind === 'spawn' || kind === 'spawnmap') file = await lib.spawnFile(kind === 'spawn' ? 'overlay' : 'map', Number(q.get('i')), catalog, id);
    } catch { file = null; }
    if (!file) return res.writeHead(404).end();
    let body;
    try { body = await fs.promises.readFile(file); } catch { return res.writeHead(404).end(); }
    res.writeHead(200, {
      'Content-Type': mimeOf(body),
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }

  // ---------- WebSocket ----------
  _onConnection(ws, req) {
    const ip = req.socket.remoteAddress || 'unknown';
    if (this._isBlocked(ip)) {
      ws.close(CLOSE_TOO_MANY, 'Too many attempts');
      return;
    }
    const token = new URL(req.url, 'http://x').searchParams.get('t') || '';
    if (!tokenMatches(token, this.getToken())) {
      this._recordFail(ip);
      ws.close(CLOSE_BAD_TOKEN, 'Bad pairing code');
      return;
    }
    ws.authed = true;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw) => this._onMessage(ws, raw));
    ws.on('close', () => this.emit('clients', this.clientCount));
    this._send(ws, { type: 'snapshot', data: this.controller.snapshot() });
    const look = this.getAppearance();
    if (look) this._send(ws, { type: 'appearance', data: look });
    this.emit('clients', this.clientCount);
  }

  _onMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    const { reqId } = msg;
    const reply = (ok, extra = {}) => this._send(ws, { type: 'result', reqId, ok, ...extra });
    const c = this.controller;
    try {
      switch (msg.type) {
        case 'toggle': {
          // Same rule as the desktop: a value typed on the phone gets locked.
          if (msg.target !== undefined && msg.target !== null && msg.target !== '') c.setTarget(String(msg.id), msg.target);
          c.setEnabled(String(msg.id), Boolean(msg.enabled));
          return reply(true);
        }
        case 'setTarget': c.setTarget(String(msg.id), msg.value); return reply(true);
        case 'apply': c.applyValue(String(msg.id), msg.value); return reply(true);
        case 'applyProfile': return reply(true, { data: c.applyProfile(String(msg.name)) });
        case 'saveProfile': return reply(true, { data: c.saveProfile(String(msg.name)) });
        case 'timer': {
          const t = c.timers;
          if (!t) return reply(false, { error: 'Timers aren\u2019t available.' });
          const fn = { toggle: 'toggle', reset: 'reset' }[msg.action];
          if (!fn) return reply(false, { error: 'Unknown timer action.' });
          return reply(true, { data: t[fn](String(msg.id)) });
        }
        case 'timerPreset': {
          const p = c.pack?.timerPresets?.[Number(msg.index)];
          if (!p || !c.timers) return reply(false, { error: 'That timer isn\u2019t in this game\u2019s list.' });
          return reply(true, { data: c.timers.startPreset(p) });
        }
        case 'check': return reply(true, { data: c.overlay.checkItem(String(msg.listId), String(msg.itemId)) });
        // Picks the list shown on the phone and in the overlay (one shared choice).
        case 'setActiveList': c.overlay.setActiveList(String(msg.id)); return reply(true);
        case 'identify':
          if (msg.action === 'cycle') { c.identify.cycle(String(msg.trait)); return reply(true); }
          if (msg.action === 'given') { c.identify.setGiven(msg.value); return reply(true); }
          if (msg.action === 'reset') { c.identify.reset(); return reply(true); }
          return reply(false, { error: 'Unknown identifier action.' });
        case 'teleport':
          c.overlay.teleport({ waypointId: String(msg.waypointId) })
            .then((r) => reply(true, { data: { name: r.name } }), (err) => reply(false, { error: err.message }));
          return undefined;
        // ----- map -----
        case 'mapPoints': return reply(true, { data: c.overlay.phoneMapPoints() });
        case 'setVariant': c.overlay.setVariant(String(msg.id)); return reply(true);
        case 'setLayer': c.overlay.setLayer(String(msg.id), Boolean(msg.on)); return reply(true);
        case 'setHere': return reply(true, { data: c.overlay.setHere({ x: msg.x, y: msg.y }) });
        case 'clearHere': c.overlay.clearHere(); return reply(true);
        case 'addWaypoint': return reply(true, { data: c.overlay.addWaypoint({ name: msg.name, x: msg.x, y: msg.y }) });
        case 'removeWaypoint': c.overlay.removeWaypoint(String(msg.id)); return reply(true);
        case 'setTracked': c.overlay.setTracked(msg.id ? String(msg.id) : null); return reply(true);
        case 'teleportTo':
          c.overlay.teleport({ x: msg.x, y: msg.y })
            .then((r) => reply(true, { data: { x: r.x, y: r.y } }), (err) => reply(false, { error: err.message }));
          return undefined;
        case 'findMe':
          c.overlay.findMe()
            .then((h) => reply(true, { data: { x: h.x, y: h.y } }), (err) => reply(false, { error: err.message }));
          return undefined;
        // ----- commands (admin/console) -----
        case 'cmdInfo': return reply(true, { data: this._cmdInfo() });
        case 'cmdRun':
        case 'cmdRaw':
        case 'cmdAdmin': {
          const cm = c.commands;
          const p = msg.type === 'cmdRun'
            ? cm.run(msg.kind === 'quick' ? 'quick' : 'action', String(msg.id), { entryId: msg.entryId == null ? null : String(msg.entryId), values: msg.values && typeof msg.values === 'object' ? msg.values : {} })
            : msg.type === 'cmdRaw' ? cm.runRaw(msg.text, msg.via) : cm.enableAdmin().then(() => ({ via: 'console', output: null }));
          p.then((r) => reply(true, { data: { via: r.via, output: r.output || null } }), (err) => reply(false, { error: err.message }));
          return undefined;
        }
        // ----- library -----
        case 'lib': return reply(true, { data: this._lib(msg) });
        case 'ping': return reply(true);
        default: return reply(false, { error: `Unknown command "${msg.type}"` });
      }
    } catch (err) {
      return reply(false, { error: err.message });
    }
  }

  // What the phone needs to draw the commands: no history, no RCON address,
  // and never the admin password (only whether one is saved).
  _cmdInfo() {
    const info = this.controller.commands.info();
    if (!info.available) return { available: false, reason: info.reason };
    const s = info.settings;
    return {
      available: true,
      actions: info.actions,
      quick: info.quick,
      canEnable: s.canEnable,
      hasAdminPassword: s.hasAdminPassword,
      rcon: s.rconSupported && Boolean(s.rcon.host && s.rcon.hasPassword),
      credits: info.credits,
    };
  }

  _lib(msg) {
    const lib = this.controller.library;
    switch (msg.action) {
      case 'info': {
        const { userGuidesDir, ...info } = lib.info();
        return info;
      }
      // Just what a list row needs: catalogs run to hundreds of entries.
      case 'entries': return lib.entries(String(msg.catalog)).map((e) => ({ id: e.id, name: e.name, category: e.category || null, map: e.map || null }));
      case 'entry': return lib.entry(String(msg.catalog), String(msg.id));
      case 'guide': return lib.guide(String(msg.id));
      case 'search': return lib.search(String(msg.q || ''));
      case 'note': return lib.setNote(String(msg.catalog), String(msg.id), msg.text);
      default: throw new Error('Unknown Library request.');
    }
  }

  // Several structure events can fire in one burst (applying a profile does);
  // coalesce them so a phone gets one snapshot, not five.
  _scheduleSnapshot() {
    clearTimeout(this._structureTimer);
    this._structureTimer = setTimeout(() => this._broadcast({ type: 'snapshot', data: this.controller.snapshot() }), 40);
  }

  broadcast(msg) {
    this._broadcast(msg);
  }

  _broadcast(msg) {
    if (!this.wss) return;
    const data = JSON.stringify(msg);
    for (const c of this.wss.clients) if (c.authed && c.readyState === 1) c.send(data);
  }

  _send(ws, msg) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  _recordFail(ip) {
    const now = Date.now();
    const list = (this.fails.get(ip) || []).filter((t) => now - t < FAIL_WINDOW_MS);
    list.push(now);
    this.fails.set(ip, list);
  }

  _isBlocked(ip) {
    const now = Date.now();
    const list = (this.fails.get(ip) || []).filter((t) => now - t < FAIL_WINDOW_MS);
    return list.length >= MAX_FAILS;
  }
}

// Constant-time compare so response timing doesn't leak how much of a guess
// was right.
function tokenMatches(given, expected) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { RemoteServer, CLOSE_BAD_TOKEN, CLOSE_TOO_MANY };
