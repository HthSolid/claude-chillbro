#!/usr/bin/env node
// Tests the multi-cwd / monorepo scenario that commonly causes prompts:
// model `cd`s into a subdir via Bash, then writes a file in a SIBLING subdir
// of the same git project. Before the fix, that ASK'd because the write was
// outside cwd. After the fix, it allows because both subdirs share the same
// git root.

import { classifyWrite } from '../src/classifyWrite.mjs';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Build a synthetic git project under /tmp so we don't depend on the test
// runner's cwd having a real .git.
const ROOT = join(tmpdir(), `chillbro-multicwd-test-${process.pid}`);
const SUB_A = join(ROOT, 'subA');
const SUB_B = join(ROOT, 'subB', 'nested');
const OUTSIDE = join(tmpdir(), `chillbro-not-this-repo-${process.pid}`);

// Setup: create the synthetic git project + an outside dir
function setup() {
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
  mkdirSync(SUB_A, { recursive: true });
  mkdirSync(SUB_B, { recursive: true });
  mkdirSync(join(ROOT, '.git'), { recursive: true });  // marker only — no real git
  writeFileSync(join(ROOT, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  mkdirSync(OUTSIDE, { recursive: true });
}
function teardown() {
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
}

setup();
let pass = 0, fail = 0;
function test(label, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok    ${label}`);
  } catch (e) {
    fail++;
    console.error(`  FAIL  ${label}\n        ${e.message}`);
  }
}

try {
  // --- The exact failure mode from the user's session ---
  test('repro: cwd is deep subdir, write target is sibling subdir of the same git root → allow', () => {
    const out = classifyWrite(join(ROOT, 'subB/nested/foo.md'), SUB_A);
    if (out.decision !== 'allow') throw new Error(`expected allow, got ${out.decision} (${out.reason})`);
    if (!out.reason.includes('in-project')) throw new Error(`expected in-project reason, got: ${out.reason}`);
  });

  test('repro: cwd is git root itself → allow file anywhere in tree', () => {
    const out = classifyWrite(join(ROOT, 'subA/foo.ts'), ROOT);
    if (out.decision !== 'allow') throw new Error(`expected allow, got ${out.decision} (${out.reason})`);
  });

  test('repro: cwd is subA, write to subA → allow (the trivial case)', () => {
    const out = classifyWrite(join(SUB_A, 'bar.ts'), SUB_A);
    if (out.decision !== 'allow') throw new Error(`expected allow, got ${out.decision}`);
  });

  test('safety: write to a path OUTSIDE the git root → ASK', () => {
    const out = classifyWrite(join(OUTSIDE, 'unrelated.ts'), SUB_A);
    if (out.decision !== 'ask') throw new Error(`expected ask, got ${out.decision} (${out.reason})`);
  });

  test('safety: write to .env inside the project still ASKs (sensitive-pattern check first)', () => {
    const out = classifyWrite(join(ROOT, '.env'), SUB_A);
    if (out.decision !== 'ask') throw new Error(`expected ask for .env, got ${out.decision}`);
    if (!out.reason.includes('sensitive')) throw new Error(`expected sensitive reason, got: ${out.reason}`);
  });

  test('safety: write to subA/secrets/api.json inside project still ASKs', () => {
    const out = classifyWrite(join(SUB_A, 'secrets/api.json'), SUB_A);
    if (out.decision !== 'ask') throw new Error(`expected ask, got ${out.decision}`);
  });

  test('CLAUDE_PROJECT_DIR env var adds an in-project root', () => {
    process.env.CLAUDE_PROJECT_DIR = ROOT;
    // Use a cwd that has no .git anywhere (tmpdir typically doesn't)
    const out = classifyWrite(join(ROOT, 'subA/x.ts'), tmpdir());
    delete process.env.CLAUDE_PROJECT_DIR;
    if (out.decision !== 'allow') throw new Error(`expected allow via CLAUDE_PROJECT_DIR, got ${out.decision} (${out.reason})`);
  });

  test('user-configured write-roots.list adds roots', async () => {
    const homeDir = process.env.HOME;
    const tmpHome = join(tmpdir(), `chillbro-home-${process.pid}`);
    mkdirSync(join(tmpHome, '.claude-chillbro'), { recursive: true });
    writeFileSync(join(tmpHome, '.claude-chillbro', 'write-roots.list'), `# test\n${ROOT}\n`);
    process.env.HOME = tmpHome;
    // Re-import to pick up the new HOME
    const fresh = await import(`../src/classifyWrite.mjs?t=${Date.now()}`);
    const out = fresh.classifyWrite(join(ROOT, 'subA/x.ts'), tmpdir());
    process.env.HOME = homeDir;
    rmSync(tmpHome, { recursive: true, force: true });
    if (out.decision !== 'allow') throw new Error(`expected allow via write-roots.list, got ${out.decision} (${out.reason})`);
  });

  await new Promise(r => setTimeout(r, 50));
} finally {
  teardown();
}

console.log(`\n${pass} passed, ${fail} failed (of ${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
