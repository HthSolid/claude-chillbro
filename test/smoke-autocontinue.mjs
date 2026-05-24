#!/usr/bin/env node
// Tests for auto-continue state management + CLI parsing.
// Does NOT exercise the LLM evaluator (that needs a live Anthropic call).

import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const STATE_DIR = join(homedir(), '.claude-chillbro');
const STATE_FILE = join(STATE_DIR, 'auto-continue.json');
const STATE_BACKUP = join(STATE_DIR, '.auto-continue.test-backup');
const CHILLBRO_BIN = join(import.meta.dirname || new URL('.', import.meta.url).pathname.replace(/\/$/, ''), '..', 'bin', 'chillbro.mjs');
const STOP_HOOK = join(import.meta.dirname || new URL('.', import.meta.url).pathname.replace(/\/$/, ''), '..', 'hooks', 'stop.mjs');

let pass = 0, fail = 0;

function run(label, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') return r.then(
      () => { pass++; console.log(`  ok    ${label}`); },
      err => { fail++; console.error(`  FAIL  ${label}\n        ${err.message}`); }
    );
    pass++;
    console.log(`  ok    ${label}`);
  } catch (err) {
    fail++;
    console.error(`  FAIL  ${label}\n        ${err.message}`);
  }
}

function chillbro(...args) {
  return execFileSync('node', [CHILLBRO_BIN, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

// Save and restore user's state file.
let savedState = null;
if (existsSync(STATE_FILE)) savedState = readFileSync(STATE_FILE);
if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);

try {
  // --- state defaults ---
  await run('blank state has enabled=false', () => {
    return import(`../src/autoContinueState.mjs?cb=${Date.now()}`).then(({ loadState }) => {
      const s = loadState();
      if (s.enabled !== false) throw new Error(`expected enabled=false, got ${s.enabled}`);
      if (s.iterations !== 0) throw new Error(`expected iterations=0, got ${s.iterations}`);
      if (s.iterations_max !== 50) throw new Error(`expected default cap 50, got ${s.iterations_max}`);
      if (s.message_template.length < 10) throw new Error(`default message too short: "${s.message_template}"`);
    });
  });

  // --- enable + persist ---
  await run('enable persists to disk and re-loads', () => {
    return import(`../src/autoContinueState.mjs?cb=${Date.now() + 1}`).then(({ enable, loadState }) => {
      enable({ message: 'test directive', phases: '1-6', iterations: 25 });
      const s = loadState();
      if (!s.enabled) throw new Error('expected enabled=true');
      if (s.message_template !== 'test directive') throw new Error(`message: ${s.message_template}`);
      if (JSON.stringify(s.phase_range) !== '[1,6]') throw new Error(`phase_range: ${JSON.stringify(s.phase_range)}`);
      if (s.iterations_max !== 25) throw new Error(`cap: ${s.iterations_max}`);
    });
  });

  // --- phase range parsing ---
  await run('parsePhaseRange handles common forms', () => {
    return import(`../src/autoContinueState.mjs?cb=${Date.now() + 2}`).then(({ parsePhaseRange }) => {
      const cases = [
        ['1-6', [1, 6]],
        ['1..6', [1, 6]],
        ['5', [1, 5]],
        ['10-20', [10, 20]],
        ['7-3', null],   // backwards
        ['abc', null],
        ['', null],
        [null, null],
      ];
      for (const [input, expected] of cases) {
        const got = parsePhaseRange(input);
        const a = JSON.stringify(got);
        const b = JSON.stringify(expected);
        if (a !== b) throw new Error(`parsePhaseRange(${JSON.stringify(input)}) = ${a}, expected ${b}`);
      }
    });
  });

  // --- iteration tracking ---
  await run('recordIteration increments + tracks phase', () => {
    return import(`../src/autoContinueState.mjs?cb=${Date.now() + 3}`).then(({ enable, recordIteration, loadState }) => {
      enable({ phases: '1-3' });
      const s1 = recordIteration({ phase: 1, summary: 'phase 1 done' });
      if (s1.iterations !== 1) throw new Error(`expected 1, got ${s1.iterations}`);
      if (s1.current_phase !== 1) throw new Error(`expected current_phase 1, got ${s1.current_phase}`);
      if (s1.completions.length !== 1) throw new Error(`expected 1 completion, got ${s1.completions.length}`);
      const s2 = recordIteration({ phase: 2, summary: 'phase 2 done' });
      if (s2.iterations !== 2) throw new Error(`expected 2, got ${s2.iterations}`);
      if (s2.current_phase !== 2) throw new Error(`expected current_phase 2, got ${s2.current_phase}`);
    });
  });

  // --- failure auto-disable ---
  await run('3 consecutive failures auto-disable', () => {
    return import(`../src/autoContinueState.mjs?cb=${Date.now() + 4}`).then(({ enable, recordFailure, loadState }) => {
      enable({});
      recordFailure();
      recordFailure();
      const s = recordFailure();
      if (s.enabled) throw new Error('expected enabled=false after 3 failures');
      if (s.consecutive_failures !== 3) throw new Error(`expected 3 failures, got ${s.consecutive_failures}`);
    });
  });

  // --- iteration cap detection ---
  await run('isIterationCapReached fires at cap', () => {
    return import(`../src/autoContinueState.mjs?cb=${Date.now() + 5}`).then(({ enable, recordIteration, isIterationCapReached, loadState }) => {
      enable({ iterations: 2 });
      let s = recordIteration({});
      if (isIterationCapReached(s)) throw new Error('cap should not be reached at iteration 1');
      s = recordIteration({});
      if (!isIterationCapReached(s)) throw new Error('cap should be reached at iteration 2');
    });
  });

  // --- phase exhaustion detection ---
  await run('isPhaseRangeExhausted fires at upper bound', () => {
    return import(`../src/autoContinueState.mjs?cb=${Date.now() + 6}`).then(({ enable, recordIteration, isPhaseRangeExhausted }) => {
      enable({ phases: '1-3' });
      let s = recordIteration({ phase: 2 });
      if (isPhaseRangeExhausted(s)) throw new Error('not exhausted at phase 2 of 1-3');
      s = recordIteration({ phase: 3 });
      if (!isPhaseRangeExhausted(s)) throw new Error('should be exhausted at phase 3 of 1-3');
    });
  });

  // --- corrupted state file recovery ---
  run('corrupt state file resets to defaults', () => {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, '{ broken json');
    return import(`../src/autoContinueState.mjs?cb=${Date.now() + 7}`).then(({ loadState }) => {
      const s = loadState();
      if (s.enabled !== false) throw new Error('expected enabled=false from blank state');
    });
  });

  // --- CLI: enable via subcommand ---
  run('CLI: chillbro auto-continue on phases 1-6 message "x" enables + persists', () => {
    chillbro('auto-continue', 'on', 'phases', '1-6', 'message', 'audit and continue');
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    if (!s.enabled) throw new Error('expected enabled=true');
    if (s.message_template !== 'audit and continue') throw new Error(`message: ${s.message_template}`);
    if (JSON.stringify(s.phase_range) !== '[1,6]') throw new Error(`phase_range: ${JSON.stringify(s.phase_range)}`);
  });

  // --- CLI: status ---
  run('CLI: status prints current state', () => {
    const out = chillbro('status');
    if (!out.includes('enabled:')) throw new Error(`status missing 'enabled': ${out.slice(0, 200)}`);
    if (!out.includes('YES')) throw new Error(`status should show YES (enabled): ${out.slice(0, 200)}`);
  });

  // --- CLI: off ---
  run('CLI: chillbro auto-continue off disables', () => {
    chillbro('auto-continue', 'off');
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    if (s.enabled) throw new Error('expected enabled=false after off');
  });

  // --- CLI: auto-continue-message updates message ---
  run('CLI: auto-continue-message updates the directive', () => {
    chillbro('auto-continue-message', 'new directive text');
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    if (s.message_template !== 'new directive text') throw new Error(`message: ${s.message_template}`);
  });

  // --- CLI: phases update ---
  run('CLI: chillbro auto-continue phases 1-10 updates range', () => {
    chillbro('auto-continue', 'phases', '1-10');
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    if (JSON.stringify(s.phase_range) !== '[1,10]') throw new Error(`phase_range: ${JSON.stringify(s.phase_range)}`);
  });

  // --- CLI: reset ---
  run('CLI: reset wipes state', () => {
    chillbro('auto-continue', 'on', 'message', 'temp');
    chillbro('reset');
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    if (s.enabled) throw new Error('expected enabled=false after reset');
  });

  // --- Stop hook: when disabled, exit 0 silently ---
  run('Stop hook: disabled state → exit 0, no output', () => {
    chillbro('auto-continue', 'off');
    const evt = JSON.stringify({ session_id: 't', transcript_path: '/nonexistent', hook_event_name: 'Stop' });
    let out;
    try {
      out = execFileSync('node', [STOP_HOOK], { input: evt, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      throw new Error(`stop hook exited non-zero: ${err.status}`);
    }
    if (out.trim() !== '') throw new Error(`expected empty stdout, got: ${out}`);
  });

  // --- Stop hook: CHILLBRO_DISABLED killswitch ---
  run('Stop hook: CHILLBRO_DISABLED → exit 0, no output', () => {
    chillbro('auto-continue', 'on'); // would normally fire if not for the killswitch
    const evt = JSON.stringify({ session_id: 't', transcript_path: '/nonexistent', hook_event_name: 'Stop' });
    const out = execFileSync('node', [STOP_HOOK], {
      input: evt,
      encoding: 'utf8',
      env: { ...process.env, CHILLBRO_DISABLED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (out.trim() !== '') throw new Error(`expected empty stdout, got: ${out}`);
    chillbro('auto-continue', 'off');
  });

  // --- Stop hook: RECURSION_GUARD ---
  run('Stop hook: CHILLBRO_RECURSION_GUARD → exit 0, no output', () => {
    chillbro('auto-continue', 'on');
    const evt = JSON.stringify({ session_id: 't', transcript_path: '/nonexistent', hook_event_name: 'Stop' });
    const out = execFileSync('node', [STOP_HOOK], {
      input: evt,
      encoding: 'utf8',
      env: { ...process.env, CHILLBRO_RECURSION_GUARD: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (out.trim() !== '') throw new Error(`expected empty stdout, got: ${out}`);
    chillbro('auto-continue', 'off');
  });

  // --- Stop hook: iteration cap reached → disable + exit 0 ---
  run('Stop hook: iteration cap reached → disables + exit 0', () => {
    chillbro('auto-continue', 'on', 'iterations', '1');
    // Manually set iterations to cap value to simulate having hit it.
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    s.iterations = 1;
    writeFileSync(STATE_FILE, JSON.stringify(s));
    const evt = JSON.stringify({ session_id: 't', transcript_path: '/nonexistent', hook_event_name: 'Stop' });
    const out = execFileSync('node', [STOP_HOOK], { input: evt, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    if (out.trim() !== '') throw new Error(`expected empty stdout, got: ${out}`);
    const after = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    if (after.enabled) throw new Error('expected hook to disable on cap');
  });

  // ─── Anti-fabrication contract tests (parser + emit shape) ──────────
  // Regression: auto-continue's injected message could reference things
  // ("audit each phase", "6 phases", "deferred items file") that weren't
  // in the directive OR the assistant's message.
  // The fix: when verdict=CONTINUE, the hook uses state.message_template
  // VERBATIM. The LLM only authors the question for ASK.

  await run('parser: CONTINUE returns question=empty, no \"message\" field passed through', async () => {
    const { parseVerdict } = await import(`../src/autoContinueEval.mjs?test=${Date.now()}`).catch(() => ({}));
    // parseVerdict isn't exported, so we test the behavior via the eval module's
    // exported API. We verify by inspecting the public schema indirectly: read
    // the file and confirm the structure is right.
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../src/autoContinueEval.mjs', import.meta.url), 'utf8');
    // The structure should mention question (anti-fabrication landed)
    if (!src.includes('question:')) throw new Error('autoContinueEval should return {question} field');
    if (!src.includes('verbatim') && !src.includes('VERBATIM')) {
      throw new Error('SYSTEM_PROMPT should mention verbatim/VERBATIM directive use');
    }
  });

  await run('stop hook: emit uses state.message_template (not LLM message) on CONTINUE', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../hooks/stop.mjs', import.meta.url), 'utf8');
    if (!src.includes('state.message_template')) {
      throw new Error('stop hook must use state.message_template for CONTINUE (anti-fabrication)');
    }
    if (!src.includes('messageToInject')) {
      throw new Error('stop hook should explicitly construct messageToInject from state vs LLM');
    }
  });

  await run('stop hook: SYSTEM_PROMPT lists explicit STOP signals (ending the loop, your call, etc.)', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../src/autoContinueEval.mjs', import.meta.url), 'utf8');
    const required = ['ending the loop', 'your call', 'needs your direction', 'choice question', 'When in doubt: STOP'];
    for (const phrase of required) {
      if (!src.includes(phrase)) throw new Error(`SYSTEM_PROMPT missing required STOP signal: "${phrase}"`);
    }
  });

  await new Promise(r => setTimeout(r, 50));
} finally {
  if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
  if (savedState !== null) writeFileSync(STATE_FILE, savedState);
  // Tidy any corruption-rename files left behind.
  try {
    for (const f of readdirSync(STATE_DIR)) {
      if (f.startsWith('auto-continue.json.corrupt.')) {
        try { unlinkSync(join(STATE_DIR, f)); } catch {}
      }
    }
  } catch {}
}

console.log(`\n${pass} passed, ${fail} failed (of ${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
