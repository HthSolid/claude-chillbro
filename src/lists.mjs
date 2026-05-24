// Load and compile static + learned regex lists.
//
// Patterns live in /patterns/{allow,ask}.list — versioned as a data product
// independent of the plugin code. See patterns/PATTERNS.md for contribution
// guide. Users can extend (NOT bypass) the static lists with their own:
//   ~/.claude-chillbro/user-allow.list
//   ~/.claude-chillbro/user-ask.list
//
// ASK list always wins over ALLOW (precedence enforced in classify.mjs).
// User patterns extend their respective list — they CANNOT override an ASK
// match because the classifier checks ASK first.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { loadLearned } from './state.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PATTERNS_DIR = join(__dirname, '..', 'patterns');
const USER_STATE_DIR = join(homedir(), '.claude-chillbro');
const USER_ALLOW = join(USER_STATE_DIR, 'user-allow.list');
const USER_ASK = join(USER_STATE_DIR, 'user-ask.list');

function parsePatternLines(txt, source) {
  return txt.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(pattern => {
      try { return new RegExp(pattern); }
      catch (e) {
        process.stderr.write(`[chillbro] bad regex in ${source}: ${pattern} (${e.message}) — skipping\n`);
        return null;
      }
    })
    .filter(Boolean);
}

function loadListFile(path, label) {
  let txt;
  try {
    txt = readFileSync(path, 'utf8');
  } catch (err) {
    // Missing user-local file is normal; missing patterns/ file is degraded mode.
    if (err.code !== 'ENOENT') {
      process.stderr.write(`[chillbro] could not read ${label} (${err.message}) — using empty list\n`);
    }
    return [];
  }
  return parsePatternLines(txt, label);
}

function loadAllowAll() {
  const core = loadListFile(join(PATTERNS_DIR, 'allow.list'), 'patterns/allow.list');
  const user = loadListFile(USER_ALLOW, 'user-allow.list');
  return [...core, ...user];
}

function loadAskAll() {
  const core = loadListFile(join(PATTERNS_DIR, 'ask.list'), 'patterns/ask.list');
  const user = loadListFile(USER_ASK, 'user-ask.list');
  return [...core, ...user];
}

// Loaded once at module init for the static lists. If a list file is missing
// or fully corrupt, returns [] — the classifier then has no patterns to
// match and falls back to LLM/ask, which is the safe degraded behavior.
export const ALLOW = loadAllowAll();
export const ASK = loadAskAll();

// Counts for `chillbro patterns status` reporting.
export function patternCounts() {
  return {
    allow_core: loadListFile(join(PATTERNS_DIR, 'allow.list'), 'patterns/allow.list').length,
    allow_user: existsSync(USER_ALLOW) ? loadListFile(USER_ALLOW, 'user-allow.list').length : 0,
    ask_core:  loadListFile(join(PATTERNS_DIR, 'ask.list'), 'patterns/ask.list').length,
    ask_user:  existsSync(USER_ASK) ? loadListFile(USER_ASK, 'user-ask.list').length : 0,
  };
}

// Read patterns/META.json for the patterns version.
export function patternsMeta() {
  try {
    return JSON.parse(readFileSync(join(PATTERNS_DIR, 'META.json'), 'utf8'));
  } catch {
    return null;
  }
}

// Returns a Set for O(1) membership tests (was O(N) array.includes() before).
// De-duplicates entries that may exist from concurrent writes pre-0.1.6.
//
// Test isolation: when CHILLBRO_TEST_NO_LEARN=1, ignore the user's
// ~/.claude-chillbro/learned-allow.txt so test outcomes don't depend on
// what commands they've approved in real-world use. Matches the existing
// CHILLBRO_TEST_NO_LLM convention.
export function loadLearnedSet() {
  if (process.env.CHILLBRO_TEST_NO_LEARN === '1') return new Set();
  return new Set(loadLearned());
}

// Back-compat alias for callers that still expect an array-like contract.
// New code should prefer loadLearnedSet() and use .has() instead of .includes().
export function loadLearnedRegexes() {
  return Array.from(loadLearnedSet());
}

// User-pattern file helpers — writing happens in bin/chillbro.mjs.
export const USER_PATHS = { USER_ALLOW, USER_ASK };
