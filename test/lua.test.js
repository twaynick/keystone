'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { preloadLua, LuaHost } = require('../src/main/engine/lua');
const { Session } = require('../src/main/engine/session');
const { parseCheatTable, tableLuaScript } = require('../src/main/engine/ct-parser');
const { DemoGame, MODULE_BASE, PLAYER, HURT_CODE, DAY } = require('../src/main/engine/demo-game');
const { Controller } = require('../src/main/controller');

const PACKS = path.join(__dirname, '..', 'packs');
const sessions = [];
const controllers = [];
test.before(() => preloadLua());
test.after(() => { for (const s of sessions) s.close(); for (const c of controllers) c.shutdown(); });

function demo({ limit } = {}) {
  const game = new DemoGame({ tickMs: 0, loadingEveryMs: 0 });
  const s = new Session({ memory: game, processName: 'demo.exe', pid: 0 });
  if (limit) s._lua = new LuaHost(s, { runLimitMs: limit });
  sessions.push(s);
  return { game, s, lua: (code) => s.lua().run(code, { name: 'test' }) };
}

const gold = (game) => game.read(PLAYER + 0x1cn, 4).readInt32LE(0);

function entry(id, name, body, extra = '') {
  return `<CheatEntry><ID>${id}</ID><Description>"${name}"</Description>${extra || `<VariableType>Auto Assembler Script</VariableType><AssemblerScript>${body}</AssemblerScript>`}</CheatEntry>`;
}
const xmlEscape = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------- the API ----------
test('lua: reads and writes the game like Cheat Engine', () => {
  const { game, lua } = demo();
  assert.equal(lua('return readFloat("[demo.exe+2000]+10")'), 100);
  assert.equal(lua('return readInteger("[demo.exe+2000]+1C")'), 250);
  assert.equal(lua(`return readPointer(${MODULE_BASE + 0x2000n})`), Number(PLAYER));
  assert.equal(lua('return getAddress("demo.exe+2000")'), Number(MODULE_BASE + 0x2000n));
  lua('writeInteger(readPointer("demo.exe+2000") + 0x1C, 4321)');
  assert.equal(gold(game), 4321);
  lua('local p = readPointer("demo.exe+2000"); writeFloat(p + 0x10, 55.5); writeBytes(p + 0x18, 1, 2, 0, 0)');
  assert.equal(game.read(PLAYER + 0x10n, 4).readFloatLE(0), 55.5);
  assert.equal(game.read(PLAYER + 0x18n, 4).readInt32LE(0), 0x201);
  assert.equal(lua('local t = readBytes("demo.exe+3000", 4, true); return #t .. ":" .. t[1]'), '4:1');
  assert.equal(lua('return select("#", readBytes("demo.exe+3000", 3))'), 3);
  // 64-bit values survive the trip (JavaScript numbers can't hold them).
  lua('writeQword("demo.exe+4000", -2); writeQword("demo.exe+4008", 0x7FFFFFFFFFFFFFF0)');
  assert.equal(lua('return tostring(readQword("demo.exe+4000")) .. " " .. string.format("%X", readQword("demo.exe+4008"))'), '-2 7FFFFFFFFFFFFFF0');
  lua('writeString("demo.exe+5000", "Hi there"); writeString("demo.exe+5100", "Wide", true)');
  assert.equal(lua('return readString("demo.exe+5000", 20) .. "|" .. readString("demo.exe+5100", 20, true)'), 'Hi there|Wide');
  assert.equal(lua('return readInteger("nowhere.dll+10")'), null, 'unreadable: nil, not an error');
  assert.equal(lua('return getAddressSafe("nowhere.dll+10")'), null);
  assert.equal(lua('return getNameFromAddress(getAddress("demo.exe+3000"))'), 'demo.exe+3000');
  assert.equal(lua('return getModuleSize("demo.exe")'), 0x10000);
  assert.equal(lua('return targetIs64Bit() and process'), 'demo.exe');
  assert.equal(lua('return byteTableToDword(dwordToByteTable(123456)) + byteTableToFloat(floatToByteTable(1.5))'), 123457.5);
  assert.equal(lua('return byteTableToString(stringToByteTable("abc")) .. bAnd(0xF0, 0x3C)'), 'abc48');
});

