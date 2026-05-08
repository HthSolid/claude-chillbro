// Last-resort classifier: spawn `claude -p` to decide on commands that didn't
// match the static lists or learned state. Uses the user's existing Claude Code
// auth (OAuth/keychain), no API key required.
//
// On any failure (timeout, non-zero exit, parse error) → returns 'ask' (fail-safe).
// Failures are logged to stderr so they show up in `claude --debug hooks`.

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

const TIMEOUT_MS = 12000;
const IS_WINDOWS = process.platform === 'win32';

function logFailure(stage, detail) {
  process.stderr.write(`[chillbro] llm classifier ${stage}: ${detail}\n`);
}

export function classifyWithLLM(command) {
  if (process.env.CHILLBRO_TEST_NO_LLM === '1') {
    return { verdict: 'ask', reason: 'llm disabled (test mode)' };
  }

  const prompt = `Classify this command:\n\n${command}`;

  // Windows ships `claude` as `claude.cmd`. Node's spawnSync without
  // shell:true does not always resolve PATHEXT, so spawn fails with ENOENT.
  // Using shell:true on Windows lets cmd.exe handle the resolution.
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
    shell: IS_WINDOWS,
    windowsHide: true,
  });

  if (result.error) {
    logFailure('spawn-error', result.error.message || String(result.error));
    return { verdict: 'ask', reason: `classifier spawn failed: ${result.error.code || 'unknown'}` };
  }
  if (result.signal) {
    logFailure('signal', `terminated by ${result.signal}`);
    return { verdict: 'ask', reason: `classifier timed out` };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').toString().trim().slice(0, 500);
    logFailure('exit-nonzero', `status=${result.status} stderr=${stderr || '(empty)'}`);
    return { verdict: 'ask', reason: `classifier exit ${result.status}` };
  }
  if (!result.stdout) {
    logFailure('empty-stdout', 'claude -p returned no stdout');
    return { verdict: 'ask', reason: 'classifier empty output' };
  }

  try {
    const env = JSON.parse(result.stdout);
    const inner = typeof env.result === 'string' ? JSON.parse(env.result) : env.result;
    if (inner?.verdict === 'SAFE') return { verdict: 'allow', reason: inner.reason || 'classified safe' };
    return { verdict: 'ask', reason: inner?.reason || 'classified risky' };
  } catch (e) {
    logFailure('parse-error', `${e.message} stdout=${result.stdout.slice(0, 300)}`);
    return { verdict: 'ask', reason: 'classifier parse error' };
  }
}
