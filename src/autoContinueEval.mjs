// dejavu-audit-skip: P-026 — tests live in /test/ (project convention), not /src/
// LLM evaluator for auto-continue: decides whether to CONTINUE the session,
// ASK a clarifying question, or STOP and let the user take over.
//
// Two-layer waterfall, mirroring llmFallback.mjs:
//   1. Anthropic API direct (sub-second, requires ANTHROPIC_API_KEY)
//   2. Headless `claude -p`   (slow cold-start, no key required)
// Both layers fail to "STOP" on any error — auto-continue is a convenience,
// never a safety boundary, so degrading to the user prompt is always correct.

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EMPTY_PLUGINS_DIR = join(tmpdir(), 'chillbro-empty-plugins');
try { mkdirSync(EMPTY_PLUGINS_DIR, { recursive: true }); } catch { /* tolerable */ }

const SYSTEM_PROMPT = `You decide whether to auto-continue a Claude Code session that just stopped.

CRITICAL CONTEXT: The user has enabled auto-continue mode for a multi-phase
task. They have PRE-AUTHORIZED PROGRESSION BETWEEN PHASES OF A SPECIFIC PLAN —
NOT authorization to invent new work, NOT authorization to pick among open
questions, NOT authorization to keep going after the plan is done.

Your DEFAULT is STOP. Only return CONTINUE when phase-to-phase progression
is unambiguous.

Decide ONE of:

  CONTINUE - Assistant just finished a CONCRETE phase of the plan AND the
             next phase is OBVIOUSLY part of the same plan AND no user
             decision is needed. Polite "shall I proceed?" between phases
             counts here because the user pre-authorized.

             Examples:
               - "Phase 3 done. Phase 4 will refactor X." → CONTINUE
               - "Auth module done. Moving on to the API layer per the plan."
                 → CONTINUE
               - "Phase 2 complete. Ready for phase 3 when you confirm."
                 → CONTINUE (pre-authorized)

  ASK      - You can't tell whether a phase finished or what the next step
             is, but the conversation isn't clearly stopping either. Return
             a specific clarifying question to send back to the assistant
             (e.g., "did you complete phase 3? if yes, please proceed to
             phase 4 per the plan").

  STOP     - This is the SAFE DEFAULT. Return STOP whenever ANY of these
             are true (and when in doubt):

             - Assistant explicitly stopped: phrases like "ending the loop",
               "standing by", "your call", "your move", "needs your direction",
               "let me know", "what would you like", "ready for next
               instructions", "nothing autonomous to chase".

             - Assistant asked a CHOICE question requiring the user's
               input: "should I do A or B?", "which approach do you
               prefer?", "want me to start with X or Y first?", "want me
               to commit or skip the commit?". Two listed options = a
               choice question = STOP.

             - Assistant listed FUTURE WORK ITEMS as a backlog ("pending
               pieces queued, can start any time:", "next steps:", "what's
               next") without committing to the next one. Listing != deciding.
               If the assistant then asks which to do first, that's STOP.

             - Assistant reported errors, failures, or ambiguity requiring
               the user's domain knowledge.

             - All phases in the configured range are done.

             - The assistant's message does not describe a concrete phase
               completion in a known multi-phase plan at all.

             - You're not sure. When in doubt: STOP. The user can always
               type "continue" themselves.

Phase tracking: extract phase_just_done as an integer ONLY if the message
contains an explicit phrase like "Phase N done", "Phase N complete", "Step
N finished", "Group N delivered". Vague gestures like "made progress" or
"got further" do NOT count.

The hook will emit the user's directive verbatim when you choose CONTINUE —
you do NOT write the continuation message yourself. Just decide the verdict.
For ASK you write the clarifying question.

Respond with ONE single-line JSON object, no prose, no markdown fence:
{"verdict":"CONTINUE"|"ASK"|"STOP","question":"<only for ASK>","phase_just_done":<int or null>,"reasoning":"<short>"}`;

const ANTHROPIC_TIMEOUT_MS = 5000;
const CLAUDE_P_TIMEOUT_MS = 20000;  // cold start ~6s + LLM thinking on the longer auto-continue prompt
                                     // can exceed 14s. 20s gives headroom; the Stop hook timeout (25s)
                                     // is the outer bound that still lets the hook emit a verdict.
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

