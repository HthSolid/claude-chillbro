// Persistent state (learned-allow + counters + caches) at ~/.claude-chillbro/.
// Plain text formats so the user can edit/prune by hand.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STATE_DIR = join(homedir(), '.claude-chillbro');
const LEARNED_FILE = join(STATE_DIR, 'learned-allow.txt');
const COUNTER_FILE = join(STATE_DIR, 'counters.json');

function ensureDir() {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
}

export function loadLearned() {
  try {
    const txt = readFileSync(LEARNED_FILE, 'utf8');
    return txt.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  } catch { return []; }
}

export function appendLearned(normalized) {
  ensureDir();
  const existing = loadLearned();
  if (existing.includes(normalized)) return false;
  const header = existsSync(LEARNED_FILE)
    ? ''
    : '# claude-chillbro :: learned auto-allow patterns\n# Auto-added after 2 successful runs of the same normalized command.\n# Edit freely — one normalized form per line, # for comments.\n\n';
  writeFileSync(LEARNED_FILE, header + (existing.concat(normalized)).join('\n') + '\n');
  return true;
}

export function loadCounters() {
  try { return JSON.parse(readFileSync(COUNTER_FILE, 'utf8')); }
  catch { return {}; }
}

export function saveCounters(c) {
  ensureDir();
  writeFileSync(COUNTER_FILE, JSON.stringify(c, null, 2));
}

export function bumpCounter(normalized) {
  const c = loadCounters();
  c[normalized] = (c[normalized] || 0) + 1;
  saveCounters(c);
  return c[normalized];
}
