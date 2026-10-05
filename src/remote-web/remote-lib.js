'use strict';

/* global $, el, app, send, toast */

// The phone's Library tab: the same sections, entries, pictures, guides and
// notes as the desktop Library, read from the PC. The phone never talks to
// the wiki; pictures come from the PC's cache over /api/lib-image.
const PhoneLib = (() => {
  const st = {
    packId: null,
    info: null,
    page: null,
    visible: false,
    entries: new Map(), // catalog -> entries
    filters: new Map(), // catalog -> { q, category }
  };
  const body = $('libBody');
  const PAGE = 100;

  const lib = (action, extra = {}) => send({ type: 'lib', action, ...extra });

  // ---------- pictures ----------
  // Fetched with the pairing code in a header (an <img src> can't send one),
  // a few at a time, and only once a row scrolls near the screen.
  const blobs = new Map(); // url -> Promise<objectURL|null>
  const queue = [];
  let active = 0;

  function picture(params) {
    const url = `/api/lib-image?${new URLSearchParams(params)}`;
    if (!blobs.has(url)) {
      blobs.set(url, new Promise((resolve) => { queue.push({ url, resolve }); pump(); }));
    }
    return blobs.get(url);
  }

  function pump() {
    while (active < 4 && queue.length) {
      const { url, resolve } = queue.shift();
      active++;
      fetch(url, { headers: { 'X-Keystone-Token': app.token } })
        .then((r) => (r.ok ? r.blob() : null))
        .then((b) => resolve(b ? URL.createObjectURL(b) : null), () => resolve(null))
        .finally(() => { active--; pump(); });
    }
  }

  const seen = new IntersectionObserver((items) => {
    for (const it of items) {
      if (!it.isIntersecting) continue;
      seen.unobserve(it.target);
      it.target.dispatchEvent(new Event('ks-visible'));
    }
  }, { rootMargin: '300px' });

  function thumb(catalog, e, letter) {
    const box = el('span', { class: 'lib-thumb' }, el('span', { class: 'lib-letter', text: letter }));
    box.addEventListener('ks-visible', async () => {
      const src = await picture({ kind: 'thumb', c: catalog, id: e.id });
      if (!src) return;
      const img = el('img', { alt: '', src });
      img.addEventListener('load', () => box.classList.add('has-img'));
      box.append(img);
    }, { once: true });
    seen.observe(box);
    return box;
  }

  // ---------- copying ----------
  // The phone page is plain http on your Wi-Fi, where browsers don't offer
  // the clipboard API; the old select-and-copy way still works there.
  function copy(text) {
    const done = () => toast('Copied.');
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, () => legacyCopy(text) && done());
      return;
    }
    if (legacyCopy(text)) done(); else toast('Couldn’t copy. Press and hold the code to copy it.', 'error');
  }
  function legacyCopy(text) {
    const t = el('textarea', { readonly: true, class: 'offscreen' });
    t.value = text;
    document.body.append(t);
    t.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    t.remove();
    return ok;
  }

  // ---------- navigation ----------
  // Each page is a history entry, so the phone's back gesture steps back
  // through the Library instead of leaving the app.
  function go(page, { replace = false } = {}) {
    st.page = page;
    const state = { ksLib: page };
    if (replace) history.replaceState(state, ''); else history.pushState(state, '');
    paint();
  }
  window.addEventListener('popstate', (e) => {
    if (!e.state?.ksLib) { if (st.page && st.page.kind !== 'home') { st.page = { kind: 'home' }; paint(); } return; }
    st.page = e.state.ksLib;
    paint();
  });
  $('libBack').addEventListener('click', () => history.back());

  let searchTimer;
  $('libSearch').addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = $('libSearch').value.trim();
    searchTimer = setTimeout(() => {
      if (q.length >= 2) go({ kind: 'search', q }, { replace: st.page?.kind === 'search' });
      else if (st.page?.kind === 'search') history.back();
    }, 250);
  });

  async function paint() {
    if (!st.visible || !st.info) return;
    const page = st.page || { kind: 'home' };
    $('libBack').hidden = page.kind === 'home';
    if (page.kind !== 'search' && document.activeElement !== $('libSearch')) $('libSearch').value = '';
    window.scrollTo(0, 0);
    try {
      if (page.kind === 'home') return paintHome();
      if (page.kind === 'section') return await paintSection(page);
      if (page.kind === 'entry') return await paintEntry(page);
      if (page.kind === 'guide') return await paintGuide(page);
      if (page.kind === 'search') return await paintSearch(page);
    } catch {
      body.replaceChildren(el('p', { class: 'lib-empty', text: 'Couldn’t load this from your PC.' }));
    }
    return undefined;
  }

  // Ignore answers that arrive after the person has moved on.
  const still = (page) => st.page === page || (!st.page && page.kind === 'home');

  function card(title, sub, onClick, extra) {
    const b = el('button', { class: 'lib-card' }, el('span', { class: 'lib-card-title', text: title }), sub ? el('span', { class: 'lib-card-sub', text: sub }) : null, extra || null);
    b.addEventListener('click', onClick);
    return b;
  }

  function paintHome() {
    const info = st.info;
    const out = [];
    if (info.sections.length) {
      out.push(el('h2', { class: 'tp-head', text: 'Browse' }));
      out.push(el('div', { class: 'lib-cards' }, ...info.sections.map((s) => card(s.label, null, () => go({ kind: 'section', catalog: s.catalog, label: s.label })))));
    }
    if (info.guides.length) {
      out.push(el('h2', { class: 'tp-head', text: 'Guides' }));
      out.push(el('div', { class: 'lib-guides' }, ...info.guides.map((g) => card(g.title, g.summary, () => go({ kind: 'guide', id: g.id, label: g.title })))));
    }
    if (info.links.length) {
      out.push(el('h2', { class: 'tp-head', text: 'On the web' }));
      out.push(el('div', { class: 'lib-links' }, ...info.links.map((l) => el('a', { class: 'btn', href: l.url, target: '_blank', rel: 'noopener noreferrer', text: l.label }))));
    }
    if (!out.length) out.push(el('p', { class: 'lib-empty', text: 'This game’s Library is empty.' }));
    body.replaceChildren(...out);
  }

  async function entriesOf(catalog) {
    if (!st.entries.has(catalog)) st.entries.set(catalog, await lib('entries', { catalog }));
    return st.entries.get(catalog);
  }

  function section(catalog) {
    return st.info.sections.find((s) => s.catalog === catalog);
  }

  async function paintSection(page) {
    body.replaceChildren(el('h1', { class: 'lib-h1', text: page.label }), el('p', { class: 'lib-empty', text: 'Loading…' }));
    const list = await entriesOf(page.catalog);
    if (!still(page)) return;
    const sec = section(page.catalog);
    const pics = Boolean(sec?.pictures?.thumb);
    const codes = sec?.idLabel === 'Code';
    const f = st.filters.get(page.catalog) || { q: '', category: '' };
    st.filters.set(page.catalog, f);
    const cats = [...new Set(list.map((e) => e.category).filter(Boolean))].sort();
    const q = el('input', { class: 'field', type: 'search', placeholder: `Filter ${page.label.toLowerCase()}`, autocomplete: 'off' });
    q.value = f.q;
    const sel = el('select', { class: 'field', 'aria-label': 'Category' }, el('option', { value: '', text: 'All' }), ...cats.map((c) => el('option', { value: c, text: c })));
    sel.value = f.category;
    sel.hidden = cats.length < 2;
    const rowsBox = el('div', { class: 'lib-rows' });
    const more = el('button', { class: 'btn lib-more' });
    let shown = PAGE;
    const matches = () => {
      const needle = f.q.trim().toLowerCase();
      return list.filter((e) => (!f.category || e.category === f.category) && (!needle || e.name.toLowerCase().includes(needle) || (codes && e.id.toLowerCase().includes(needle))));
    };
    const draw = () => {
      const m = matches();
      rowsBox.replaceChildren(...m.slice(0, shown).map((e) => {
        const row = el('button', { class: 'lib-row' },
          pics ? thumb(page.catalog, e, e.name.charAt(0)) : null,
          el('span', { class: 'lib-row-main' }, el('span', { class: 'row-name', text: e.name }), el('span', { class: 'lib-row-sub', text: codes ? e.id : [e.category, e.map].filter(Boolean).join(' · ') })));
        row.addEventListener('click', () => go({ kind: 'entry', catalog: page.catalog, id: e.id, label: e.name }));
        return row;
      }));
      if (!m.length) rowsBox.append(el('p', { class: 'lib-empty', text: 'Nothing matches.' }));
      more.hidden = m.length <= shown;
      more.textContent = `Show more (${m.length - shown} left)`;
    };
    more.addEventListener('click', () => { shown += PAGE; draw(); });
    q.addEventListener('input', () => { f.q = q.value; shown = PAGE; draw(); });
    sel.addEventListener('change', () => { f.category = sel.value; shown = PAGE; draw(); });
    body.replaceChildren(el('h1', { class: 'lib-h1', text: page.label }), el('div', { class: 'lib-filters' }, q, sel), rowsBox, more);
    draw();
  }

  async function paintEntry(page) {
    const e = await lib('entry', { catalog: page.catalog, id: page.id });
    if (!still(page)) return;
    const sec = section(page.catalog);
    const pics = e.pictures;
    const out = [el('h1', { class: 'lib-h1', text: e.name })];
    if (pics?.hero) {
      const fig = el('figure', { class: 'lib-hero loading' });
      out.push(fig);
      picture({ kind: 'hero', c: page.catalog, id: e.id }).then((src) => {
        if (!src) { fig.remove(); return; }
        const img = el('img', { alt: e.name, src });
        img.addEventListener('load', () => fig.classList.remove('loading'));
        fig.append(img);
      });
    }
    const dl = el('dl', { class: 'lib-facts' });
    const add = (label, ...nodes) => dl.append(el('dt', { text: label }), el('dd', {}, ...nodes));
    if (e.category) add('Category', document.createTextNode(e.category));
    if (e.map) add('Map', document.createTextNode(e.map));
    if (e.stack) add('Stack size', document.createTextNode(String(e.stack)));
    const copyable = (text) => {
      const b = el('button', { class: 'btn small', text: 'Copy' });
      b.addEventListener('click', () => copy(text));
      return [el('code', { text }), b];
    };
    if (e.commandActions?.length || (sec?.idLabel && sec.idLabel !== 'ID')) add(sec?.idLabel || 'ID', ...copyable(e.id));
    if (e.blueprint) add('Blueprint', ...copyable(e.blueprint));
    for (const [label, value] of Array.isArray(e.facts) ? e.facts : []) add(String(label), document.createTextNode(String(value)));
    if (dl.children.length) out.push(dl);
    // "Spawn tamed", "Give to me"...: the pack's commands for this entry.
    const cmds = window.PhoneCommands ? PhoneCommands.entryButtons(page.catalog, e) : [];
    if (cmds.length) out.push(el('div', { class: 'lib-cmds' }, ...cmds));
    for (const [label, items] of Array.isArray(e.lists) ? e.lists : []) {
      if (!Array.isArray(items) || !items.length) continue;
      out.push(el('h2', { class: 'tp-head', text: String(label) }), el('ul', { class: 'lib-list' }, ...items.map((t) => el('li', { text: String(t) }))));
    }
    if (pics?.spawnMaps?.length) out.push(spawnBlock(page.catalog, e, pics));
    if (e.wikiUrl) out.push(el('a', { class: 'btn primary lib-wiki', href: e.wikiUrl, target: '_blank', rel: 'noopener noreferrer', text: `Open on ${st.info.wiki?.label || 'the wiki'}` }));
    // Notes save as you type, same as on the PC.
    const note = el('textarea', { class: 'field lib-note', rows: '4', maxlength: '4000', placeholder: 'Your notes' });
    note.value = e.note || '';
    let t;
    note.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => lib('note', { catalog: page.catalog, id: e.id, text: note.value }).catch(() => {}), 600);
    });
    out.push(el('h2', { class: 'tp-head', text: 'My notes' }), note);
    if (pics?.credit) out.push(el('p', { class: 'map-credit', text: `${pics.credit}.` }));
    body.replaceChildren(...out);
  }

  // Where a creature spawns (ARK), one button per map it's on. Which maps
  // it's on isn't known up front: each map's overlay is asked for and the
  // ones that exist get a button.
  function spawnBlock(catalog, e, pics) {
    const tabs = el('div', { class: 'chips' });
    const base = el('img', { alt: '', class: 'spawn-base' });
    const over = el('img', { alt: '', class: 'spawn-over' });
    const block = el('section', { class: 'lib-spawn', hidden: true }, el('h2', { class: 'tp-head', text: 'Where it spawns' }), tabs, el('div', { class: 'spawn-stage' }, base, over));
    const show = async (i) => {
      for (const b of tabs.children) b.classList.toggle('on', Number(b.dataset.i) === i);
      const [m, o] = await Promise.all([picture({ kind: 'spawnmap', i, c: catalog, id: e.id }), picture({ kind: 'spawn', i, c: catalog, id: e.id })]);
      if (m) base.src = m;
      if (o) over.src = o;
    };
    let first = true;
    for (const m of pics.spawnMaps) {
      picture({ kind: 'spawn', i: m.index, c: catalog, id: e.id }).then((src) => {
        if (!src) return;
        const b = el('button', { class: 'chip', 'data-i': String(m.index), text: m.name });
        b.addEventListener('click', () => show(m.index));
        // Answers come back in any order; keep the pack's map order.
        const after = [...tabs.children].find((x) => Number(x.dataset.i) > m.index);
        tabs.insertBefore(b, after || null);
        block.hidden = false;
        if (first) { first = false; show(m.index); }
      });
    }
    return block;
  }

  async function paintGuide(page) {
    const g = await lib('guide', { id: page.id });
    if (!still(page)) return;
    // The PC renders guides with raw HTML escaped and only http(s) links, the
    // same Markdown the desktop shows.
    const article = el('article', { class: 'lib-guide' });
    article.innerHTML = g.html;
    for (const a of article.querySelectorAll('a[href]')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    body.replaceChildren(article);
  }

  async function paintSearch(page) {
    const hits = await lib('search', { q: page.q });
    if (!still(page)) return;
    if (!hits.length) { body.replaceChildren(el('p', { class: 'lib-empty', text: `Nothing called “${page.q}”.` })); return; }
    body.replaceChildren(el('div', { class: 'lib-guides' }, ...hits.map((h) => card(h.title, h.kind === 'entry' ? [h.section, h.sub].filter(Boolean).join(' · ') : h.sub,
      () => go(h.kind === 'entry' ? { kind: 'entry', catalog: h.catalog, id: h.id, label: h.title } : { kind: 'guide', id: h.id, label: h.title })))));
  }

  async function update(s, visible) {
    const wasVisible = st.visible;
    st.visible = Boolean(visible);
    const packId = s?.library ? s.packId || s.displayName : null;
    if (packId !== st.packId) {
      // Another game: start over.
      st.packId = packId;
      st.info = null;
      st.page = null;
      st.entries.clear();
      st.filters.clear();
      for (const p of blobs.values()) p.then((u) => u && URL.revokeObjectURL(u));
      blobs.clear();
      if (!packId) { body.replaceChildren(); return; }
    }
    if (!st.visible) return;
    if (!st.info) {
      try {
        st.info = await lib('info');
      } catch {
        return;
      }
      if (!st.page) { st.page = { kind: 'home' }; history.replaceState({ ksLib: st.page }, ''); }
      paint();
      return;
    }
    if (!wasVisible) paint();
  }

  return { update };
})();
window.PhoneLib = PhoneLib;
