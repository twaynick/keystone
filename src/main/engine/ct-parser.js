'use strict';

const { XMLParser } = require('fast-xml-parser');
const { CE_TYPE_MAP } = require('./values');
const address = require('./address');
const { unsupportedReason } = require('./autoasm');

// Parses a Cheat Engine .CT table into Keystone's flat record list.
//
// Record kinds:
//   group  – a header (CE "GroupHeader" or any entry that only holds children)
//   value  – a plain address/pointer with a numeric type: fully supported
//   script – an Auto Assembler script (Lua ones included), run by
//            autoasm.js when switched on
//   unsupported – strings, AOBs, custom types, or scripts using Cheat
//            Engine features Keystone doesn't have

const parser = new XMLParser({
  ignoreAttributes: true,
  // Offsets like "10" are hex in CE. Letting the parser coerce them would turn
  // "10" into decimal 10 and silently corrupt every pointer chain.
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => name === 'CheatEntry' || name === 'Offset',
});

function parseCheatTable(xml, { sourceName = 'table' } = {}) {
  let doc;
  try {
    doc = parser.parse(xml);
  } catch (err) {
    throw new Error(`Not a valid Cheat Engine table: ${err.message}`);
  }
  const root = doc.CheatTable;
  if (!root) throw new Error('Not a Cheat Engine table (no <CheatTable> root)');

  const records = [];
  walk(root.CheatEntries?.CheatEntry || [], [], records, sourceName);
  return records;
}

function walk(entries, groupPath, out, sourceName) {
  for (const e of entries) {
    const name = cleanDescription(e.Description) || `Entry ${e.ID ?? out.length}`;
    const id = `ct:${sourceName}:${e.ID ?? groupPath.concat(name).join('/')}`;
    const children = e.CheatEntries?.CheatEntry || [];
    const isGroup = String(e.GroupHeader) === '1' || (children.length > 0 && !e.Address && !e.AssemblerScript);

    if (isGroup) {
      out.push({ id, name, kind: 'group', groupPath: [...groupPath], depth: groupPath.length });
    } else {
      out.push(toRecord(e, id, name, groupPath));
    }
    // Children of a value entry (CE allows that) are grouped under it too.
    if (children.length) walk(children, groupPath.concat(name), out, sourceName);
  }
}

function toRecord(e, id, name, groupPath) {
  const base = { id, name, groupPath: [...groupPath], depth: groupPath.length, source: 'ct' };
  const ceType = String(e.VariableType || '').trim();

  if (e.AssemblerScript || ceType.toLowerCase() === 'auto assembler script') {
    const script = String(e.AssemblerScript || '');
    const why = unsupportedReason(script);
    if (why) return { ...base, kind: 'unsupported', reason: `Script: ${why}` };
    return { ...base, kind: 'script', script };
  }

  const valueType = CE_TYPE_MAP[ceType.toLowerCase()];
  if (!valueType) {
    return { ...base, kind: 'unsupported', reason: `Type "${ceType || 'custom'}" isn't supported yet` };
  }
  if (!e.Address) {
    return { ...base, kind: 'unsupported', reason: 'No address' };
  }

  // CE stores <Offsets> last-applied-first (its pointeroffsets[0] is the final
  // offset). Reverse so the resolver can walk them in natural order.
  let offsets;
  try {
    offsets = (e.Offsets?.Offset || [])
      .map((o) => String(o).trim())
      .map((o) => {
        if (!/^-?[0-9a-f]+$/i.test(o)) throw new Error(`Offset "${o}" is an expression`);
        return o.startsWith('-') ? -BigInt('0x' + o.slice(1)) : BigInt('0x' + o);
      })
      .reverse();
  } catch (err) {
    return { ...base, kind: 'unsupported', reason: err.message };
  }

  const addr = String(e.Address).trim();
  try {
    // Symbols without a dot aren't modules: a script registers them, and the
    // value reads once that script is on.
    address.parse(addr);
  } catch (err) {
    return { ...base, kind: 'unsupported', reason: err.message };
  }

  return {
    ...base,
    kind: 'value',
    valueType,
    address: addr,
    offsets,
    hex: String(e.ShowAsHex) === '1',
  };
}

// CE wraps descriptions in literal quotes: <Description>"Health"</Description>
function cleanDescription(d) {
  if (d === undefined || d === null) return '';
  return String(d).trim().replace(/^"(.*)"$/s, '$1').trim();
}

// The table's own Lua script (Cheat Engine's Table > Show Cheat Table Lua
// Script), which runs when the table opens. null if there isn't one.
function tableLuaScript(xml) {
  let doc;
  try { doc = parser.parse(xml); } catch { return null; }
  const code = doc.CheatTable?.LuaScript;
  return typeof code === 'string' && code.trim() ? code : null;
}

// One entry described the way a .CT file would (VariableType, Address,
// Offsets.Offset, AssemblerScript, GroupHeader), for mods a table's Lua
// makes with AddressList.createMemoryRecord.
function recordFromEntry(e, id, groupPath) {
  const name = cleanDescription(e.Description) || 'No description';
  if (String(e.GroupHeader) === '1') return { id, name, kind: 'group', groupPath: [...groupPath], depth: groupPath.length };
  return toRecord(e, id, name, groupPath);
}

module.exports = { parseCheatTable, tableLuaScript, recordFromEntry };