test('lua: symbols, AOB scans and autoAssemble share the session with scripts', () => {
  const { game, s, lua } = demo();
  const hurt = Number(MODULE_BASE + 0x1000n);
  assert.equal(lua('return AOBScanModuleUnique("demo.exe", "F3 0F 5C C1 F3 0F 11 47 10")'), hurt);
  assert.equal(lua('return AOBScanUnique("F3 0F 5C C1 ?? 0F 11 47")'), hurt);
  assert.equal(lua('local r = AOBScan("F3 0F 5C C1"); local n, a = r.Count, r[0]; r.destroy(); return n .. " " .. a'), `1 ${hurt.toString(16).toUpperCase()}`);
  assert.equal(lua('return AOBScan("01 02 03 04 05 06 07 08 09")'), null);
  lua('registerSymbol("pGold", readPointer("demo.exe+2000") + 0x1C)');
  assert.equal(s.symbols.get('pgold'), PLAYER + 0x1cn);
  assert.equal(lua('return readInteger("pGold")'), 250);
  // Assembled from Lua, undone with the info it returned.
  assert.equal(lua(`
    local ok, info = autoAssemble([[
[ENABLE]
demo.exe+1000:
  nop 9
[DISABLE]
demo.exe+1000:
  db F3 0F 5C C1 F3 0F 11 47 10
]])
    disableInfo = info
    return ok`), true);
  assert.ok(game.read(MODULE_BASE + 0x1000n, 9).equals(Buffer.alloc(9, 0x90)));
  lua('autoAssemble([[[ENABLE]\ndemo.exe+1000:\n  nop 9\n[DISABLE]\ndemo.exe+1000:\n  db F3 0F 5C C1 F3 0F 11 47 10]], false, disableInfo)');
  assert.ok(game.read(MODULE_BASE + 0x1000n, 9).equals(HURT_CODE));
  assert.equal(lua('local ok = autoAssemble("nowhere.dll+10:\\n nop"); return ok'), false);
  assert.match(lua('local _, e = autoAssemble("nowhere.dll+10:\\n nop"); return e'), /nowhere/i);
  const p = lua('local p = allocateMemory(0x100); writeInteger(p, 7); return p');
  assert.equal(game.read(BigInt(p), 4).readInt32LE(0), 7);
});

// ---------- scripts with Lua in them ----------
test('lua: a Lua script entry switches on and off', () => {
  const { game, s } = demo();
  const script = xmlEscape(`{$lua}
if syntaxcheck then return end
[ENABLE]
saved = readInteger("[demo.exe+2000]+1C")
writeInteger("[demo.exe+2000]+1C", 9999)
[DISABLE]
writeInteger("[demo.exe+2000]+1C", saved)
`);
  const recs = parseCheatTable(`<CheatTable><CheatEntries>${entry(1, 'Rich', script)}</CheatEntries></CheatTable>`, { sourceName: 't' });
  assert.equal(recs[0].kind, 'script');
  s.addRecords(recs, 't.CT');
  s.setEnabled('ct:t:1', true);
  assert.equal(gold(game), 9999);
  s.setEnabled('ct:t:1', false);
  assert.equal(gold(game), 250);
});

test('lua: {$lua} blocks write Auto Assembler for the script around them', () => {
  const { game, s } = demo();
  // The God mode of the demo table, with the address found from Lua.
  const script = xmlEscape(`[ENABLE]
{$lua}
if syntaxcheck then return end
local at = AOBScanModuleUnique("demo.exe", "F3 0F 5C C1 F3 0F 11 47 10")
return string.format("label(HURTAT)\\nregistersymbol(HURTAT)\\n%X:\\nHURTAT:", at)
{$asm}
  nop 9
[DISABLE]
HURTAT:
  db F3 0F 5C C1 F3 0F 11 47 10
luacall(unregisterSymbol("HURTAT"))
`);
  s.addRecords(parseCheatTable(`<CheatTable><CheatEntries>${entry(1, 'God mode', script)}</CheatEntries></CheatTable>`, { sourceName: 't' }), 't.CT');
  s.setEnabled('ct:t:1', true);
  assert.ok(game.read(MODULE_BASE + 0x1000n, 9).equals(Buffer.alloc(9, 0x90)));
  // [DISABLE] reaches HURTAT through the symbol [ENABLE] registered.
  s.setEnabled('ct:t:1', false);
  assert.ok(game.read(MODULE_BASE + 0x1000n, 9).equals(HURT_CODE));
  assert.equal(s.symbols.has('hurtat'), false, 'luacall ran');
});

