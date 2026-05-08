// Last-resort classifier: spawn `claude -p` to decide on commands that didn't
// match the static lists or learned state. Uses the user's existing Claude Code
// auth (OAuth/keychain), no API key required.
//
// On any failure (timeout, non-zero exit, parse error) → returns 'ask' (fail-safe).

import { spawnSync } from 'node:child_process';

const SYSTEM_PROMPT = `You classify shell commands by safety. Reply with ONE word only.

SAFE = read-only, no filesystem writes outside cwd, no network mutations, no privilege escalation, fully reversible, no secrets accessed.
RISKY = anything destructive, irreversible, network-mutating, privilege-elevating, secret-touching, OR ambiguous.

When in doubt: RISKY.`;

const SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['SAFE', 'RISKY'] },
    reason: { type: 'string' },
  },
  required: ['verdict'],
  additionalProperties: false,
});

const TIMEOUT_MS = 6000;

export function classifyWithLLM(command) {
  if (process.env.CHILLBRO_TEST_NO_LLM === '1') {
    return { verdict: 'ask', reason: 'llm disabled (test mode)' };
  }

  const prompt = `Classify this command:\n\n${command}`;

  const result = spawnSync('claude', [
    '-p',
    '--model', 'haiku',
    '--output-format', 'json',
    '--tools', '',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--system-prompt', SYSTEM_PROMPT,
    '--json-schema', SCHEMA,
    prompt,
  ], {
    timeout: TIMEOUT_MS,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error || result.status !== 0 || !result.stdout) {
    return { verdict: 'ask', reason: 'classifier unavailable' };
  }

  try {
    const env = JSON.parse(result.stdout);
    const inner = typeof env.result === 'string' ? JSON.parse(env.result) : env.result;
    if (inner?.verdict === 'SAFE') return { verdict: 'allow', reason: inner.reason || 'classified safe' };
    return { verdict: 'ask', reason: inner?.reason || 'classified risky' };
  } catch {
    return { verdict: 'ask', reason: 'classifier parse error' };
  }
}
