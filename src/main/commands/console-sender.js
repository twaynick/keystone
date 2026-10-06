'use strict';

const koffi = require('koffi');

// Sends commands to a game's own console by simulating the keyboard:
// focus the game window, press the console key, type (or paste) the command,
// press Enter. It needs no access to the game process, only its window, so it
// works with anti-cheat games like ASA on BattlEye servers. It is the same
// thing as typing the command yourself, just faster.

// ---- Win32 layouts (defined on every platform so tests can check sizes) ----
const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
  wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
});
const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
  dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
});
const INPUT = koffi.struct('INPUT', {
  type: 'uint32',
  u: koffi.union('INPUT_UNION', { mi: MOUSEINPUT, ki: KEYBDINPUT }),
});
const EnumWindowsProc = koffi.proto('bool __stdcall EnumWindowsProc(uintptr_t hwnd, intptr_t lParam)');

const INPUT_KEYBOARD = 1;
const KEYEVENTF_KEYUP = 0x2;
const KEYEVENTF_UNICODE = 0x4;
const KEYEVENTF_SCANCODE = 0x8;
const SW_RESTORE = 9;
const GW_OWNER = 4;

// Keys people bind the console to. Scan codes (set 1) rather than virtual
// keys, because many games read the physical key and ignore virtual-key-only
// input.
const KEYS = {
  Tab: { scan: 0x0f, label: 'Tab' },
  Backquote: { scan: 0x29, label: '` (backquote)' },
  Insert: { scan: 0x52, extended: true, label: 'Insert' },
  Enter: { scan: 0x1c },
  Escape: { scan: 0x01 },
  Ctrl: { scan: 0x1d },
  V: { scan: 0x2f },
  Alt: { scan: 0x38 },
};

// Timing. Games drop keystrokes that arrive faster than they poll input, and
// the console needs a moment to open before it accepts text.
const T = { afterFocus: 300, afterConsoleKey: 220, perChar: 6, beforeEnter: 60, afterEnter: 320 };

// ---- pure part: what to press, in order (unit-tested on any OS) ----
// keepsOpen: games differ in what Enter does. ARK closes its console after
// each command, so every line reopens it. Bethesda games (Fallout) leave it
// open, so the console opens once, takes every line, then gets closed with
// the same key; reopening per line would toggle it shut instead.
function plan(lines, { consoleKey = 'Tab', mode = 'type', keepsOpen = false } = {}) {
  if (!KEYS[consoleKey]) throw new Error(`Unknown console key "${consoleKey}".`);
  const steps = [];
  const open = () => steps.push({ key: consoleKey }, { wait: T.afterConsoleKey });
  if (keepsOpen) open();
  for (const line of lines) {
    const text = String(line);
    // Commands are ASCII; anything else (smart quotes pasted from a website)
    // would arrive as gibberish in the console.
    const bad = [...text].find((ch) => ch.charCodeAt(0) > 0x7e || ch.charCodeAt(0) < 0x20);
    if (bad) throw new Error(`The command contains a character the game console can't take: "${bad}".`);
    if (!keepsOpen) open();
    if (mode === 'paste') {
      steps.push({ clipboard: text }, { chord: ['Ctrl', 'V'] });
    } else {
      steps.push({ text });
    }
    steps.push({ wait: T.beforeEnter }, { key: 'Enter' }, { wait: T.afterEnter });
  }
  if (keepsOpen) steps.push({ key: consoleKey }, { wait: T.afterConsoleKey });
  return steps;
}

// ---- Windows part ----
let api = null;
function load() {
  if (api) return api;
  if (process.platform !== 'win32') throw new Error('Sending commands to a game needs Windows.');
  const u32 = koffi.load('user32.dll');
  api = {
    EnumWindows: u32.func('bool __stdcall EnumWindows(EnumWindowsProc *cb, intptr_t lParam)'),
    GetWindowThreadProcessId: u32.func('uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hWnd, _Out_ uint32_t *pid)'),
    IsWindowVisible: u32.func('bool __stdcall IsWindowVisible(uintptr_t hWnd)'),
    GetWindow: u32.func('uintptr_t __stdcall GetWindow(uintptr_t hWnd, uint32_t uCmd)'),
    GetWindowTextLengthW: u32.func('int __stdcall GetWindowTextLengthW(uintptr_t hWnd)'),
    IsIconic: u32.func('bool __stdcall IsIconic(uintptr_t hWnd)'),
    ShowWindow: u32.func('bool __stdcall ShowWindow(uintptr_t hWnd, int nCmdShow)'),
    SetForegroundWindow: u32.func('bool __stdcall SetForegroundWindow(uintptr_t hWnd)'),
    GetForegroundWindow: u32.func('uintptr_t __stdcall GetForegroundWindow()'),
    SendInput: u32.func('uint32_t __stdcall SendInput(uint32_t cInputs, INPUT *pInputs, int cbSize)'),
  };
  return api;
}

