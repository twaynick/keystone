'use strict';

// Dev tool: builds a Forza car list (make, year, class and PI, value, how to
// get it, stats) from the Forza Wiki's per-game car tables.
//   node scripts/build-forza-cars.js fh5 packs/forza-horizon-5/cars.json
//   node scripts/build-forza-cars.js fh4 packs/forza-horizon-4/cars.json
//   node scripts/build-forza-cars.js fm23 packs/forza-motorsport/cars.json
//   node scripts/build-forza-cars.js fh6 packs/forza-horizon-6/cars.json

const fs = require('fs');

const API = 'https://forza.fandom.com/api.php';
const UA = { 'User-Agent': 'Keystone catalog builder (https://github.com/twaynick/keystone)' };
const PAGES = { fh6: 'Forza Horizon 6/Cars', fh5: 'Forza Horizon 5/Cars', fh4: 'Forza Horizon 4/Cars', fm23: 'Forza Motorsport (2023)/Cars' };
const TEMPLATES = { fh6: 'CarListStatsFH6', fh5: 'CarListStatsFH5', fh4: 'CarListStatsFH4', fm23: 'CarListStatsFM23' };

const RARITY = { c: 'Common', r: 'Rare', e: 'Epic', l: 'Legendary', leg: 'Legendary', h: 'Forza Edition', fe: 'Forza Edition', ae: 'Anniversary', tr: 'Treasure Car', treasure: 'Treasure Car', b: 'Barn Find', barn: 'Barn Find' };
// The wiki's own country codes (from the CarListStats templates). Note "aus"
// is Austria there, Australia is "ast" or "oz".
const COUNTRY = {
  ast: 'Australia', oz: 'Australia', aus: 'Austria', can: 'Canada', ch: 'China', cro: 'Croatia', den: 'Denmark', fr: 'France', fra: 'France',
  ger: 'Germany', it: 'Italy', ita: 'Italy', jp: 'Japan', jpn: 'Japan', kor: 'South Korea', mx: 'Mexico', mex: 'Mexico', net: 'Netherlands',
  spn: 'Spain', swe: 'Sweden', uae: 'United Arab Emirates', uk: 'United Kingdom', us: 'United States', usa: 'United States',
};
const DRIVE = { fr: 'Front engine, rear-wheel drive', ff: 'Front engine, front-wheel drive', mr: 'Mid engine, rear-wheel drive', rr: 'Rear engine, rear-wheel drive', awd: 'All-wheel drive', fa: 'Front engine, all-wheel drive', ma: 'Mid engine, all-wheel drive', ra: 'Rear engine, all-wheel drive' };

// Classes by Performance Index, as each game's template draws them. Horizon 6
// moved every band down 100 and added R (901-998) under X; Motorsport has its
// own letters.
function carClass(game, pi) {
  if (!Number.isFinite(pi)) return null;
  const bands = game === 'fh6' ? [[400, 'D'], [500, 'C'], [600, 'B'], [700, 'A'], [800, 'S1'], [900, 'S2'], [998, 'R']]
    : game === 'fm23' ? [[300, 'E'], [400, 'D'], [500, 'C'], [600, 'B'], [700, 'A'], [800, 'S'], [900, 'R'], [998, 'P']]
      : [[500, 'D'], [600, 'C'], [700, 'B'], [800, 'A'], [900, 'S1'], [998, 'S2']];
  return (bands.find(([max]) => pi <= max) || [0, 'X'])[1];
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const pageOf = (t) => `/wiki/${encodeURIComponent(t.replace(/ /g, '_')).replace(/%2F/g, '/').replace(/%3A/g, ':').replace(/%27/g, "'").replace(/%2C/g, ',').replace(/%28/g, '(').replace(/%29/g, ')')}`;
const link = (s) => { const m = String(s).match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/); return m ? { page: m[1].trim(), name: (m[2] || m[1]).trim() } : null; };
const num = (s) => Number(String(s || '').replace(/[, ]/g, ''));

// Splits template parameters on "|", except inside [[links|with labels]].
function params(raw) {
  const out = [];
  let cur = '';
  let depth = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw.startsWith('[[', i)) { depth++; cur += '[['; i++; continue; }
    if (raw.startsWith(']]', i)) { depth--; cur += ']]'; i++; continue; }
    if (raw[i] === '|' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += raw[i];
  }
  out.push(cur.trim());
  return out;
}

function row(game, raw) {
  // "#55 ACCIONA <nowiki>|</nowiki> Sainz" is a literal bar, not a separator.
  const all = params(raw.replace(/<nowiki>\|<\/nowiki>/g, '/'));
  const pos = all.filter((x) => !/^\w+\s*=/.test(x));
  const named = Object.fromEntries(all.filter((x) => /^\w+\s*=/.test(x)).map((x) => x.split(/\s*=\s*/)));
  if (game === 'fh5' || game === 'fh6') {
    const [page, display, year, rarity, value, unlock, sp, ha, ac, la, br, of, pi, country] = pos;
    return { page, name: display || page, year, rarity, value, unlock, stats: { Speed: sp, Handling: ha, Acceleration: ac, Launch: la, Braking: br, Offroad: of }, pi: num(pi), country };
  }
  if (game === 'fh4') {
    const [rarity, code, year, car, unlock, value, sp, ha, ac, la, br, pi] = pos;
    const l = link(car) || { page: car, name: car };
    // The short name is also the in-game picture's: "HOR XB1 Abarth 124.png".
    return { page: l.page, name: l.name, year, rarity, value, unlock, stats: { Speed: sp, Handling: ha, Acceleration: ac, Launch: la, Braking: br }, pi: num(pi), img: code ? `HOR XB1 ${code}.png` : null };
  }
  const [, year, car, country, drive, pi, sp, ha, ac, br, value] = pos;
  const l = link(car) || { page: car, name: car };
  return { page: l.page, name: l.name, year, value, drive, stats: { Speed: sp, Handling: ha, Acceleration: ac, Braking: br }, pi: num(pi), country, dlc: named.dlc };
}

