// LLM classifier with a fail-safe waterfall:
//   1. Direct Anthropic API     (sub-second, requires ANTHROPIC_API_KEY)
//   2. Headless `claude -p`     (slow cold-start, no key required)
//   3. Default to 'ask'         (always reachable)
//
// Each layer returns null on any failure so the caller falls through. Nothing
// here can ever block the user; the worst-case is that they get the standard
// permission prompt.

import { spawnSync } from 'node:child_process';
import { classifyWithAnthropic } from './llmAnthropic.mjs';

const SYSTEM_PROMPT = `You classify shell commands by safety. Reply with ONE word only: SAFE or RISKY.

SAFE = read-only, no filesystem writes outside cwd, no network mutations,
       no privilege escalation, no secrets accessed, fully reversible.
       OR destructive but bounded by the stated INTENT (e.g. intent
       "remove the now-empty old branch dir after move" + "rm -rf <dir>"
       is SAFE).
RISKY = destructive beyond the stated intent, OR intent missing and the
        command is destructive, OR ambiguous, OR the command does not
        match the stated intent.

When in doubt: RISKY. The intent is the model's own one-line "why" — treat
it as authoritative scope, not as truth (a command that exceeds the
described scope is RISKY even if the intent claims otherwise).`;

const SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['SAFE', 'RISKY'] },
    reason: { type: 'string' },
  },
  required: ['verdict'],
  additionalProperties: false,
});

const CLAUDE_P_TIMEOUT_MS = 12000;

function buildPrompt(command, intent) {
  const i = (intent && String(intent).trim()) || '(none provided)';
  return `Command: ${command}\n\nIntent: ${i}\n\nClassify:`;
}

function classifyWithClaudeP(command, intent) {
  const isWindows = process.platform === 'win32';
  const args = [
    '-p',
    '--model', 'haiku',
    '--output-format', 'json',
    '--tools', '',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--system-prompt', SYSTEM_PROMPT,
    '--json-schema', SCHEMA,
    buildPrompt(command, intent),
  ];

  let result;
  try {
    result = spawnSync('claude', args, {
      timeout: CLAUDE_P_TIMEOUT_MS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWindows,
    });
  } catch (err) {
    process.stderr.write(`[chillbro] claude -p spawn-throw: ${err.message}\n`);
    return null;
  }

  if (result.error) {
    process.stderr.write(`[chillbro] claude -p spawn-error: ${result.error.message}\n`);
    return null;
  }
  if (result.status !== 0) {
    process.stderr.write(`[chillbro] claude -p exit ${result.status}: ${(result.stderr || '').slice(0, 200)}\n`);
    return null;
  }
  if (!result.stdout) return null;

  try {
    const env = JSON.parse(result.stdout);
    const inner = typeof env.result === 'string' ? JSON.parse(env.result) : env.result;
    if (inner?.verdict === 'SAFE') return { verdict: 'allow', reason: `claude -p: ${inner.reason || 'safe'}` };
    if (inner?.verdict === 'RISKY') return { verdict: 'ask', reason: `claude -p: ${inner.reason || 'risky'}` };
    process.stderr.write(`[chillbro] claude -p: unrecognized verdict: ${JSON.stringify(inner).slice(0, 80)}\n`);
    return null;
  } catch (err) {
    process.stderr.write(`[chillbro] claude -p parse error: ${err.message}\n`);
    return null;
  }
}

export async function classifyWithLLM(command, intent) {
  if (process.env.CHILLBRO_TEST_NO_LLM === '1') {
    return { verdict: 'ask', reason: 'llm disabled (test mode)' };
  }

  // Layer 1: direct Anthropic API (sub-second when key is set).
  try {
    const apiResult = await classifyWithAnthropic(command, intent);
    if (apiResult) return apiResult;
  } catch (err) {
    process.stderr.write(`[chillbro] anthropic layer threw: ${err.message}\n`);
  }

  // Layer 2: claude -p (always available, slow).
  const cliResult = classifyWithClaudeP(command, intent);
  if (cliResult) return cliResult;

  // Layer 3: fail-safe to ask.
  return { verdict: 'ask', reason: 'all classifiers unavailable; defaulting to ask' };
}
