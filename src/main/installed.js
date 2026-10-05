'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Finds games installed through Steam, Epic and GOG, so the library can
// mark what's installed and the Play button can start games from any store.
// Only reads the stores' own manifest files and registry keys; it never runs
// the launchers.
//
// Store paths are Windows paths, so they're handled with path.win32 (which
// also keeps the parsers testable on any OS).

// ---------- parsers (pure, tested on any OS) ----------

// Valve's KeyValues text format ("key" "value" / "key" { ... }).
function parseVdf(text) {
  const tokens = [];
  const re = /"((?:[^"\\]|\\.)*)"|([{}])/g;
  let m;
  while ((m = re.exec(text))) tokens.push(m[2] || { s: m[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"') });
  let i = 0;
  function obj() {
    const out = {};
    while (i < tokens.length) {
      const t = tokens[i++];
      if (t === '}') return out;
      if (typeof t !== 'object') continue;
      const next = tokens[i];
      if (next === '{') { i++; out[t.s] = obj(); } else if (next && typeof next === 'object') { i++; out[t.s] = next.s; }
    }
    return out;
  }
  return obj();
}

function steamLibraries(vdfText) {
  const root = parseVdf(vdfText);
  const lf = root.libraryfolders || root.LibraryFolders || {};
  // Only the numbered entries are libraries; the old format also kept
  // bookkeeping keys like "TimeNextStatsReport" at the same level.
  return Object.entries(lf)
    .filter(([k]) => /^\d+$/.test(k))
    .map(([, v]) => (typeof v === 'string' ? v : v?.path))
    .filter((v) => v && /[\\/:]/.test(v));
}

function steamApp(acfText, libraryPath) {
  const st = parseVdf(acfText).AppState;
  if (!st?.appid || !st.installdir) return null;
  return {
    store: 'steam',
    id: String(st.appid),
    name: st.name || st.installdir,
    path: path.win32.join(libraryPath, 'steamapps', 'common', st.installdir),
  };
}

function epicApp(json) {
  if (!json?.AppName || !json.InstallLocation || json.bIsIncompleteInstall) return null;
  return {
    store: 'epic',
    id: String(json.AppName),
    name: json.DisplayName || json.AppName,
    path: json.InstallLocation,
    exe: json.LaunchExecutable ? path.win32.basename(json.LaunchExecutable) : null,
    // Epic's launcher URI wants namespace:catalogItemId:appName when known.
    launchId: json.CatalogNamespace && json.CatalogItemId ? `${json.CatalogNamespace}:${json.CatalogItemId}:${json.AppName}` : json.AppName,
  };
}

// `reg query HKLM\SOFTWARE\WOW6432Node\GOG.com\Games /s` output.
function gogApps(regText) {
  const out = [];
  let cur = null;
  for (const line of regText.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line.trim())) {
      if (cur?.gameID && cur.path) out.push(cur);
      cur = {};
      continue;
    }
    const m = line.match(/^\s+(\S+)\s+REG_\w+\s+(.*)$/);
    if (m && cur) cur[m[1]] = m[2].trim();
  }
  if (cur?.gameID && cur.path) out.push(cur);
  return out.map((g) => ({
    store: 'gog',
    id: g.gameID,
    name: g.gameName || g.GAMENAME || g.gameID,
    path: g.path,
    exe: g.exe ? path.win32.basename(g.exe) : (g.exeFile || null),
    exePath: g.exe || null,
  }));
}

// PowerShell JSON (see findXbox): one object when there's a single game,
// an array otherwise.
function xboxApps(jsonText) {
  let data;
  try { data = JSON.parse(jsonText || 'null'); } catch { return []; }
  if (!data) return [];
  return (Array.isArray(data) ? data : [data])
    .filter((g) => g?.family && g.appId && g.path)
    .map((g) => ({
      store: 'xbox',
      id: g.family,
      // Display names are sometimes resource ids ("ms-resource:..."): use
      // the package name then.
      name: g.name && !/^ms-resource:/i.test(g.name) ? g.name : g.pkg || g.family,
      path: g.path,
      exe: g.exe ? path.win32.basename(g.exe) : null,
      appId: g.appId,
    }));
}

// ---------- Windows discovery ----------