test('lua: errors keep the mod off and say what went wrong', () => {
  const { s, game } = demo({ limit: 300 });
  const recs = parseCheatTable(`<CheatTable><CheatEntries>
    ${entry(1, 'Broken', xmlEscape('{$lua}\n[ENABLE]\nlocal x = nil\nreturn x.y\n[DISABLE]\n'))}
    ${entry(2, 'Forever', xmlEscape('{$lua}\n[ENABLE]\nwhile true do end\n[DISABLE]\n'))}
    ${entry(3, 'Mono', xmlEscape('{$lua}\n[ENABLE]\nLaunchMonoDataCollector()\nlocal c = mono_findClass("Player")\n[DISABLE]\n'))}
    ${entry(4, 'Missing', xmlEscape('{$lua}\n[ENABLE]\nsomeCheatEngineThing(1)\n[DISABLE]\n'))}
    ${entry(5, 'Shell', xmlEscape('{$lua}\n[ENABLE]\nshellExecute("calc.exe")\n[DISABLE]\n'))}
  </CheatEntries></CheatTable>`, { sourceName: 't' });
  s.addRecords(recs, 't.CT');
  const fails = (id, re) => {
    assert.throws(() => s.setEnabled(id, true), re);
    assert.equal(s.state.get(id).enabled, false);
    assert.match(s.state.get(id).error, re);
  };
  fails('ct:t:1', /Lua error on line 3: attempt to index a nil value/);
  const t0 = Date.now();
  fails('ct:t:2', /ran for more than/);
  assert.ok(Date.now() - t0 < 2000);
  fails('ct:t:3', /Unity Mono/);
  fails('ct:t:4', /uses someCheatEngineThing, a Cheat Engine Lua feature Keystone doesn't have/);
  fails('ct:t:5', /files, programs or the internet/);
  // Lua still works after all that.
  assert.equal(s.lua().run('return readInteger("demo.exe+3000")', { name: 'x' }), 1);
  assert.ok(game.isAlive());
});

test('lua: the locked box has no files, programs, network or bytecode', () => {
  const { lua } = demo();
  assert.equal(lua('return tostring(io) .. tostring(require) .. tostring(package) .. tostring(debug) .. tostring(dofile) .. tostring(os.execute) .. tostring(os.remove) .. tostring(string.dump)'), 'nil'.repeat(8));
  assert.equal(lua('return type(os.time()) .. type(os.clock())'), 'numbernumber');
  assert.equal(lua('return load("return 1 + 1")()'), 2);
  assert.equal(lua('local f = load("\\27LuaT"); return tostring(f)'), 'nil', 'no precompiled chunks');
  assert.equal(lua('return tostring(__ks_read) .. tostring(__ks_write)'), 'nilnil', 'raw functions are hidden');
});

// ---------- tables ----------
test('lua: a table’s startup script runs on load, and its mods can drive each other', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keystone-lua-'));
  const c = new Controller({ packsDir: PACKS, dataDir: dir });
  controllers.push(c);
  c.attach({ demo: true });
  const notices = [];
  c.on('notice', (t) => notices.push(t));
  const startup = `
function setGold(v) getAddressList().getMemoryRecordByDescription("Gold").Value = v end
showMessage("Table ready")
loadedFrom = process`;
  const ct = `<?xml version="1.0" encoding="utf-8"?>
<CheatTable CheatEngineTableVersion="45"><CheatEntries>
  ${entry(1, 'Gold', '', '<VariableType>4 Bytes</VariableType><Address>demo.exe+2000</Address><Offsets><Offset>1C</Offset></Offsets>')}
  ${entry(2, 'Give gold', xmlEscape('{$lua}\n[ENABLE]\nsetGold(777)\nmemrec.Description = "Gave gold"\n[DISABLE]\n'))}
  ${entry(3, 'All on', xmlEscape('{$lua}\n[ENABLE]\nAddressList.getMemoryRecordByID(2).Active = true\n[DISABLE]\nAddressList.getMemoryRecordByID(2).Active = false\n'))}
</CheatEntries>
<LuaScript>${xmlEscape(startup)}</LuaScript>
</CheatTable>`;
  assert.match(tableLuaScript(ct), /function setGold/);
  const file = path.join(dir, 'Lua.CT');
  fs.writeFileSync(file, ct);
  c.loadTableFile(file);
  assert.deepEqual(notices, ['Table ready']);
  const id = (n) => c.snapshot().records.find((r) => r.name === n || r.name === `Gave ${n}`)?.id;
  c.setEnabled('ct:Lua:3', true);
  const snap = c.snapshot();
  assert.equal(snap.records.find((r) => r.id === 'ct:Lua:2').enabled, true, 'one script switched another on');
  assert.equal(snap.records.find((r) => r.id === 'ct:Lua:2').name, 'Gave gold');
  assert.equal(gold(c.session.memory), 777);
  c.setEnabled('ct:Lua:3', false);
  assert.equal(c.snapshot().records.find((r) => r.id === 'ct:Lua:2').enabled, false);
  assert.ok(id('gold'));

  // A broken startup script is reported; the table still loads.
  const bad = path.join(dir, 'Bad.CT');
  fs.writeFileSync(bad, ct.replace(xmlEscape(startup), 'error("nope")'));
  c.loadTableFile(bad);
  assert.match(notices.pop(), /Bad\.CT: its Lua startup script stopped \(Lua error on line 1: nope\)\. The rest of the table loaded\./);
  assert.ok(c.snapshot().records.some((r) => r.id === 'ct:Bad:2'));
});

