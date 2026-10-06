'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { Scanner } = require('./engine/scanner');
const values = require('./engine/values');

// The value finder and "My mods": search the game's memory for a number the
// game shows, narrow it down, and turn what's left into a mod.
//
// Where a value lives decides how long a mod made from it lasts:
//   - inside the game's own files (static memory, "Game.exe+1A2B3C"): the
//     same place every time the game starts, so the mod is saved and can be
//     shared as a table, until a game update moves it.
//   - anywhere else (the heap): a different place every run. The mod works
//     until the game closes and isn't saved. Most values live here; the
//     pointer finder is what makes those last.

const GROUP_ID = 'mine:mods:group';
const GROUP = 'My mods';
const MAX_LISTED = 200;
const MAX_MODS = 200;
const CE_TYPE = { byte: 'Byte', int16: '2 Bytes', int32: '4 Bytes', int64: '8 Bytes', float: 'Float', double: 'Double' };

class FinderModel {
  constructor(controller) {
    this.c = controller;
    this.scanner = null;
    this.forSession = null;
    this.progress = null;
    this.sessionMods = []; // heap mods, gone with the session
    this.last = null;      // last scan's settings, so the UI can show them
  }

  get session() { return this.c.session; }

  _require() {
    if (!this.session) throw new Error(this.c.game ? 'The value finder needs mods, which aren’t available for this game right now.' : 'Choose a game first.');
    if (this.forSession !== this.session) {
      // A new game or a restart: old hits point at memory that's gone.
      this.scanner = new Scanner(this.session.memory);
      this.scanner.on('progress', (p) => { this.progress = p; this.c.emit('finder', 'progress'); });
      this.scanner.on('busy', () => this.c.emit('finder', 'busy'));
      this.forSession = this.session;
      this.sessionMods = [];
      this.last = null;
    }
    return this.scanner;
  }

  // ---------- scanning ----------
  async first(opts) {
    const s = this._require();
    const type = values.TYPES[opts?.type] ? opts.type : 'int32';
    this.progress = null;
    const r = await s.first({ ...opts, type });
    this.last = { type, compare: opts?.compare || 'exact' };
    this.c.emit('finder', 'done');
    return r;
  }

  async next(opts) {
    const s = this._require();
    this.progress = null;
    const r = await s.next(opts);
    this.last = { ...this.last, compare: opts?.compare || 'exact' };
    this.c.emit('finder', 'done');
    return r;
  }

  undo() { const n = this._require().undo(); this.c.emit('finder', 'done'); return n; }
  reset() { this._require().reset(); this.last = null; this.c.emit('finder', 'done'); return true; }
  cancel() { this._require().cancel(); return true; }

  info() {
    if (!this.session) return { available: false, reason: this.c.game ? 'The value finder needs mods, which aren’t available for this game right now.' : 'Choose a game first.', mods: this.myMods() };
    const s = this._require();
    const sum = s.summary();
    const list = !s.busy && sum.count && sum.count <= MAX_LISTED
      ? s.results(MAX_LISTED).map((r) => ({ address: hex(r.address), value: r.value, previous: r.previous, where: this.whereIs(r.address) }))
      : [];
    return { available: true, busy: s.busy, progress: s.busy ? this.progress : null, ...sum, last: this.last, results: list, listLimit: MAX_LISTED, mods: this.myMods() };
  }

  // "demo.exe+3000" for an address inside a loaded module, else null.
  whereIs(addr) {
    const mem = this.session?.memory;
    mem?.refreshModules?.();
    for (const m of mem?.modules?.values?.() || []) {
      const base = BigInt(m.base);
      if (addr >= base && addr < base + BigInt(m.size)) return `${m.name}+${(addr - base).toString(16).toUpperCase()}`;
    }
    return null;
  }

  // ---------- My mods ----------
  myMods() {
    const saved = this.c.game ? (this.c.store.load(this.c.game.key).myMods || []) : [];
    return [
      ...saved.map((m) => ({ ...m, kept: true })),
      ...this.sessionMods.map((m) => ({ ...m, kept: false })),
    ];
  }

