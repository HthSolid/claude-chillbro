#!/usr/bin/env node
// PostToolUse hook for Bash. If a command ran (regardless of how it was permitted)
// and wasn't already on the static allow list, count it. After 2 successful runs
// of the same normalized form, promote to learned-allow.
//
// Failsafe contract identical to pretool.mjs (CHILLBRO_DISABLED, RECURSION_GUARD,
// swallow-and-continue on errors).

import { classifyStatic } from '../src/classify.mjs';
import { normalize } from '../src/normalize.mjs';
import { atomicBumpAndPromote, loadLearned } from '../src/state.mjs';
import { splitCommand } from '../src/splitter.mjs';
import { readStdinSafe } from '../src/stdinSafe.mjs';

const PROMOTION_THRESHOLD = 2;

// Helper: any throw in a state operation degrades silently (we'd rather lose
// a learning increment than have posttool fail and spam stderr).
function safeBumpAndPromote(norm) {
  try {
    const { promoted } = atomicBumpAndPromote(norm, PROMOTION_THRESHOLD);
    if (promoted) process.stderr.write(`[chillbro] learned auto-allow: ${norm}\n`);
  } catch (err) {
    process.stderr.write(`[chillbro] posttool state error for "${norm}": ${err.message}\n`);
  }
}

try {
  if (process.env.CHILLBRO_DISABLED === '1') process.exit(0);
  if (process.env.CHILLBRO_RECURSION_GUARD === '1') process.exit(0);

  const raw = await readStdinSafe();
  if (!raw.trim()) process.exit(0);
  const evt = JSON.parse(raw);

  if (evt.tool_name !== 'Bash') process.exit(0);

  const cmd = evt.tool_input?.command;
  if (typeof cmd !== 'string' || !cmd.trim()) process.exit(0);

  // Only learn commands that the static pipeline did NOT already classify.
  // Static-allow and static-ask are deterministic — no need to learn them.
  // We deliberately skip the LLM waterfall here (sync classifyStatic only) to
  // keep PostToolUse fast; if the static layer doesn't know, the user must
  // have approved manually for execution to have happened.
  const cwd = evt.cwd || process.cwd();
  let source = 'unknown';
  try {
    source = classifyStatic(cmd, cwd).source;
  } catch (err) {
    process.stderr.write(`[chillbro] posttool classify error: ${err.message}\n`);
    process.exit(0);
  }
  if (source !== 'unknown') process.exit(0);

  // Only count if the command actually executed without error.
  const exitCode = evt.tool_response?.exit_code ?? evt.tool_response?.exitCode;
  if (exitCode !== undefined && exitCode !== 0) process.exit(0);

  // Per-segment learning (so a compound `cmd1 && cmd2` teaches both).
  const segs = splitCommand(cmd) || [cmd];
  let already = [];
  try { already = loadLearned(); } catch { /* corrupt or missing -> start fresh */ }
  for (const seg of segs) {
    let norm;
    try { norm = normalize(seg); } catch { continue; }
    if (already.includes(norm)) continue;
    safeBumpAndPromote(norm);
  }
} catch (err) {
  process.stderr.write(`[chillbro] posttool error: ${err.message}\n`);
}
