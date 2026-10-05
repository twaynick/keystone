'use strict';

const fs = require('fs');
const path = require('path');
const { RconClient } = require('./rcon');

// The command center for the selected game: builds admin/console commands
// from the game pack's templates, validates the form values, and runs them
// either in the game's own console (keyboard) or over RCON (network).
//
// Pack format (pack.json "commands"):
//   console: { key, prefixes: [...], enable: "EnableCheats {password}" }
//   rcon:    { port }                     // omit for games without RCON
//   catalogs: { creatures: "creatures.json", items: "items.json" }
//   actions: [{ id, label, catalog, via, template, fields: [...] }]
//   quick:   [{ id, label, via, template, fields?, confirm? }]
//
// Template placeholders: {id} {blueprint} {name} from the picked catalog
// entry, plus {fieldKey} for each form field.

const MAX_REPEAT = 20;
const MAX_HISTORY = 40;

class CommandsModel {
  constructor(controller, { secrets, consoleSend, rconFactory } = {}) {
    this.c = controller;
    // secrets: { encrypt(str) -> str, decrypt(str) -> str }. Electron's
    // safeStorage in the app; a pass-through in tests.
    this.secrets = secrets || { encrypt: (s) => `plain:${s}`, decrypt: (s) => String(s).replace(/^plain:/, '') };
    this.consoleSend = consoleSend || null;
    this.rconFactory = rconFactory || ((opts) => new RconClient(opts));
    this.rcon = null;
    this.rconKey = null;
    this.catalogCache = new Map();
  }

  get game() { return this.c.game; }
  get spec() { return this.c.pack?.commands || null; }

  _require() {
    if (!this.game) throw new Error('Choose a game first.');
    if (!this.spec) throw new Error('There are no commands for this game yet. Commands come from its game pack.');
    return this.spec;
  }

  _data() {
    const d = this.c.store.load(this.game.key);
    if (!d.commands) d.commands = {};
    return d.commands;
  }

  _update(fn) {
    this.c.store.update(this.game.key, (d) => {
      if (!d.commands) d.commands = {};
      fn(d.commands);
    });
    this.c.emit('commands');
  }

  // ---------- settings ----------
  settings() {
    const spec = this.spec || {};
    const d = this.game ? this._data() : {};
    const prefixes = spec.console?.prefixes || [''];
    // Some consoles (Fallout's) have no paste, so paste mode is only offered
    // where the pack says it works.
    const pasteSupported = spec.console?.paste !== false;
    return {
      consoleKey: d.consoleKey || spec.console?.key || 'Tab',
      prefix: d.prefix ?? prefixes[0],
      prefixes,
      mode: pasteSupported ? (d.mode || 'type') : 'type',
      pasteSupported,
      canEnable: Boolean(spec.console?.enable),
      hasAdminPassword: Boolean(d.adminPassword),
      rconSupported: Boolean(spec.rcon),
      rcon: {
        host: d.rcon?.host || '',
        port: d.rcon?.port || spec.rcon?.port || '',
        hasPassword: Boolean(d.rcon?.password),
      },
    };
  }

  setSettings(patch) {
    const spec = this._require();
    this._update((d) => {
      if (patch.consoleKey !== undefined) {
        if (!['Tab', 'Backquote', 'Insert'].includes(patch.consoleKey)) throw new Error('Pick Tab, backquote or Insert for the console key.');
        d.consoleKey = patch.consoleKey;
      }
      if (patch.prefix !== undefined) {
        if (!(spec.console?.prefixes || ['']).includes(patch.prefix)) throw new Error('Unknown command prefix.');
        d.prefix = patch.prefix;
      }
      if (patch.mode !== undefined) {
        if (!['type', 'paste'].includes(patch.mode)) throw new Error('Unknown send mode.');
        if (patch.mode === 'paste' && spec.console?.paste === false) throw new Error('This game\u2019s console can\u2019t paste. Keystone types commands instead.');
        d.mode = patch.mode;
      }
      if (patch.adminPassword !== undefined) {
        d.adminPassword = patch.adminPassword ? this.secrets.encrypt(String(patch.adminPassword)) : null;
      }
    });
    return this.settings();
  }

  setRcon({ host, port, password }) {
    const spec = this._require();
    if (!spec.rcon) throw new Error('This game doesn’t use RCON.');
    const h = String(host || '').trim();
    const p = Number(port);
    if (!h) throw new Error('Enter the server’s address.');
    if (!/^[a-z0-9.-]+$/i.test(h)) throw new Error('The server address should look like 123.45.67.89 or play.example.com.');
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('The RCON port is a number between 1 and 65535.');
    this._update((d) => {
      d.rcon = { ...(d.rcon || {}), host: h, port: p };
      // Empty password field means "keep the saved one".
      if (password) d.rcon.password = this.secrets.encrypt(String(password));
    });
    this._dropRcon();
    return this.settings();
  }