function reg(args) {
  return new Promise((resolve) => {
    execFile('reg', ['query', ...args], { windowsHide: true, timeout: 5000 }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

async function readText(file) {
  try { return await fs.promises.readFile(file, 'utf8'); } catch { return null; }
}

async function findSteam() {
  const out = [];
  const regOut = await reg(['HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath']);
  const m = regOut.match(/SteamPath\s+REG_SZ\s+(.+)/);
  const steamRoot = m ? m[1].trim().replace(/\//g, '\\') : 'C:\\Program Files (x86)\\Steam';
  const vdf = await readText(path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'));
  const libs = new Set([steamRoot, ...(vdf ? steamLibraries(vdf) : [])]);
  for (const lib of libs) {
    const dir = path.join(lib, 'steamapps');
    let files = [];
    try { files = await fs.promises.readdir(dir); } catch { continue; }
    for (const f of files.filter((x) => /^appmanifest_\d+\.acf$/i.test(x))) {
      const app = steamApp((await readText(path.join(dir, f))) || '', lib);
      if (app) out.push(app);
    }
  }
  return out;
}

async function findEpic() {
  const dir = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
  let files = [];
  try { files = await fs.promises.readdir(dir); } catch { return []; }
  const out = [];
  for (const f of files.filter((x) => /\.item$/i.test(x))) {
    try {
      const app = epicApp(JSON.parse((await readText(path.join(dir, f))) || '{}'));
      if (app) out.push(app);
    } catch { /* a half-written manifest: skip it */ }
  }
  return out;
}

async function findGog() {
  return gogApps(await reg(['HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games', '/s']));
}

// Xbox app / Game Pass games are Store packages. Only packages with a
// MicrosoftGame.config are games, and that file names the executable.
const XBOX_PS = [
  "$ErrorActionPreference='SilentlyContinue'",
  'Get-AppxPackage | Where-Object { -not $_.IsFramework -and $_.InstallLocation -and (Test-Path -LiteralPath (Join-Path $_.InstallLocation "MicrosoftGame.config")) } | ForEach-Object {',
  '  $cfg = [xml](Get-Content -LiteralPath (Join-Path $_.InstallLocation "MicrosoftGame.config"))',
  '  $app = (Get-AppxPackageManifest $_).Package.Applications.Application | Select-Object -First 1',
  '  [pscustomobject]@{ name = $cfg.Game.ShellVisuals.DefaultDisplayName; pkg = $_.Name; family = $_.PackageFamilyName; appId = $app.Id; path = $_.InstallLocation; exe = ($cfg.Game.ExecutableList.Executable | Select-Object -First 1).Name }',
  '} | ConvertTo-Json -Compress',
].join('\n');

function findXbox() {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', XBOX_PS], { windowsHide: true, timeout: 20000, maxBuffer: 4 << 20 }, (err, stdout) => {
      resolve(err ? [] : xboxApps(stdout));
    });
  });
}

// Does `exe` exist somewhere under `dir` (a few levels deep)? Games keep their
// executable in places like Binaries\Win64\.
async function findExe(dir, exe, depth = 4) {
  const want = exe.toLowerCase();
  async function walk(d, level) {
    let entries;
    try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return null; }
    for (const e of entries) if (e.isFile() && e.name.toLowerCase() === want) return path.join(d, e.name);
    if (level >= depth) return null;
    for (const e of entries) {
      if (e.isDirectory() && !/^(_commonredist|redist|directx|vcredist|support)$/i.test(e.name)) {
        const hit = await walk(path.join(d, e.name), level + 1);
        if (hit) return hit;
      }
    }
    return null;
  }
  return walk(dir, 0);
}

const STOP = new Set(['the', 'of', 'a', 'and', 'edition', 'game', 'remastered', 'goty', 'definitive', 'complete']);
const words = (s) => String(s).toLowerCase().replace(/[™®©]/g, '').split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w));

// "LEGO Batman: The Videogame" vs a "LEGOBatman" folder: true when most
// of the pack name's words appear in the other name (or its squashed form).
function nameLike(packName, other) {
  const want = words(packName);
  if (!want.length) return false;
  const have = words(other);
  const squashed = have.join('');
  const found = want.filter((w) => have.includes(w) || squashed.includes(w)).length;
  return found / want.length >= 0.6;
}

class InstalledGames {
  constructor({ scanners } = {}) {
    // Injectable for tests.
    this.scanners = scanners || (process.platform === 'win32' ? [findSteam, findEpic, findGog, findXbox] : []);
    this.cache = null;
    this.at = 0;
    this.exeCache = new Map();
  }

  // Five minutes: installs rarely change, and the Xbox scan starts PowerShell.
  async list({ maxAgeMs = 300_000 } = {}) {
    if (this.cache && Date.now() - this.at < maxAgeMs) return this.cache;
    const results = await Promise.all(this.scanners.map((s) => s().catch(() => [])));
    this.cache = results.flat();
    this.at = Date.now();
    return this.cache;
  }

  // Matches packs to installed games: by Steam app id first, then by the
  // pack's executable inside each install folder.
  async match(packs) {
    const games = await this.list();
    const out = new Map();
    for (const p of packs) {
      if (!p.exe.length) continue;
      const steamId = p.art?.steamAppId || p.launch?.steamAppId;
      let hit = steamId ? games.find((g) => g.store === 'steam' && g.id === String(steamId)) : null;
      if (!hit) hit = games.find((g) => g.exe && p.exe.includes(g.exe.toLowerCase()));
      if (!hit) {
        // Walking folders is slow, so only look inside installs whose name
        // looks like the pack's (a library can hold hundreds of games).
        for (const g of games.filter((x) => nameLike(p.name, x.name) || nameLike(p.name, path.win32.basename(x.path || '')))) {
          const key = `${g.path}|${p.exe[0]}`;
          if (!this.exeCache.has(key)) this.exeCache.set(key, await findExe(g.path, p.exe[0]));
          if (this.exeCache.get(key)) { hit = { ...g, exePath: this.exeCache.get(key) }; break; }
        }
      }
      if (hit) out.set(p.id, hit);
    }
    return out;
  }
}

// How to start an installed game from its store, or null.
function launchFor(hit) {
  if (!hit) return null;
  if (hit.store === 'steam') return { kind: 'uri', uri: `steam://rungameid/${hit.id}` };
  if (hit.store === 'epic') return { kind: 'uri', uri: `com.epicgames.launcher://apps/${encodeURIComponent(hit.launchId || hit.id)}?action=launch&silent=true` };
  // Store apps can't be started by their exe; Explorer starts them by their
  // app id, the same way the Start menu does.
  if (hit.store === 'xbox') return { kind: 'appx', id: `${hit.id}!${hit.appId}` };
  // GOG games are DRM-free: start the executable directly.
  if (hit.exePath) return { kind: 'path', path: hit.exePath };
  return null;
}

module.exports = { parseVdf, steamLibraries, steamApp, epicApp, gogApps, xboxApps, findExe, nameLike, InstalledGames, launchFor };
