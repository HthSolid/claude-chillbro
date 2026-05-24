#!/usr/bin/env node
// Tests for the versioned pattern catalog (patterns/) + user-local override files.
//
// Verifies:
//   - patterns/ is the active source of truth
//   - patternsMeta() reads META.json
//   - patternCounts() returns core + user split correctly
//   - User-local user-allow.list extends the core allow list
//   - User-local user-ask.list extends the core ask list
//   - User patterns CANNOT override an ASK match (safety invariant)
//   - CLI: chillbro patterns status / add-allow / add-ask all work
//   - Invalid regex in user file is logged + skipped, doesn't crash

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const STATE_DIR = join(homedir(), '.claude-chillbro');
const USER_ALLOW = join(STATE_DIR, 'user-allow.list');
const USER_ASK = join(STATE_DIR, 'user-ask.list');

const savedAllow = existsSync(USER_ALLOW) ? readFileSync(USER_ALLOW) : null;
const savedAsk   = existsSync(USER_ASK)   ? readFileSync(USER_ASK)   : null;

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ok    ${label}`); }
function bad(label, err) { fail++; console.error(`  FAIL  ${label}\n        ${err.message}`); }
async function run(label, fn) {
  try { await fn(); ok(label); }
  catch (err) { bad(label, err); }
}

try {
  // Clean slate
  if (existsSync(USER_ALLOW)) unlinkSync(USER_ALLOW);
  if (existsSync(USER_ASK))   unlinkSync(USER_ASK);
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

  console.log('=== patterns metadata + counts ===');

  await run('patternsMeta() reads META.json', async () => {
    const { patternsMeta } = await import(`../src/lists.mjs?t=${Date.now()}`);
    const m = patternsMeta();
    assert(m, 'meta should not be null');
    assert.equal(m.schema_version, 1);
    assert(/^\d+\.\d+\.\d+/.test(m.patterns_version), `expected semver, got: ${m.patterns_version}`);
    assert(Array.isArray(m.categories_in_allow));
    assert(Array.isArray(m.categories_in_ask));
  });

  await run('patternCounts() reports core counts; user counts = 0 when no user files', async () => {
    const { patternCounts } = await import(`../src/lists.mjs?t=${Date.now()}`);
    const c = patternCounts();
    assert(c.allow_core > 100, `expected >100 core allow patterns, got ${c.allow_core}`);
    assert(c.ask_core > 50,    `expected >50 core ask patterns, got ${c.ask_core}`);
    assert.equal(c.allow_user, 0);
    assert.equal(c.ask_user, 0);
  });

  // ──────────────────────────────────────────────────────────────────
  console.log('\n=== user-local overrides ===');

  await run('user-allow.list extends ALLOW (extra pattern matches)', async () => {
    writeFileSync(USER_ALLOW, '^my-internal-cli\\s+(status|list)(\\s|$)\n');
    const { classifyStatic } = await import(`../src/classify.mjs?t=${Date.now()}`);
    process.env.CHILLBRO_TEST_NO_LEARN = '1';
    try {
      const r = classifyStatic('my-internal-cli status', process.cwd());
      assert.equal(r.decision, 'allow', `expected allow, got ${r.decision} (source=${r.source})`);
    } finally {
      delete process.env.CHILLBRO_TEST_NO_LEARN;
    }
  });

  await run('user-ask.list extends ASK (count + classify via subprocess)', async () => {
    writeFileSync(USER_ASK, '^my-deploy\\s+--prod\\b\n');
    // Verify count via fresh patternCounts() call (re-reads from disk).
    const { patternCounts } = await import(`../src/lists.mjs?t=${Date.now()}`);
    const c = patternCounts();
    assert.equal(c.ask_user, 1, `expected 1 user-ask pattern, got ${c.ask_user}`);
    // Verify end-to-end classify via a fresh subprocess (module-level ASK is
    // cached at first import; in-process re-import is insufficient).
    const repoRoot = resolve(new URL('..', import.meta.url).pathname.replace(/\/$/, ''));
    const classifyPath = join(repoRoot, 'src/classify.mjs');
    const probeScript = [
      "process.env.CHILLBRO_TEST_NO_LEARN='1';",
      "const { classifyStatic } = await import(process.argv[1]);",
      "const r = classifyStatic('my-deploy --prod release-1.2', process.cwd());",
      "process.stdout.write(JSON.stringify(r));",
    ].join('\n');
    const out = execFileSync('node', ['--input-type=module', '-e', probeScript, classifyPath], { encoding: 'utf8' });
    const r = JSON.parse(out);
    assert.equal(r.decision, 'ask', `expected ask via subprocess, got ${r.decision} (source=${r.source})`);
    assert.equal(r.source, 'static-ask');
  });

  await run('SAFETY: user-allow CANNOT override a static-ASK match', async () => {
    // Attempt to allow rm -rf via user-allow. The static ASK list catches it first.
    writeFileSync(USER_ALLOW, '^rm\\s+-rf(\\s|$)\n');
    const { classifyStatic } = await import(`../src/classify.mjs?t=${Date.now()}`);
    process.env.CHILLBRO_TEST_NO_LEARN = '1';
    try {
      const r = classifyStatic('rm -rf /tmp/foo', process.cwd());
      assert.equal(r.decision, 'ask', `SAFETY: user-allow should not bypass static-ASK; got ${r.decision} (source=${r.source})`);
      assert.equal(r.source, 'static-ask');
    } finally {
      delete process.env.CHILLBRO_TEST_NO_LEARN;
      unlinkSync(USER_ALLOW);
    }
  });

  await run('invalid regex in user-allow.list is logged + skipped, others still load', async () => {
    writeFileSync(USER_ALLOW, '^valid-cmd\\b\n((((not-a-regex\n^another-valid\\b\n');
    // Module-load-time stderr is harder to capture; just verify two valid load
    const { patternCounts } = await import(`../src/lists.mjs?t=${Date.now()}`);
    const c = patternCounts();
    assert.equal(c.allow_user, 2, `expected 2 valid user-allow patterns, got ${c.allow_user}`);
  });

  await run('comments and blank lines in user file are ignored', async () => {
    writeFileSync(USER_ALLOW, '# my notes\n\n^only-this-cmd\\b\n\n# trailing comment\n');
    const { patternCounts } = await import(`../src/lists.mjs?t=${Date.now()}`);
    const c = patternCounts();
    assert.equal(c.allow_user, 1);
  });

  // ──────────────────────────────────────────────────────────────────
  console.log('\n=== bin/chillbro patterns CLI ===');

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

  await run('chillbro patterns status: prints version + counts', () => {
    if (existsSync(USER_ALLOW)) unlinkSync(USER_ALLOW);
    if (existsSync(USER_ASK))   unlinkSync(USER_ASK);
    const { out } = runCli(['patterns', 'status'], 0);
    assert(/catalog:\s+v\d+\.\d+\.\d+/.test(out), `expected version line in: ${out.slice(0, 200)}`);
    assert(/allow \(core\):\s+\d+/.test(out));
    assert(/ask\s+\(core\):\s+\d+/.test(out));
  });

  await run('chillbro patterns add-allow: appends + dedup on second add', () => {
    if (existsSync(USER_ALLOW)) unlinkSync(USER_ALLOW);
    const r1 = runCli(['patterns', 'add-allow', '^new-tool\\s+--list'], 0);
    assert(existsSync(USER_ALLOW));
    const content = readFileSync(USER_ALLOW, 'utf8');
    assert(content.includes('^new-tool\\s+--list'));
    // Add same pattern again — should be deduped
    const r2 = runCli(['patterns', 'add-allow', '^new-tool\\s+--list'], 0);
    assert(/already.*skipped/.test(r2.out), `expected dedup message in: ${r2.out.slice(0, 200)}`);
    // Should still have only ONE line for the pattern
    const lines = readFileSync(USER_ALLOW, 'utf8').split('\n').filter(l => l.trim() === '^new-tool\\s+--list');
    assert.equal(lines.length, 1);
  });

  await run('chillbro patterns add-ask: writes to user-ask.list', () => {
    if (existsSync(USER_ASK)) unlinkSync(USER_ASK);
    runCli(['patterns', 'add-ask', '^company-deploy\\b'], 0);
    assert(existsSync(USER_ASK));
    assert(readFileSync(USER_ASK, 'utf8').includes('^company-deploy\\b'));
  });

  await run('chillbro patterns add-allow rejects invalid regex with exit 2', () => {
    const { status, err } = runCli(['patterns', 'add-allow', '((unbalanced'], 2);
    assert.equal(status, 2);
    assert(/invalid regex/.test(err), `expected "invalid regex" in: ${err}`);
  });

  await run('chillbro patterns add-allow rejects empty pattern with exit 2', () => {
    const { status, err } = runCli(['patterns', 'add-allow', '   '], 2);
    assert.equal(status, 2);
  });

  await run('chillbro patterns list: dumps allow + ask + user files', () => {
    writeFileSync(USER_ALLOW, '^user-allow-marker\\b\n');
    const { out, status } = runCli(['patterns', 'list'], 0);
    assert(out.includes('=== patterns/allow.list ==='));
    assert(out.includes('=== patterns/ask.list ==='));
    assert(out.includes('user-allow.list'));
    assert(out.includes('^user-allow-marker\\b'));
  });

  await run('chillbro patterns edit-allow: prints the user-allow.list path', () => {
    const { out, status } = runCli(['patterns', 'edit-allow'], 0);
    assert(out.trim().endsWith('user-allow.list'));
  });

  await run('chillbro patterns: unknown subcommand → exit 2', () => {
    const { status } = runCli(['patterns', 'bogus'], 2);
    assert.equal(status, 2);
  });
} finally {
  if (savedAllow !== null) writeFileSync(USER_ALLOW, savedAllow);
  else if (existsSync(USER_ALLOW)) unlinkSync(USER_ALLOW);
  if (savedAsk !== null) writeFileSync(USER_ASK, savedAsk);
  else if (existsSync(USER_ASK)) unlinkSync(USER_ASK);
}

console.log(`\n${pass} passed, ${fail} failed (of ${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
