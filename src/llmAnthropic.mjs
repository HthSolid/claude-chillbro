// Direct Anthropic API classifier. Sub-second when ANTHROPIC_API_KEY is set.
// Uses node's built-in fetch (Node 18+).
//
// Returns { verdict, reason } on success, null on any failure (no key, network
// error, timeout, non-2xx, unparseable response). Caller falls through to the
// next layer in the waterfall.

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 3000;

const SYSTEM = `You classify shell commands by safety. Reply with ONE word only: SAFE or RISKY.

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

function buildUserMessage(command, intent) {
  const i = (intent && String(intent).trim()) || '(none provided)';
  return `Command: ${command}\n\nIntent: ${i}\n\nClassify (one word):`;
}

export async function classifyWithAnthropic(command, intent) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8,
        system: SYSTEM,
        messages: [{ role: 'user', content: buildUserMessage(command, intent) }],
      }),
    });

    if (!res.ok) {
      process.stderr.write(`[chillbro] anthropic api: HTTP ${res.status}\n`);
      return null;
    }

    const data = await res.json();
    const text = (data?.content?.[0]?.text || '').trim().toUpperCase();
    if (text.startsWith('SAFE')) return { verdict: 'allow', reason: 'anthropic api: safe' };
    if (text.startsWith('RISKY')) return { verdict: 'ask', reason: 'anthropic api: risky' };

    process.stderr.write(`[chillbro] anthropic api: unparseable response: ${text.slice(0, 40)}\n`);
    return null;
  } catch (err) {
    if (err.name === 'AbortError') {
      process.stderr.write(`[chillbro] anthropic api: timed out at ${TIMEOUT_MS}ms\n`);
    } else {
      process.stderr.write(`[chillbro] anthropic api: ${err.message}\n`);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}
