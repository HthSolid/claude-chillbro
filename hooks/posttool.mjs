#!/usr/bin/env node
// PostToolUse hook for Bash. If a command ran (regardless of how it was permitted)
// and wasn't already on the static allow list, count it. After 2 successful runs
// of the same normalized form, promote to learned-allow.

import { classify } from '../src/classify.mjs';
import { normalize } from '../src/normalize.mjs';
import { bumpCounter, appendLearned, loadLearned } from '../src/state.mjs';
import { splitCommand } from '../src/splitter.mjs';

const PROMOTION_THRESHOLD = 2;

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

try {
  const raw = await readStdin();
  if (!raw.trim()) process.exit(0);
  const evt = JSON.parse(raw);

  if (evt.tool_name !== 'Bash') process.exit(0);

  const cmd = evt.tool_input?.command;
  if (typeof cmd !== 'string' || !cmd.trim()) process.exit(0);

  // Only learn from commands the user actually approved (not ones we already
  // auto-allow via static lists — those don't need learning, and we'd just
  // spam the counter file).
  const cwd = evt.cwd || process.cwd();
  const { decision, source } = classify(cmd, cwd);
  if (source === 'static-allow' || source === 'static-ask' || source === 'splitter') process.exit(0);

  // Only count if the command actually executed without error.
  const exitCode = evt.tool_response?.exit_code ?? evt.tool_response?.exitCode;
  if (exitCode !== undefined && exitCode !== 0) process.exit(0);

  // Don't learn risky commands even if they succeeded.
  if (decision !== 'allow') process.exit(0);

  // Per-segment learning (so a compound `cmd1 && cmd2` teaches both).
  const segs = splitCommand(cmd) || [cmd];
  const already = loadLearned();
  for (const seg of segs) {
    const norm = normalize(seg);
    if (already.includes(norm)) continue;
    const count = bumpCounter(norm);
    if (count >= PROMOTION_THRESHOLD) {
      const added = appendLearned(norm);
      if (added) process.stderr.write(`[chillbro] learned auto-allow: ${norm}\n`);
    }
  }
} catch (err) {
  process.stderr.write(`[chillbro] posttool error: ${err.message}\n`);
}
