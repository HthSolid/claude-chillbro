// Split a shell command into independently-classifiable segments.
// Respects single quotes, double quotes, and backslash escapes.
//
// Two failure modes, surfaced distinctly via splitCommandWithReason():
//   - 'subshell'   : command substitution ($(...) / `...`). The LLM can
//                    reason about the whole command including the subshell
//                    body, so the caller should pass these through to the
//                    LLM fallback rather than auto-asking.
//   - 'unbalanced' : quotes never closed. Almost always user typo —
//                    deterministic ASK is the right call.
//
// splitCommand() is the legacy null-or-array API kept for callers that
// only need success/fail (e.g. posttool's counter bumper).

const SEPARATORS = ['&&', '||', ';', '|'];

export function splitCommandWithReason(cmd) {
  if (typeof cmd !== 'string') return { bail: 'unbalanced' };

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
      // Subshell substitution — can't split safely. Bail with reason so the
      // caller can decide to pass to LLM instead of deterministic ASK.
      if (c2 === '$(' || c === '`') return { bail: 'subshell' };

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

  if (inSingle || inDouble) return { bail: 'unbalanced' };
  if (buf.trim()) segments.push(buf.trim());
  return { segments };
}

export function splitCommand(cmd) {
  const r = splitCommandWithReason(cmd);
  return r.segments ?? null;
}
