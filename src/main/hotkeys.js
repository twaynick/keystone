'use strict';

// Per-mod hotkeys. Accelerators use Electron's format ("Ctrl+num1", "F6").
//
// Rules, so a hotkey can't break normal play or Keystone itself:
//   - letters, digits and symbols need Ctrl or Alt (otherwise typing in chat
//     or pressing a movement key would toggle a mod)
//   - F-keys, numpad keys and navigation keys can be used alone
//   - Keystone's own shortcuts are reserved

const MODIFIERS = ['Ctrl', 'Alt', 'Shift'];
const SOLO_KEYS = new Set([
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  ...Array.from({ length: 10 }, (_, i) => `num${i}`),
  'numadd', 'numsub', 'nummult', 'numdiv', 'numdec',
  'Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
]);
const NEEDS_MOD = /^([A-Z0-9]|Up|Down|Left|Right|Space|Tab|Backspace|[`\-=[\];',./\\])$/;
const RESERVED = new Set(['Ctrl+Shift+O', 'Ctrl+Shift+E', 'Ctrl+Shift+W', 'Ctrl+Shift+B', 'Ctrl+Shift+G', 'Ctrl+Shift+F']);

// Returns the normalized accelerator or throws a message for the person.
function normalize(input) {
  const parts = String(input || '').split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new Error('Press a key.');
  const key = parts.pop();
  const mods = [...new Set(parts.map((m) => {
    const x = m.toLowerCase();
    if (x === 'ctrl' || x === 'control' || x === 'commandorcontrol') return 'Ctrl';
    if (x === 'alt' || x === 'option') return 'Alt';
    if (x === 'shift') return 'Shift';
    throw new Error(`"${m}" can't be part of a hotkey.`);
  }))].sort((a, b) => MODIFIERS.indexOf(a) - MODIFIERS.indexOf(b));
  const k = /^num/i.test(key) ? key.toLowerCase() : key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1);
  if (!SOLO_KEYS.has(k) && !NEEDS_MOD.test(k)) throw new Error(`"${key}" can't be used as a hotkey.`);
  if (NEEDS_MOD.test(k) && !mods.some((m) => m === 'Ctrl' || m === 'Alt')) {
    throw new Error('Add Ctrl or Alt to that key, so typing in the game doesn’t trigger it.');
  }
  const accel = [...mods, k].join('+');
  if (RESERVED.has(accel)) throw new Error(`${accel} is one of Keystone's own shortcuts.`);
  return accel;
}

// Keeps Electron's global shortcuts in sync with the open game's hotkeys.
// Hotkeys only fire while the game has a mod session; they're released the
// moment it detaches so the keys go back to other programs.
class HotkeyRegistry {
  constructor({ globalShortcut, onFire }) {
    this.gs = globalShortcut;
    this.onFire = onFire;
    this.active = new Map(); // accel -> recordId
    this.failed = new Set();
  }

  sync(map) {
    const want = new Map(Object.entries(map || {}).map(([id, accel]) => [accel, id]));
    for (const [accel, id] of this.active) {
      if (want.get(accel) !== id) { this.gs.unregister(accel); this.active.delete(accel); }
    }
    this.failed = new Set([...this.failed].filter((a) => want.has(a)));
    for (const [accel, id] of want) {
      if (this.active.has(accel)) continue;
      let ok = false;
      try { ok = this.gs.register(accel, () => this.onFire(id)); } catch { ok = false; }
      if (ok) { this.active.set(accel, id); this.failed.delete(accel); } else this.failed.add(accel);
    }
    return [...this.failed];
  }

  clear() {
    return this.sync({});
  }
}

module.exports = { normalize, HotkeyRegistry, RESERVED };
