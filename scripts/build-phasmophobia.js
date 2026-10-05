'use strict';

// Dev tool: builds the Phasmophobia pack's catalogs from the Phasmophobia
// Wiki: ghosts (evidence, guaranteed evidence, strengths, weaknesses),
// equipment, cursed possessions and maps.
//   node scripts/build-phasmophobia.js packs/phasmophobia
//
// The game adds ghosts and changes evidence now and then; rerun this after
// an update and check the diff.

const fs = require('fs');
const path = require('path');

const API = 'https://phasmophobia.fandom.com/api.php';
const UA = { 'User-Agent': 'Keystone catalog builder (https://github.com/twaynick/keystone)' };

// Evidence ids used in the pack, and every spelling the wiki uses for them.
const EVIDENCE = [
  { id: 'emf', name: 'EMF Level 5', match: /^EMF/i },
  { id: 'dots', name: 'D.O.T.S. Projector', match: /^D\.?O\.?T\.?S/i },
  { id: 'uv', name: 'Ultraviolet', match: /^(Ultraviolet|Fingerprints|UV)/i },
  { id: 'freezing', name: 'Freezing Temperatures', match: /^Freezing/i },
  { id: 'orb', name: 'Ghost Orb', match: /^Ghost Orb/i },
  { id: 'writing', name: 'Ghost Writing', match: /^Ghost Writing/i },
  { id: 'box', name: 'Spirit Box', match: /^Spirit Box/i },
];
const evId = (s) => (EVIDENCE.find((e) => e.match.test(s.trim())) || {}).id;

async function wikitext(titles) {
  const res = await fetch(`${API}?${new URLSearchParams({ action: 'query', titles: titles.join('|'), prop: 'revisions', rvprop: 'content', rvslots: 'main', redirects: '1', format: 'json' })}`, { headers: UA });
  const d = await res.json();
  const out = {};
  for (const p of Object.values(d.query.pages)) out[p.title] = p.revisions?.[0]?.slots?.main?.['*'] || '';
  return out;
}

