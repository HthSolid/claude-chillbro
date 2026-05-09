// Static safety scan for inline interpreter calls (python -c, node -e, etc.).
//
// If the inline code contains zero dangerous tokens, classify as safe with no
// LLM call. Any match returns 'unknown' so the caller defers to LLM. We bias
// toward false positives (defer unnecessarily) over false negatives
// (auto-allow malicious code).
//
// Shell interpreters (bash -c, sh -c, zsh -c) are intentionally NOT auto-allowed
// here — their inline IS shell, and fully classifying nested shell would require
// recursion. Defer those to the LLM, which sees the full original command.

const LANG_INTERPRETER_RX = /^(python3?|node|nodejs|deno|bun|perl|ruby)\s+(-c|-e)\s+/;

const LANG_DANGEROUS = [
  // Python: anything beyond a small read-only allowlist of os attributes
  /\bos\.(?!path\b|sep\b|name\b|environ\b|getcwd\b|getenv\b|listdir\b|stat\b|fstat\b|access\b|R_OK\b|W_OK\b|X_OK\b|F_OK\b)/,
  /\bsubprocess\b/,
  /\bshutil\.(copy|move|rmtree|remove|chown|chmod|make_archive)/,
  /\bsocket\.(socket|create_connection|create_server)/,
  /\b(urllib|httplib|requests|httpx|aiohttp|http\.client)\b/,
  /\bsmtplib\b/,
  /\bftplib\b/,
  /\bparamiko\b/,
  /\bpty\b/,
  /\b__import__\s*\(/,
  /\beval\s*\(/,
  /\bex[e]c\s*\(/,
  /\bcompile\s*\(/,
  /\bopen\s*\([^,)]+,\s*['"][wxa]/,
  // Note: f.write(/file.write(/Path(...).unlink() etc. are all caught by the
  // chain-depth-agnostic `\.(write|unlink|...)\(` pattern further down. No
  // narrower variant needed.
  /\bPath\b[^.]{0,40}\.(write|unlink|mkdir|rmdir|chmod)/,
  /\bos\.(remove|unlink|rmdir|removedirs|chmod|chown|symlink|link|rename|replace|truncate|kill)/,

  // Node / JS
  /\b(require|import)\s*\(\s*['"]child_process['"]/,
  /\b(require|import)\s*\(\s*['"]http['"]/,
  /\b(require|import)\s*\(\s*['"]https['"]/,
  /\b(require|import)\s*\(\s*['"]net['"]/,
  /\b(require|import)\s*\(\s*['"]dgram['"]/,
  /\b(require|import)\s*\(\s*['"]tls['"]/,
  /\b(require|import)\s*\(\s*['"]cluster['"]/,
  /\b(require|import)\s*\(\s*['"]worker_threads['"]/,
  // Destructive filesystem method invocation at any chain depth. Catches
  // `fs.writeFileSync(...)`, `fs.promises.unlink(...)`, AND
  // `require('fs').writeFileSync(...)` where 'fs' and the method aren't
  // syntactically adjacent.
  /\.(write|append|unlink|rm|rmdir|mkdir|truncate|chmod|chown|symlink|link|rename)(File|Sync|FileSync)?\s*\(/,
  /\bspawn(Sync)?\s*\(/,
  /\bex[e]c(Sync|File|FileSync)?\s*\(/,
  /\bnew\s+Function\s*\(/,
  /\beval\s*\(/,
  /\bglobalThis\.eval\b/,

  // Perl
  /\bsystem\s*\(/,
  /`[^`]+`/,
  /\bunlink\b/,
  /\bopen\s*\([^,]+,\s*['"]?[>+]/,
  /\bIPC::/,

  // Ruby
  /\b%x\{/,
  /\bIO\.popen\b/,
  /\bKernel\.(system|ex[e]c|spawn)\b/,
  /\bFile\.(delete|unlink|chmod|chown|rename|write)/,
  /\bDir\.(delete|rmdir|mkdir)/,
];

function extractInlineCode(segment) {
  const m = segment.match(LANG_INTERPRETER_RX);
  if (!m) return null;
  const after = segment.slice(m[0].length);
  if (!after) return null;

  const quote = after[0];
  if (quote !== '"' && quote !== "'") {
    let i = 0;
    while (i < after.length) {
      if (after[i] === '\\' && i + 1 < after.length) { i += 2; continue; }
      if (/\s/.test(after[i])) return after.slice(0, i);
      i++;
    }
    return after;
  }

  let i = 1;
  while (i < after.length) {
    if (after[i] === '\\' && i + 1 < after.length) { i += 2; continue; }
    if (after[i] === quote) return after.slice(1, i);
    i++;
  }
  return null;
}

export function classifyInlineInterpreter(segment) {
  if (!LANG_INTERPRETER_RX.test(segment)) return null;

  const code = extractInlineCode(segment);
  if (code === null) {
    return { kind: 'unknown', reason: 'inline interpreter: could not extract code (unbalanced quotes?)' };
  }

  for (const re of LANG_DANGEROUS) {
    if (re.test(code)) {
      return { kind: 'unknown', reason: `inline interpreter: dangerous token /${re.source.slice(0, 40)}/` };
    }
  }

  return { kind: 'allow', reason: 'inline interpreter: read-only / data-only code' };
}
