'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { evaluate } = require('../src/main/identify');
const { Controller } = require('../src/main/controller');

const PACKS = path.join(__dirname, '..', 'packs');
const spec = JSON.parse(fs.readFileSync(path.join(PACKS, 'phasmophobia', 'pack.json'), 'utf8')).identify;
const ghosts = JSON.parse(fs.readFileSync(path.join(PACKS, 'phasmophobia', 'ghosts.json'), 'utf8'));
const left = (state) => evaluate(spec, ghosts, state).candidates.filter((c) => c.possible).map((c) => c.name).sort();
const why = (state, name) => evaluate(spec, ghosts, state).candidates.find((c) => c.name === name).why;

test('the ghost data is complete: 30 ghosts, 3 evidence each, no two alike', () => {
  assert.equal(ghosts.length, 30);
  const combos = new Set();
  for (const g of ghosts) {
    assert.equal(g.traits.length, 3, g.name);
    assert.ok(g.traits.every((t) => spec.traits.some((x) => x.id === t)), g.name);
    assert.ok(g.forced.every((t) => g.traits.includes(t)), `${g.name}: forced evidence is one of its own`);
    combos.add([...g.traits].sort().join('+'));
  }
  assert.equal(combos.size, 30, 'every ghost has its own evidence set');
});

test('three pieces found names one ghost', () => {
  assert.deepEqual(left({ traits: { emf: 'found', orb: 'found', box: 'found' } }), ['Dayan']);
  assert.deepEqual(left({ traits: { writing: 'found', uv: 'found', box: 'found' } }), ['Poltergeist']);
  assert.equal(left({}).length, 30);
});

test('ruling evidence out removes ghosts that give it (3 pieces given)', () => {
  const l = left({ traits: { box: 'out', orb: 'out', emf: 'out' } });
  assert.ok(l.includes('Demon') && !l.includes('Spirit') && !l.includes('Raiju'));
  assert.equal(why({ traits: { box: 'out' } }, 'Spirit'), 'You ruled out its evidence');
  assert.equal(why({ traits: { uv: 'found' } }, 'Spirit'), 'Doesn’t give that evidence');
});

test('Nightmare: one piece is hidden, so a missing piece is not proof, unless it is guaranteed', () => {
  const s = { given: 2, traits: { writing: 'found', box: 'found', emf: 'out' } };
  const l = left(s);
  assert.ok(l.includes('Spirit'), 'EMF may be the hidden one');
  assert.ok(l.includes('Mare') && l.includes('Moroi') && l.includes('Deogen'));
  // Spirit Box is guaranteed for the Moroi and Deogen.
  const s2 = { given: 2, traits: { writing: 'found', box: 'out' } };
  assert.equal(why(s2, 'Moroi'), 'Always shows evidence you ruled out');
  assert.equal(why(s2, 'Deogen'), 'Always shows evidence you ruled out');
  assert.equal(why({ given: 2, traits: { emf: 'out', writing: 'out' } }, 'Spirit'), 'You ruled out its evidence', 'two missing: can’t both be hidden');
  assert.equal(why({ given: 2, traits: { writing: 'found', emf: 'found', box: 'found' } }, 'Spirit'), 'Gives fewer pieces of evidence than you found');
});

test('the Mimic: fake orbs always, on top of its three', () => {
  assert.deepEqual(left({ traits: { orb: 'found', uv: 'found', freezing: 'found', box: 'found' } }), ['The Mimic']);
  assert.equal(why({ traits: { orb: 'out' } }, 'The Mimic'), 'It always shows this');
  assert.equal(why({ given: 0, traits: { orb: 'out' } }, 'The Mimic'), 'It always shows this', 'even with no evidence given');
  assert.ok(left({ given: 1, traits: { orb: 'found', box: 'found' } }).includes('The Mimic'), 'Insanity: orbs plus one real piece');
});

test('no evidence given: evidence rules nothing out except the Mimic\'s orbs', () => {
  assert.equal(left({ given: 0, traits: { emf: 'out', uv: 'out', box: 'out' } }).length, 30);
  assert.equal(left({ given: 0, traits: { uv: 'found' } }).length, 0);
});

test('useful evidence: what still splits the remaining ghosts', () => {
  const r = evaluate(spec, ghosts, { traits: { emf: 'found', orb: 'found' } });
  const names = r.candidates.filter((c) => c.possible).map((c) => c.name).sort();
  assert.deepEqual(names, ['Dayan', 'Obake', 'Raiju']);
  assert.deepEqual(r.useful.sort(), ['box', 'dots', 'uv']);
});

test('the identifier through the controller: cycle, difficulty, strike, reset, phone brief', () => {
  const c = new Controller({ packsDir: PACKS, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'keystone-ident-')) });
  c.listProcesses = () => [];
  c.attach({ packId: 'phasmophobia' });
  assert.equal(c.identify.info().title, 'Ghost identifier');
  c.identify.cycle('emf');
  assert.equal(c.identify.info().marks.emf, 'found');
  c.identify.cycle('emf');
  assert.equal(c.identify.info().marks.emf, 'out');
  c.identify.cycle('emf');
  assert.equal(c.identify.info().marks.emf, undefined);
  c.identify.setGiven(2);
  assert.equal(c.identify.info().given, 2);
  assert.throws(() => c.identify.setGiven(7), /Pick how much/);
  assert.throws(() => c.identify.setTrait('ectoplasm', 'found'), /isn.t in this game/);
  c.identify.strike('banshee');
  assert.equal(c.identify.info().candidates.find((x) => x.id === 'banshee').why, 'You ruled it out');
  c.identify.setTrait('box', 'found');
  const brief = c.snapshot().identify;
  assert.ok(brief.left.every((g) => g.id !== 'banshee'));
  assert.equal(brief.marks.box, 'found');
  assert.equal(c.overlay.state().identify.title, 'Ghost identifier');
  c.identify.reset();
  assert.deepEqual(c.identify.info().marks, {});
  assert.deepEqual(c.identify.info().struck, []);
  assert.equal(c.identify.info().given, 2, 'difficulty kept across contracts');
  assert.deepEqual(c.snapshot().timerPresets.slice(0, 1), ['Incense']);
  // Games without one say so.
  c.attach({ packId: 'fallout-4' });
  assert.equal(c.identify.info(), null);
  assert.throws(() => c.identify.cycle('emf'), /no identifier/);
  c.shutdown();
});