// Wiki markup down to plain text: links to their labels, no files, tags,
// comments or italics.
function plain(s) {
  return s.replace(/<!--[\s\S]*?-->/g, '').replace(/\[\[File:[^\]]*\]\]/gi, '').replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/<[^>]+>/g, '').replace(/'{2,}/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
    // One template line forgets its closing bracket.
    .replace(/^([^()]*\([^()]*)$/, '$1)');
}

// How to get each car, worded exactly as the wiki shows it: the templates
// spell out each unlock code with the row's own details ("Car Mastery:
// Porsche 911", "Earn the Yellow Wristband"), so the rows are expanded by the
// wiki rather than mapped by hand. 100 rows a request.
const UNLOCK_DIV = {
  fh6: /<div style="font-size: 11px; line-height: 12px; padding-bottom: 1px">([\s\S]*?)<\/div>/,
  fh5: /<div style="font-size: 11px; line-height: 12px; padding-bottom: 1px">([\s\S]*?)<\/div>/,
  fh4: /<div style="font-size: smaller; line-height: 14px">([\s\S]*?)<\/div>/,
};
async function unlockTexts(game, rows) {
  if (!UNLOCK_DIV[game]) return rows.map(() => null);
  const out = [];
  const SEP = '\n@@KEYSTONE-ROW@@\n';
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    const body = new URLSearchParams({ action: 'expandtemplates', prop: 'wikitext', format: 'json', text: batch.join(SEP) });
    const res = await fetch(API, { method: 'POST', headers: { ...UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const parts = (await res.json()).expandtemplates.wikitext.split('@@KEYSTONE-ROW@@');
    if (parts.length !== batch.length) throw new Error(`expanded ${parts.length} rows, sent ${batch.length}`);
    for (const p of parts) {
      const m = p.match(UNLOCK_DIV[game]);
      const t = m ? plain(m[1]).replace(/\?{3}/g, '?') : '';
      out.push(t && !/^Unknown/.test(t) ? t : null);
    }
  }
  return out;
}

async function main() {
  const [game, out] = process.argv.slice(2);
  if (!PAGES[game] || !out) throw new Error('usage: build-forza-cars.js fh6|fh5|fh4|fm23 <out.json>');
  const res = await fetch(`${API}?${new URLSearchParams({ action: 'query', titles: PAGES[game], prop: 'revisions', rvprop: 'content', rvslots: 'main', format: 'json' })}`, { headers: UA });
  const text = Object.values((await res.json()).query.pages)[0].revisions[0].slots.main['*'];
  const rows = [];
  const seen = new Set();
  let make = '';
  for (const line of text.split('\n')) {
    // "<!-- Abarth -->" starts a make; commented-out rows are skipped.
    const heading = line.match(/^<!--\s*([^>{}]+?)\s*-->$/);
    if (heading) { make = heading[1]; continue; }
    const m = line.match(new RegExp(`^\\{\\{${TEMPLATES[game]}\\|(.*)\\}\\}\\s*$`));
    if (!m) continue;
    const c = row(game, m[1]);
    if (!c.page || !c.name || seen.has(c.page + c.year)) continue;
    seen.add(c.page + c.year);
    rows.push({ c, make, raw: line.trim() });
  }
  const unlocks = await unlockTexts(game, rows.map((r) => r.raw));
  const cars = rows.map(({ c, make }, i) => {
    const facts = [];
    if (/^\d{4}$/.test(c.year)) facts.push(['Year', c.year]);
    if (Number.isFinite(c.pi) && c.pi > 0) facts.push(['Class', `${carClass(game, c.pi)} ${c.pi}`]);
    if (num(c.value) > 0) facts.push(['Value', `${num(c.value).toLocaleString('en-US')} CR`]);
    if (unlocks[i]) facts.push(['How to get it', unlocks[i]]);
    if (RARITY[String(c.rarity || '').toLowerCase()]) facts.push(['Rarity', RARITY[String(c.rarity).toLowerCase()]]);
    if (DRIVE[String(c.drive || '').toLowerCase()]) facts.push(['Layout', DRIVE[String(c.drive).toLowerCase()]]);
    if (COUNTRY[String(c.country || '').toLowerCase()]) facts.push(['Country', COUNTRY[String(c.country).toLowerCase()]]);
    const stats = Object.entries(c.stats).filter(([, v]) => v && /^\d+(\.\d+)?$/.test(v)).map(([k, v]) => `${k} ${v}`);
    if (stats.length) facts.push(['Stats', stats.join(' · ')]);
    if (c.dlc) facts.push(['DLC', 'Yes']);
    const name = /^\d{4}$/.test(c.year) && !c.name.includes(c.year) ? `${c.year} ${c.name}` : c.name;
    // Story and event cars sit after the last make with no heading of their
    // own ("Alejandra's Flatbed Truck" isn't a Zenvo).
    const category = make && c.name.toLowerCase().includes(make.split(' ')[0].toLowerCase()) ? make : make ? 'Story and special cars' : c.name.split(' ')[0];
    const car = { name, id: slug(`${c.page}-${c.year}`), category, page: pageOf(c.page) };
    if (c.img) car.img = c.img;
    car.facts = facts;
    return car;
  });
  cars.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  fs.writeFileSync(out, `[\n${cars.map((x) => JSON.stringify(x)).join(',\n')}\n]\n`);
  console.error(`${cars.length} cars, ${new Set(cars.map((x) => x.category)).size} makes`);
}

main().catch((err) => { console.error(err); process.exit(1); });
