// Special-case context probes. These run synchronously when a command pattern
// requires runtime context (current branch for git push, repo visibility for gh).
// Results are cached in memory for the lifetime of the hook process. Cheap.

import { execFileSync } from 'node:child_process';

const PROBE_TIMEOUT_MS = 1500;

function safeExec(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, {
      timeout: PROBE_TIMEOUT_MS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      ...opts,
    }).trim();
  } catch { return null; }
}

const visCache = new Map();

export function repoVisibility(cwd) {
  if (visCache.has(cwd)) return visCache.get(cwd);
  const out = safeExec('gh', ['repo', 'view', '--json', 'visibility', '-q', '.visibility'], { cwd });
  const v = out ? out.toLowerCase() : 'unknown';
  visCache.set(cwd, v);
  return v;
}

export function currentBranch(cwd) {
  return safeExec('git', ['symbolic-ref', '--short', 'HEAD'], { cwd });
}

// Inspect a `git push` invocation and return the destination ref, if determinable.
// Returns 'main' / 'master' for pushes that target one of those, the explicit ref
// when given, or the current branch when bare. null = couldn't determine.
export function gitPushTarget(segment, cwd) {
  const tokens = segment.split(/\s+/).slice(2); // drop "git push"
  const positional = tokens.filter(t => !t.startsWith('-'));
  if (positional.length >= 2) return positional[1].replace(/^\+/, '');
  if (positional.length === 1) {
    // single positional could be remote name (e.g., "origin") -> bare push
    // or could be refspec.
    if (positional[0].includes(':') || positional[0].includes('/')) return positional[0];
    return currentBranch(cwd);
  }
  return currentBranch(cwd);
}
