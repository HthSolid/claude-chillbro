#!/usr/bin/env node
// PreToolUse hook for Bash. Reads the hook event JSON from stdin, classifies the
// command, writes a Claude Code permission decision to stdout.
//
// Output schema (Claude Code hook protocol):
//   { hookSpecificOutput: { hookEventName, permissionDecision, permissionDecisionReason } }

import { classify as classifyBash } from '../src/classify.mjs';
import { classifyWrite } from '../src/classifyWrite.mjs';

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function emit(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: `chillbro: ${reason}`,
    },
  }));
}

function dispatch(evt) {
  const cwd = evt.cwd || process.cwd();
  switch (evt.tool_name) {
    case 'Bash': {
      const cmd = evt.tool_input?.command;
      if (typeof cmd !== 'string' || !cmd.trim()) return null;
      return classifyBash(cmd, cwd);
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
  const raw = await readStdin();
  if (!raw.trim()) process.exit(0);
  const evt = JSON.parse(raw);

  const result = dispatch(evt);
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
