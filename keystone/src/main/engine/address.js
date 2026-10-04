'use strict';

// Resolves Cheat Engine–style address expressions against a memory backend.
//
// Supported: hex numbers, module names ("game.exe", "\"GameAssembly.dll\""),
// + and -, and [ ] for dereference, e.g.  [game.exe+1A2B]+10
// Not supported: registered symbols from Auto Assembler scripts (e.g. "pPlayer").
// Those only exist after CE runs the script, so we report them instead of guessing.

class AddressError extends Error {}

function tokenize(expr) {
  const tokens = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (/\s/.test(c)) { i++; continue; }
    if ('+-[]'.includes(c)) { tokens.push({ t: c }); i++; continue; }
    if (c === '"') {
      const end = expr.indexOf('"', i + 1);
      if (end < 0) throw new AddressError(`Unclosed quote in "${expr}"`);
      tokens.push({ t: 'sym', v: expr.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < expr.length && !/[\s+\-[\]"]/.test(expr[j])) j++;
    const word = expr.slice(i, j);
    // A dot means module name ("dead.dll" would otherwise parse as hex-ish text).
    // A bare word of hex digits is a number, matching CE's own precedence.
    if (!word.includes('.') && /^(0x)?[0-9a-f]+$/i.test(word)) {
      tokens.push({ t: 'num', v: BigInt('0x' + word.replace(/^0x/i, '')) });
    } else {
      tokens.push({ t: 'sym', v: word });
    }
    i = j;
  }
  return tokens;
}

function parse(expr) {
  const tokens = tokenize(String(expr));
  let pos = 0;

  function parseExpr() {
    let node = parseTerm();
    while (pos < tokens.length && (tokens[pos].t === '+' || tokens[pos].t === '-')) {
      const op = tokens[pos++].t;
      node = { op, a: node, b: parseTerm() };
    }
    return node;
  }

  function parseTerm() {
    const tok = tokens[pos++];
    if (!tok) throw new AddressError(`Unexpected end of address "${expr}"`);
    if (tok.t === '[') {
      const inner = parseExpr();
      if (tokens[pos++]?.t !== ']') throw new AddressError(`Missing ] in "${expr}"`);
      return { op: 'deref', a: inner };
    }
    if (tok.t === 'num') return { op: 'num', v: tok.v };
    if (tok.t === 'sym') return { op: 'sym', v: tok.v };
    throw new AddressError(`Unexpected "${tok.t}" in "${expr}"`);
  }

  const tree = parseExpr();
  if (pos !== tokens.length) throw new AddressError(`Trailing input in "${expr}"`);
  return tree;
}

// Returns the list of module names an expression needs, so the session can
// mark a record unsupported up front if it uses a symbol that isn't a module.
function symbolsOf(tree, out = []) {
  if (!tree) return out;
  if (tree.op === 'sym') out.push(tree.v);
  symbolsOf(tree.a, out);
  symbolsOf(tree.b, out);
  return out;
}

const MASK64 = (1n << 64n) - 1n;

function evaluate(tree, mem) {
  switch (tree.op) {
    case 'num': return tree.v;
    case 'sym': {
      const mod = mem.getModule(tree.v);
      if (!mod) throw new AddressError(`Module or symbol "${tree.v}" not found`);
      return mod.base;
    }
    case '+': return (evaluate(tree.a, mem) + evaluate(tree.b, mem)) & MASK64;
    case '-': return (evaluate(tree.a, mem) - evaluate(tree.b, mem)) & MASK64;
    case 'deref': return readPointer(mem, evaluate(tree.a, mem));
    default: throw new AddressError(`Bad node ${tree.op}`);
  }
}

function readPointer(mem, addr) {
  const buf = mem.read(addr, mem.pointerSize);
  if (!buf) throw new AddressError(`Can't read pointer at 0x${addr.toString(16)}`);
  return mem.pointerSize === 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
}

// Final address of a record: evaluate the base expression, then walk offsets.
// `offsets` are in application order (first applied first) — the CT parser
// already reversed CE's on-disk order.
function resolve(record, mem) {
  if (!record._tree) record._tree = parse(record.address);
  let addr = evaluate(record._tree, mem);
  for (const off of record.offsets || []) {
    const p = readPointer(mem, addr);
    // A null pointer mid-chain is the normal state during loading screens.
    if (p === 0n) throw new AddressError('Pointer chain hit null');
    addr = (p + off) & MASK64;
  }
  return addr;
}

module.exports = { parse, evaluate, resolve, symbolsOf, readPointer, AddressError };
