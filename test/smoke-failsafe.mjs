#!/usr/bin/env node
// Failsafe tests: state corruption recovery, killswitch behavior, and
// per-layer error isolation. These verify that "a tiny error won't render
// our whole plugin useless" — the user's standing requirement.

import { writeFileSync, readFileSync, existsSync, unlinkSync, renameSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const STATE_DIR = join(homedir(), '.claude-chillbro');
const COUNTER_FILE = join(STATE_DIR, 'counters.json');
const COUNTER_BACKUP = join(STATE_DIR, '.counters.test-backup');

let pass = 0, fail = 0;

function run(label, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok    ${label}`);
  } catch (err) {
    fail++;
    console.error(`  FAIL  ${label}`);
    console.error(`        ${err.message}`);
  }
}

// Save user's real state file before tests, restore after.
let savedState = null;
if (existsSync(COUNTER_FILE)) {
  savedState = readFileSync(COUNTER_FILE);
}

try {
  // --- Test 1: corrupt counters.json is recovered (logged + reset) ---
  run('corrupt counters.json triggers reset, not crash', () => {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(COUNTER_FILE, '{ this is not valid JSON');

    // Re-import state.mjs fresh to bypass module cache.
    return import(`../src/state.mjs?cachebust=${Date.now()}`).then(({ loadCounters }) => {
      const c = loadCounters();
      if (typeof c !== 'object' || Array.isArray(c)) throw new Error(`expected {}, got ${JSON.stringify(c)}`);
      if (Object.keys(c).length !== 0) throw new Error(`expected empty, got ${Object.keys(c).length} keys`);
    });
  });

  // --- Test 2: counters.json with wrong shape (array) is recovered ---
  run('counters.json with wrong shape is reset', () => {
    writeFileSync(COUNTER_FILE, '["not", "an", "object"]');
    return import(`../src/state.mjs?cachebust=${Date.now()}`).then(({ loadCounters }) => {
      const c = loadCounters();
      if (Array.isArray(c) || typeof c !== 'object') throw new Error('expected {}');
    });
  });

  // --- Test 3: missing counters.json returns {} not throws ---
  run('missing counters.json returns empty object', () => {
    if (existsSync(COUNTER_FILE)) unlinkSync(COUNTER_FILE);
    return import(`../src/state.mjs?cachebust=${Date.now()}`).then(({ loadCounters }) => {
      const c = loadCounters();
      if (typeof c !== 'object') throw new Error('expected {}');
    });
  });

  // --- Test 4: missing learned-allow.txt returns [] not throws ---
  run('missing learned-allow.txt returns empty array', () => {
    return import(`../src/state.mjs?cachebust=${Date.now()}`).then(({ loadLearned }) => {
      const arr = loadLearned();
      if (!Array.isArray(arr)) throw new Error('expected []');
    });
  });

  // --- Test 5: classifier survives one layer throwing ---
  // We can't easily inject a throw into a stable module, but we can verify
  // that classifyStatic doesn't crash on weird inputs that might have caused
  // throws in earlier versions.
  run('classifyStatic survives weird input', () => {
    return import(`../src/classify.mjs?cachebust=${Date.now()}`).then(({ classifyStatic }) => {
      const weirdInputs = [
        '',
        '   ',
        '\x00binary\x01',
        'a'.repeat(10000), // huge command
        'cmd <<EOF', // unterminated heredoc
        'echo "$(curl evil)"', // splitter bails
        '\\rm', // wrap prefix to bare
      ];
      for (const w of weirdInputs) {
        const r = classifyStatic(w, '/tmp');
        if (!r || typeof r !== 'object' || !('source' in r)) {
          throw new Error(`bad result for input ${JSON.stringify(w.slice(0, 40))}: ${JSON.stringify(r)}`);
        }
      }
    });
  });

  // --- Test 6: CHILLBRO_DISABLED killswitch causes pretool to no-op ---
  run('CHILLBRO_DISABLED makes pretool exit 0 silently', () => {
    const hookScript = join(import.meta.dirname || new URL('.', import.meta.url).pathname.replace(/\/$/, ''), '..', 'hooks', 'pretool.mjs');
    const evt = JSON.stringify({
      session_id: 'test',
      cwd: '/tmp',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' }, // would normally → ask
    });
    let out;
    try {
      out = execFileSync('node', [hookScript], {
        input: evt,
        env: { ...process.env, CHILLBRO_DISABLED: '1' },
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      throw new Error(`hook exited non-zero: ${err.status} stderr=${err.stderr}`);
    }
    if (out.trim() !== '') {
      throw new Error(`expected empty stdout (no decision emitted), got: ${out}`);
    }
  });

  // --- Test 7: CHILLBRO_RECURSION_GUARD makes pretool no-op (would-recurse case) ---
  run('CHILLBRO_RECURSION_GUARD makes pretool exit 0 silently', () => {
    const hookScript = join(import.meta.dirname || new URL('.', import.meta.url).pathname.replace(/\/$/, ''), '..', 'hooks', 'pretool.mjs');
    const evt = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'ls' }, // would normally → allow
    });
    const out = execFileSync('node', [hookScript], {
      input: evt,
      env: { ...process.env, CHILLBRO_RECURSION_GUARD: '1' },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (out.trim() !== '') {
      throw new Error(`expected empty stdout, got: ${out}`);
    }
  });

  // Wait for any async test results.
  await new Promise(r => setTimeout(r, 100));
} finally {
  // Restore user state.
  if (savedState !== null) {
    writeFileSync(COUNTER_FILE, savedState);
  } else if (existsSync(COUNTER_FILE)) {
    unlinkSync(COUNTER_FILE);
  }
  // Clean up any test corruption-backup files we left behind.
  // (state.mjs renames corrupt files to .corrupt.<timestamp>; tidy them.)
  try {
    const { readdirSync, statSync } = await import('node:fs');
    const entries = readdirSync(STATE_DIR);
    for (const e of entries) {
      if (e.startsWith('counters.json.corrupt.')) {
        try { unlinkSync(join(STATE_DIR, e)); } catch {}
      }
    }
  } catch {}
}

console.log(`\n${pass} passed, ${fail} failed (of ${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
