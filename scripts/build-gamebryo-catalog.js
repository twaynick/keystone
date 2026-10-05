'use strict';

// Dev tool: builds a Fallout 3 or New Vegas item catalog (name, category,
// base-game Form ID, wiki page, picture file) from Nukapedia's item infoboxes.
//   node scripts/build-gamebryo-catalog.js fo3 packs/fallout-3/items.json
//   node scripts/build-gamebryo-catalog.js fnv packs/fallout-new-vegas/items.json
//
// Only base-game IDs ({{ID|...}}) are kept. DLC items ({{DLC ID|...}}) get
// their first two digits from the load order, so a fixed ID would be wrong
// for some players; the packs' Form ID guide explains how to work them out.

const fs = require('fs');

const API = 'https://fallout.fandom.com/api.php';
const UA = { 'User-Agent': 'Keystone catalog builder (https://github.com/twaynick/keystone)' };
const GAMES = {
  fo3: { code: 'FO3', suffix: ' (Fallout 3)' },
  fnv: { code: 'FNV', suffix: ' (Fallout: New Vegas)' },
};
const TEMPLATES = {
  'Infobox weapon gamebryo': 'Weapons',
  'Infobox apparel': 'Apparel',
  'Infobox consumable': 'Aid',
  'Infobox ammo gamebryo': 'Ammo',
  'Infobox item': 'Miscellaneous',
};

async function api(params) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${API}?${new URLSearchParams({ format: 'json', ...params })}`, { headers: UA });
    if (res.ok) return res.json();
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  throw new Error(`API failed for ${JSON.stringify(params)}`);
}

async function embeddedIn(template) {
  const titles = [];
  let cont = {};
  for (;;) {
    const d = await api({ action: 'query', list: 'embeddedin', eititle: `Template:${template}`, einamespace: '0', eilimit: '500', ...cont });
    titles.push(...d.query.embeddedin.map((p) => p.title));
    if (!d.continue) return titles;
    cont = d.continue;
  }
}

function field(text, name) {
  const m = text.match(new RegExp(`\\n\\s*\\|\\s*${name.replace(/ /g, '[ _]')}\\s*=([^\\n]*)`, 'i'));
  return m ? m[1].trim() : '';
}

function infobox(text, template) {
  const start = text.search(new RegExp(`\\{\\{\\s*${template.replace(/ /g, '[ _]')}\\s*\\n`, 'i'));
  if (start < 0) return null;
  // Up to the matching closing braces.
  let depth = 0;
  for (let i = start; i < text.length - 1; i++) {
    if (text[i] === '{' && text[i + 1] === '{') { depth++; i++; } else if (text[i] === '}' && text[i + 1] === '}') { depth--; i++; if (!depth) return text.slice(start, i + 1); }
  }
  return null;
}

const clean = (s) => s.replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1').replace(/\{\{[^}]*\}\}/g, '').replace(/<[^>]+>/g, '').replace(/'''?/g, '').trim();

async function main() {
  const [gameKey, out] = process.argv.slice(2);
  const game = GAMES[gameKey];
  if (!game || !out) throw new Error('usage: build-gamebryo-catalog.js fo3|fnv <out.json>');
  const byTitle = new Map();
  for (const [tpl, cat] of Object.entries(TEMPLATES)) for (const t of await embeddedIn(tpl)) if (!byTitle.has(t)) byTitle.set(t, { tpl, cat });
  const titles = [...byTitle.keys()];
  console.error(`${titles.length} pages use the item infoboxes`);
  const items = [];
  const seenIds = new Set();
  for (let i = 0; i < titles.length; i += 50) {
    const d = await api({ action: 'query', titles: titles.slice(i, i + 50).join('|'), prop: 'revisions', rvprop: 'content', rvslots: 'main' });
    for (const p of Object.values(d.query.pages)) {
      const text = p.revisions?.[0]?.slots?.main?.['*'];
      if (!text) continue;
      const { tpl, cat } = byTitle.get(p.title);
      const box = infobox(text, tpl);
      if (!box) continue;
      const games = field(box, 'games').toUpperCase().split(/[^A-Z0-9]+/);
      if (!games.includes(game.code)) continue;
      if (/\{\{\s*(cut content|mentioned-only)/i.test(text)) continue;
      // Developer leftovers and scripted set pieces, not things a player can use.
      if (/^(Debug |Testfx$)|\(cut\)|^Nellis Artillery$/i.test(p.title)) continue;
      const id = (field(box, 'formid').match(/\{\{\s*ID\s*\|\s*([0-9a-f]{1,8})\s*\}\}/i) || [])[1];
      if (!id) continue;
      const formId = id.toUpperCase().padStart(8, '0');
      if (seenIds.has(formId)) continue;
      seenIds.add(formId);
      let category = cat;
      if (cat === 'Weapons') { const skill = clean(field(box, 'skill')).replace(/\s*\(.*\)$/, ''); if (skill) category = `Weapons: ${skill}`; }
      if (cat === 'Miscellaneous') {
        const type = clean(field(box, 'type')).toLowerCase();
        if (/note|holotape|password|recording/.test(type)) category = 'Notes and holotapes';
        else if (/key/.test(type)) category = 'Keys';
        else if (/bobblehead/.test(type) || /^Bobblehead/.test(p.title)) category = 'Bobbleheads';
        else if (/book|magazine|skill/.test(type)) category = 'Books and magazines';
      }
      // "Wanda (weapon)" -> "Wanda": the wiki's disambiguation isn't part of the name.
      const name = (p.title.endsWith(game.suffix) ? p.title.slice(0, -game.suffix.length) : p.title)
        .replace(/\s*\((weapon|armor|apparel|item|consumable|ammunition|ammo|note|holotape|key|quest item)\)$/i, '');
      const img = field(box, 'image').replace(/^(File|Image):/i, '').replace(/‎/g, '').trim();
      items.push({
        name: name.charAt(0).toUpperCase() + name.slice(1),
        category,
        id: formId,
        page: `/wiki/${encodeURIComponent(p.title.replace(/ /g, '_')).replace(/%2F/g, '/').replace(/%3A/g, ':').replace(/%2C/g, ',').replace(/%27/g, "'")}`,
        ...(img && /\.(png|jpe?g|gif|webp)$/i.test(img) ? { img } : {}),
      });
    }
  }
  items.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  // One entry per line, like the other packs' catalogs, so diffs stay readable.
  fs.writeFileSync(out, `[\n${items.map((x) => JSON.stringify(x)).join(',\n')}\n]\n`);
  const cats = {};
  for (const x of items) cats[x.category] = (cats[x.category] || 0) + 1;
  console.error(`${items.length} items`, cats);
}

main().catch((err) => { console.error(err); process.exit(1); });
