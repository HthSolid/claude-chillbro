// dejavu-audit-skip: P-026 — tests live in /test/ (project convention), not /src/
// State management for auto-continue mode.
//
// Lives at ~/.claude-chillbro/auto-continue.json. Re-read on every Stop hook
// invocation so toggling it mid-session takes effect immediately (no Claude
// Code restart). Atomic writes (temp + rename) avoid torn JSON on crash.
//
// Schema:
//   {
//     enabled: boolean,
//     message_template: string,    // user's directive, fed back to Claude
//     phase_range: [low, high]|null,  // e.g. [1,6] or null for "no phase tracking"
//     current_phase: number|null,  // last completed phase (LLM-detected)
//     iterations: number,          // count of auto-continues this session
//     iterations_max: number,      // hard cap
//     completions: [{phase, ts, summary}],  // history
//     consecutive_failures: number, // LLM/parse failures in a row
//     enabled_at: string|null,     // ISO timestamp of last enable
//   }

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STATE_DIR = join(homedir(), '.claude-chillbro');
const STATE_FILE = join(STATE_DIR, 'auto-continue.json');

const DEFAULT_MESSAGE = 'Please audit what you just completed; if there is a next phase, proceed with it. Do not commit unless explicitly asked.';
const DEFAULT_ITERATIONS_MAX = 50;
const FAILURE_AUTO_DISABLE = 3;

function ensureDir() {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
}

function atomicWrite(path, contents) {
  ensureDir();
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}

function blankState() {
  return {
    enabled: false,
    message_template: DEFAULT_MESSAGE,
    phase_range: null,
    current_phase: null,
    iterations: 0,
    iterations_max: DEFAULT_ITERATIONS_MAX,
    completions: [],
    consecutive_failures: 0,
    enabled_at: null,
  };
}

export function loadState() {
  let raw;
  try { raw = readFileSync(STATE_FILE, 'utf8'); }
  catch (err) {
    if (err.code !== 'ENOENT') {
      process.stderr.write(`[chillbro] auto-continue state read error: ${err.message} — using defaults\n`);
    }
    return blankState();
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      process.stderr.write(`[chillbro] auto-continue state shape unexpected — resetting\n`);
      return blankState();
    }
    return { ...blankState(), ...parsed };
  } catch (err) {
    process.stderr.write(`[chillbro] auto-continue state JSON parse error: ${err.message} — resetting\n`);
    try { renameSync(STATE_FILE, `${STATE_FILE}.corrupt.${Date.now()}`); } catch { /* best effort */ }
    // Self-heal: write a fresh blank state to disk so subsequent reads find a
    // valid file. Without this, the file is gone (renamed) and every following
    // read returns blank-from-memory but appears as "no state" externally.
    const fresh = blankState();
    try { atomicWrite(STATE_FILE, JSON.stringify(fresh, null, 2)); } catch { /* tolerable */ }
    return fresh;
  }
}

export function saveState(state) {
  atomicWrite(STATE_FILE, JSON.stringify(state, null, 2));
}

// --- public mutators (used by bin/chillbro) ---

export function enable({ message, phases, iterations } = {}) {
  const s = loadState();
  s.enabled = true;
  s.enabled_at = new Date().toISOString();
  s.iterations = 0;
  s.completions = [];
  s.consecutive_failures = 0;
  s.current_phase = null;
  if (typeof message === 'string' && message.trim()) s.message_template = message;
  if (phases) {
    const range = parsePhaseRange(phases);
    if (range) s.phase_range = range;
  }
  if (typeof iterations === 'number' && iterations > 0) s.iterations_max = iterations;
  saveState(s);
  return s;
}

export function disable() {
  const s = loadState();
  s.enabled = false;
  saveState(s);
  return s;
}

export function setMessage(message) {
  const s = loadState();
  s.message_template = message;
  saveState(s);
  return s;
}

export function setPhases(phases) {
  const s = loadState();
  const range = parsePhaseRange(phases);
  if (range) s.phase_range = range;
  saveState(s);
  return s;
}

export function setIterationsMax(n) {
  const s = loadState();
  s.iterations_max = Math.max(1, Math.floor(n));
  saveState(s);
  return s;
}

export function reset() {
  saveState(blankState());
  return blankState();
}

// --- internal mutators (used by hooks/stop.mjs) ---

export function recordIteration({ phase = null, summary = '' } = {}) {
  const s = loadState();
  s.iterations += 1;
  s.consecutive_failures = 0;
  if (phase !== null && Number.isInteger(phase)) {
    s.current_phase = phase;
    s.completions.push({ phase, ts: new Date().toISOString(), summary: summary.slice(0, 200) });
  }
  saveState(s);
  return s;
}

export function recordFailure() {
  const s = loadState();
  s.consecutive_failures += 1;
  if (s.consecutive_failures >= FAILURE_AUTO_DISABLE) {
    s.enabled = false;
    process.stderr.write(`[chillbro] auto-continue auto-disabled after ${s.consecutive_failures} consecutive failures\n`);
  }
  saveState(s);
  return s;
}

// --- helpers ---

// Parse "1-6", "5", "1..6" into [low, high]. Returns null on invalid.
export function parsePhaseRange(input) {
  if (input == null) return null;
  if (Array.isArray(input) && input.length === 2) return [Number(input[0]), Number(input[1])];
  const s = String(input).trim();
  let m = s.match(/^(\d+)\s*[-–.]+\s*(\d+)$/); // 1-6, 1..6, 1—6
  if (m) {
    const lo = +m[1], hi = +m[2];
    return lo <= hi ? [lo, hi] : null;
  }
  m = s.match(/^(\d+)$/);
  if (m) return [1, +m[1]]; // "phases 6" means "1-6"
  return null;
}

// True iff the given phase number is at or beyond the configured upper bound.
export function isPhaseRangeExhausted(state) {
  if (!state.phase_range || state.current_phase == null) return false;
  return state.current_phase >= state.phase_range[1];
}

// True iff iteration cap was hit.
export function isIterationCapReached(state) {
  return state.iterations >= state.iterations_max;
}
