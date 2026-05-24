// Persistent state (learned-allow + counters + caches) at ~/.claude-chillbro/.
// Plain text formats so the user can edit/prune by hand.
//
// Failure model: any read or parse error degrades to "empty state" rather than
// throwing. A torn JSON write (e.g., crash mid-write of counters.json) would
// break every subsequent posttool invocation if we let it propagate. Instead
// we log + reset so the plugin keeps working even after corruption.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync, appendFileSync, openSync, closeSync, writeSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STATE_DIR = join(homedir(), '.claude-chillbro');
const LEARNED_FILE = join(STATE_DIR, 'learned-allow.txt');
const COUNTER_FILE = join(STATE_DIR, 'counters.json');
const LEARN_AUDIT = join(STATE_DIR, 'learned-allow.log');
const STATE_LOCK = join(STATE_DIR, '.state.lock');

// Cross-process lock around the counters + learned read-modify-write pair.
//
// Before this, `atomicBumpAndPromote` was atomic per-file (temp + rename) but
// NOT atomic across processes — two parallel posttool invocations on the same
// normalized command both read counter=N, both wrote counter=N+1, losing one
// increment. The stress test showed 20 parallel processes retaining only ~2/20
// increments + creating duplicate audit lines.
//
// Approach: O_EXCL lockfile (createSync with 'wx' flag is atomic on POSIX +
// Windows). Spin-retry up to 500ms with 2ms busy waits. If the lock file is
// older than 5s, treat as stale (owner crashed) and force-take. If we still
// can't acquire after the timeout, fall back to running the critical section
// without the lock — a lost update is better than blocking the hook.
const LOCK_TIMEOUT_MS = 500;
const LOCK_STALE_MS = 5000;

function busyWait(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin briefly */ }
}

function withLock(fn) {
  ensureDir();
  const start = Date.now();
  while (Date.now() - start < LOCK_TIMEOUT_MS) {
    let fd;
    try {
      fd = openSync(STATE_LOCK, 'wx');  // O_EXCL — atomic create-or-fail
      try {
        writeSync(fd, Buffer.from(`${process.pid}\n${Date.now()}\n`));
        return fn();
      } finally {
        try { closeSync(fd); } catch {}
        try { unlinkSync(STATE_LOCK); } catch {}
      }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Lock contended. If it's stale (owner crashed), force-take.
      try {
        const st = statSync(STATE_LOCK);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          try { unlinkSync(STATE_LOCK); } catch {}
          continue;  // retry immediately
        }
      } catch { /* lock file disappeared, try again */ }
      busyWait(2);
    }
  }
  // Timed out: run unlocked. Lossy but not catastrophic — the rare case
  // where this happens (>500ms of sustained contention) is itself unusual.
  process.stderr.write(`[chillbro] withLock: timed out after ${LOCK_TIMEOUT_MS}ms — proceeding unlocked\n`);
  return fn();
}

// Append a one-line audit record every time a pattern is promoted to
// learned-allow. Lightweight plugin-self-defense: if the file grows
// unexpectedly fast (or contains patterns the user doesn't recognize), it's
// a signal that something is auto-promoting beyond what they approved.
//
// Format: ISO-8601 \t source \t normalized command
//   source = 'auto' (PostToolUse promoted via threshold) or 'manual'
//            (user ran `chillbro learn add ...`)
function writeLearnAudit(normalized, source = 'auto') {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    const line = `${new Date().toISOString()}\t${source}\t${normalized}\n`;
    appendFileSync(LEARN_AUDIT, line);
  } catch {
    // Audit log failure must never block learning.
  }
}

export const PATHS = { STATE_DIR, LEARNED_FILE, COUNTER_FILE, LEARN_AUDIT };

function ensureDir() {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
}

// Atomic write: write to a temp file then rename. Avoids torn writes that
// produce malformed JSON if the process is killed mid-write.
function atomicWrite(path, contents) {
  ensureDir();
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}

export function loadLearned() {
  try {
    const txt = readFileSync(LEARNED_FILE, 'utf8');
    return txt.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      process.stderr.write(`[chillbro] learned-allow read error: ${err.message} — starting fresh\n`);
    }
    return [];
  }
}

