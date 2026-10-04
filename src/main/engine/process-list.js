'use strict';

const koffi = require('koffi');
const win32 = require('./win32');

// Background Windows processes that are never games. Hiding them keeps the
// picker short enough to scan; the search box still finds anything.
const NOISE = new Set([
  'system', '[system process]', 'registry', 'smss.exe', 'csrss.exe', 'wininit.exe', 'services.exe',
  'lsass.exe', 'svchost.exe', 'winlogon.exe', 'fontdrvhost.exe', 'dwm.exe', 'conhost.exe',
  'runtimebroker.exe', 'sihost.exe', 'taskhostw.exe', 'ctfmon.exe', 'searchhost.exe',
  'startmenuexperiencehost.exe', 'shellexperiencehost.exe', 'textinputhost.exe', 'dllhost.exe',
  'wmiprvse.exe', 'spoolsv.exe', 'audiodg.exe', 'msmpeng.exe', 'securityhealthservice.exe',
  'searchindexer.exe', 'smartscreen.exe', 'lsaiso.exe', 'memory compression', 'wudfhost.exe',
  'applicationframehost.exe', 'systemsettings.exe', 'backgroundtaskhost.exe', 'nissrv.exe',
  'secure system', 'idle', 'explorer.exe', 'keystone.exe', 'electron.exe',
]);

function listProcesses() {
  if (process.platform !== 'win32') return [];
  const k = win32.load();
  const snap = k.CreateToolhelp32Snapshot(win32.C.TH32CS_SNAPPROCESS, 0);
  if (win32.isInvalidHandle(snap)) return [];
  const seen = new Map();
  try {
    const entry = { dwSize: koffi.sizeof(win32.PROCESSENTRY32W) };
    if (k.Process32FirstW(snap, entry)) {
      do {
        const name = entry.szExeFile;
        const pid = entry.th32ProcessID;
        if (pid <= 4 || NOISE.has(name.toLowerCase())) continue;
        // Browsers and launchers spawn dozens of same-named helpers; show each
        // app once and keep the instance with the most threads, which for a
        // game is the one actually running the game loop.
        const prev = seen.get(name.toLowerCase());
        if (!prev || entry.cntThreads > prev.threads) {
          seen.set(name.toLowerCase(), { pid, name, threads: entry.cntThreads, count: (prev?.count || 0) + 1 });
        } else {
          prev.count++;
        }
      } while (k.Process32NextW(snap, entry));
    }
  } finally {
    k.CloseHandle(snap);
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

module.exports = { listProcesses };
