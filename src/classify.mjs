// Top-level classifier. Given a full Bash command and cwd, returns:
//   { decision: 'allow' | 'ask', reason: string, source: '...' }
//
// Pipeline:
//   1. Split into segments (compound commands).
//   2. For each segment: ASK list → LEARNED → ALLOW list → special-cases → unknown.
//   3. If any segment is ASK → ASK.
//   4. If any segment is UNKNOWN → LLM fallback over the full command.
//   5. Else ALLOW.

import { splitCommand } from './splitter.mjs';
import { ALLOW, ASK, loadLearnedRegexes } from './lists.mjs';
import { normalize } from './normalize.mjs';
import { repoVisibility, gitPushTarget } from './probes.mjs';
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

  // 3. Learned auto-allow (exact-match on normalized form).
  const norm = normalize(seg);
  if (learned.includes(norm)) return { kind: 'allow', reason: `learned: ${norm}` };

  // 4. ALLOW list.
  for (const re of ALLOW) {
    if (re.test(seg)) return { kind: 'allow', reason: `matched: ${re.source}` };
  }

  return { kind: 'unknown' };
}

export function classify(command, cwd) {
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
    return { decision: 'allow', reason: verdicts.map(v => v.reason).join(' | '), source: 'static-allow' };
  }

  // 5. LLM fallback on the full original command (gives it more context than just the segment).
  const llm = classifyWithLLM(command);
  return { decision: llm.verdict, reason: llm.reason, source: 'llm' };
}