function buildUserMessage(state, lastAssistantText) {
  const phaseRange = state.phase_range ? `${state.phase_range[0]}-${state.phase_range[1]}` : 'unspecified';
  const lastDone = state.current_phase != null ? state.current_phase : 'none yet';
  const trimmed = String(lastAssistantText || '').slice(-3000);
  return `Auto-continue context:
  phase range:        ${phaseRange}
  last phase done:    ${lastDone}
  iteration:          ${state.iterations + 1}/${state.iterations_max}
  user's directive:   "${state.message_template}"

Last assistant message (final ${trimmed.length} chars):
${trimmed}

Decide:`;
}

function parseVerdict(text) {
  if (!text) return null;
  // Strip code-fence wrappers if the model added them despite instructions.
  let cleaned = String(text).trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  // Find the first {...} block.
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let parsed;
  try { parsed = JSON.parse(m[0]); }
  catch { return null; }
  const verdict = String(parsed.verdict || '').toUpperCase();
  if (!['CONTINUE', 'ASK', 'STOP'].includes(verdict)) return null;
  // Anti-fabrication: only the ASK path lets the LLM author user-visible text
  // (the clarifying question). For CONTINUE the hook uses the user's
  // directive verbatim from state, ignoring whatever the LLM put in `message`.
  return {
    verdict,
    question: typeof parsed.question === 'string' ? parsed.question : (typeof parsed.message === 'string' ? parsed.message : ''),
    phase_just_done: Number.isInteger(parsed.phase_just_done) ? parsed.phase_just_done : null,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
  };
}

async function evalViaAnthropic(state, lastAssistantText) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ANTHROPIC_TIMEOUT_MS);

  try {
    const res = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        // Opt into 1-hour cache TTL so the SYSTEM_PROMPT stays warm across
        // a multi-phase task instead of expiring after the default 5min.
        'anthropic-beta': 'extended-cache-ttl-2025-04-11',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 400,
        system: [
          { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } },
        ],
        messages: [{ role: 'user', content: buildUserMessage(state, lastAssistantText) }],
      }),
    });
    if (!res.ok) {
      process.stderr.write(`[chillbro] auto-continue api: HTTP ${res.status}\n`);
      return null;
    }
    const data = await res.json();
    const text = data?.content?.[0]?.text || '';
    const v = parseVerdict(text);
    if (!v) process.stderr.write(`[chillbro] auto-continue api: unparseable response: ${text.slice(0, 80)}\n`);
    return v;
  } catch (err) {
    if (err.name === 'AbortError') process.stderr.write(`[chillbro] auto-continue api: timeout at ${ANTHROPIC_TIMEOUT_MS}ms\n`);
    else process.stderr.write(`[chillbro] auto-continue api: ${err.message}\n`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function evalViaClaudeP(state, lastAssistantText) {
  const isWindows = process.platform === 'win32';
  const args = [
    '-p',
    '--model', 'haiku',
    '--output-format', 'json',
    '--tools', '',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--plugin-dir', EMPTY_PLUGINS_DIR,
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', '',
    '--system-prompt', SYSTEM_PROMPT,
    buildUserMessage(state, lastAssistantText),
  ];

  let result;
  try {
    result = spawnSync('claude', args, {
      timeout: CLAUDE_P_TIMEOUT_MS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWindows,
      env: { ...process.env, CHILLBRO_RECURSION_GUARD: '1' },
    });
  } catch (err) {
    process.stderr.write(`[chillbro] auto-continue claude-p spawn: ${err.message}\n`);
    return null;
  }
  if (result.error || result.status !== 0 || !result.stdout) {
    process.stderr.write(`[chillbro] auto-continue claude-p failed: status=${result.status} err=${result.error?.message}\n`);
    return null;
  }
  try {
    const env = JSON.parse(result.stdout);
    const text = typeof env.result === 'string' ? env.result : JSON.stringify(env.structured_output || env.result || '');
    return parseVerdict(text);
  } catch (err) {
    process.stderr.write(`[chillbro] auto-continue claude-p parse: ${err.message}\n`);
    return null;
  }
}

// Returns { verdict, message, phase_just_done, reasoning } on success.
// Returns null on total failure (caller should fall back to STOP).
export async function evaluateAutoContinue(state, lastAssistantText) {
  if (process.env.CHILLBRO_TEST_NO_LLM === '1') return null;

  try {
    const api = await evalViaAnthropic(state, lastAssistantText);
    if (api) return api;
  } catch (err) {
    process.stderr.write(`[chillbro] auto-continue api layer threw: ${err.message}\n`);
  }
  const cli = evalViaClaudeP(state, lastAssistantText);
  if (cli) return cli;
  return null;
}
