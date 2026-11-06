/**
 * A small YAML reader for store test files. It covers what a test file needs, and nothing more:
 * mappings, lists ("- "), comments, quoted and plain text, numbers, true/false/null, and one-line
 * { a: 1 } / [a, b] values. Anchors, tags and multi-line text blocks are refused with a plain message.
 * No dependency: test files come from store owners, so the reader stays small and predictable.
 */

class YamlError extends Error {}
const fail = (line, msg) => { throw new YamlError(line ? `Line ${line}: ${msg}` : msg); };

/** Removes a trailing " # comment" that is not inside quotes. */
function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '\\' && q === '"') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  return s;
}

/** Finds the ":" that separates a key from its value (followed by a space or the end), outside quotes and brackets. */
function keySplit(s) {
  let q = null, depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '\\' && q === '"') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (c === ':' && depth === 0 && (i === s.length - 1 || s[i + 1] === ' ')) return i;
  }
  return -1;
}

function unquote(s, line) {
  if (s[0] === "'") {
    if (!s.endsWith("'") || s.length < 2) fail(line, 'a quote is not closed');
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (!s.endsWith('"') || s.length < 2) fail(line, 'a quote is not closed');
  try { return JSON.parse(s); } catch { fail(line, 'this quoted text is not valid'); }
}

function plain(s, line) {
  if (/^[&*!]/.test(s)) fail(line, 'anchors, aliases and tags (&, *, !) are not supported; write the value out in full');
  if (s === '|' || s === '>' || /^[|>][-+]?$/.test(s)) fail(line, 'multi-line text blocks (| and >) are not supported; put the text on one line in quotes');
  if (/^(true|True|TRUE)$/.test(s)) return true;
  if (/^(false|False|FALSE)$/.test(s)) return false;
  if (/^(null|Null|NULL|~)$/.test(s) || s === '') return null;
  if (/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s);
  return s;
}

/** One-line { a: 1, b: [x, y] } and [a, b] values. */
function flow(src, line) {
  let i = 0;
  const ws = () => { while (src[i] === ' ') i++; };
  const value = () => {
    ws();
    if (src[i] === '{') return map();
    if (src[i] === '[') return list();
    if (src[i] === '"' || src[i] === "'") {
      const q = src[i];
      let j = i + 1;
      while (j < src.length && src[j] !== q) { if (src[j] === '\\' && q === '"') j++; j++; }
      if (j >= src.length) fail(line, 'a quote is not closed');
      const out = unquote(src.slice(i, j + 1), line);
      i = j + 1;
      return out;
    }
    let j = i;
    while (j < src.length && !',]}'.includes(src[j]) && !(src[j] === ':' && src[j + 1] === ' ')) j++;
    const out = plain(src.slice(i, j).trim(), line);
    i = j;
    return out;
  };
  const map = () => {
    i++; const out = {};
    for (;;) {
      ws();
      if (src[i] === '}') { i++; return out; }
      const k = value();
      ws();
      if (src[i] !== ':') fail(line, `expected ":" after "${k}"`);
      i++;
      out[String(k)] = value();
      ws();
      if (src[i] === ',') { i++; continue; }
      if (src[i] === '}') { i++; return out; }
      fail(line, 'expected "," or "}"');
    }
  };
  const list = () => {
    i++; const out = [];
    for (;;) {
      ws();
      if (src[i] === ']') { i++; return out; }
      out.push(value());
      ws();
      if (src[i] === ',') { i++; continue; }
      if (src[i] === ']') { i++; return out; }
      fail(line, 'expected "," or "]"');
    }
  };
  const out = value();
  ws();
  if (i < src.length) fail(line, 'unexpected text after the value');
  return out;
}

function scalar(s, line) {
  if (s[0] === '{' || s[0] === '[') return flow(s, line);
  if (s[0] === '"' || s[0] === "'") return unquote(s, line);
  return plain(s, line);
}

export function parseYaml(text) {
  const lines = [];
  String(text).replace(/\r\n?/g, '\n').split('\n').forEach((raw, n) => {
    if (/^\s*\t/.test(raw)) fail(n + 1, 'use spaces, not tabs, to indent');
    const t = stripComment(raw);
    if (!t.trim() || t.trim() === '---' || t.trim() === '...') return;
    lines.push({ indent: t.length - t.trimStart().length, text: t.trim(), line: n + 1 });
  });
  if (!lines.length) return null;
  let i = 0;

  const isItem = (l) => l.text === '-' || l.text.startsWith('- ');

  function node(indent) {
    return isItem(lines[i]) ? seq(indent) : map(indent);
  }
  function seq(indent) {
    const out = [];
    while (i < lines.length && lines[i].indent === indent && isItem(lines[i])) {
      const l = lines[i];
      const rest = l.text.slice(1).trimStart();
      if (!rest) {
        i++;
        if (i < lines.length && lines[i].indent > indent) out.push(node(lines[i].indent));
        else out.push(null);
      } else if (keySplit(rest) > 0 && !/^["'{[]/.test(rest)) {
        // "- key: value" starts a mapping whose lines line up with "key".
        lines[i] = { indent: indent + (l.text.length - rest.length), text: rest, line: l.line };
        out.push(map(lines[i].indent));
      } else if (rest.startsWith('- ')) {
        lines[i] = { indent: indent + (l.text.length - rest.length), text: rest, line: l.line };
        out.push(seq(lines[i].indent));
      } else {
        out.push(scalar(rest, l.line));
        i++;
      }
    }
    if (i < lines.length && lines[i].indent > indent) fail(lines[i].line, 'this line is indented more than the list item above it');
    return out;
  }
  function map(indent) {
    const out = {};
    while (i < lines.length && lines[i].indent === indent && !isItem(lines[i])) {
      const l = lines[i];
      const at = keySplit(l.text);
      if (at <= 0) fail(l.line, `expected "name: value", found "${l.text.slice(0, 40)}"`);
      let key = l.text.slice(0, at).trim();
      if (key[0] === '"' || key[0] === "'") key = unquote(key, l.line);
      if (Object.prototype.hasOwnProperty.call(out, key)) fail(l.line, `"${key}" appears twice`);
      const rest = l.text.slice(at + 1).trim();
      i++;
      if (rest) out[key] = scalar(rest, l.line);
      else if (i < lines.length && lines[i].indent > indent) out[key] = node(lines[i].indent);
      else if (i < lines.length && lines[i].indent === indent && isItem(lines[i])) out[key] = seq(indent);
      else out[key] = null;
    }
    if (i < lines.length && lines[i].indent > indent) fail(lines[i].line, 'this line is indented more than the line above it');
    return out;
  }

  const out = node(lines[0].indent);
  if (i < lines.length) fail(lines[i].line, 'this line is indented less than the start of the file');
  return out;
}

export { YamlError };
