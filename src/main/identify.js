'use strict';

// "What is it?" tools: tick the evidence you've found or ruled out and see
// what's left. Phasmophobia's ghost identifier is the first; the logic only
// knows about traits, so other games can reuse it.
//
// pack.json:
//   "identify": {
//     "title": "Ghost identifier", "catalog": "ghosts",
//     "traits": [ { "id": "emf", "name": "EMF Level 5" }, ... ],
//     "given": { "label": "Evidence given", "default": 3,
//                "options": [ [3, "3 (Professional and below)"], [2, "2 (Nightmare)"] ] }
//   }
// Catalog entries list "traits" (all of them), "forced" (always shown, even
// when fewer are given) and "extra" (shown on top, always: the Mimic's orbs).

const STATES = new Set(['found', 'out']);

// Why a candidate is out, or null if it's still possible.
function verdict(c, marks, given, struck) {
  if (struck.has(c.id)) return 'You ruled it out';
  const traits = new Set(c.traits || []);
  const extra = new Set(c.extra || []);
  const forced = new Set(c.forced || []);
  const found = Object.keys(marks).filter((t) => marks[t] === 'found');
  const out = Object.keys(marks).filter((t) => marks[t] === 'out');
  for (const t of extra) if (marks[t] === 'out') return 'It always shows this';
  const real = found.filter((t) => !extra.has(t));
  if (real.some((t) => !traits.has(t))) return 'Doesn’t give that evidence';
  if (real.length > given) return 'Gives fewer pieces of evidence than you found';
  const missingOwn = out.filter((t) => traits.has(t));
  // With fewer pieces given, some of its evidence is hidden, so ruling one
  // out doesn't rule out the ghost, until more are ruled out than can hide.
  const hidden = traits.size - given;
  if (missingOwn.length > Math.max(0, hidden)) return 'You ruled out its evidence';
  if (given >= 1 && missingOwn.some((t) => forced.has(t))) return 'Always shows evidence you ruled out';
  return null;
}

function evaluate(spec, list, state) {
  const given = Number.isInteger(state.given) ? state.given : (spec.given?.default ?? 3);
  const marks = Object.fromEntries(Object.entries(state.traits || {}).filter(([k, v]) => spec.traits.some((t) => t.id === k) && STATES.has(v)));
  const struck = new Set(state.struck || []);
  const candidates = list.map((c) => {
    const why = verdict(c, marks, given, struck);
    return { id: c.id, name: c.name, traits: c.traits || [], forced: c.forced || [], extra: c.extra || [], possible: !why, why };
  });
  const left = candidates.filter((c) => c.possible);
  // Evidence still worth checking: given by some of what's left but not all.
  const useful = spec.traits.filter((t) => !marks[t.id] && left.some((c) => c.traits.includes(t.id)) && !left.every((c) => c.traits.includes(t.id))).map((t) => t.id);
  return { given, marks, struck: [...struck], candidates, left: left.map((c) => c.id), useful };
}

class IdentifyModel {
  constructor(controller) {
    this.c = controller;
  }

  get spec() {
    const s = this.c.pack?.identify;
    return s && s.catalog && Array.isArray(s.traits) && s.traits.length ? s : null;
  }

  _require() {
    if (!this.c.game) throw new Error('Choose a game first.');
    const s = this.spec;
    if (!s) throw new Error('This game has no identifier.');
    return s;
  }

  _state() {
    return this.c.store.load(this.c.game.key).identify || {};
  }

  _update(fn) {
    this.c.store.update(this.c.game.key, (d) => {
      d.identify = d.identify || {};
      fn(d.identify);
    });
    this.c.emit('overlay');
  }

  info() {
    if (!this.c.game || !this.spec) return null;
    const s = this.spec;
    const list = this.c.library.entries(s.catalog);
    return {
      title: String(s.title || 'Identifier'),
      catalog: s.catalog,
      traits: s.traits.map((t) => ({ id: String(t.id), name: String(t.name) })),
      givenOptions: (s.given?.options || [[3, '3']]).map(([v, label]) => ({ value: Number(v), label: String(label) })),
      givenLabel: String(s.given?.label || 'Evidence given'),
      ...evaluate(s, list, this._state()),
    };
  }

  // found -> out -> unknown, for one-button toggling on the phone and desktop.
  cycle(traitId) {
    const cur = this._state().traits?.[traitId];
    return this.setTrait(traitId, cur === 'found' ? 'out' : cur === 'out' ? null : 'found');
  }

  setTrait(traitId, mark) {
    const s = this._require();
    if (!s.traits.some((t) => t.id === traitId)) throw new Error('That evidence isn’t in this game.');
    if (mark !== null && !STATES.has(mark)) throw new Error('Mark evidence as found or ruled out.');
    this._update((st) => {
      st.traits = { ...(st.traits || {}) };
      if (mark) st.traits[traitId] = mark; else delete st.traits[traitId];
    });
    return this.info();
  }

  setGiven(n) {
    const s = this._require();
    const v = Number(n);
    const allowed = (s.given?.options || [[3]]).map(([x]) => Number(x));
    if (!allowed.includes(v)) throw new Error('Pick how much evidence the ghost gives.');
    this._update((st) => { st.given = v; });
    return this.info();
  }

  strike(id, on) {
    const s = this._require();
    if (!this.c.library.entries(s.catalog).some((e) => e.id === id)) throw new Error('That isn’t in the list.');
    this._update((st) => {
      const set = new Set(st.struck || []);
      const next = on === undefined ? !set.has(id) : Boolean(on);
      if (next) set.add(id); else set.delete(id);
      st.struck = [...set];
    });
    return this.info();
  }

  // A new contract: clear the marks, keep the difficulty.
  reset() {
    this._require();
    this._update((st) => { st.traits = {}; st.struck = []; });
    return this.info();
  }
}

module.exports = { IdentifyModel, evaluate, verdict };
