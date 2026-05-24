// Top-level Bash classifier. Given a full command, cwd, and (optional) intent
// from the model, returns { decision, reason, source }.
//
// Pipeline (per segment after compound-command split):
//   1. ASK list — narrow destructive patterns win first.
//   2. Special probes (git push branch, gh repo visibility).
//   3. Inline interpreter scanner (python -c, node -e, etc.) — static safe-code check.
//   4. Learned auto-allow (exact match on normalized form).
//   5. ALLOW list.
//   6. Otherwise → unknown.
//
// Aggregation:
//   - Any segment ASK → ask.
//   - All segments allow → allow.
//   - Any segment unknown → escalate full command to LLM (Anthropic API → claude -p → ask).
//
// Failure isolation: every layer is wrapped in try/catch so a thrown error
// from one layer never breaks the others. Worst-case is the segment is
// classified 'unknown' and falls through to LLM/ask.

import { splitCommandWithReason } from './splitter.mjs';
import { ALLOW, ASK, loadLearnedSet } from './lists.mjs';
import { normalize } from './normalize.mjs';
import { repoVisibility, gitPushTarget } from './probes.mjs';
import { classifyInlineInterpreter } from './inlineInterpreters.mjs';
import { classifyWithLLM } from './llmFallback.mjs';
import { normalizeForMatching } from './commandNormalize.mjs';
import { preprocessCommand } from './heredoc.mjs';
import { debugLog } from './debug.mjs';

const RX = {
  gitPush: /^git\s+push(\s|$)/,
  ghPublic: /^gh\s+(pr|issue|release)\s+(create|merge)\b/,
};

// Wrap a layer call so any thrown error degrades to "no opinion" rather than
// killing the whole classification. Logs to stderr so debug-mode users can
// see what failed.
function safe(layerName, fn, fallback) {
  try {
    return fn();
  } catch (err) {
    process.stderr.write(`[chillbro] ${layerName} layer threw: ${err.message}\n`);
    return fallback;
  }
}

function classifySegment(segOriginal, cwd, learned) {
  // Normalize prefix baggage (path/env/wrap) before matching against patterns,
  // but keep the original for ASK-list matching of in-content destructive
  // patterns (rm -rf, > /dev/sd*, etc.). The ASK list checks for substrings
  // anywhere in the command, not just the verb position.
  const seg = safe('normalize', () => normalizeForMatching(segOriginal), segOriginal);

  // 1. ASK list — checked against the ORIGINAL segment. Destructive substrings
  // can appear in arguments (e.g., redirect targets, embedded paths) and we
  // don't want normalization to hide them.
  for (const re of ASK) {
    if (safe('ask-match', () => re.test(segOriginal), false)) {
      return { kind: 'ask', reason: `matched: ${re.source}` };
    }
  }

  // 2. Special-case probes (override allow when context demands it). Use the
  // normalized form so `~/.cargo/bin/git push main` is recognized as `git push`.
  if (RX.gitPush.test(seg)) {
    const target = safe('git-push-probe', () => gitPushTarget(seg, cwd), null);
    if (target && /^(refs\/heads\/)?(main|master)$/.test(target)) {
      return { kind: 'ask', reason: `git push targets ${target}` };
    }
    return { kind: 'allow', reason: `git push to ${target || 'feature branch'}` };
  }

  if (RX.ghPublic.test(seg)) {
    const vis = safe('gh-visibility-probe', () => repoVisibility(cwd), 'unknown');
    if (vis === 'public') return { kind: 'ask', reason: 'public-repo gh action' };
    if (vis === 'private' || vis === 'internal') return { kind: 'allow', reason: `${vis}-repo gh action` };
    return { kind: 'ask', reason: 'unknown repo visibility' };
  }

  // 3. Inline interpreter scanner. Run on the NORMALIZED segment so that
  // path-prefixed interpreters (`/path/venv/bin/python3 -c "..."`,
  // `~/.local/bin/node -e "..."`) still classify. The code inside the
  // quotes is the same regardless of how the interpreter is invoked, so
  // scanning the normalized form is safe.
  const inline = safe('inline-scanner', () => classifyInlineInterpreter(seg), null);
  if (inline?.kind === 'allow') return inline;
  const inlineSuspect = inline?.kind === 'unknown';

  // 4. Learned auto-allow (exact match on normalized-for-learning form).
  // O(1) Set.has() instead of the old O(N) array.includes(); matters when
  // learned-allow grows past a few hundred entries.
  const norm = safe('learn-normalize', () => normalize(seg), seg);
  if (!inlineSuspect && learned.has(norm)) {
    return { kind: 'allow', reason: `learned: ${norm}` };
  }

  // 5. ALLOW list.
  if (!inlineSuspect) {
    for (const re of ALLOW) {
      if (safe('allow-match', () => re.test(seg), false)) {
        return { kind: 'allow', reason: `matched: ${re.source}` };
      }
    }
  }

  return { kind: 'unknown', reason: inlineSuspect ? inline.reason : undefined };
}

// Static-only classification (synchronous, no network/subprocess). Returns one of:
//   { decision: 'ask'|'allow', reason, source: 'static-ask'|'static-allow'|'splitter' }
//   { decision: null,          reason,           source: 'unknown' }
// Callers that need the LLM waterfall use classify() instead.
export function classifyStatic(command, cwd) {
  // Pre-process: collapse line continuations + strip heredoc bodies. Keeps
  // the splitter from breaking on `;` etc. inside multi-line content.
  const preprocessed = safe('preprocess', () => preprocessCommand(command), command);

  const splitResult = safe('split', () => splitCommandWithReason(preprocessed), { bail: 'unbalanced' });
  if (splitResult.bail === 'subshell') {
    // Splitter can't safely segment subshells, but the LLM CAN reason about
    // the whole command (including the subshell body). Return 'unknown' so
    // the classify() waterfall hits the LLM layer instead of asking blindly.
    return { decision: null, reason: 'subshell substitution — defer to LLM', source: 'unknown' };
  }
  if (splitResult.bail === 'unbalanced') {
    return { decision: 'ask', reason: 'unbalanced quotes', source: 'splitter' };
  }
  const segs = splitResult.segments;
  if (segs.length === 0) {
    return { decision: 'allow', reason: 'empty command', source: 'splitter' };
  }

  const learned = safe('load-learned', () => loadLearnedSet(), new Set());
  const verdicts = segs.map(s => classifySegment(s, cwd, learned));

  for (const v of verdicts) {
    if (v.kind === 'ask') return { decision: 'ask', reason: v.reason, source: 'static-ask' };
  }

  const unknowns = verdicts.filter(v => v.kind === 'unknown');
  if (unknowns.length === 0) {
    return { decision: 'allow', reason: verdicts.map(v => v.reason).filter(Boolean).join(' | '), source: 'static-allow' };
  }

  return {
    decision: null,
    reason: unknowns.map(u => u.reason).filter(Boolean).join(' | ') || 'no static match',
    source: 'unknown',
  };
}

// Full pipeline: static classification, then LLM waterfall for unknowns.
export async function classify(command, cwd, intent) {
  const startedAt = Date.now();
  const stat = classifyStatic(command, cwd);
  if (stat.source !== 'unknown') {
    debugLog({ tool: 'Bash', command: command.slice(0, 200), intent, ...stat, ms: Date.now() - startedAt });
    return stat;
  }

  const llm = await classifyWithLLM(command, intent);
  const result = { decision: llm.verdict, reason: llm.reason, source: 'llm' };
  debugLog({ tool: 'Bash', command: command.slice(0, 200), intent, ...result, ms: Date.now() - startedAt });
  return result;
}
