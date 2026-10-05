'use strict';

// Dev tool: fills in "img" (the picture file a wiki's infobox shows) for
// catalog entries that don't have one, by reading the infobox on each
// entry's wiki page. Library pictures use it first ("File:{img}").
//   node scripts/add-wiki-pictures.js packs/fallout-4/items.json https://fallout.fandom.com/api.php FO4 "{page}" "{name} (Fallout 4)" "{lname} (Fallout 4)" "{name}" "{lname}"
//
// The game code (FO4) must appear in the infobox's "games" field when it has
// one, so a page about the same item in another game isn't used.

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

function titlesFor(e, templates) {
  const page = typeof e.page === 'string' && e.page.startsWith('/wiki/') ? decodeURIComponent(e.page.slice(6)).replace(/_/g, ' ') : null;
  const lname = e.name.charAt(0) + e.name.slice(1).toLowerCase();
  const out = [];
  for (const t of templates) {
    if (t.includes('{page}') && !page) continue;
    const v = t.replace('{page}', page || '').replace('{name}', e.name).replace('{lname}', lname);
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

function imageFrom(text, game) {
  const start = text.search(/\{\{\s*Infobox/i);
  if (start < 0) return null;
  const box = text.slice(start, start + 6000);
  const games = (box.match(/\n\s*\|\s*games\s*=([^\n]*)/i) || [])[1];
  if (games && !games.toUpperCase().split(/[^A-Z0-9]+/).includes(game)) return null;
  const img = ((box.match(/\n\s*\|\s*image\s*=([^\n|]*)/i) || [])[1] || '').replace(/^(File|Image):/i, '').replace(/‎/g, '').trim();
  return /^[^/\\?#|<>{}[\]]{1,200}\.(png|jpe?g|gif|webp)$/i.test(img) ? img : null;
}

async function main() {
  const [file, base, game, ...templates] = process.argv.slice(2);
  const items = JSON.parse(fs.readFileSync(file, 'utf8'));
  const todo = items.filter((e) => !e.img);
  const want = new Map(todo.map((e) => [e, titlesFor(e, templates)]));
  const all = [...new Set([...want.values()].flat())];
  const text = new Map();
  for (let i = 0; i < all.length; i += 50) {
    const d = await api(base, { action: 'query', titles: all.slice(i, i + 50).join('|'), prop: 'revisions', rvprop: 'content', rvslots: 'main', redirects: '1' });
    const back = new Map();
    for (const n of d.query.normalized || []) back.set(n.to, n.from);
    for (const r of d.query.redirects || []) back.set(r.to, back.get(r.from) || r.from);
    for (const p of Object.values(d.query.pages)) {
      const t = p.revisions?.[0]?.slots?.main?.['*'];
      if (t) text.set(back.get(p.title) || p.title, t);
    }
  }
  let added = 0;
  for (const [e, titles] of want) {
    for (const t of titles) {
      const img = text.has(t) ? imageFrom(text.get(t), game) : null;
      if (img) { e.img = img; added++; break; }
    }
  }
  fs.writeFileSync(file, `[\n${items.map((x) => JSON.stringify(x)).join(',\n')}\n]\n`);
  console.error(`added pictures to ${added} of ${todo.length} entries; ${items.filter((e) => e.img).length}/${items.length} now have one`);
}

main().catch((err) => { console.error(err); process.exit(1); });