const unlink = (s) => s.replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1').replace(/'''?|<\/?u>/g, '').replace(/<ref[^>]*>.*?<\/ref>|<ref[^/]*\/>/g, '').trim();
const slug = (s) => s.toLowerCase().replace(/^the /, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const pageOf = (title) => `/wiki/${encodeURIComponent(title.replace(/ /g, '_')).replace(/%2F/g, '/').replace(/%3A/g, ':').replace(/%27/g, "'")}`;

function tableRows(text) {
  return text.split(/\n\|-\s*\n/).slice(1).map((r) => r.split('\n|}')[0]);
}

async function main() {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: build-phasmophobia.js <pack dir>');
  const p = await wikitext(['Evidence', 'Ghost', 'Equipment', 'Map', 'Cursed Possession']);

  // ---- ghosts ----
  const ev = p.Evidence.slice(p.Evidence.indexOf('==Ghost evidence=='));
  const ghosts = new Map();
  for (const m of ev.matchAll(/\|-\s*\n\|\[\[([^\]|]+)(?:\|[^\]]*)?\]\]\s*\n\|(.+)/g)) {
    const cells = m[2].split('||').map((c) => c.trim()).filter(Boolean);
    ghosts.set(m[1].trim(), {
      traits: cells.map((c) => evId(unlink(c))).filter(Boolean),
      forced: cells.filter((c) => /<u>/.test(c)).map((c) => evId(unlink(c))).filter(Boolean),
    });
  }
  // Ghosts newer than the evidence table: read their own page's infobox.
  const listed = [...p.Ghost.matchAll(/\|\s*\[\[([^\]|]+)\]\]/g)].map((m) => m[1].trim());
  const all = [...new Set(listed.filter((n) => !/[:#]/.test(n)))];
  const missing = all.filter((n) => !ghosts.has(n));
  if (missing.length) {
    const pages = await wikitext(missing);
    for (const [title, text] of Object.entries(pages)) {
      const traits = [...text.matchAll(/\|\s*Evidence\d\s*=.*?(?:alt|link)=([^|\]]+)/gi)].map((m) => evId(m[1])).filter(Boolean);
      if (traits.length === 3) ghosts.set(title, { traits: [...new Set(traits)], forced: [] });
    }
  }
  const traitsTable = p.Ghost.slice(p.Ghost.indexOf('!Ghost type'));
  const notes = {};
  for (const r of tableRows(traitsTable)) {
    const m = r.match(/^!\s*\[\[([^\]|]+)(?:\|[^\]]*)?\]\]\s*\n\|([\s\S]*?)\n\|([\s\S]*)$/);
    if (!m) continue;
    const lines = (s) => unlink(s).split(/<br\s*\/?>|\n/).map((x) => x.trim()).filter(Boolean);
    notes[m[1].trim()] = { strengths: lines(m[2]), weaknesses: lines(m[3]) };
  }
  const name = (id) => EVIDENCE.find((e) => e.id === id).name;
  const ghostList = [...ghosts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([n, g]) => ({
    name: n,
    id: slug(n),
    category: 'Ghost',
    page: pageOf(n),
    traits: g.traits,
    forced: g.forced,
    // The Mimic always shows Ghost Orbs on top of its three.
    ...(n === 'The Mimic' ? { extra: ['orb'] } : {}),
    facts: [
      ['Evidence', g.traits.map(name).join(', ')],
      ...(g.forced.length ? [['Always shows', g.forced.map(name).join(', ')]] : []),
      ...(n === 'The Mimic' ? [['Also shows', 'Fake Ghost Orbs, even with no evidence given']] : []),
    ],
    lists: notes[n] ? [['Strengths', notes[n].strengths], ['Weaknesses', notes[n].weaknesses]] : [],
  }));
  if (ghostList.length < 20 || ghostList.some((g) => g.traits.length !== 3)) throw new Error('ghost table looks wrong; check the wiki layout');

  // ---- equipment ----
  const equipment = [];
  for (const [heading, category] of [['==Starter equipment==', 'Starter equipment'], ['==Optional equipment==', 'Optional equipment'], ['==Truck equipment==', 'Truck equipment']]) {
    const start = p.Equipment.indexOf(heading);
    if (start < 0) continue;
    const section = p.Equipment.slice(start, p.Equipment.indexOf('\n==', start + heading.length) >>> 0 || undefined);
    for (const r of tableRows(section)) {
      const cells = r.split(/\n\|/).map((c) => c.replace(/^\|/, '').trim());
      const title = (cells[0].match(/\[\[([^\]|#]+)/) || [])[1];
      if (!title) continue;
      const facts = [];
      if (cells[1] && /\$/.test(cells[1])) facts.push(['Price', unlink(cells[1])]);
      if (cells[2] && /^\d+$/.test(unlink(cells[2]))) facts.push(['Most you can bring', unlink(cells[2])]);
      const desc = unlink(cells.slice(3).join(' ').replace(/\n\*/g, ' • '));
      if (desc) facts.push(['What it does', desc]);
      equipment.push({ name: title.trim(), id: slug(title), category, page: pageOf(title.trim()), facts });
    }
  }

  // ---- cursed possessions ----
  const cursedNames = (p['Cursed Possession'].match(/These items are the (.+?)\./) || [])[1] || '';
  const cursed = [...cursedNames.matchAll(/\[\[([^\]|]+)\]\]/g)].map((m) => ({ name: m[1], id: slug(m[1]), category: 'Cursed possession', page: pageOf(m[1]) }));

  // ---- maps ----
  const maps = [];
  const mapSection = p.Map.slice(p.Map.indexOf('==List of maps=='), p.Map.indexOf('===Removed Maps==='));
  let size = '';
  for (const line of mapSection.split('\n')) {
    const h = line.match(/^===\s*(\w+)\s*===/);
    if (h) { size = h[1]; continue; }
    const m = line.match(/^\*\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/);
    if (m) maps.push({ name: (m[2] || m[1]).trim(), id: slug(m[2] || m[1]), category: `${size} map`, page: pageOf(m[1].trim()) });
  }

  const write = (file, list) => fs.writeFileSync(path.join(dir, file), `[\n${list.map((x) => JSON.stringify(x)).join(',\n')}\n]\n`);
  write('ghosts.json', ghostList);
  write('equipment.json', equipment);
  write('cursed.json', cursed);
  write('maps.json', maps);
  console.error(`${ghostList.length} ghosts, ${equipment.length} equipment, ${cursed.length} cursed possessions, ${maps.length} maps`);
}

main().catch((err) => { console.error(err); process.exit(1); });
