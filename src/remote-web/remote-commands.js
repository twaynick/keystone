'use strict';

/* global $, el, send, toast, app */

// Admin and console commands from the phone: the pack's quick commands (God
// mode, Fly...), typed commands, admin login, and "Spawn tamed" / "Give to me"
// on Library entries. The PC builds, checks and sends every command; the
// phone only picks which one and fills in the form.
const PhoneCommands = (() => {
  const st = { key: null, info: null, loading: null, sheet: null };

  // Typing into the game takes a moment per line, and RCON waits for the
  // server: give long commands time before calling it a timeout.
  const RUN_TIMEOUT = 30000;

  async function info() {
    if (st.info) return st.info;
    if (!st.loading) {
      st.loading = send({ type: 'cmdInfo' }).then((i) => { st.info = i; return i; }).finally(() => { st.loading = null; });
    }
    return st.loading;
  }

  function sent(r, label) {
    if (r?.output) toast(`${label}: ${r.output.slice(0, 160)}`);
    else toast(r?.via === 'rcon' ? `${label}: sent to the server.` : `${label}: typed into the game.`);
  }

  // ---------- the form sheet ----------
  function fieldInput(f) {
    const id = `cmdf-${f.key}`;
    let input;
    if (f.type === 'toggle') {
      input = el('input', { type: 'checkbox', id });
      input.checked = Boolean(f.default);
      return el('label', { class: 'cmd-toggle', for: id }, input, el('span', { text: f.label }));
    }
    if (f.type === 'choice') {
      input = el('select', { class: 'field', id }, ...(f.options || []).map((o) => el('option', { value: String(o.value), text: o.label || String(o.value) })));
      if (f.default !== undefined) input.value = String(f.default);
    } else if (f.type === 'number') {
      input = el('input', { class: 'field', id, type: 'number', inputmode: 'numeric', min: f.min, max: f.max });
      if (f.default !== undefined) input.value = String(f.default);
    } else {
      input = el('input', { class: 'field', id, type: 'text', maxlength: f.max || 200, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
      if (f.default !== undefined) input.value = String(f.default);
    }
    const hint = f.type === 'number' && (f.min !== undefined || f.max !== undefined) ? `${f.min ?? ''}–${f.max ?? ''}` : (f.patternHelp || '');
    return el('label', { class: 'cmd-field', for: id }, el('span', { class: 'cmd-label', text: f.label }), input, hint ? el('span', { class: 'cmd-hint', text: hint }) : null);
  }

  function values(fields) {
    const out = {};
    for (const f of fields) {
      const input = $(`cmdf-${f.key}`);
      if (!input) continue;
      out[f.key] = f.type === 'toggle' ? input.checked : input.value;
    }
    return out;
  }

  // a: { id, label, help, via, fields, confirm }, kind: 'action' | 'quick'
  function openSheet(kind, a, entry) {
    st.sheet = { kind, a, entry };
    $('cmdName').textContent = entry ? `${a.label}: ${entry.name}` : a.label;
    $('cmdHelp').textContent = a.help || '';
    $('cmdHelp').hidden = !a.help;
    $('cmdFields').replaceChildren(...(a.fields || []).map(fieldInput));
    $('cmdVia').textContent = a.via === 'rcon' ? 'Sent to the server over RCON.' : 'Typed into the game’s console, so the game needs to be the window in front.';
    $('cmdSheet').hidden = false;
    $('backdrop').hidden = false;
  }

  function closeSheet() {
    if ($('cmdSheet').hidden) return;
    st.sheet = null;
    $('cmdSheet').hidden = true;
    if (!app.sheetId && $('spotSheet').hidden) $('backdrop').hidden = true;
  }
  $('backdrop').addEventListener('click', closeSheet);

  $('cmdRun').addEventListener('click', async () => {
    const sh = st.sheet;
    if (!sh) return;
    if (sh.a.confirm && !window.confirm(sh.a.confirm)) return;
    const b = $('cmdRun');
    b.disabled = true;
    try {
      const r = await send({ type: 'cmdRun', kind: sh.kind, id: sh.a.id, entryId: sh.entry?.id ?? null, values: values(sh.a.fields || []) }, RUN_TIMEOUT);
      sent(r, sh.entry ? `${sh.a.label}: ${sh.entry.name}` : sh.a.label);
      closeSheet();
    } catch { /* send() showed why */ }
    b.disabled = false;
  });

  // Quick commands without a form run on one tap (after their warning, if
  // they have one); ones with fields open the form.
  async function runQuick(a) {
    if (a.fields?.length) { openSheet('quick', a, null); return; }
    if (a.confirm && !window.confirm(a.confirm)) return;
    try { sent(await send({ type: 'cmdRun', kind: 'quick', id: a.id }, RUN_TIMEOUT), a.label); } catch { /* shown */ }
  }

  // ---------- the Tools section ----------
  async function render() {
    let i;
    try { i = await info(); } catch { return; }
    if (!i?.available) { $('cmdSec').hidden = true; return; }
    $('cmdSec').hidden = false;
    $('cmdNote').textContent = 'Console commands type into the game, so keep it the window in front. Spawn and give commands are on each creature and item in the Library.';
    $('cmdAdminRow').hidden = !i.canEnable;
    // Disabled buttons don't explain themselves on a phone (no hover), so the
    // label says what's missing.
    $('cmdAdmin').disabled = !i.hasAdminPassword;
    $('cmdAdmin').textContent = i.hasAdminPassword ? 'Admin login' : 'Admin login (save your password in Commands on the PC first)';
    $('cmdQuick').replaceChildren(...i.quick.map((a) => {
      const b = el('button', { class: `btn${a.confirm ? ' danger' : ''}`, text: a.label });
      b.addEventListener('click', () => runQuick(a));
      return b;
    }));
    $('cmdRawVia').hidden = !i.rcon;
  }

  $('cmdAdmin').addEventListener('click', async () => {
    if (!st.info?.hasAdminPassword) { toast('Save your admin password in Keystone’s Commands settings on your PC first.', 'error'); return; }
    try { await send({ type: 'cmdAdmin' }, RUN_TIMEOUT); toast('Admin login typed into the game.'); } catch { /* shown */ }
  });

  async function sendRaw() {
    const text = $('cmdRawText').value.trim();
    if (!text) { toast('Type a command first.', 'error'); return; }
    const via = $('cmdRawVia').hidden ? 'console' : $('cmdRawVia').value;
    $('cmdRawSend').disabled = true;
    try {
      sent(await send({ type: 'cmdRaw', text, via }, RUN_TIMEOUT), 'Command');
      $('cmdRawText').value = '';
    } catch { /* shown */ }
    $('cmdRawSend').disabled = false;
  }
  $('cmdRawSend').addEventListener('click', sendRaw);
  $('cmdRawText').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendRaw(); });

  // ---------- Library entries ----------
  // Buttons for an entry's actions ("Spawn tamed", "Give to me"), or [].
  function entryButtons(catalog, entry) {
    if (!entry.commandActions?.length) return [];
    return entry.commandActions.map((ca) => {
      const b = el('button', { class: 'btn primary', text: ca.label });
      b.addEventListener('click', async () => {
        try {
          const i = await info();
          const a = i?.actions?.find((x) => x.id === ca.id);
          if (!a) { toast('That command isn’t available any more.', 'error'); return; }
          openSheet('action', a, entry);
        } catch { /* shown */ }
      });
      return b;
    });
  }

  function update(s, visible) {
    const key = s?.attached && s.hasCommands ? `${s.packId}|${s.game?.pid ?? ''}` : null;
    if (key !== st.key) { st.key = key; st.info = null; closeSheet(); }
    if (!key) { $('cmdSec').hidden = true; return; }
    // The admin password can be saved on the PC at any time; ask again when
    // the Tools tab is opened.
    if (visible && !st.wasVisible) st.info = null;
    st.wasVisible = visible;
    if (visible) render();
  }

  return { update, entryButtons };
})();
window.PhoneCommands = PhoneCommands;
