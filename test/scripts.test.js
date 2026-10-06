'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { assembleInstruction, evalExpr, reassemble } = require('../src/main/engine/asm');
const { ScriptRunner, sections, parsePattern, findPattern, unsupportedReason } = require('../src/main/engine/autoasm');
const { parseCheatTable } = require('../src/main/engine/ct-parser');
const { DemoGame, MODULE_BASE, PLAYER, HURT_CODE, AMMO_CODE } = require('../src/main/engine/demo-game');
const { Controller } = require('../src/main/controller');

const PACKS = path.join(__dirname, '..', 'packs');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'keystone-scripts-'));
const controllers = [];
test.after(() => { for (const c of controllers) c.shutdown(); });

// ---------- assembler ----------
test('assembler: Cheat Engine syntax to the right bytes', () => {
  const syms = { newmem: 0x140100000n, 'game.exe': 0x140000000n, myvalue: 0x140100800n, return: 0x140001234n };
  const ctx = { eval: (e) => evalExpr(e, { resolve: (n) => syms[n.toLowerCase()] ?? null }) };
  const at = 0x140100000n;
  const cases = [
    ['mov [rdi+000000E8],#999', 'c787e8000000e7030000'],
    ['mov [rdi+E8],eax', '8987e8000000'],
    ['mov rcx,[rbx+08]', '488b4b08'],
    ['jmp return', 'e92f12f0ff'],
    ['je return', '0f842e12f0ff'],
    ['movss xmm0,[myvalue]', 'f30f1005f8070000'],
    ['mov [rbx+10],(float)100', 'c743100000c842'],
    ['cmp dword ptr [rcx+10],0', '83791000'],
    ['lea rax,[rcx+rdx*4+10]', '488d449110'],
    ['mov eax,[Game.exe+123456]', '8b0550340200'],
    ['mov rax,myvalue', '48b80008104001000000'],
    ['dec [rdi+18]', 'ff4f18'],
    ['cvtsi2ss xmm0,eax', 'f30f2ac0'],
    ['imul eax,ecx,#10', '6bc10a'],
    ['cmovz eax,ecx', '0f44c1'],
    ['mov r8b,1', '41b001'],
    ['fld dword ptr [rax]', 'd900'],
    ['call qword ptr [rax+10]', 'ff5010'],
    ['mov rax,-1', '48c7c0ffffffff'],
    ['and qword ptr [rax],-2', '488320fe'],
    ['vmovss xmm0,[rax]', 'c5fa1000'],
    ['nop', '90'],
    ['ret', 'c3'],
  ];
  for (const [line, hex] of cases) assert.equal(assembleInstruction(line, at, ctx).toString('hex'), hex, line);
  assert.throws(() => assembleInstruction('frobnicate eax', at, ctx), /Unknown instruction/);
  assert.throws(() => assembleInstruction('mov eax,nothere', at, ctx), /Unknown symbol/);
  assert.throws(() => assembleInstruction('jne short return', at, ctx), /Can't assemble/);
});

test('assembler: numbers are hex unless #decimal; reassemble moves RIP-relative code', () => {
  const ev = (e) => evalExpr(e, { resolve: () => null });
  assert.equal(ev('10'), 16n);
  assert.equal(ev('#10'), 10n);
  assert.equal(ev('$1000'), 0x1000n);
  assert.equal(ev('(float)1'), 0x3f800000n);
  assert.equal(ev('100-8*2'), 0xf0n);
  // mov eax,[rip+10] at 0x1000 reads 0x1016; moved to 0x2000 it must still read 0x1016.
  const moved = reassemble(Buffer.from('8b0510000000', 'hex'), 0x1000n, 0x2000n);
  assert.equal(moved.length, 6);
  assert.equal(moved.bytes.toString('hex'), '8b0510f0ffff');
});

// ---------- script text ----------
test('scripts: sections, comments, patterns and what can\'t run', () => {
  const s = sections('{ header\n comment }\n[ENABLE]\nnop // hi\n(* x *)\n[DISABLE]\ndb \'a//b\'');
  assert.deepEqual(s.enable, ['nop']);
  assert.deepEqual(s.disable, ["db 'a//b'"]);
  assert.deepEqual(sections('alloc(x,4)').enable, ['alloc(x,4)'], 'no markers: all enable');
  const p = parsePattern('48 8B ?? 1* *');
  assert.deepEqual(p.mask, [0xff, 0xff, 0, 0xf0, 0]);
  assert.match(unsupportedReason('[ENABLE]\n{$lua}\nprint(1)'), /Lua/);
  assert.equal(unsupportedReason('[ENABLE]\nnop'), null);
  const recs = parseCheatTable('<CheatTable><CheatEntries><CheatEntry><ID>1</ID><Description>"L"</Description><VariableType>Auto Assembler Script</VariableType><AssemblerScript>[ENABLE]\n{$lua}\n[DISABLE]</AssemblerScript></CheatEntry></CheatEntries></CheatTable>');
  assert.equal(recs[0].kind, 'unsupported');
  assert.match(recs[0].reason, /Lua/);
});

test('patterns are found across 16 MB chunk edges', () => {
  const big = Buffer.alloc(17 * 1024 * 1024);
  const at = 16 * 1024 * 1024 - 3;
  Buffer.from('deadbeef1122', 'hex').copy(big, at);
  const mem = { read: (a, n) => big.subarray(Number(a), Number(a) + n) };
  assert.equal(findPattern(mem, [{ base: 0n, size: big.length }], parsePattern('DE AD ?? EF 11')), BigInt(at));
  assert.equal(findPattern(mem, [{ base: 0n, size: big.length }], parsePattern('DE AD BE EF 99')), null);
});

// ---------- running scripts ----------
function demoController(extra = {}) {
  const c = new Controller({ packsDir: PACKS, dataDir: tmpDir(), ...extra });
  controllers.push(c);
  c.listProcesses = () => [];
  c.attach({ demo: true });
  return c;
}
const idOf = (c, name) => c.session.records.find((r) => r.name === name).id;

test('the demo table: God mode NOPs the damage, Infinite ammo uses a code cave, both undo', () => {
  const c = demoController();
  const game = c.session.memory;
  const hp = () => game._rf(PLAYER, 0x10);
  const ammo = () => game._ri(PLAYER, 0x18);

  c.setEnabled(idOf(c, 'God mode'), true);
  assert.equal(game.read(MODULE_BASE + 0x1000n, 9).toString('hex'), '909090909090909090');
  const h = hp();
  game.step(1000);
  assert.equal(hp(), h, 'no damage');
  assert.ok(c.session.symbols.has('hurt'));

  c.setEnabled(idOf(c, 'Infinite ammo'), true);
  const cave = game.blocks.find((b) => b.base > MODULE_BASE + 0x10000n);
  assert.ok(cave, 'a code cave was allocated');
  const jmp = game.read(MODULE_BASE + 0x1100n, 7);
  assert.equal(jmp[0], 0xe9, 'the game’s code now jumps to the cave');
  assert.equal(MODULE_BASE + 0x1105n + BigInt(jmp.readInt32LE(1)), cave.base);
  assert.equal(jmp.subarray(5).toString('hex'), '9090');
  // The cave: mov rcx,[rbx+08] then a jump back after the patched bytes.
  const caveCode = game.read(cave.base, 9);
  assert.equal(caveCode.subarray(0, 4).toString('hex'), '488b4b08');
  assert.equal(cave.base + 9n + BigInt(caveCode.readInt32LE(5)), MODULE_BASE + 0x1107n);
  const a = ammo();
  game.step(3000);
  assert.equal(ammo(), a, 'no bullets used');

  // Profiles bring scripts back in order.
  const toggles = c.session.exportToggles();
  assert.equal(toggles[idOf(c, 'Infinite ammo')].enabled, true);

  c.setEnabled(idOf(c, 'Infinite ammo'), false);
  c.setEnabled(idOf(c, 'God mode'), false);
  assert.ok(game.read(MODULE_BASE + 0x1000n, 9).equals(HURT_CODE));
  assert.ok(game.read(MODULE_BASE + 0x1100n, 7).equals(AMMO_CODE));
  assert.ok(!game.blocks.includes(cave), 'the cave was freed');
  assert.ok(!c.session.symbols.has('ammo'));

  const { failed } = c.session.importToggles(toggles);
  assert.deepEqual(failed, []);
  assert.equal(game.read(MODULE_BASE + 0x1100n, 1)[0], 0xe9);
});

test('turning off Keystone’s link to the game puts the game’s code back', () => {
  const c = demoController();
  const game = c.session.memory;
  c.setEnabled(idOf(c, 'God mode'), true);
  c.detach();
  assert.ok(game.read(MODULE_BASE + 0x1000n, 9).equals(HURT_CODE));
});

test('a value reads through a symbol once the script that registers it is on', () => {
  const ct = `<CheatTable><CheatEntries>
    <CheatEntry><ID>1</ID><Description>"Player pointer"</Description><VariableType>Auto Assembler Script</VariableType><AssemblerScript>[ENABLE]
alloc(pStats,8)
registersymbol(pStats)
pStats:
  readmem(demo.exe+2000,8)
[DISABLE]
unregistersymbol(pStats)
dealloc(pStats)</AssemblerScript>
      <CheatEntries><CheatEntry><ID>2</ID><Description>"Gold"</Description><VariableType>4 Bytes</VariableType><Address>[pStats]+1C</Address></CheatEntry></CheatEntries>
    </CheatEntry>
  </CheatEntries></CheatTable>`;
  const file = path.join(tmpDir(), 'symbols.ct');
  fs.writeFileSync(file, ct);
  const c = demoController();
  c.loadTableFile(file);
  const gold = c.session.records.find((r) => r.name === 'Gold' && r.address.includes('pStats'));
  c.session.readTick();
  assert.match(c.session.state.get(gold.id).error, /Turn on the script that sets up "pStats"/);
  c.setEnabled(c.session.records.find((r) => r.name === 'Player pointer').id, true);
  c.session.readTick();
  assert.equal(c.session.state.get(gold.id).current, c.session.memory._ri(PLAYER, 0x1c));
});

test('a script that can’t find its code changes nothing and says why', () => {
  const c = demoController();
  const game = c.session.memory;
  const r = new ScriptRunner(game, new Map());
  const before = game.blocks.length;
  assert.throws(() => r.run('x', `[ENABLE]
alloc(newmem,$100)
aobscanmodule(NOPE,demo.exe,11 22 33 44 55 66)
newmem:
  nop`, 'enable'), /Couldn't find the code this script changes \(NOPE\)/);
  assert.equal(game.blocks.length, before, 'the memory allocated first went back');
  assert.throws(() => r.run('y', '[ENABLE]\nlabel(never)\nalloc(m,10)\nm:\n jmp never', 'enable'), /never placed/);
  assert.throws(() => r.run('z', '[ENABLE]\nnop', 'enable'), /before any address/);
  assert.throws(() => r.run('w', '[ENABLE]\nassert(demo.exe+1000,90 90)', 'enable'), /isn.t what this script expects/);
});

test('a failed write puts back what was already written', () => {
  const game = new DemoGame({ tickMs: 0 });
  const realWrite = game.write.bind(game);
  game.write = (addr, buf) => (addr === MODULE_BASE + 0x1100n ? false : realWrite(addr, buf));
  const r = new ScriptRunner(game, new Map());
  assert.throws(() => r.run('x', `[ENABLE]
demo.exe+1000:
  nop 9
demo.exe+1100:
  nop 7`, 'enable'), /Couldn't write/);
  assert.ok(game.read(MODULE_BASE + 0x1000n, 9).equals(HURT_CODE), 'the first patch was undone');
});

test('a failing script shows its error on the mod', () => {
  const ct = `<CheatTable><CheatEntries><CheatEntry><ID>1</ID><Description>"Broken"</Description><VariableType>Auto Assembler Script</VariableType><AssemblerScript>[ENABLE]
aobscanmodule(X,demo.exe,DE AD BE EF)
[DISABLE]</AssemblerScript></CheatEntry></CheatEntries></CheatTable>`;
  const file = path.join(tmpDir(), 'broken.ct');
  fs.writeFileSync(file, ct);
  const c = demoController();
  c.loadTableFile(file);
  const id = idOf(c, 'Broken');
  assert.throws(() => c.setEnabled(id, true), /"Broken" didn't turn on: Couldn't find/);
  const rec = c.snapshot().records.find((r) => r.id === id);
  assert.equal(rec.enabled, false);
  assert.equal(rec.status, 'error');
  assert.match(rec.error, /Couldn't find/);
  // A hotkey or overlay tap switches scripts too.
  assert.equal(c.quickAction(idOf(c, 'God mode')).state, 'On');
  assert.equal(c.quickAction(idOf(c, 'God mode')).state, 'Off');
});
