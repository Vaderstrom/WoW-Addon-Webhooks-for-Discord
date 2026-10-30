'use strict';
// Reads a SavedVariables file as data: `Name = value` assignments whose values are Lua table, string, number and
// boolean literals (what WoW writes). It never runs the file: anything else (calls, operators, functions) is an error.
// Tables with only the keys 1..n become arrays (an empty table too); other tables become objects (number keys as
// strings).
// Pass the file read as 'latin1' (its bytes): strings are then decoded from UTF-8 here, escapes included.

const MAX_DEPTH = 64;

class LuaSyntaxError extends Error {}

function parse(text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  let i = 0;
  const n = text.length;

  function fail(what) {
    const line = text.slice(0, i).split('\n').length;
    throw new LuaSyntaxError(`${what} at line ${line}`);
  }

  // Whitespace and comments (-- line, --[[ block ]] and --[==[ ]==]).
  function skip() {
    for (;;) {
      while (i < n && /\s/.test(text[i])) i++;
      if (text.startsWith('--', i)) {
        i += 2;
        const long = /^\[(=*)\[/.exec(text.slice(i, i + 64));
        if (long) {
          const close = ']' + long[1] + ']';
          const end = text.indexOf(close, i);
          if (end < 0) fail('unfinished comment');
          i = end + close.length;
        } else {
          while (i < n && text[i] !== '\n') i++;
        }
        continue;
      }
      return;
    }
  }

  function name() {
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i, i + 256));
    if (!m) return null;
    i += m[0].length;
    return m[0];
  }

  const ESC = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', '\\': '\\', '"': '"', "'": "'", '\n': '\n' };

  function string() {
    const q = text[i++];
    let out = '';
    for (;;) {
      if (i >= n) fail('unfinished string');
      const c = text[i++];
      if (c === q) return out;
      if (c === '\n') fail('line break in string');
      if (c !== '\\') { out += c; continue; }
      const e = text[i++];
      if (e in ESC) { out += ESC[e]; continue; }
      if (e === '\r') { out += '\n'; if (text[i] === '\n') i++; continue; }
      if (/[0-9]/.test(e)) {
        let d = e;
        while (d.length < 3 && /[0-9]/.test(text[i])) d += text[i++];
        out += String.fromCharCode(Number(d));
        continue;
      }
      if (e === 'x') {
        const h = text.slice(i, i + 2);
        if (!/^[0-9A-Fa-f]{2}$/.test(h)) fail('bad \\x escape');
        i += 2;
        out += String.fromCharCode(parseInt(h, 16));
        continue;
      }
      fail('bad escape');
    }
  }

  function longString() {
    const m = /^\[(=*)\[/.exec(text.slice(i, i + 64));
    const close = ']' + m[1] + ']';
    i += m[0].length;
    if (text[i] === '\r') i++;
    if (text[i] === '\n') i++;
    const end = text.indexOf(close, i);
    if (end < 0) fail('unfinished long string');
    const s = text.slice(i, end);
    i = end + close.length;
    return s;
  }

  function number() {
    const m = /^-?(?:0[xX][0-9A-Fa-f]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|inf|nan)/.exec(text.slice(i, i + 64));
    if (!m) fail('bad number');
    i += m[0].length;
    return Number(m[0]);
  }

  // Lua strings are bytes; WoW writes UTF-8. Decode byte strings that came out of escapes.
  function utf8(s) {
    if (!/[\x80-\xff]/.test(s) || /[^\x00-\xff]/.test(s)) return s;
    try { return Buffer.from(s, 'latin1').toString('utf8'); } catch (e) { return s; }
  }

  function value(depth) {
    skip();
    if (i >= n) fail('value expected');
    const c = text[i];
    if (c === '{') return table(depth + 1);
    if (c === '"' || c === "'") return utf8(string());
    if (c === '[' && /^\[=*\[/.test(text.slice(i, i + 64))) return utf8(longString());
    if (c === '-' || c === '.' || /[0-9]/.test(c)) return number();
    const word = name();
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'nil') return null;
    fail('unexpected ' + (word ? `"${word}"` : `"${c}"`));
    return undefined;
  }

  function table(depth) {
    if (depth > MAX_DEPTH) fail('tables nested too deep');
    i++; // {
    const entries = [];
    let next = 1;
    for (;;) {
      skip();
      if (text[i] === '}') { i++; break; }
      let key;
      if (text[i] === '[' && !/^\[=*\[/.test(text.slice(i, i + 64))) {
        i++;
        key = value(depth);
        skip();
        if (text[i] !== ']') fail('"]" expected');
        i++;
        skip();
        if (text[i] !== '=') fail('"=" expected');
        i++;
      } else {
        const save = i;
        const word = name();
        skip();
        if (word && text[i] === '=' && text[i + 1] !== '=') { key = word; i++; } else { i = save; key = next++; }
      }
      const v = value(depth);
      if (key !== null && key !== undefined && v !== null) entries.push([key, v]);
      skip();
      if (text[i] === ',' || text[i] === ';') { i++; continue; }
      if (text[i] === '}') { i++; break; }
      fail('"," or "}" expected');
    }
    // An empty table is an empty list (an addon's empty news list; seen with a real save).
    const isArray = entries.every(([k], idx) => k === idx + 1);
    if (isArray) return entries.map(([, v]) => v);
    const obj = {};
    for (const [k, v] of entries) obj[String(k)] = v;
    return obj;
  }

  const globals = {};
  for (;;) {
    skip();
    if (i >= n) break;
    const g = name();
    if (!g) fail('name expected');
    skip();
    if (text[i] !== '=') fail('"=" expected');
    i++;
    const v = value(0);
    if (v !== null) globals[g] = v;
    skip();
    if (text[i] === ';') i++;
  }
  return globals;
}

module.exports = { parse, LuaSyntaxError };
