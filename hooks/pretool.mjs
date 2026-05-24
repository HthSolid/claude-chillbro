#!/usr/bin/env node
// PreToolUse hook for Bash. Reads the hook event JSON from stdin, classifies the
// command, writes a Claude Code permission decision to stdout.
//
// Output schema (Claude Code hook protocol):
//   { hookSpecificOutput: { hookEventName, permissionDecision, permissionDecisionReason } }
//
// Failsafe contract:
//   - CHILLBRO_DISABLED=1     → exit 0 silently, default flow takes over.
//   - CHILLBRO_RECURSION_GUARD → set when chillbro spawns claude -p; if seen
//                                here it means we're inside the nested process
//                                and must not run (would loop).
//   - Any thrown error        → log to stderr, exit 0 (no decision emitted),
//                                default flow takes over. Never block the user.

import { classify as classifyBash } from '../src/classify.mjs';
import { classifyWrite } from '../src/classifyWrite.mjs';
import { classifyRead } from '../src/classifyRead.mjs';
import { classifyMcp } from '../src/classifyMcp.mjs';
import { readStdinSafe } from '../src/stdinSafe.mjs';

function emit(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: `chillbro: ${reason}`,
    },
  }));
}

async function dispatch(evt) {
  const cwd = evt.cwd || process.cwd();
  const name = evt.tool_name;

  if (typeof name === 'string' && name.startsWith('mcp__')) {
    return classifyMcp(name);
  }

  switch (name) {
    case 'Bash': {
      const cmd = evt.tool_input?.command;
      if (typeof cmd !== 'string' || !cmd.trim()) return null;
      // The model's own one-line "why I'm running this." Used to scope-bound
      // the LLM verdict for ambiguous commands. Optional and may be missing.
      const intent = evt.tool_input?.description;
      return await classifyBash(cmd, cwd, intent);
    }
    case 'Read': {
      const filePath = evt.tool_input?.file_path;
      return classifyRead(filePath, cwd);
    }
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const filePath = evt.tool_input?.file_path || evt.tool_input?.notebook_path;
      return classifyWrite(filePath, cwd);
    }
    default:
      return null;
  }
}

try {
  // Killswitch: emergency disable without uninstalling the plugin.
  if (process.env.CHILLBRO_DISABLED === '1') process.exit(0);

  // Recursion guard: when chillbro itself spawns `claude -p` for LLM
  // classification, that nested Claude Code process must not re-trigger
  // chillbro's hook (which would call claude -p again, ad infinitum). The
  // llmFallback.mjs sets this env var on the spawned subprocess; if we see
  // it here, we are the nested process and must no-op.
  if (process.env.CHILLBRO_RECURSION_GUARD === '1') process.exit(0);

  const raw = await readStdinSafe();
  if (!raw.trim()) process.exit(0);
  const evt = JSON.parse(raw);

  const result = await dispatch(evt);
  if (!result) process.exit(0);

  // Only emit when we want to short-circuit Claude Code's default flow.
  // 'allow' → skip the prompt. 'ask' → exit silently, default flow runs.
  if (result.decision === 'allow') {
    emit('allow', `${result.source}: ${result.reason}`);
  }
} catch (err) {
  // Never block the user on a hook bug. Fail open to default flow.
  process.stderr.write(`[chillbro] pretool error: ${err.message}\n`);
}
