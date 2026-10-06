'use strict';

const iced = require('iced-x86');

// x86-64 assembler for Cheat Engine scripts, in Cheat Engine's syntax:
//   mov [rdi+000000E8],#999      numbers are hex unless written #decimal
//   movss xmm0,[myvalue]         a label or address in [ ] is RIP-relative
//   mov [rbx+10],(float)100      (float)/(double) give the number's bits
//   jmp return                   branches to labels are always 5/6-byte near
//                                jumps, so sizes never depend on where labels land
//
// iced-x86 (MIT, WebAssembly) does the actual encoding; this file turns text
// into iced Instructions. Instead of a hand-written opcode table, it reads
// iced's own list of instruction forms (every Code with its operand kinds)
// and picks the shortest form that fits the operands, the way an assembler
// does. That covers the whole instruction set games use (SSE, FPU, cmov,
// setcc...) without listing it here.

const R = iced.Register;
const K = iced.OpCodeOperandKind;

// ---------- lookup tables, built once ----------
let FORMS = null; // mnemonic -> [{ code, kinds: [string], mem: bytes }]
let REGS = null;  // lowercase name -> Register

function tables() {
  if (FORMS) return;
  FORMS = new Map();
  for (const name of Object.keys(iced.Code)) {
    if (!Number.isNaN(Number(name))) continue;
    const code = iced.Code[name];
    const o = iced.CodeExt.opCode(code);
    try {
      if (!o.isInstruction || !o.mode64) continue;
      const enc = iced.EncodingKind[o.encoding];
      if (enc !== 'Legacy' && enc !== 'VEX') continue;
      const kinds = [];
      for (let j = 0; j < o.opCount; j++) kinds.push(K[o.opKind(j)]);
      const m = iced.Mnemonic[o.mnemonic].toLowerCase();
      if (!FORMS.has(m)) FORMS.set(m, []);
      FORMS.get(m).push({ code, kinds, mem: o.memorySize ? iced.MemorySizeExt.size(o.memorySize) : 0 });
    } finally {
      o.free();
    }
  }
  REGS = new Map();
  for (const name of Object.keys(R)) {
    if (Number.isNaN(Number(name)) && name !== 'None') REGS.set(name.toLowerCase(), R[name]);
  }
  // Cheat Engine (and Intel) spell the low bytes of r8-r15 "r8b".
  for (let n = 8; n <= 15; n++) REGS.set(`r${n}b`, R[`R${n}L`]);
}

// Condition-code spellings that mean the same instruction.
const ALIAS = {
  jz: 'je', jnz: 'jne', jc: 'jb', jnae: 'jb', jnc: 'jae', jnb: 'jae', jna: 'jbe', jnbe: 'ja',
  jnge: 'jl', jnl: 'jge', jng: 'jle', jnle: 'jg', jpe: 'jp', jpo: 'jnp',
  cmovz: 'cmove', cmovnz: 'cmovne', cmovc: 'cmovb', cmovnae: 'cmovb', cmovnc: 'cmovae', cmovnb: 'cmovae', cmovna: 'cmovbe',
  cmovnbe: 'cmova', cmovnge: 'cmovl', cmovnl: 'cmovge', cmovng: 'cmovle', cmovnle: 'cmovg',
  setz: 'sete', setnz: 'setne', setc: 'setb', setnae: 'setb', setnc: 'setae', setnb: 'setae', setna: 'setbe', setnbe: 'seta',
  setnge: 'setl', setnl: 'setge', setng: 'setle', setnle: 'setg', sal: 'shl', retn: 'ret',
};

const SIZES = { byte: 1, word: 2, dword: 4, qword: 8, tbyte: 10, tword: 10, xmmword: 16, oword: 16, dqword: 16, ymmword: 32, real4: 4, real8: 8 };

class AsmError extends Error {}

// ---------- numbers ----------
const M64 = (1n << 64n) - 1n;

