// Optional per-decision debug log. Activated by setting CHILLBRO_DEBUG=1 in
// the user's shell environment. Writes one JSON line per classification to
// `~/.claude-chillbro/debug.log`. Silent and free when the env var is unset.
//
// Use case: when a command unexpectedly prompts the user, they can `tail` the
// log to see exactly which layer (static-allow / static-ask / inline-scanner /
// learned / llm / splitter) made the decision and why.

import { appendFileSync, mkdirSync, existsSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STATE_DIR = join(homedir(), '.claude-chillbro');
const DEBUG_LOG = join(STATE_DIR, 'debug.log');

// Rotation: when the active log exceeds MAX_BYTES, shift .2 → .3, .1 → .2,
// debug.log → .1 and start fresh. Keeps total disk use bounded to roughly
// 4 * MAX_BYTES. Defaults to 50 MB so a left-on CHILLBRO_DEBUG=1 session
// can't fill a small disk.
const MAX_BYTES = Number(process.env.CHILLBRO_DEBUG_MAX_BYTES) || 50 * 1024 * 1024;
const KEEP_BACKUPS = 3;

function isEnabled() {
  return process.env.CHILLBRO_DEBUG === '1';
}

function rotateIfNeeded() {
  let size = 0;
  try { size = statSync(DEBUG_LOG).size; } catch { return; /* doesn't exist yet */ }
  if (size < MAX_BYTES) return;
  // Shift backups: drop the oldest, slide the rest up.
  try { unlinkSync(`${DEBUG_LOG}.${KEEP_BACKUPS}`); } catch { /* may not exist */ }
  for (let i = KEEP_BACKUPS - 1; i >= 1; i--) {
    try { renameSync(`${DEBUG_LOG}.${i}`, `${DEBUG_LOG}.${i + 1}`); } catch { /* may not exist */ }
  }
  try { renameSync(DEBUG_LOG, `${DEBUG_LOG}.1`); } catch { /* may have been deleted between stat and rename */ }
}

export function debugLog(record) {
  if (!isEnabled()) return;
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    rotateIfNeeded();
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      ...record,
    }) + '\n';
    appendFileSync(DEBUG_LOG, line);
  } catch {
    // Never throw from debug logging — failsafe means failsafe.
  }
}
