'use strict';

// Dev tool: builds a Library catalog from wiki categories (MediaWiki API):
// one entry per page, labelled with the category it came from.
//   node scripts/build-category-catalog.js https://farcry.fandom.com/api.php packs/far-cry-5/weapons.json \
//     "Far Cry 5 weapons=Weapon" "Far Cry 5 vehicles=Vehicle"
//
// Pages in several of the listed categories keep the first. Subcategories,
// list pages ("List of ..."), galleries and "cut content" are skipped.

const fs = require('fs');

const UA = { 'User-Agent': 'Keystone catalog builder (https://github.com/twaynick/keystone)' };

async function api(base, params) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${base}?${new URLSearchParams({ format: 'json', ...params })}`, { headers: UA });
    if (res.ok) return res.json();
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  throw new Error('API failed');
}

// Pages in a category and its subcategories (two levels: "Far Cry 5 weapons"
// keeps its guns in "Far Cry 5 assault rifles" and the like). Image, cut and
// DLC-only subcategories are skipped.
async function members(base, category, depth = 2, seen = new Set()) {
  if (seen.has(category)) return [];
  seen.add(category);
  const out = [];
  let cont = {};
  for (;;) {
    const d = await api(base, { action: 'query', list: 'categorymembers', cmtitle: `Category:${category}`, cmnamespace: '0|14', cmlimit: '500', ...cont });
    for (const m of d.query.categorymembers) {
      if (m.ns === 0) out.push(m.title);
      else if (depth > 0 && !/images?|cut|concept|icons?|files|audio|videos?|quotes/i.test(m.title)) out.push(...await members(base, m.title.replace(/^Category:/, ''), depth - 1, seen));
    }
    if (!d.continue) return out;
    cont = d.continue;
  }
}

async function cutPages(base, titles) {
  // Pages also in a "cut" category are things that never made it into the game.
  const cut = new Set();
  for (let i = 0; i < titles.length; i += 50) {
    const d = await api(base, { action: 'query', titles: titles.slice(i, i + 50).join('|'), prop: 'categories', cllimit: 'max' });
    for (const p of Object.values(d.query.pages)) if ((p.categories || []).some((c) => /\bcut\b/i.test(c.title))) cut.add(p.title);
  }
  return cut;
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const pageOf = (t) => `/wiki/${encodeURIComponent(t.replace(/ /g, '_')).replace(/%2F/g, '/').replace(/%3A/g, ':').replace(/%27/g, "'").replace(/%2C/g, ',').replace(/%28/g, '(').replace(/%29/g, ')')}`;

async function main() {
  const [base, out, ...specs] = process.argv.slice(2);
  if (!base || !out || !specs.length) throw new Error('usage: build-category-catalog.js <api.php> <out.json> "Category=Label" ...');
  const seen = new Map();
  for (const spec of specs) {
    const [cat, label] = spec.split('=');
    for (const t of await members(base, cat)) {
      // Subpages per game ("MS16/FC5") are kept; galleries and trivia aren't.
      if (/^(List of|Gallery)|\/(gallery|trivia|quotes|transcript|images?)$|\b(gallery|cut content)\b/i.test(t) || t.toLowerCase() === cat.toLowerCase()) continue;
      if (!seen.has(t)) seen.set(t, label || cat);
    }
  }
  const cut = await cutPages(base, [...seen.keys()]);
  const strip = (t) => t.replace(/\/[A-Z0-9]{2,6}$/, '').replace(/\s*\((Far Cry[^)]*|weapon|vehicle|animal|[^)]*\d)\)$/i, '');
  const items = [...seen.entries()].filter(([t]) => !cut.has(t)).map(([t, category]) => ({ name: strip(t), id: slug(t), category, page: pageOf(t) }));
  items.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  fs.writeFileSync(out, `[\n${items.map((x) => JSON.stringify(x)).join(',\n')}\n]\n`);
  console.error(`${items.length} entries (${cut.size} cut pages left out)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