  async testRcon() {
    const client = this._rconClient();
    const out = await client.command('ListPlayers');
    return { ok: true, output: out || '(no reply)' };
  }

  _rconClient() {
    const spec = this._require();
    if (!spec.rcon) throw new Error('This game doesn’t use RCON.');
    const r = this._data().rcon;
    if (!r?.host || !r?.port || !r?.password) throw new Error('Set up RCON first: server address, port and admin password.');
    const key = `${r.host}:${r.port}:${r.password}`;
    if (!this.rcon || this.rconKey !== key) {
      this._dropRcon();
      this.rcon = this.rconFactory({ host: r.host, port: r.port, password: this.secrets.decrypt(r.password) });
      this.rconKey = key;
    }
    return this.rcon;
  }

  _dropRcon() {
    if (this.rcon) this.rcon.close();
    this.rcon = null;
    this.rconKey = null;
  }

  // ---------- catalogs ----------
  catalog(name) {
    this._require();
    const file = this.spec.catalogs?.[name];
    if (!file) throw new Error(`No ${name} list for this game.`);
    const abs = path.resolve(this.c.pack.folder, file);
    if (!this.catalogCache.has(abs)) {
      const entries = JSON.parse(fs.readFileSync(abs, 'utf8'));
      this.catalogCache.set(abs, entries);
    }
    return this.catalogCache.get(abs);
  }

  _entry(catalogName, entryId) {
    const e = this.catalog(catalogName).find((x) => x.id === entryId);
    if (!e) throw new Error('That entry isn’t in the list any more.');
    return e;
  }

  // ---------- building ----------
  _find(kind, id) {
    const list = (kind === 'quick' ? this.spec.quick : this.spec.actions) || [];
    const a = list.find((x) => x.id === id);
    if (!a) throw new Error('Unknown command.');
    return a;
  }

  // Returns { via, lines, label } without running anything.
  build(kind, id, { entryId = null, values = {} } = {}) {
    this._require();
    const action = this._find(kind, id);
    const entry = action.catalog ? this._entry(action.catalog, entryId) : null;
    const vals = validateFields(action.fields || [], values);
    const repeatField = (action.fields || []).find((f) => f.repeat);
    const times = repeatField ? vals[repeatField.key] : 1;

    let line = render(action.template, { ...(entry || {}), ...vals });
    const via = action.via || 'console';
    if (via === 'console' && !action.noPrefix) {
      const prefix = this.settings().prefix;
      if (prefix) line = `${prefix} ${line}`;
    }
    return { via, lines: Array.from({ length: times }, () => line), label: entry ? `${action.label}: ${entry.name}` : action.label, confirm: action.confirm || null };
  }

  async run(kind, id, opts = {}) {
    const built = this.build(kind, id, opts);
    return this._execute(built, built.lines);
  }

  async runRaw(text, via) {
    this._require();
    const line = String(text || '').trim();
    if (!line) throw new Error('Type a command first.');
    if (line.length > 500) throw new Error('That command is too long.');
    const v = via === 'rcon' ? 'rcon' : 'console';
    return this._execute({ via: v, lines: [line], label: 'Typed command' }, [line]);
  }

  // Lines Keystone built itself (teleport), from numbers it already checked.
  // Console lines get the same admin prefix as the pack's own commands.
  async runBuilt(lines, via, label, { mode } = {}) {
    const spec = this._require();
    const v = via === 'rcon' ? 'rcon' : 'console';
    if (v === 'console' && !spec.console) throw new Error('This game has no console Keystone can type into.');
    const prefix = v === 'console' ? this.settings().prefix : '';
    const out = lines.map((l) => (prefix ? `${prefix} ${l}` : l));
    return this._execute({ via: v, lines: out, label, mode }, out);
  }

  // Types EnableCheats <password> in the console. Never stored in history.
  async enableAdmin() {
    const spec = this._require();
    if (!spec.console?.enable) throw new Error('This game has no admin login command.');
    const enc = this._data().adminPassword;
    if (!enc) throw new Error('Save your admin password in Command settings first.');
    const line = render(spec.console.enable, { password: this.secrets.decrypt(enc) });
    await this._console([line]);
    this._log({ label: 'Admin login', via: 'console', lines: [render(spec.console.enable, { password: '••••••' })], ok: true });
    return true;
  }