export function appendLearned(normalized, source = 'auto') {
  const existing = loadLearned();
  if (existing.includes(normalized)) return false;
  const header = existsSync(LEARNED_FILE)
    ? ''
    : '# claude-chillbro :: learned auto-allow patterns\n# Auto-added after 2 successful runs of the same normalized command.\n# Edit freely. One normalized form per line. # for comments.\n\n';
  atomicWrite(LEARNED_FILE, header + existing.concat(normalized).join('\n') + '\n');
  writeLearnAudit(normalized, source);
  return true;
}

// Remove a learned pattern. Returns true if found and removed.
export function forgetLearned(normalized) {
  const existing = loadLearned();
  const filtered = existing.filter(l => l !== normalized);
  if (filtered.length === existing.length) return false;
  const header = '# claude-chillbro :: learned auto-allow patterns\n# Auto-added after 2 successful runs of the same normalized command.\n# Edit freely. One normalized form per line. # for comments.\n\n';
  atomicWrite(LEARNED_FILE, header + filtered.join('\n') + (filtered.length ? '\n' : ''));
  writeLearnAudit(normalized, 'forgotten');
  return true;
}

// Read the audit log (newest first). Returns array of {ts, source, normalized}.
export function readLearnAudit(limit = 50) {
  try {
    const lines = readFileSync(LEARN_AUDIT, 'utf8').split('\n').filter(Boolean);
    const parsed = lines.map(l => {
      const [ts, source, normalized] = l.split('\t');
      return { ts, source, normalized };
    }).filter(e => e.ts && e.normalized);
    return parsed.reverse().slice(0, limit);
  } catch { return []; }
}

export function loadCounters() {
  let raw;
  try { raw = readFileSync(COUNTER_FILE, 'utf8'); }
  catch (err) {
    if (err.code !== 'ENOENT') {
      process.stderr.write(`[chillbro] counters read error: ${err.message} — starting fresh\n`);
    }
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    process.stderr.write(`[chillbro] counters file has unexpected shape — resetting\n`);
    return {};
  } catch (err) {
    process.stderr.write(`[chillbro] counters JSON parse error: ${err.message} — resetting\n`);
    // Move the corrupted file aside so the user can inspect it later if they want.
    try { renameSync(COUNTER_FILE, `${COUNTER_FILE}.corrupt.${Date.now()}`); } catch { /* best effort */ }
    return {};
  }
}

export function saveCounters(c) {
  atomicWrite(COUNTER_FILE, JSON.stringify(c, null, 2));
}

export function bumpCounter(normalized) {
  const c = loadCounters();
  c[normalized] = (c[normalized] || 0) + 1;
  saveCounters(c);
  return c[normalized];
}

// Atomic bump + promote. Wrapped in `withLock` so it is safe across
// concurrent processes. Validated by smoke-improvements.mjs parallel stress
// test (20 processes hitting the same normalized command → all 20 increments
// retained, exactly 1 learned-allow entry, exactly 1 audit line).
export function atomicBumpAndPromote(normalized, promotionThreshold = 2) {
  return withLock(() => atomicBumpAndPromoteUnlocked(normalized, promotionThreshold));
}

function atomicBumpAndPromoteUnlocked(normalized, promotionThreshold = 2) {
  const counters = loadCounters();
  const existingLearned = loadLearned();
  const learned = new Set(existingLearned);

  if (learned.has(normalized)) {
    return { count: counters[normalized] ?? promotionThreshold, promoted: false, alreadyLearned: true };
  }

  const next = (counters[normalized] || 0) + 1;
  counters[normalized] = next;

  let promoted = false;
  if (next >= promotionThreshold) {
    learned.add(normalized);
    promoted = true;
  }

  saveCounters(counters);
  if (promoted) {
    const header = existsSync(LEARNED_FILE)
      ? ''
      : '# claude-chillbro :: learned auto-allow patterns\n# Auto-added after 2 successful runs of the same normalized command.\n# Edit freely. One normalized form per line. # for comments.\n\n';
    atomicWrite(LEARNED_FILE, header + Array.from(learned).join('\n') + '\n');
    writeLearnAudit(normalized, 'auto');
  }
  return { count: next, promoted, alreadyLearned: false };
}