test('lua: timers keep running until stopped, and end with the game', async () => {
  const { game, s, lua } = demo();
  lua(`
    ticks = 0
    t = createTimer(nil, false)
    t.Interval = 20
    t.OnTimer = function(timer)
      ticks = ticks + 1
      writeInteger("[demo.exe+2000]+1C", 1000 + ticks)
      if ticks == 3 then timer.Enabled = false end
    end
    t.Enabled = true`);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(lua('return ticks'), 3);
  assert.equal(gold(game), 1003);

  // A timer that errors stops and says so, instead of failing every tick.
  const notices = [];
  s.on('notice', (n) => notices.push(n));
  lua('bad = createTimer(); bad.Interval = 10; bad.OnTimer = function() error("tick failed") end');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(notices.length, 1);
  assert.match(notices[0], /A Lua timer in this table stopped: .*tick failed/);

  lua('forever = createTimer(); forever.Interval = 10; forever.OnTimer = function() writeInteger("demo.exe+3000", 42) end');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(game.read(DAY, 4).readInt32LE(0), 42);
  s.close();
  assert.equal(s._lua.timers.size, 0, 'closing the game stops its timers');
});

test('lua: background tasks run after the script that started them', async () => {
  const { lua } = demo();
  lua('done = false; createThread(function(th) done = readInteger("demo.exe+3000") end)');
  assert.equal(lua('return done'), false);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(lua('return done'), 1);
});

test('lua: windows a table builds are accepted and stay hidden', () => {
  const { lua } = demo();
  assert.equal(lua(`
    local f = createForm(false)
    f.Caption = "Trainer"
    local b = createButton(f)
    b.Caption = "Go"
    b.OnClick = function() end
    f.show()
    getAutoAttachList().add("demo.exe")
    return f.Caption .. " " .. tostring(messageDialog("Sure?", mtConfirmation, mbYes, mbNo) == mrYes)`), 'Trainer true');
});

test('lua: the demo table’s Gold rain timer works through the app', async () => {
  const c = new Controller({ packsDir: PACKS, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'keystone-lua-')) });
  controllers.push(c);
  c.attach({ demo: true });
  const rain = c.snapshot().records.find((r) => r.name === 'Gold rain (Lua)');
  assert.equal(rain.kind, 'script');
  const lua = c.session.lua();
  lua.run('goldRainBefore = readInteger("[demo.exe+2000]+1C")', { name: 'x' });
  c.setEnabled(rain.id, true);
  // Speed the timer up rather than wait seconds.
  lua.run('goldRain.Interval = 15', { name: 'x' });
  await new Promise((r) => setTimeout(r, 100));
  const g = gold(c.session.memory);
  assert.ok(g >= 250 + 200, `gold went up (${g})`);
  c.setEnabled(rain.id, false);
  assert.equal(lua.timers.size, 0);
});

