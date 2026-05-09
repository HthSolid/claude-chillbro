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

import { splitCommand } from './splitter.mjs';
import { ALLOW, ASK, loadLearnedRegexes } from './lists.mjs';
import { normalize } from './normalize.mjs';
import { repoVisibility, gitPushTarget } from './probes.mjs';
import { classifyInlineInterpreter } from './inlineInterpreters.mjs';
import { classifyWithLLM } from './llmFallback.mjs';

const RX = {
  gitPush: /^git\s+push(\s|$)/,
  ghPublic: /^gh\s+(pr|issue|release)\s+(create|merge)\b/,
};

function classifySegment(seg, cwd, learned) {
  // 1. ASK list — narrow patterns win first.
  for (const re of ASK) {
    if (re.test(seg)) return { kind: 'ask', reason: `matched: ${re.source}` };
  }

  // 2. Special-case probes (override allow when context demands it).
  if (RX.gitPush.test(seg)) {
    const target = gitPushTarget(seg, cwd);
    if (target && /^(refs\/heads\/)?(main|master)$/.test(target)) {
      return { kind: 'ask', reason: `git push targets ${target}` };
    }
    return { kind: 'allow', reason: `git push to ${target || 'feature branch'}` };
  }

  if (RX.ghPublic.test(seg)) {
    const vis = repoVisibility(cwd);
    if (vis === 'public') return { kind: 'ask', reason: 'public-repo gh action' };
    if (vis === 'private' || vis === 'internal') return { kind: 'allow', reason: `${vis}-repo gh action` };
    return { kind: 'ask', reason: 'unknown repo visibility' };
  }

  // 3. Inline interpreter scanner. If clean → allow. If suspect → leave for later layers.
  const inline = classifyInlineInterpreter(seg);
  if (inline?.kind === 'allow') return inline;
  // 'unknown' from the inline scanner means: the segment IS an inline interpreter
  // call but contains a dangerous token. Don't allow via the static list below
  // even if some loose pattern matches; force escalation to LLM.
  const inlineSuspect = inline?.kind === 'unknown';

  // 4. Learned auto-allow (exact match on normalized form).
  const norm = normalize(seg);
  if (!inlineSuspect && learned.includes(norm)) {
    return { kind: 'allow', reason: `learned: ${norm}` };
  }

  // 5. ALLOW list.
  if (!inlineSuspect) {
    for (const re of ALLOW) {
      if (re.test(seg)) return { kind: 'allow', reason: `matched: ${re.source}` };
    }
  }

  return { kind: 'unknown', reason: inlineSuspect ? inline.reason : undefined };
}

// Static-only classification (synchronous, no network/subprocess). Returns one of:
//   { decision: 'ask'|'allow', reason, source: 'static-ask'|'static-allow'|'splitter' }
//   { decision: null,          reason,           source: 'unknown' }
// Callers that need the LLM waterfall use classify() instead.
export function classifyStatic(command, cwd) {
  const segs = splitCommand(command);
  if (segs === null) {
    return { decision: 'ask', reason: 'complex shell construct (subshell/substitution/unbalanced)', source: 'splitter' };
  }
  if (segs.length === 0) {
    return { decision: 'allow', reason: 'empty command', source: 'splitter' };
  }

  const learned = loadLearnedRegexes();
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
  const stat = classifyStatic(command, cwd);
  if (stat.source !== 'unknown') return stat;

  const llm = await classifyWithLLM(command, intent);
  return { decision: llm.verdict, reason: llm.reason, source: 'llm' };
}
