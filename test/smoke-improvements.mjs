#!/usr/bin/env node
// Tests for the 0.1.6 hardening round:
//   - atomic bumpAndPromote (no lost increments, no learned-allow dupes)
//   - Set lookup for learned (O(1), dedups on load)
//   - debug log rotation (size cap → .1/.2/.3 backups)
//   - bin/chillbro CLI arg validation (errors on unknown tokens)
//
// LLM-related tests for the two-stage classifier stay in the live-integration
// probes since they require a real Haiku call.

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync, rmSync, statSync, renameSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const STATE_DIR = join(homedir(), '.claude-chillbro');
const COUNTER_FILE = join(STATE_DIR, 'counters.json');
const LEARNED_FILE = join(STATE_DIR, 'learned-allow.txt');
const DEBUG_LOG = join(STATE_DIR, 'debug.log');

// Save real user state so tests don't trash it.
const savedCounters = existsSync(COUNTER_FILE) ? readFileSync(COUNTER_FILE) : null;
const savedLearned = existsSync(LEARNED_FILE) ? readFileSync(LEARNED_FILE) : null;
const savedDebug = existsSync(DEBUG_LOG) ? readFileSync(DEBUG_LOG) : null;

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ok    ${label}`); }
function bad(label, err) { fail++; console.error(`  FAIL  ${label}\n        ${err.message}`); }
async function run(label, fn) {
  try { await fn(); ok(label); }
  catch (err) { bad(label, err); }
}

try {
  // ──────────────────────────────────────────────────────────────────
  console.log('=== atomicBumpAndPromote ===');

  await run('first call: count=1, not promoted', async () => {
    if (existsSync(COUNTER_FILE)) unlinkSync(COUNTER_FILE);
    if (existsSync(LEARNED_FILE)) unlinkSync(LEARNED_FILE);
    const { atomicBumpAndPromote } = await import(`../src/state.mjs?test=${Date.now()}`);
    const r = atomicBumpAndPromote('foo bar baz');
    assert.equal(r.count, 1);
    assert.equal(r.promoted, false);
  });

  await run('second call on same norm: count=2, promoted', async () => {
    const { atomicBumpAndPromote } = await import(`../src/state.mjs?test=${Date.now()}`);
    const r = atomicBumpAndPromote('foo bar baz');
    assert.equal(r.count, 2);
    assert.equal(r.promoted, true);
    // learned-allow.txt now has the norm
    const learned = readFileSync(LEARNED_FILE, 'utf8');
    assert(learned.includes('foo bar baz'));
  });

  await run('third call: alreadyLearned=true, no second append', async () => {
    const { atomicBumpAndPromote } = await import(`../src/state.mjs?test=${Date.now()}`);
    const r = atomicBumpAndPromote('foo bar baz');
    assert.equal(r.alreadyLearned, true);
    assert.equal(r.promoted, false);
    // Count of "foo bar baz" lines in learned-allow.txt is exactly 1 (no dup)
    const lines = readFileSync(LEARNED_FILE, 'utf8').split('\n').filter(l => l.trim() === 'foo bar baz');
    assert.equal(lines.length, 1, `expected 1 occurrence of "foo bar baz" in learned-allow.txt, got ${lines.length}`);
  });

  await run('different norm: independent counter', async () => {
    const { atomicBumpAndPromote } = await import(`../src/state.mjs?test=${Date.now()}`);
    const r = atomicBumpAndPromote('different command');
    assert.equal(r.count, 1);
    assert.equal(r.promoted, false);
  });

  // ──────────────────────────────────────────────────────────────────
  console.log('\n=== Set-based learned lookup ===');

  await run('loadLearnedSet returns Set, dedups, has() works', async () => {
    if (existsSync(LEARNED_FILE)) unlinkSync(LEARNED_FILE);
    // Write a learned file with duplicates and comments and blank lines
    writeFileSync(LEARNED_FILE, [
      '# comment line, ignored',
      '',
      'cmd alpha',
      'cmd alpha', // duplicate
      'cmd beta',
      '# another comment',
      'cmd alpha', // dup again
    ].join('\n'));
    // Bust import cache so module re-reads
    const { loadLearnedSet } = await import(`../src/lists.mjs?test=${Date.now()}`);
    const s = loadLearnedSet();
    assert(s instanceof Set, `expected Set, got ${s?.constructor?.name}`);
    assert.equal(s.size, 2, `expected 2 unique entries, got ${s.size}`);
    assert(s.has('cmd alpha'));
    assert(s.has('cmd beta'));
    assert(!s.has('cmd gamma'));
  });

  await run('CHILLBRO_TEST_NO_LEARN=1 returns empty Set', async () => {
    process.env.CHILLBRO_TEST_NO_LEARN = '1';
    try {
      const { loadLearnedSet } = await import(`../src/lists.mjs?test=${Date.now()}`);
      const s = loadLearnedSet();
      assert(s instanceof Set);
      assert.equal(s.size, 0);
    } finally {
      delete process.env.CHILLBRO_TEST_NO_LEARN;
    }
  });

  // ──────────────────────────────────────────────────────────────────
  console.log('\n=== debug log rotation ===');

  await run('CHILLBRO_DEBUG=0: no log written (no-op)', async () => {
    if (existsSync(DEBUG_LOG)) unlinkSync(DEBUG_LOG);
    delete process.env.CHILLBRO_DEBUG;
    const { debugLog } = await import(`../src/debug.mjs?test=${Date.now()}`);
    debugLog({ test: 'noop' });
    assert(!existsSync(DEBUG_LOG), 'expected no debug.log when CHILLBRO_DEBUG unset');
  });

  await run('CHILLBRO_DEBUG=1: log written; rotation fires at MAX_BYTES', async () => {
    process.env.CHILLBRO_DEBUG = '1';
    process.env.CHILLBRO_DEBUG_MAX_BYTES = '2048'; // tiny so rotation fires fast in tests
    try {
      if (existsSync(DEBUG_LOG)) unlinkSync(DEBUG_LOG);
      for (let i = 1; i <= 3; i++) {
        const p = `${DEBUG_LOG}.${i}`;
        if (existsSync(p)) unlinkSync(p);
      }
      // Bust import cache so the new MAX_BYTES env is picked up
      const { debugLog } = await import(`../src/debug.mjs?test=${Date.now()}`);
      // Write enough to force at least one rotation (each line ~50-100 bytes)
      for (let i = 0; i < 100; i++) {
        debugLog({ i, payload: 'x'.repeat(200) });
      }
      // After many writes the active log should exist and be < MAX_BYTES
      // (because rotation moves it to .1 when it exceeds the cap)
      assert(existsSync(DEBUG_LOG), 'expected current debug.log to exist');
      const sz = statSync(DEBUG_LOG).size;
      assert(sz <= 2048 * 2, `expected current debug.log size < 2*MAX_BYTES, got ${sz}`);
      // At least one backup exists
      assert(existsSync(`${DEBUG_LOG}.1`), 'expected debug.log.1 backup to exist after rotation');
    } finally {
      delete process.env.CHILLBRO_DEBUG;
      delete process.env.CHILLBRO_DEBUG_MAX_BYTES;
    }
  });

  // ──────────────────────────────────────────────────────────────────
  console.log('\n=== bin/chillbro CLI validation ===');

  const cliPath = resolve(new URL('..', import.meta.url).pathname.replace(/\/$/, ''), 'bin/chillbro.mjs');

  function runCli(args, expectExit) {
    let out = '', err = '', status = 0;
    try {
      out = execFileSync('node', [cliPath, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      out = e.stdout?.toString() || '';
      err = e.stderr?.toString() || '';
      status = e.status ?? -1;
    }
    if (typeof expectExit === 'number') {
      assert.equal(status, expectExit, `expected exit ${expectExit}, got ${status}; stderr=${err.slice(0, 200)}`);
    }
    return { out, err, status };
  }

  await run('valid: auto-continue on phases 1-3 message "..." → exit 0', () => {
    const { status } = runCli(['auto-continue', 'on', 'phases', '1-3', 'message', 'test'], 0);
    assert.equal(status, 0);
    runCli(['auto-continue', 'off'], 0); // cleanup
  });

  await run('invalid: unknown token → exit 2 + error message', () => {
    const { err, status } = runCli(['auto-continue', 'on', 'typo', 'thingy'], 2);
    assert.equal(status, 2);
    assert(err.includes('unknown token'), `expected "unknown token" in stderr, got: ${err.slice(0, 200)}`);
  });

  await run('invalid: phases "bogus" → exit 2 + error message', () => {
    const { err, status } = runCli(['auto-continue', 'on', 'phases', 'bogus'], 2);
    assert(err.includes('invalid phases'), `expected "invalid phases" in stderr, got: ${err.slice(0, 200)}`);
  });

  await run('invalid: phases backwards "7-3" → exit 2', () => {
    const { err, status } = runCli(['auto-continue', 'on', 'phases', '7-3'], 2);
    assert(err.includes('invalid phases'));
  });

  await run('invalid: iterations 0 → exit 2', () => {
    const { err, status } = runCli(['auto-continue', 'on', 'iterations', '0'], 2);
    assert(err.includes('invalid iterations'));
  });

  await run('invalid: option without value → exit 2', () => {
    const { err, status } = runCli(['auto-continue', 'on', 'phases'], 2);
    assert(err.includes('requires a value'));
  });

  await run('status subcommand always works (exit 0)', () => {
    const { status } = runCli(['status'], 0);
    assert.equal(status, 0);
  });

  // ──────────────────────────────────────────────────────────────────
  console.log('\n=== stdin read timeout ===');

  await run('readStdinSafe throws on idle stdin within timeout', async () => {
    // Use `sleep 2` producer that holds stdin open without writing — simulates
    // a stuck Claude Code that opens our hook's stdin then crashes.
    const { spawn } = await import('node:child_process');
    const repoRoot = resolve(new URL('..', import.meta.url).pathname.replace(/\/$/, ''));
    const stdinPath = join(repoRoot, 'src/stdinSafe.mjs');
    // Minimal inline probe: import readStdinSafe and call with 300ms cap.
    const probe = [
      `import { readStdinSafe } from ${JSON.stringify(stdinPath)};`,
      `try { await readStdinSafe(300); process.stdout.write('NO_TIMEOUT'); }`,
      `catch (e) { process.stdout.write('TIMED_OUT:' + e.message); }`,
    ].join(' ');
    const p = spawn('sh', ['-c', `sleep 2 | node --input-type=module -e ${JSON.stringify(probe)}`], {
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', c => out += c);
    await new Promise(r => p.on('exit', r));
    assert(out.startsWith('TIMED_OUT'), `expected timeout, got: ${out}`);
  });

  // ──────────────────────────────────────────────────────────────────
  console.log('\n=== learn CLI + audit log ===');

  await run('chillbro learn add → writes to learned-allow + audit log', () => {
    if (existsSync(LEARNED_FILE)) unlinkSync(LEARNED_FILE);
    const auditLog = join(STATE_DIR, 'learned-allow.log');
    if (existsSync(auditLog)) unlinkSync(auditLog);
    const { out, status } = runCli(['learn', 'add', 'my-cli-test --flag'], 0);
    assert(out.includes('promoted'));
    assert(existsSync(LEARNED_FILE));
    const learned = readFileSync(LEARNED_FILE, 'utf8');
    assert(learned.includes('my-cli-test'));
    // Audit log entry exists with source=manual
    assert(existsSync(auditLog));
    const audit = readFileSync(auditLog, 'utf8');
    assert(/\tmanual\t/.test(audit), `expected manual source in audit: ${audit}`);
  });

  await run('chillbro learn add (same cmd twice) reports "already in"', () => {
    const { out } = runCli(['learn', 'add', 'my-cli-test --flag'], 0);
    assert(/already/.test(out), `expected "already" msg, got: ${out}`);
  });

  await run('chillbro learn list shows the added entry', () => {
    const { out } = runCli(['learn', 'list'], 0);
    assert(out.includes('my-cli-test'));
  });

  await run('chillbro learn audit shows the manual entry', () => {
    const { out } = runCli(['learn', 'audit'], 0);
    assert(/\[manual\]/.test(out));
    assert(out.includes('my-cli-test'));
  });

  await run('chillbro learn forget removes from learned-allow + writes "forgotten" audit', () => {
    const { out, status } = runCli(['learn', 'forget', 'my-cli-test --flag'], 0);
    assert(/removed/.test(out));
    const learned = readFileSync(LEARNED_FILE, 'utf8');
    assert(!learned.includes('my-cli-test'));
    const audit = readFileSync(join(STATE_DIR, 'learned-allow.log'), 'utf8');
    assert(/\tforgotten\t/.test(audit), `expected forgotten source in audit: ${audit}`);
  });

  await run('chillbro learn forget unknown command → exit 2', () => {
    const { status } = runCli(['learn', 'forget', 'nonexistent-cmd'], 2);
    assert.equal(status, 2);
  });

  await run('chillbro learn audit-path prints the log path', () => {
    const { out } = runCli(['learn', 'audit-path'], 0);
    assert(out.trim().endsWith('learned-allow.log'));
  });

  await run('atomicBumpAndPromote writes "auto" audit line on promotion', async () => {
    if (existsSync(LEARNED_FILE)) unlinkSync(LEARNED_FILE);
    if (existsSync(join(STATE_DIR, 'learned-allow.log'))) unlinkSync(join(STATE_DIR, 'learned-allow.log'));
    if (existsSync(join(STATE_DIR, 'counters.json'))) unlinkSync(join(STATE_DIR, 'counters.json'));
    const { atomicBumpAndPromote } = await import(`../src/state.mjs?audit=${Date.now()}`);
    atomicBumpAndPromote('audit-test-cmd', 2);
    atomicBumpAndPromote('audit-test-cmd', 2); // promotes
    const audit = readFileSync(join(STATE_DIR, 'learned-allow.log'), 'utf8');
    assert(/\tauto\t/.test(audit), `expected auto source in audit: ${audit}`);
    assert(audit.includes('audit-test-cmd'));
  });
} finally {
  // Restore real state.
  if (savedCounters !== null) writeFileSync(COUNTER_FILE, savedCounters);
  else if (existsSync(COUNTER_FILE)) unlinkSync(COUNTER_FILE);
  if (savedLearned !== null) writeFileSync(LEARNED_FILE, savedLearned);
  else if (existsSync(LEARNED_FILE)) unlinkSync(LEARNED_FILE);
  if (savedDebug !== null) writeFileSync(DEBUG_LOG, savedDebug);
  else if (existsSync(DEBUG_LOG)) unlinkSync(DEBUG_LOG);
  // Clean up rotated backups created by the test
  for (let i = 1; i <= 3; i++) {
    const p = `${DEBUG_LOG}.${i}`;
    try { if (existsSync(p)) unlinkSync(p); } catch {}
  }
  // Clean up corrupted-state files left behind by earlier tests
  try {
    const { readdirSync } = await import('node:fs');
    for (const f of readdirSync(STATE_DIR)) {
      if (f.startsWith('counters.json.corrupt.')) {
        try { unlinkSync(join(STATE_DIR, f)); } catch {}
      }
    }
  } catch {}
}

console.log(`\n${pass} passed, ${fail} failed (of ${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
