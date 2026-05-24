// Classifier for Write / Edit / MultiEdit tools.
//
// Default: ALLOW. The whole point of asking the model to write a file is for it
// to write the file — re-prompting on every save is the prime annoyance.
//
// ASK only for genuinely sensitive targets: env files, credential stores, SSH
// keys, anything outside the project tree (the model is reaching out of the
// project), and explicitly-marked secrets directories.
//
// "Project tree" is determined by climbing up from cwd to find the nearest
// `.git/` directory. This matters because Claude Code reports cwd as the
// shell's current dir, which changes when the model uses Bash `cd` — in a
// monorepo the cwd could be a deep subdir while the model legitimately needs
// to write files anywhere in the parent project. cwd-only checking caused
// ~28% of paths in real sessions to get prompted on cross-subdir writes
// that were clearly inside the same git project.
//
// Fallback order:
//   1. nearest .git/ above cwd                  (best — matches user intuition)
//   2. CLAUDE_PROJECT_DIR env var if set        (Claude Code may inject this)
//   3. configured roots in ~/.claude-chillbro/write-roots.list (user override)
//   4. cwd itself                                (last-resort, current behavior)

import { resolve, relative, isAbsolute, dirname, join } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';

const ASK_PATTERNS = [
  /(^|\/)\.env(\..+)?$/,
  /(^|\/)\.env$/,
  /(^|\/)\.aws\/credentials\b/,
  /(^|\/)\.ssh\/(id_|authorized_keys\b|known_hosts\b)/,
  /(^|\/)secrets?\//i,
  /(^|\/)private\//i,
  /(^|\/)credentials?\.(json|ya?ml|toml|env)$/i,
  /(^|\/)\.netrc$/,
  /(^|\/)\.pgpass$/,
];

const WRITE_ROOTS_FILE = join(homedir(), '.claude-chillbro', 'write-roots.list');

// Climb up from `dir` until we hit a `.git` directory. Returns the parent
// directory containing `.git`, or null if we walk all the way to root.
// Caches results per-process so we don't re-stat for each Write call.
const gitRootCache = new Map();
function findGitRoot(startDir) {
  if (!startDir) return null;
  if (gitRootCache.has(startDir)) return gitRootCache.get(startDir);
  let dir = resolve(startDir);
  const root = '/';
  for (let i = 0; i < 64 && dir && dir !== root; i++) {
    try {
      const candidate = join(dir, '.git');
      const st = statSync(candidate);
      if (st && (st.isDirectory() || st.isFile())) {
        gitRootCache.set(startDir, dir);
        return dir;
      }
    } catch { /* not here */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  gitRootCache.set(startDir, null);
  return null;
}

function loadUserWriteRoots() {
  try {
    return readFileSync(WRITE_ROOTS_FILE, 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .map(l => resolve(l.replace(/^~/, homedir())));
  } catch { return []; }
}

// Returns the list of directories considered "in-project" for a given cwd.
// Always includes cwd. Adds: git root above cwd, CLAUDE_PROJECT_DIR if set,
// any directories the user has listed in ~/.claude-chillbro/write-roots.list.
function inProjectRoots(cwd) {
  const roots = new Set();
  if (cwd) roots.add(resolve(cwd));
  const gitRoot = findGitRoot(cwd);
  if (gitRoot) roots.add(gitRoot);
  const projDir = process.env.CLAUDE_PROJECT_DIR;
  if (projDir) roots.add(resolve(projDir));
  for (const r of loadUserWriteRoots()) roots.add(r);
  return Array.from(roots);
}

function isInsideAny(abs, roots) {
  for (const root of roots) {
    if (abs === root) return root;
    if (abs.startsWith(root + '/')) return root;
  }
  return null;
}

export function classifyWrite(filePath, cwd) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return { decision: 'ask', reason: 'missing file_path', source: 'write-classify' };
  }

  const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);

  // Sensitive-path check runs first against the absolute path, so it catches
  // .env / .ssh / secrets / etc. regardless of where the project root is.
  for (const re of ASK_PATTERNS) {
    if (re.test(abs)) return { decision: 'ask', reason: `sensitive path: ${re.source}`, source: 'write-classify' };
  }

  // Then check if the write target is inside any "in-project" root.
  const roots = inProjectRoots(cwd);
  const matchedRoot = isInsideAny(abs, roots);
  if (matchedRoot) {
    return { decision: 'allow', reason: `in-project (root: ${matchedRoot})`, source: 'write-classify' };
  }

  return { decision: 'ask', reason: `outside any known project root (cwd=${cwd}, abs=${abs})`, source: 'write-classify' };
}

// Exported for tests; not part of the public API.
export const _internal = { findGitRoot, loadUserWriteRoots, inProjectRoots, isInsideAny, WRITE_ROOTS_FILE };
