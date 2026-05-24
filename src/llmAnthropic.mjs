// Direct Anthropic API classifier. Sub-second when ANTHROPIC_API_KEY is set.
// Uses node's built-in fetch (Node 18+).
//
// Two-stage classifier (Anthropic Auto Mode pattern, https://www.anthropic.com/engineering/claude-code-auto-mode):
//   STAGE 1: tight prompt, single-token reply. ~200-300ms typical. Most
//            commands resolve here without needing more context.
//   STAGE 2: full prompt with intent + scope reasoning. Only invoked when
//            stage 1 says RISKY or returns UNCLEAR — needed to distinguish
//            "destructive but in-scope per the user's stated intent" from
//            "destructive and unbounded".
//
// Both stages share the same cached system block (1-hour ephemeral TTL).
// Cache reads are 0.1x base cost, so after warmup nearly all the prompt
// tokens are read-cost not write-cost.
//
// Returns { verdict, reason } on success, null on any failure (no key, network
// error, timeout, non-2xx, unparseable response). Caller falls through to the
// next layer in the waterfall.

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const STAGE1_TIMEOUT_MS = 2500;
const STAGE2_TIMEOUT_MS = 4500;

const SYSTEM_STAGE1 = `You classify shell commands by safety.

Reply with EXACTLY ONE word: SAFE, RISKY, or UNCLEAR.

SAFE    = read-only, no filesystem writes outside cwd, no network mutations,
          no privilege escalation, no secrets accessed, fully reversible.
RISKY   = destructive (filesystem write/delete outside cwd, network mutation,
          privilege escalation, secret access) AND no stated intent that
          bounds the scope.
UNCLEAR = looks destructive but a stated intent might justify it. Escalate
          to stage 2 for full reasoning.

When in doubt between SAFE and UNCLEAR, choose UNCLEAR.
When in doubt between RISKY and UNCLEAR, choose UNCLEAR.

Output the word, nothing else.`;

const SYSTEM_STAGE2 = `You classify shell commands by safety. This is stage 2
of a two-stage classifier; the cheaper stage 1 has flagged this command as
either RISKY or UNCLEAR. Your job is to give the final verdict.

Reply with EXACTLY ONE word: SAFE or RISKY.

SAFE = read-only, OR destructive but bounded by the stated INTENT (e.g.
       intent "remove the now-empty old branch dir after move" + command
       "rm -rf <dir>" is SAFE because the destruction matches the intent).
RISKY = destructive beyond the stated intent, OR intent missing and the
        command is destructive, OR ambiguous, OR the command does not
        match the stated intent.

When in doubt: RISKY. The intent is the model's own one-line "why". Treat
it as authoritative scope, not as truth (a command that exceeds the
described scope is RISKY even if the intent claims otherwise).`;

function buildStage1Msg(command) {
  return `Command:\n${command}\n\nClassify (SAFE / RISKY / UNCLEAR):`;
}

function buildStage2Msg(command, intent, stage1Verdict) {
  const i = (intent && String(intent).trim()) || '(none provided)';
  return `Command: ${command}\n\nIntent: ${i}\n\nStage 1 verdict: ${stage1Verdict}\n\nFinal classification (SAFE / RISKY):`;
}

async function postChat({ key, system, userText, maxTokens, timeoutMs, signal }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        // Opt into the 1-hour extended cache TTL. Default is 5 minutes,
        // which expires between most LLM-fallback calls in a dev session.
        'anthropic-beta': 'extended-cache-ttl-2025-04-11',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        // System block is marked cacheable with a 1h TTL so subsequent calls
        // within an hour read it at 0.1x cost instead of regenerating.
        system: [
          { type: 'text', text: system, cache_control: { type: 'ephemeral', ttl: '1h' } },
        ],
        messages: [{ role: 'user', content: userText }],
      }),
    });
    if (!res.ok) {
      process.stderr.write(`[chillbro] anthropic api: HTTP ${res.status}\n`);
      return null;
    }
    const data = await res.json();
    const text = (data?.content?.[0]?.text || '').trim().toUpperCase();
    return text;
  } catch (err) {
    if (err.name === 'AbortError') {
      process.stderr.write(`[chillbro] anthropic api: timed out at ${timeoutMs}ms\n`);
    } else {
      process.stderr.write(`[chillbro] anthropic api: ${err.message}\n`);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function firstWord(text) {
  if (!text) return '';
  const m = text.match(/[A-Z]+/);
  return m ? m[0] : '';
}

export async function classifyWithAnthropic(command, intent) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;

  // --- STAGE 1: single-token verdict from a tight prompt ---
  const stage1Text = await postChat({
    key,
    system: SYSTEM_STAGE1,
    userText: buildStage1Msg(command),
    maxTokens: 4,
    timeoutMs: STAGE1_TIMEOUT_MS,
  });
  if (!stage1Text) return null;
  const stage1Verdict = firstWord(stage1Text);

  if (stage1Verdict === 'SAFE') {
    return { verdict: 'allow', reason: 'anthropic stage1: safe' };
  }
  if (stage1Verdict !== 'RISKY' && stage1Verdict !== 'UNCLEAR') {
    process.stderr.write(`[chillbro] anthropic stage1: unparseable: ${stage1Text.slice(0, 40)}\n`);
    return null;
  }

  // --- STAGE 2: full reasoning with intent ---
  const stage2Text = await postChat({
    key,
    system: SYSTEM_STAGE2,
    userText: buildStage2Msg(command, intent, stage1Verdict),
    maxTokens: 12,
    timeoutMs: STAGE2_TIMEOUT_MS,
  });
  if (!stage2Text) {
    // Stage 1 said RISKY/UNCLEAR; without stage 2 we can't confirm SAFE.
    // Conservative: report ask.
    return { verdict: 'ask', reason: `anthropic stage1: ${stage1Verdict.toLowerCase()} (stage2 unavailable)` };
  }
  const stage2Verdict = firstWord(stage2Text);
  if (stage2Verdict === 'SAFE') {
    return { verdict: 'allow', reason: `anthropic stage2: safe (after stage1=${stage1Verdict.toLowerCase()})` };
  }
  if (stage2Verdict === 'RISKY') {
    return { verdict: 'ask', reason: `anthropic stage2: risky (after stage1=${stage1Verdict.toLowerCase()})` };
  }
  process.stderr.write(`[chillbro] anthropic stage2: unparseable: ${stage2Text.slice(0, 40)}\n`);
  return null;
}
