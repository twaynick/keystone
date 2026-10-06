'use strict';

// Dev tool: builds the Fallout Shelter pack's Library lists (weapons, outfits,
// dwellers, pets, rooms) from Nukapedia's overview pages.
//   node scripts/build-fallout-shelter.js packs/fallout-shelter
//
// The overview pages keep everything in tables, so this reads the rendered
// HTML (MediaWiki's "parse") rather than the wikitext, whose templates would
// need a template engine to make sense of.

const fs = require('fs');
const path = require('path');

const API = 'https://fallout.fandom.com/api.php';
const UA = { 'User-Agent': 'Keystone catalog builder (https://github.com/twaynick/keystone)' };

async function parse(page) {
  const res = await fetch(`${API}?${new URLSearchParams({ action: 'parse', page, prop: 'text', redirects: '1', format: 'json' })}`, { headers: UA });
  const d = await res.json();
  if (d.error) throw new Error(`${page}: ${d.error.info}`);
  return d.parse.text['*'];
}

const decode = (s) => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const text = (h) => decode(h.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

// Every table on the page with the section heading it sits under. Cells keep
// their HTML so links and pictures can be read from them.
function tables(html) {
  const out = [];
  const re = /<h([234])[^>]*>[\s\S]*?<span class="mw-headline" id="[^"]*">([\s\S]*?)<\/span>|<table[^>]*>([\s\S]*?)<\/table>/g;
  const heads = {};
  let m;
  while ((m = re.exec(html))) {
    if (m[1]) {
      heads[m[1]] = text(m[2]);
      for (let l = Number(m[1]) + 1; l <= 4; l++) delete heads[l];
      continue;
    }
    const rows = [...m[3].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((r) => [...r[1].matchAll(/<(t[hd])([^>]*)>([\s\S]*?)<\/t[hd]>/g)].map((c) => ({
      th: c[1] === 'th', attrs: c[2], html: c[3], text: text(c[3]),
    })));
    if (!rows.length) continue;
    out.push({ h2: heads[2] || '', h3: heads[3] || '', h4: heads[4] || '', headers: rows[0].map((c) => c.text), rows: rows.slice(1) });
  }
  return out;
}

const link = (h) => {
  const m = h.match(/<a href="\/wiki\/([^"#?]+)"[^>]*>([\s\S]*?)<\/a>/);
  return m ? { page: `/wiki/${m[1]}`, name: text(m[2]) } : null;
};
// Keys come percent-encoded ("Grognak%27s_Axe_FoS.png").
const image = (h) => {
  const k = h.match(/data-image-key="([^"]+)"/)?.[1];
  if (!k) return null;
  try { return decodeURIComponent(k).replace(/_/g, ' '); } catch { return k.replace(/_/g, ' '); }
};
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Rows under a rowspan cell (a weapon family's shared picture) have fewer
// cells; their data columns line up with the header from the right.
function rowMap(t, row) {
  const out = {};
  const off = t.headers.length - row.length;
  row.forEach((c, i) => { out[t.headers[i + off]] = c; });
  return out;
}

function nameCell(row) {
  for (const c of row) {
    if (/table-progress-checkbox|mw-file-element/.test(c.html) && !/<a href="\/wiki\/(?!File:)/.test(c.html.replace(/<span[^>]*typeof="mw:File"[\s\S]*?<\/span>/g, ''))) continue;
    const l = link(c.html.replace(/<span[^>]*typeof="mw:File"[\s\S]*?<\/span>/g, ''));
    if (l) return l;
  }
  return null;
}

const SPECIAL = ['S', 'P', 'E', 'C', 'I', 'A', 'L'];
const specialText = (r, signed) => SPECIAL.filter((k) => r[k]?.text && r[k].text !== '0').map((k) => `${k} ${signed && !/^[+-]/.test(r[k].text) ? `+${r[k].text}` : r[k].text}`).join(' · ');

async function weapons() {
  const out = [];
  for (const t of tables(await parse('Fallout Shelter weapons'))) {
    if (!t.headers.includes('Damage') || !t.headers.includes('Rarity')) continue;
    if (/cut/i.test(t.h2)) continue;
    let img = null;
    for (const row of t.rows) {
      const r = rowMap(t, row);
      const n = nameCell(row);
      // A family's picture spans its rows; carry it down.
      const rowImg = row.map((c) => image(c.html)).find(Boolean);
      if (rowImg) img = rowImg;
      if (!n || !r.Damage) continue;
      const facts = [['Damage', r.Damage.text.replace(/—/g, '-')]];
      if (r['Average damage']?.text) facts.push(['Average damage', r['Average damage'].text]);
      if (r.Value?.text) facts.push(['Sells for', `${r.Value.text} caps`]);
      if (r.Rarity?.text && r.Rarity.text !== 'none') facts.push(['Rarity', r.Rarity.text]);
      const category = t.h3 ? `${t.h3.replace(/ \d$/, '')} (${t.h2})` : t.h2;
      out.push({ name: n.name, id: slug(n.name), category: category.replace('Unarmed (Unarmed)', 'Unarmed'), page: n.page, ...(img ? { img } : {}), facts });
    }
  }
  return out;
}

async function outfits() {
  const out = [];
  for (const t of tables(await parse('Fallout Shelter outfits'))) {
    if (!t.headers.includes('Rarity') || !t.headers.includes('S')) continue;
    if (/cut/i.test(t.h2)) continue;
    for (const row of t.rows) {
      const r = rowMap(t, row);
      const n = nameCell(row);
      if (!n) continue;
      const img = row.map((c) => image(c.html)).find(Boolean);
      const facts = [];
      if (r.Rarity?.text && r.Rarity.text !== 'N/A') facts.push(['Rarity', r.Rarity.text]);
      const sp = specialText(r, true);
      if (sp) facts.push(['SPECIAL', sp]);
      if (r.Value?.text) facts.push(['Sells for', `${r.Value.text} caps`]);
      out.push({ name: n.name, id: slug(n.name), category: t.h3 || t.h2 || 'Outfits', page: n.page, ...(img ? { img } : {}), facts });
    }
  }
  return out;
}

async function dwellers() {
  const out = [];
  for (const t of tables(await parse('Fallout Shelter characters'))) {
    if (!t.headers.includes('Outfit') || !t.headers.includes('S')) continue;
    const legendary = t.headers.includes('Weapon');
    for (const row of t.rows) {
      const r = rowMap(t, row);
      // Legendary rows read "Abraham Washington<br>(<game icon> <link to the
      // character>)": the name is before the break, the link goes to the
      // original character's page, and the icon says which game they're from.
      const cell = r.Name?.html || '';
      const name = text(cell.split(/<br\s*\/?>/i)[0]);
      if (!name) continue;
      const from = cell.match(/class="va-icon" title="([^"]+)"/)?.[1] || null;
      const n = { name, page: link(cell.replace(/<span class="va-icon"[\s\S]*?<\/span><\/span>/g, ''))?.page || null };
      const img = row.map((c) => image(c.html)).find(Boolean);
      const facts = [['SPECIAL', specialText(r, false)]];
      if (r.Weapon?.text) facts.push(['Weapon', r.Weapon.text]);
      if (r.Outfit?.text && r.Outfit.text !== '-') facts.push(['Outfit', r.Outfit.text]);
      if (from) facts.push(['From', from]);
      out.push({ name: n.name, id: slug(n.name), category: legendary ? 'Legendary dwellers' : 'Rare dwellers', ...(n.page ? { page: n.page } : {}), ...(img ? { img } : {}), facts });
    }
  }
  return out;
}

// Legendary dwellers first: they're the ones people look up.
const legendaryFirst = (list) => [...list].sort((a, b) => (a.category === b.category ? 0 : a.category === 'Legendary dwellers' ? -1 : 1));

async function pets() {
  const out = [];
  for (const t of tables(await parse('Fallout Shelter pets'))) {
    if (!t.headers.includes('Breed') || !t.headers.includes('Bonus')) continue;
    for (const row of t.rows) {
      const r = rowMap(t, row);
      const breed = r.Breed?.text;
      if (!breed) continue;
      const img = row.map((c) => image(c.html)).find(Boolean);
      const facts = [['Bonus', r.Bonus.text]];
      for (const k of ['Common Bonus', 'Rare Bonus', 'Legendary Bonus']) if (r[k]?.text && r[k].text !== 'N/A') facts.push([k.replace(' Bonus', ''), r[k].text]);
      if (r['Legendary name(s)']?.text) facts.push(['Legendary name', r['Legendary name(s)'].text]);
      if (r['Breed description']?.text) facts.push(['Description', r['Breed description'].text]);
      const category = t.h3 || t.h2 || 'Pets';
      out.push({ name: breed, id: slug(`${category}-${breed}`), category, ...(img ? { img } : {}), facts });
    }
  }
  return out;
}

// Some breeds come in several kinds with different bonuses (a Burmilla can
// lower crafting cost or speed up crafting): name those by their bonus.
// Same breed and bonus twice: they differ by legendary name and strength.
function nameVariants(list) {
  const fact = (e, k) => e.facts.find(([x]) => x === k)?.[1];
  const tally = (key) => { const m = new Map(); for (const e of list) m.set(key(e), (m.get(key(e)) || 0) + 1); return m; };
  const byName = tally((e) => e.name);
  const byBonus = tally((e) => `${e.name}|${fact(e, 'Bonus')}`);
  return list.map((e) => {
    if (byName.get(e.name) < 2) return e;
    const parts = [fact(e, 'Bonus')];
    if (byBonus.get(`${e.name}|${fact(e, 'Bonus')}`) > 1 && fact(e, 'Legendary name')) parts.push(fact(e, 'Legendary name'));
    const name = `${e.name} (${parts.join(', ')})`;
    return { ...e, name, id: slug(`${e.category}-${name}`) };
  });
}

async function rooms() {
  const out = [];
  for (const t of tables(await parse('Fallout Shelter rooms'))) {
    if (!t.headers.includes('Population required')) continue;
    for (const row of t.rows) {
      const r = rowMap(t, row);
      const n = nameCell(row) || (r.Name?.text ? { name: r.Name.text, page: null } : null);
      if (!n) continue;
      const facts = [];
      const add = (label, k, suffix = '') => { const v = r[k]?.text; if (v && v !== '-') facts.push([label, `${v}${suffix}`]); };
      add('Uses', 'Ability');
      add('Unlocks at', 'Population required', ' dwellers');
      add('Cost', 'Base cost', ' caps');
      add('Upgrade to level 2', 'Upgrade cost to Lv. 2', ' caps');
      add('Upgrade to level 3', 'Upgrade cost to Lv. 3', ' caps');
      add('Dwellers', 'Capacity');
      add('Makes', 'Output');
      out.push({ name: n.name, id: slug(n.name), category: r.Category?.text || 'Rooms', ...(n.page ? { page: n.page } : {}), facts });
    }
  }
  return out;
}

function dedupe(list) {
  const seen = new Map();
  for (const e of list) {
    let id = e.id;
    for (let i = 2; seen.has(id); i++) id = `${e.id}-${i}`;
    seen.set(id, { ...e, id });
  }
  return [...seen.values()];
}

async function main() {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: build-fallout-shelter.js <pack folder>');
  for (const [file, fn] of [['weapons.json', weapons], ['outfits.json', outfits], ['dwellers.json', async () => legendaryFirst(await dwellers())], ['pets.json', async () => nameVariants(await pets())], ['rooms.json', rooms]]) {
    const list = dedupe(await fn());
    fs.writeFileSync(path.join(dir, file), `[\n${list.map((x) => JSON.stringify(x)).join(',\n')}\n]\n`);
    console.error(`${file}: ${list.length} (${[...new Set(list.map((x) => x.category))].join(', ')})`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