// Main window of a process: visible, top-level, unowned, with a title.
function findWindow(pid) {
  const k = load();
  let found = null;
  const cb = koffi.register((hwnd) => {
    const p = [0];
    k.GetWindowThreadProcessId(hwnd, p);
    if (p[0] === pid && k.IsWindowVisible(hwnd) && !BigInt(k.GetWindow(hwnd, GW_OWNER)) && k.GetWindowTextLengthW(hwnd) > 0) {
      found = hwnd;
      return false; // stop enumerating
    }
    return true;
  }, koffi.pointer(EnumWindowsProc));
  try {
    k.EnumWindows(cb, 0);
  } finally {
    koffi.unregister(cb);
  }
  return found;
}

function keyInput(name, up) {
  const k = KEYS[name];
  return {
    type: INPUT_KEYBOARD,
    u: { ki: { wVk: 0, wScan: k.scan, dwFlags: KEYEVENTF_SCANCODE | (up ? KEYEVENTF_KEYUP : 0) | (k.extended ? 1 : 0), time: 0, dwExtraInfo: 0 } },
  };
}

function charInputs(ch) {
  const code = ch.charCodeAt(0);
  return [
    { type: INPUT_KEYBOARD, u: { ki: { wVk: 0, wScan: code, dwFlags: KEYEVENTF_UNICODE, time: 0, dwExtraInfo: 0 } } },
    { type: INPUT_KEYBOARD, u: { ki: { wVk: 0, wScan: code, dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, time: 0, dwExtraInfo: 0 } } },
  ];
}

function send(inputs) {
  const k = load();
  const n = k.SendInput(inputs.length, inputs, koffi.sizeof(INPUT));
  // SendInput returns fewer events than asked when something blocks it,
  // usually a program running as administrator (UIPI).
  if (n !== inputs.length) {
    throw new Error('Windows blocked the simulated keys. If the game runs as administrator, run Keystone as administrator too.');
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function focus(hwnd) {
  const k = load();
  if (k.IsIconic(hwnd)) k.ShowWindow(hwnd, SW_RESTORE);
  if (BigInt(k.GetForegroundWindow()) === BigInt(hwnd)) return;
  // Windows only lets the foreground app hand focus to another window. A
  // tap of Alt counts as user input and lifts that restriction, which matters
  // when the command came from the phone and Keystone isn't in front.
  send([keyInput('Alt', false), keyInput('Alt', true)]);
  k.SetForegroundWindow(hwnd);
  await sleep(T.afterFocus);
  if (BigInt(k.GetForegroundWindow()) !== BigInt(hwnd)) {
    throw new Error('Windows didn’t let Keystone switch to the game. Click into the game once, then try again.');
  }
}

// Runs a list of command lines in the game whose process id is `pid`.
// `clipboard` is { readText, writeText } (Electron's), used by paste mode.
async function sendToConsole(pid, lines, { consoleKey = 'Tab', mode = 'type', keepsOpen = false, clipboard = null } = {}) {
  const steps = plan(lines, { consoleKey, mode, keepsOpen });
  const hwnd = findWindow(pid);
  if (!hwnd) throw new Error('Couldn’t find the game’s window. Is the game running and past its loading screen?');
  await focus(hwnd);
  // readText() is a Promise in newer Electron versions; await works for both.
  let saved = mode === 'paste' && clipboard ? await clipboard.readText() : null;
  if (saved !== null && typeof saved !== 'string') saved = '';
  try {
    for (const s of steps) {
      if (s.wait) await sleep(s.wait);
      else if (s.key) send([keyInput(s.key, false), keyInput(s.key, true)]);
      else if (s.chord) send([...s.chord.map((n) => keyInput(n, false)), ...s.chord.slice().reverse().map((n) => keyInput(n, true))]);
      else if (s.clipboard !== undefined) { await clipboard.writeText(s.clipboard); await sleep(30); }
      else if (s.text) {
        for (const ch of s.text) {
          send(charInputs(ch));
          await sleep(T.perChar);
        }
      }
    }
  } finally {
    // Put back whatever was on the clipboard before paste mode borrowed it.
    if (saved !== null) await clipboard.writeText(saved);
  }
}

module.exports = { sendToConsole, plan, KEYS, INPUT, KEYBDINPUT, MOUSEINPUT };
