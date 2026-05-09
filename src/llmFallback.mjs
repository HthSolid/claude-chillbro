// LLM classifier with a fail-safe waterfall:
//   1. Direct Anthropic API     (sub-second, requires ANTHROPIC_API_KEY)
//   2. Headless `claude -p`     (slow cold-start, no key required)
//   3. Default to 'ask'         (always reachable)
//
// Each layer returns null on any failure so the caller falls through. Nothing
// here can ever block the user; the worst-case is that they get the standard
// permission prompt.

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyWithAnthropic } from './llmAnthropic.mjs';

// Empty plugin directory to pass to the nested `claude -p` invocation. Without
// it, the inner Claude Code process discovers and loads ALL of the user's
// installed plugins (including chillbro itself, which would recurse, plus
// dejavu's session_start.py, etc.). With it, the inner process loads zero
// plugins and starts in ~4s instead of 12-16s.
const EMPTY_PLUGINS_DIR = join(tmpdir(), 'chillbro-empty-plugins');
try { mkdirSync(EMPTY_PLUGINS_DIR, { recursive: true }); } catch { /* tolerable */ }

const SYSTEM_PROMPT = `You classify shell commands by safety. Reply with ONE word only: SAFE or RISKY.

SAFE = read-only, no filesystem writes outside cwd, no network mutations,
       no privilege escalation, no secrets accessed, fully reversible.
       OR destructive but bounded by the stated INTENT (e.g. intent
       "remove the now-empty old branch dir after move" + "rm -rf <dir>"
       is SAFE).
RISKY = destructive beyond the stated intent, OR intent missing and the
        command is destructive, OR ambiguous, OR the command does not
        match the stated intent.

When in doubt: RISKY. The intent is the model's own one-line "why". Treat
it as authoritative scope, not as truth (a command that exceeds the
described scope is RISKY even if the intent claims otherwise).`;

// Schema deliberately omitted: forcing structured output triggers a second
// model turn (~+4s latency), and the prose parser below reliably extracts
// SAFE/RISKY from a one-word reply.

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
    // Isolation flags: skip plugin discovery (avoids recursion into chillbro
    // itself + slow startup from other plugins like dejavu), skip MCP servers,
    // skip CLAUDE.md / settings loading. Drops cold start from ~12-16s to ~4s.
    '--plugin-dir', EMPTY_PLUGINS_DIR,
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', '',
    '--system-prompt', SYSTEM_PROMPT,
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

    // Three valid response shapes from claude -p, in order of preference:
    //   1. env.structured_output.verdict — set when --json-schema is satisfied
    //      (the cleanest, most recent path)
    //   2. env.result is itself JSON with {verdict} — older shape when schema
    //      coercion put the JSON inside the result string
    //   3. env.result is prose containing "SAFE" or "RISKY" — fallback when
    //      schema enforcement isn't engaged or the model emitted prose
    const verdictFromStructured = env.structured_output?.verdict;
    if (verdictFromStructured === 'SAFE') return { verdict: 'allow', reason: 'claude -p: safe' };
    if (verdictFromStructured === 'RISKY') return { verdict: 'ask', reason: 'claude -p: risky' };

    if (typeof env.result === 'string') {
      try {
        const inner = JSON.parse(env.result);
        if (inner?.verdict === 'SAFE') return { verdict: 'allow', reason: `claude -p: ${inner.reason || 'safe'}` };
        if (inner?.verdict === 'RISKY') return { verdict: 'ask', reason: `claude -p: ${inner.reason || 'risky'}` };
      } catch { /* result wasn't JSON, try prose match below */ }

      const upper = env.result.toUpperCase();
      if (/\bSAFE\b/.test(upper) && !/\bRISKY\b/.test(upper)) return { verdict: 'allow', reason: 'claude -p: safe (prose)' };
      if (/\bRISKY\b/.test(upper)) return { verdict: 'ask', reason: 'claude -p: risky (prose)' };
    }

    process.stderr.write(`[chillbro] claude -p: unrecognized response shape: ${JSON.stringify(env).slice(0, 120)}\n`);
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