  async _execute(built, lines) {
    try {
      let output = null;
      if (built.via === 'rcon') {
        const client = this._rconClient();
        const outs = [];
        for (const l of lines) outs.push(await client.command(l));
        output = outs.filter(Boolean).join('\n') || null;
      } else {
        await this._console(lines, built.mode);
      }
      this._log({ label: built.label, via: built.via, lines, ok: true, output });
      return { ok: true, via: built.via, lines, output };
    } catch (err) {
      this._log({ label: built.label, via: built.via, lines, ok: false, error: err.message });
      throw err;
    }
  }

  async _console(lines, modeOverride) {
    if (!this.game.pid) throw new Error('Start the game to use console commands. RCON commands work without it.');
    if (!this.consoleSend) throw new Error('Sending to the game console isn’t available here.');
    const s = this.settings();
    await this.consoleSend(this.game.pid, lines, { consoleKey: s.consoleKey, mode: modeOverride || s.mode, keepsOpen: Boolean(this.spec.console?.keepsOpen) });
  }

  // ---------- history ----------
  history() {
    return this.game ? (this._data().history || []) : [];
  }

  _log(entry) {
    this._update((d) => {
      d.history = [{ at: new Date().toISOString(), ...entry }, ...(d.history || [])].slice(0, MAX_HISTORY);
    });
  }

  clearHistory() {
    this._require();
    this._update((d) => { d.history = []; });
    return true;
  }

  // ---------- what the UI needs ----------
  info() {
    if (!this.game) return { available: false, reason: 'Choose a game first.' };
    if (!this.spec) return { available: false, reason: 'There are no commands for this game yet.' };
    const strip = (a) => ({ id: a.id, label: a.label, catalog: a.catalog || null, via: a.via || 'console', fields: a.fields || [], confirm: a.confirm || null, help: a.help || null });
    return {
      available: true,
      game: this.game.name,
      pack: this.c.pack.name,
      actions: (this.spec.actions || []).map(strip),
      quick: (this.spec.quick || []).map(strip),
      catalogs: Object.keys(this.spec.catalogs || {}),
      settings: this.settings(),
      history: this.history(),
      credits: this.spec.credits || null,
    };
  }

  shutdown() {
    this._dropRcon();
  }
}

// Field types: number { min, max, integer, default }, text { pattern, max },
// toggle (renders as 1/0), choice { options: [{ value, label }] }.
function validateFields(fields, values) {
  const out = {};
  for (const f of fields) {
    const raw = values[f.key] ?? f.default;
    if (f.type === 'number') {
      const n = Number(raw);
      if (raw === '' || raw === undefined || !Number.isFinite(n)) throw new Error(`${f.label} needs a number.`);
      if (f.integer !== false && !Number.isInteger(n)) throw new Error(`${f.label} must be a whole number.`);
      if (f.min !== undefined && n < f.min) throw new Error(`${f.label} can't be below ${f.min}.`);
      if (f.max !== undefined && n > f.max) throw new Error(`${f.label} can't be above ${f.max}.`);
      if (f.repeat && n > MAX_REPEAT) throw new Error(`${f.label} can't be more than ${MAX_REPEAT} at once.`);
      out[f.key] = n;
    } else if (f.type === 'toggle') {
      out[f.key] = raw === true || raw === 1 || raw === '1' || raw === 'true' ? 1 : 0;
    } else if (f.type === 'choice') {
      if (!f.options.some((o) => String(o.value) === String(raw))) throw new Error(`Pick a ${f.label.toLowerCase()}.`);
      out[f.key] = String(raw);
    } else {
      const s = String(raw ?? '').trim();
      if (!s && !f.optional) throw new Error(`${f.label} can't be empty.`);
      if (f.max && s.length > f.max) throw new Error(`${f.label} is too long.`);
      if (f.pattern && s && !new RegExp(f.pattern).test(s)) throw new Error(f.patternHelp || `${f.label} isn't in the right format.`);
      // Quotes and pipes would let a value break out of the command string
      // and smuggle in a second command.
      if (/["|\r\n]/.test(s)) throw new Error(`${f.label} can't contain quotes or | characters.`);
      out[f.key] = s;
    }
  }
  return out;
}

function render(template, vars) {
  return template.replace(/\{(\w+)\}/g, (m, k) => {
    if (vars[k] === undefined || vars[k] === null) throw new Error(`Missing value for {${k}}.`);
    const v = String(vars[k]);
    if (/["\r\n]/.test(v) && k !== 'password') throw new Error(`Bad characters in ${k}.`);
    return v;
  });
}

module.exports = { CommandsModel, validateFields, render };