  addMod({ address, type, name } = {}) {
    if (!this.session) throw new Error('Start the game first.');
    if (!values.TYPES[type]) throw new Error('Pick what kind of value it is.');
    let addr;
    try { addr = BigInt(`0x${String(address).replace(/^0x/i, '')}`); } catch { throw new Error('That address isn’t valid.'); }
    if (!this.session.memory.read(addr, values.sizeOf(type))) throw new Error('Keystone can’t read that address any more. Scan again.');
    const label = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!label) throw new Error('Give the mod a name, like "Caps" or "Health".');
    if (this.myMods().length >= MAX_MODS) throw new Error(`That's the limit of ${MAX_MODS} mods. Delete some first.`);
    const where = this.whereIs(addr);
    const mod = { id: `mine:mods:${crypto.randomUUID().slice(0, 8)}`, name: label, type, address: where || hex(addr), offsets: [] };
    if (where) this.c.store.update(this.c.game.key, (d) => { d.myMods = [...(d.myMods || []), mod]; });
    else this.sessionMods.push(mod);
    this.load();
    return { ...mod, kept: Boolean(where) };
  }

  renameMod(id, name) {
    const label = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!label) throw new Error('Give the mod a name.');
    this._edit(id, (m) => ({ ...m, name: label }));
    return true;
  }

  removeMod(id) {
    this._edit(id, null);
    return true;
  }

  _edit(id, fn) {
    const i = this.sessionMods.findIndex((m) => m.id === id);
    if (i >= 0) {
      if (fn) this.sessionMods[i] = fn(this.sessionMods[i]); else this.sessionMods.splice(i, 1);
    } else {
      if (!this.c.game) throw new Error('Choose a game first.');
      let found = false;
      this.c.store.update(this.c.game.key, (d) => {
        d.myMods = (d.myMods || []).flatMap((m) => {
          if (m.id !== id) return [m];
          found = true;
          return fn ? [fn(m)] : [];
        });
      });
      if (!found) throw new Error('That mod no longer exists.');
    }
    this.load();
  }

  // Puts My mods into the session as their own group. Called on attach and
  // after every change; replaces the previous copy (same id prefix).
  load() {
    const s = this.session;
    if (!s) return;
    if (this.forSession !== s) this._require();
    const mods = this.myMods();
    if (!mods.length) {
      // Nothing left: take the group out too.
      s.records = s.records.filter((r) => !r.id.startsWith('mine:mods:'));
      for (const id of [...s.state.keys()]) if (id.startsWith('mine:mods:')) s.state.delete(id);
      s.emit('structure');
      return;
    }
    const recs = [{ id: GROUP_ID, name: GROUP, kind: 'group', groupPath: [], depth: 0, source: 'mine' }];
    for (const m of mods) {
      recs.push({
        id: m.id, name: m.name, kind: 'value', valueType: m.type, address: m.address,
        offsets: (m.offsets || []).map((o) => BigInt(o)), groupPath: [GROUP], depth: 1, source: 'mine',
        ...(m.kept ? {} : { sessionOnly: true }),
      });
    }
    // Keep each mod's on/off state across the reload.
    const before = new Map([...s.state].filter(([id]) => id.startsWith('mine:mods:')));
    s.addRecords(recs, null);
    for (const [id, st] of before) if (s.state.has(id)) Object.assign(s.state.get(id), { enabled: st.enabled, target: st.target });
  }

  // ---------- sharing ----------
  // A Cheat Engine table of the saved mods: loads in Keystone (Mods, Load
  // table), in Cheat Engine, and ships with a pack as packs/<id>/mods.ct.
  tableXml() {
    const saved = this.myMods().filter((m) => m.kept);
    if (!saved.length) throw new Error('There are no saved mods to share yet. Mods from static memory are saved; ones that only last until the game closes can’t be shared.');
    const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const entries = saved.map((m, i) => {
      // CE stores offsets last-applied-first.
      const offs = (m.offsets || []).slice().reverse().map((o) => `<Offset>${BigInt(o) < 0n ? `-${(-BigInt(o)).toString(16).toUpperCase()}` : BigInt(o).toString(16).toUpperCase()}</Offset>`).join('');
      return [
        '    <CheatEntry>',
        `      <ID>${i + 1}</ID>`,
        `      <Description>"${esc(m.name)}"</Description>`,
        `      <VariableType>${CE_TYPE[m.type]}</VariableType>`,
        `      <Address>${esc(m.address)}</Address>`,
        offs ? `      <Offsets>${offs}</Offsets>` : null,
        '    </CheatEntry>',
      ].filter(Boolean).join('\n');
    });
    const game = this.c.pack?.name || this.c.game?.name || 'game';
    return `<?xml version="1.0" encoding="utf-8"?>\n<!-- ${esc(game)}: mods made with Keystone's value finder. -->\n<CheatTable CheatEngineTableVersion="45">\n  <CheatEntries>\n${entries.join('\n')}\n  </CheatEntries>\n</CheatTable>\n`;
  }

  exportTable(filePath) {
    fs.writeFileSync(filePath, this.tableXml());
    return { file: filePath, count: this.myMods().filter((m) => m.kept).length };
  }

  suggestedFileName() {
    return this.c.pack ? 'mods.ct' : `${String(this.c.game?.name || 'game').replace(/\.exe$/i, '').replace(/[^\w.-]+/g, '-')}-mods.ct`;
  }
}

const hex = (n) => n.toString(16).toUpperCase();

module.exports = { FinderModel, GROUP_ID };