test('lua: a table that makes its mods with Lua when it opens', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keystone-lua-'));
  const c = new Controller({ packsDir: PACKS, dataDir: dir });
  controllers.push(c);
  c.attach({ demo: true });
  const startup = `
local al = getAddressList()
local group = al.createMemoryRecord()
group.Description = "Made by Lua"
group.IsGroupHeader = true

local hp = al.createMemoryRecord()
hp.Description = "Health"
hp.Type = vtSingle
hp.Address = "demo.exe+2000"
hp.OffsetCount = 1
hp.Offset[0] = 0x10
hp:appendToEntry(group)

local g = al.createMemoryRecord()
g.Description = "Gold (wrong for now)"
g.Address = "demo.exe+2000"
g.Type = vtDword
g.OffsetCount = 1
g.Offset[0] = 0x1C
g:appendToEntry(group)
g.Description = "Gold"

local s = al.createMemoryRecord()
s.Description = "No damage"
s.Type = vtAutoAssembler
s.Script = "[ENABLE]\\ndemo.exe+1000:\\n  nop 9\\n[DISABLE]\\ndemo.exe+1000:\\n  db F3 0F 5C C1 F3 0F 11 47 10\\n"
s:appendToEntry(group)

local junk = al.createMemoryRecord()
junk.Description = "Temporary"
junk:delete()
madeCount = group.Count .. " " .. group.Child[1].Description .. " " .. string.format("%X", hp.CurrentAddress)`;
  const ct = `<?xml version="1.0" encoding="utf-8"?>
<CheatTable CheatEngineTableVersion="45"><CheatEntries></CheatEntries>
<LuaScript>${xmlEscape(startup)}</LuaScript></CheatTable>`;
  const file = path.join(dir, 'Made.CT');
  fs.writeFileSync(file, ct);
  const res = c.loadTableFile(file);
  assert.equal(res.summary.values, 2);
  assert.equal(res.summary.scripts, 1);
  const mine = () => c.snapshot().records.filter((r) => r.id.startsWith('ct:Made:'));
  assert.deepEqual(mine().map((r) => [r.name, r.kind, r.groupPath.join('/')]), [
    ['Made by Lua', 'group', ''],
    ['Health', 'value', 'Made by Lua'],
    ['Gold', 'value', 'Made by Lua'],
    ['No damage', 'script', 'Made by Lua'],
  ]);
  assert.equal(c.session.lua().run('return madeCount', { name: 'x' }), `3 Gold ${(PLAYER + 0x10n).toString(16).toUpperCase()}`);
  const ids = mine().map((r) => r.id);
  const health = mine().find((r) => r.name === 'Health');
  assert.equal(c.session.state.get(health.id).current, 100);

  // They work like any mod.
  c.applyValue(mine().find((r) => r.name === 'Gold').id, 4242);
  assert.equal(gold(c.session.memory), 4242);
  c.setEnabled(mine().find((r) => r.name === 'No damage').id, true);
  assert.ok(c.session.memory.read(MODULE_BASE + 0x1000n, 9).equals(Buffer.alloc(9, 0x90)));
  c.setEnabled(mine().find((r) => r.name === 'No damage').id, false);

  // Loading the table again makes the same mods with the same ids (so
  // saved mods keep matching), not a second copy.
  c.loadTableFile(file);
  assert.deepEqual(mine().map((r) => r.id), ids);

  // Mods from the file can't be rebuilt from Lua; Lua-made ones can be deleted.
  assert.throws(() => c.session.lua().run('getAddressList().getMemoryRecordByDescription("Stamina").Address = "demo.exe+10"', { name: 'x' }), /only change the Address of mods made with Lua/);
  c.session.lua().run('getAddressList().getMemoryRecordByDescription("Made by Lua"):delete()', { name: 'x' });
  assert.equal(mine().length, 0, 'deleting a group deletes what is in it');

  // A table with no entries whose Lua makes none is still refused.
  const empty = path.join(dir, 'Empty.CT');
  fs.writeFileSync(empty, ct.replace(xmlEscape(startup), 'x = 1'));
  assert.throws(() => c.loadTableFile(empty), /has no entries, and its Lua script didn't make any/);
});