// Cheat Engine numbers: hex by default ("10" is 16), #decimal, $hex, 0xhex,
// (float)/(double)/(int) casts.
function parseNumber(tok) {
  const t = tok.trim();
  let m;
  if ((m = t.match(/^\(float\)\s*(-?[\d.]+(?:e-?\d+)?)$/i))) { const b = Buffer.alloc(4); b.writeFloatLE(Number(m[1])); return BigInt(b.readUInt32LE(0)); }
  if ((m = t.match(/^\(double\)\s*(-?[\d.]+(?:e-?\d+)?)$/i))) { const b = Buffer.alloc(8); b.writeDoubleLE(Number(m[1])); return b.readBigUInt64LE(0); }
  if ((m = t.match(/^\(int\)\s*(-?\d+)$/i))) return BigInt(m[1]);
  if ((m = t.match(/^(-)?#(\d+)$/))) return m[1] ? -BigInt(m[2]) : BigInt(m[2]);
  if ((m = t.match(/^(-)?(?:\$|0x)?([0-9a-f]+)$/i))) return m[1] ? -BigInt(`0x${m[2]}`) : BigInt(`0x${m[2]}`);
  return null;
}

// ---------- expressions: symbol+offset, [pointer], arithmetic ----------
// resolve(name) -> BigInt | null; read(addr) -> BigInt pointer (for [ ] in addresses)
function evalExpr(text, ctx) {
  const src = String(text).trim();
  let i = 0;
  const peek = () => src[i];
  const ws = () => { while (/\s/.test(src[i] || '')) i++; };
  function primary() {
    ws();
    if (peek() === '(' && !/^\((float|double|int)\)/i.test(src.slice(i))) { i++; const v = sum(); ws(); if (src[i++] !== ')') throw new AsmError(`Missing ) in "${src}"`); return v; }
    if (peek() === '[') {
      i++;
      const v = sum();
      ws();
      if (src[i++] !== ']') throw new AsmError(`Missing ] in "${src}"`);
      if (!ctx.read) throw new AsmError(`Can't read memory for "${src}"`);
      return ctx.read(v);
    }
    if (peek() === '"') {
      const end = src.indexOf('"', i + 1);
      if (end < 0) throw new AsmError(`Missing " in "${src}"`);
      const name = src.slice(i + 1, end);
      i = end + 1;
      const v = ctx.resolve(name);
      if (v === null || v === undefined) throw new AsmError(`Unknown module or symbol "${name}"`);
      return v;
    }
    const m = src.slice(i).match(/^(\((?:float|double|int)\)\s*-?[\d.]+(?:e-?\d+)?|#\d+|\$[0-9a-f]+|0x[0-9a-f]+|[\w.@$]+)/i);
    if (!m) throw new AsmError(`Can't read "${src.slice(i) || src}"`);
    i += m[0].length;
    const tok = m[0];
    // A known symbol wins over the same letters read as hex ("dead" could be either).
    if (/^[a-z_@][\w.@$]*$/i.test(tok)) {
      const v = ctx.resolve(tok);
      if (v !== null && v !== undefined) return v;
    }
    const n = parseNumber(tok);
    if (n === null) throw new AsmError(`Unknown symbol "${tok}"`);
    return n;
  }
  function unary() { ws(); if (peek() === '-') { i++; return -unary(); } if (peek() === '+') { i++; return unary(); } return primary(); }
  function product() { let v = unary(); for (;;) { ws(); if (peek() === '*') { i++; v *= unary(); } else return v; } }
  function sum() { let v = product(); for (;;) { ws(); if (peek() === '+') { i++; v += product(); } else if (peek() === '-') { i++; v -= product(); } else return v; } }
  const v = sum();
  ws();
  if (i < src.length) throw new AsmError(`Can't read "${src}"`);
  return v & M64;
}

// Splits on commas outside brackets and parentheses.
function splitOperands(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '[' || ch === '(') depth++;
    if (ch === ']' || ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function regInfo(reg) {
  const X = iced.RegisterExt;
  const cls = X.isGPR(reg) ? 'gpr' : X.isXMM(reg) ? 'xmm' : X.isYMM(reg) ? 'ymm' : X.isMM(reg) ? 'mm' : X.isST(reg) ? 'st' : X.isSegmentRegister(reg) ? 'seg' : 'other';
  return { cls, size: X.size(reg) };
}

// ---------- operands ----------
function parseOperand(text, ctx) {
  let t = text.trim();
  const lower = t.toLowerCase();
  tables();
  if (REGS.has(lower)) return { type: 'reg', reg: REGS.get(lower), ...regInfo(REGS.get(lower)) };
  // st(1) is ST1
  const st = lower.match(/^st\s*\(\s*(\d)\s*\)$/);
  if (st) { const reg = R[`ST${st[1]}`]; return { type: 'reg', reg, cls: 'st', size: 10 }; }

  // Memory: [size [ptr]] [seg:][ ... ]
  const mm = t.match(/^(?:(byte|word|dword|qword|tbyte|tword|xmmword|oword|dqword|ymmword|real4|real8)\s+(?:ptr\s+)?)?(?:(cs|ds|es|fs|gs|ss)\s*:\s*)?\[(.+)\]$/i);
  if (mm) {
    const size = mm[1] ? SIZES[mm[1].toLowerCase()] : 0;
    const seg = mm[2] ? REGS.get(mm[2].toLowerCase()) : R.None;
    let base = R.None;
    let index = R.None;
    let scale = 1;
    let disp = 0n;
    let symbolic = false;
    // Terms joined by + and -; registers (with *scale) vs everything else.
    const terms = mm[3].replace(/\s+/g, '').replace(/-/g, '+-').split('+').filter(Boolean);
    const rest = [];
    for (const term of terms) {
      const neg = term.startsWith('-');
      const body = neg ? term.slice(1) : term;
      const sc = body.match(/^([a-z0-9]+)\*([1248])$|^([1248])\*([a-z0-9]+)$/i);
      const regName = (sc ? (sc[1] || sc[4]) : body).toLowerCase();
      if (!neg && REGS.has(regName) && iced.RegisterExt.isGPR(REGS.get(regName))) {
        const reg = REGS.get(regName);
        if (sc) { if (index !== R.None) throw new AsmError(`Two index registers in "${text}"`); index = reg; scale = Number(sc[2] || sc[3]); }
        else if (base === R.None) base = reg;
        else if (index === R.None) index = reg;
        else throw new AsmError(`Too many registers in "${text}"`);
        continue;
      }
      if (/^rip$/i.test(regName) && !neg) { base = R.RIP; continue; }
      rest.push(term);
    }
    if (rest.length) {
      const expr = rest.join('+').replace(/\+-/g, '-');
      // Anything that isn't a plain number depends on symbols/labels.
      symbolic = !rest.every((x) => parseNumber(x.replace(/^-/, '')) !== null);
      disp = ctx.eval(expr);
    }
    // No registers at all: an absolute address, reached RIP-relative in x64.
    if (base === R.None && index === R.None) return { type: 'mem', size, seg, base: R.RIP, index, scale, disp, rip: true, symbolic };
    // Displacements are signed: "-10" came back as 2^64-16.
    if (disp > 0x7fffffffffffffffn) disp -= 1n << 64n;
    return { type: 'mem', size, seg, base, index, scale, disp, rip: false, symbolic };
  }

  // Branch hint
  const short = lower.startsWith('short ');
  if (short) t = t.slice(6).trim();
  const far = /^(near|far)\s+/i.test(t);
  if (far) t = t.replace(/^(near|far)\s+/i, '');
  // Immediate: a number, or a symbol/label/expression.
  const n = parseNumber(t);
  if (n !== null) return { type: 'imm', value: n & M64, signedHint: n < 0n, symbolic: false, short };
  return { type: 'imm', value: ctx.eval(t), symbolic: true, short };
}

// ---------- matching an operand to an operand kind ----------
const domain = (v, bits) => {
  // v is 0..2^64-1; read it as a value of `bits` bits, signed. null if it doesn't fit.
  const s = v > 0x7fffffffffffffffn ? v - (1n << 64n) : v;
  const lo = -(1n << BigInt(bits - 1));
  const hi = (1n << BigInt(bits)) - 1n;
  if (s < lo || s > hi) return null;
  const top = 1n << BigInt(bits);
  const u = ((s % top) + top) % top;
  return u >= top / 2n ? u - top : u;
};

function regKind(kind) {
  const m = kind.match(/^(r8|r16|r32|r64|xmm|ymm|mm|k|tmm)_(reg|rm|opcode|vvvv|reg_mem|is4|is5)$/) || kind.match(/^(xmm|ymm)p3_vvvv$/);
  if (!m) return null;
  return m[1];
}
const GPR_BITS = { r8: 1, r16: 2, r32: 4, r64: 8 };

function fits(kind, op, form, others) {
  // Exact registers (al, cl, eax, rax, st0...)
  const exact = { al: R.AL, cl: R.CL, ax: R.AX, dx: R.DX, eax: R.EAX, rax: R.RAX, st0: R.ST0, es: R.ES, cs: R.CS, ss: R.SS, ds: R.DS, fs: R.FS, gs: R.GS };
  if (exact[kind] !== undefined) return op.type === 'reg' && op.reg === exact[kind];
  const rk = regKind(kind);
  if (rk) {
    if (op.type !== 'reg') return false;
    if (GPR_BITS[rk]) return op.cls === 'gpr' && op.size === GPR_BITS[rk];
    return op.cls === rk;
  }
  if (kind === 'sti_opcode') return op.type === 'reg' && op.cls === 'st';
  if (kind === 'seg_reg') return op.type === 'reg' && op.cls === 'seg';
  const orMem = kind.match(/^(r8|r16|r32|r64|xmm|ymm|mm)_or_mem$/);
  if (orMem || kind === 'mem') {
    if (op.type === 'reg') return Boolean(orMem) && (GPR_BITS[orMem[1]] ? op.cls === 'gpr' && op.size === GPR_BITS[orMem[1]] : op.cls === orMem[1]);
    if (op.type !== 'mem') return false;
    const want = form.mem || (orMem && GPR_BITS[orMem[1]]) || 0;
    if (op.size) return !want || op.size === want || kind === 'mem' && form.mem === 0;
    // No size written: take it from a general register in the instruction,
    // else Cheat Engine's default of 4 bytes for plain integer forms.
    const reg = others.find((o) => o.type === 'reg' && o.cls === 'gpr');
    if (orMem && GPR_BITS[orMem[1]]) return reg ? GPR_BITS[orMem[1]] === reg.size : GPR_BITS[orMem[1]] === 4;
    return true;
  }
  if (kind.startsWith('imm')) {
    if (op.type !== 'imm') return false;
    // Symbol values pick the widest form, so a label's address can't change
    // an instruction's size between the two assembly passes.
    const v = op.value;
    switch (kind) {
      case 'imm8_const_1': return !op.symbolic && v === 1n;
      case 'imm8': return !op.symbolic && domain(v, 8) !== null;
      case 'imm16': return domain(v, 16) !== null;
      case 'imm32': return domain(v, 32) !== null;
      case 'imm64': return true;
      case 'imm8sex16': { const s = domain(v, 16); return !op.symbolic && s !== null && s >= -128n && s <= 127n; }
      case 'imm8sex32': { const s = domain(v, 32); return !op.symbolic && s !== null && s >= -128n && s <= 127n; }
      case 'imm8sex64': { const s = domain(v, 64); return !op.symbolic && s !== null && s >= -128n && s <= 127n; }
      case 'imm32sex64': { const s = domain(v, 64); return s !== null && s >= -(1n << 31n) && s < (1n << 31n) && !op.symbolic; }
      default: return false;
    }
  }
  if (kind === 'br64_4') return op.type === 'imm' && !op.short;
  if (kind === 'br64_1') return op.type === 'imm' && op.short;
  return false;
}

function memOperand(op) {
  // RIP-relative: iced wants the absolute target and works out the offset.
  if (op.rip) return iced.MemoryOperand.new64(R.RIP, R.None, 1, op.disp, 8, false, op.seg);
  const dsize = op.disp === 0n ? 0 : 1; // the encoder widens to 4 when it must
  return iced.MemoryOperand.new64(op.base, op.index, op.scale, op.disp, dsize, false, op.seg);
}

function immArg(kind, v) {
  if (kind === 'imm64') return { u64: v };
  const bits = { imm8: 8, imm16: 16, imm32: 32, imm8sex16: 16, imm8sex32: 32, imm8sex64: 64, imm32sex64: 64, imm8_const_1: 8 }[kind];
  const s = domain(v, bits);
  // Sign-extended forms take the signed value; the rest take the raw bits.
  if (kind.includes('sex')) return { i32: Number(s) };
  return { u32: Number(((s % (1n << BigInt(bits))) + (1n << BigInt(bits))) % (1n << BigInt(bits))) };
}

function build(form, ops) {
  const I = iced.Instruction;
  if (form.kinds.some((k) => k.startsWith('br64'))) return I.createBranch(form.code, ops[0].value);
  // Operands the instruction implies (al in "in al,dx" style forms) still go in.
  const parts = ops.map((op, j) => {
    if (op.type === 'reg') return { t: 'Reg', v: op.reg };
    if (op.type === 'mem') return { t: 'Mem', v: memOperand(op) };
    return { t: 'Imm', ...immArg(form.kinds[j], op.value) };
  });
  if (!parts.length) return I.create(form.code);
  const imm = parts.find((p) => p.t === 'Imm');
  if (imm && imm.u64 !== undefined) return I.createRegU64(form.code, parts[0].v, imm.u64);
  const name = parts.map((p) => (p.t === 'Imm' ? (p.i32 !== undefined ? 'I32' : 'U32') : p.t)).join('');
  const fn = I[`create${name}`];
  if (typeof fn !== 'function') throw new AsmError('That operand combination isn’t supported.');
  return fn.call(I, form.code, ...parts.map((p) => (p.t === 'Imm' ? (p.i32 !== undefined ? p.i32 : p.u32) : p.v)));
}

const encoder = { e: null };
function encodeOne(ins, rip) {
  if (!encoder.e) encoder.e = new iced.Encoder(64);
  let n;
  try {
    n = encoder.e.encode(ins, rip);
  } catch (err) {
    // A failed encode can leave partial bytes in the encoder's buffer,
    // which would end up in front of the next instruction.
    encoder.e.takeBuffer();
    throw err;
  }
  const bytes = Buffer.from(encoder.e.takeBuffer());
  return bytes.subarray(bytes.length - n);
}

// Assembles one instruction at `rip`. ctx: { eval(expr) -> BigInt, read? }.
// Returns a Buffer.
function assembleInstruction(line, rip, ctx) {
  tables();
  let text = line.trim();
  const prefixes = [];
  for (;;) {
    const m = text.match(/^(lock|rep|repe|repz|repne|repnz)\s+/i);
    if (!m) break;
    prefixes.push(m[1].toLowerCase());
    text = text.slice(m[0].length);
  }
  const sp = text.search(/\s/);
  let mnem = (sp < 0 ? text : text.slice(0, sp)).toLowerCase();
  const rest = sp < 0 ? '' : text.slice(sp + 1).trim();
  mnem = ALIAS[mnem] || mnem;
  if (mnem === 'nop' && !rest) return Buffer.from([0x90]);
  if (mnem === 'ret' && !rest) return Buffer.from([0xc3]);
  if (mnem === 'int3') return Buffer.from([0xcc]);
  const forms = FORMS.get(mnem);
  if (!forms) throw new AsmError(`Unknown instruction "${mnem}"`);
  const ops = splitOperands(rest).map((o) => parseOperand(o, ctx));
  let best = null;
  let lastErr = null;
  for (const form of forms) {
    if (form.kinds.length !== ops.length) continue;
    if (!form.kinds.every((k, j) => fits(k, ops[j], form, ops.filter((_, x) => x !== j)))) continue;
    try {
      const ins = build(form, ops);
      if (prefixes.includes('lock')) ins.hasLockPrefix = true;
      if (prefixes.some((p) => p === 'rep' || p === 'repe' || p === 'repz')) ins.hasRepePrefix = true;
      if (prefixes.some((p) => p === 'repne' || p === 'repnz')) ins.hasRepnePrefix = true;
      const bytes = encodeOne(ins, rip);
      ins.free();
      if (!best || bytes.length < best.length) best = bytes;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!best) {
    const why = lastErr ? `: ${String(lastErr.message).replace(/\s*\(.*\)$/, '')}` : '';
    throw new AsmError(`Can't assemble "${line.trim()}"${why}`);
  }
  return best;
}

// Re-encodes the instruction at `from` (read from memory) to run at `rip`,
// fixing RIP-relative addresses and branches. Cheat Engine's reassemble().
function reassemble(bytes, from, rip) {
  const d = new iced.Decoder(64, Uint8Array.from(bytes), iced.DecoderOptions.None);
  d.ip = from;
  const ins = d.decode();
  if (ins.isInvalid) { ins.free(); d.free(); throw new AsmError('There’s no valid instruction there to copy.'); }
  try {
    return { bytes: encodeOne(ins, rip), length: ins.length };
  } finally {
    ins.free();
    d.free();
  }
}

// Length of the instruction at the start of `bytes` (for readmem-style copies).
function instructionLength(bytes, ip = 0n) {
  const d = new iced.Decoder(64, Uint8Array.from(bytes), iced.DecoderOptions.None);
  d.ip = ip;
  const ins = d.decode();
  const n = ins.isInvalid ? 0 : ins.length;
  ins.free();
  d.free();
  return n;
}

module.exports = { assembleInstruction, reassemble, instructionLength, evalExpr, parseNumber, splitOperands, AsmError };
