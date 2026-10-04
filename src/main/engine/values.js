'use strict';

// Value types a mod can read/write. Names are Keystone's own; CE_TYPE_MAP
// translates Cheat Engine's <VariableType> strings onto them.
const TYPES = {
  byte:   { size: 1, read: (b) => b.readUInt8(0),      write: (b, v) => b.writeUInt8(clampInt(v, 0, 0xff), 0) },
  int16:  { size: 2, read: (b) => b.readInt16LE(0),    write: (b, v) => b.writeInt16LE(clampInt(v, -0x8000, 0x7fff), 0) },
  int32:  { size: 4, read: (b) => b.readInt32LE(0),    write: (b, v) => b.writeInt32LE(clampInt(v, -0x80000000, 0x7fffffff), 0) },
  // int64 goes through BigInt so values past 2^53 don't silently lose bits on write.
  int64:  { size: 8, read: (b) => Number(b.readBigInt64LE(0)), write: (b, v) => b.writeBigInt64LE(BigInt(Math.trunc(Number(v))), 0) },
  float:  { size: 4, read: (b) => b.readFloatLE(0),    write: (b, v) => b.writeFloatLE(Number(v), 0) },
  double: { size: 8, read: (b) => b.readDoubleLE(0),   write: (b, v) => b.writeDoubleLE(Number(v), 0) },
};

const CE_TYPE_MAP = {
  'byte': 'byte',
  '2 bytes': 'int16',
  '4 bytes': 'int32',
  '8 bytes': 'int64',
  'float': 'float',
  'double': 'double',
};

function clampInt(v, min, max) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) throw new Error(`Not a number: ${v}`);
  return Math.min(max, Math.max(min, n));
}

function sizeOf(type) {
  const t = TYPES[type];
  if (!t) throw new Error(`Unknown value type: ${type}`);
  return t.size;
}

function decode(type, buf) {
  return TYPES[type].read(buf);
}

function encode(type, value) {
  const t = TYPES[type];
  if (!t) throw new Error(`Unknown value type: ${type}`);
  const num = Number(value);
  if (!Number.isFinite(num)) throw new Error(`"${value}" is not a number`);
  const buf = Buffer.alloc(t.size);
  t.write(buf, num);
  return buf;
}

// Floats read back as 72.30000305175781; round for display only.
function formatValue(type, value) {
  if (value === null || value === undefined) return '';
  if (type === 'float') return String(Math.round(value * 1000) / 1000);
  if (type === 'double') return String(Math.round(value * 1e6) / 1e6);
  return String(value);
}

module.exports = { TYPES, CE_TYPE_MAP, sizeOf, decode, encode, formatValue };
