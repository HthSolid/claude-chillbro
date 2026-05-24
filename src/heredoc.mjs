// Heredoc body stripping + line-continuation collapse.
//
// The splitter treats `&&`, `||`, `;`, `|` as command separators, but those
// characters appear inside heredoc bodies (especially when Claude is writing
// source code into a file via `cat <<EOF > file`). Splitting inside a heredoc
// produces garbage segments like `pub fn x() { let y = 1; }` getting broken
// at every `;`.
//
// Solution: PRE-PROCESS the command string to remove heredoc bodies before
// the splitter runs. The heredoc start marker (`cat <<EOF`) stays in the
// segment so it still classifies normally; only the body and terminator are
// elided.
//
// Also handles backslash-newline line continuations by collapsing them to a
// single space so multi-line shell statements are treated as one segment.

// Collapse backslash-at-end-of-line into a single space.
export function stripLineContinuations(cmd) {
  return cmd.replace(/\\\n/g, ' ');
}

// Remove heredoc bodies and terminators, leaving only the heredoc-start
// marker (the `<<DELIM` syntax up through end of that line) in place. Handles:
//   <<EOF                      (basic)
//   <<-EOF ... \tEOF           (dash strips leading tabs from terminator)
//   <<'EOF' / <<"EOF" / <<\EOF (quoted/escaped delimiter)
//   multiple heredocs on one line
//   unterminated heredocs (consume to EOF)
export function stripHeredocBodies(cmd) {
  let out = '';
  let i = 0;
  const n = cmd.length;

  while (i < n) {
    const hereStart = cmd.indexOf('<<', i);
    if (hereStart === -1) {
      out += cmd.slice(i);
      break;
    }

    // Append everything up to (but not yet including) the `<<`.
    out += cmd.slice(i, hereStart);
    i = hereStart;

    // Try to parse: <<[-]['"\\]?DELIM['"]?
    let j = i + 2;
    let stripTabs = false;
    if (cmd[j] === '-') { stripTabs = true; j++; }

    // Optional whitespace between << and delimiter.
    while (j < n && (cmd[j] === ' ' || cmd[j] === '\t')) j++;

    let delim = '';
    if (cmd[j] === '"' || cmd[j] === "'") {
      const q = cmd[j];
      j++;
      while (j < n && cmd[j] !== q) {
        delim += cmd[j];
        j++;
      }
      if (j < n) j++; // skip closing quote
    } else if (cmd[j] === '\\') {
      j++;
      while (j < n && /[A-Za-z0-9_]/.test(cmd[j])) {
        delim += cmd[j];
        j++;
      }
    } else {
      while (j < n && /[A-Za-z0-9_]/.test(cmd[j])) {
        delim += cmd[j];
        j++;
      }
    }

    if (!delim) {
      // Not a heredoc — `<<` was a bit shift or syntax error or a stray pair.
      // Append the `<<` we had pending and continue past it.
      out += '<<';
      i += 2;
      continue;
    }

    // Append the heredoc start marker (everything up through the delimiter).
    out += cmd.slice(i, j);
    i = j;

    // Append the rest of the line that the heredoc starts on (could be
    // redirects like `> file`, more pipes, etc.).
    while (i < n && cmd[i] !== '\n') {
      out += cmd[i];
      i++;
    }
    if (i < n) {
      out += cmd[i]; // the newline
      i++;
    }

    // Now consume body lines until terminator, dropping them from output.
    while (i < n) {
      const lineStart = i;
      while (i < n && cmd[i] !== '\n') i++;
      const line = cmd.slice(lineStart, i);
      const trimmed = stripTabs ? line.replace(/^\t+/, '') : line;
      if (trimmed === delim) {
        // Terminator line - keep it (so the segment shape is preserved).
        out += line;
        if (i < n) {
          out += cmd[i];
          i++;
        }
        break;
      }
      // Body line - skip entirely.
      if (i < n) i++; // skip \n
    }
  }

  return out;
}

// Apply both pre-processing passes. Order matters: line continuations first
// so heredoc detection sees a single-line `cat <<EOF` even if user wrote
// `cat \\\n  <<EOF`.
export function preprocessCommand(cmd) {
  return stripHeredocBodies(stripLineContinuations(cmd));
}
