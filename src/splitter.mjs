// Split a shell command into independently-classifiable segments.
// Respects single quotes, double quotes, and backslash escapes.
// Bails (returns null) on command substitution ($(...) / `...`) or unbalanced quotes —
// those are too tricky to classify safely; the caller should treat them as ASK.

const SEPARATORS = ['&&', '||', ';', '|'];

export function splitCommand(cmd) {
  if (typeof cmd !== 'string') return null;

  const segments = [];
  let buf = '';
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let parenDepth = 0;

  while (i < cmd.length) {
    const c = cmd[i];
    const c2 = cmd.slice(i, i + 2);

    if (c === '\\' && i + 1 < cmd.length) {
      buf += c + cmd[i + 1];
      i += 2;
      continue;
    }

    if (!inDouble && c === "'") { inSingle = !inSingle; buf += c; i++; continue; }
    if (!inSingle && c === '"') { inDouble = !inDouble; buf += c; i++; continue; }

    if (!inSingle && !inDouble) {
      // Bail on command substitution — too risky to classify piece-by-piece.
      if (c2 === '$(' || c === '`') return null;

      if (c === '(') { parenDepth++; buf += c; i++; continue; }
      if (c === ')') { parenDepth--; buf += c; i++; continue; }

      if (parenDepth === 0) {
        if (c2 === '&&' || c2 === '||') {
          if (buf.trim()) segments.push(buf.trim());
          buf = '';
          i += 2;
          continue;
        }
        if (c === ';' || c === '|') {
          if (buf.trim()) segments.push(buf.trim());
          buf = '';
          i += 1;
          continue;
        }
      }
    }

    buf += c;
    i++;
  }

  if (inSingle || inDouble) return null; // unbalanced
  if (buf.trim()) segments.push(buf.trim());
  return segments;
}
