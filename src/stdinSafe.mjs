// Read stdin with a timeout. The hook scripts (pretool/posttool/stop) read
// the Claude Code event JSON via `for await (const chunk of process.stdin)`,
// which has no timeout — if Claude Code crashes or closes stdin in a weird
// state, the hook could hang for the full hook timeout (16-25s) instead of
// failing fast and letting the default flow run.

import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_TIMEOUT_MS = 5000;

export async function readStdinSafe(timeoutMs = DEFAULT_TIMEOUT_MS) {
  let data = '';
  const reader = (async () => {
    for await (const chunk of process.stdin) data += chunk;
    return data;
  })();
  const timeout = delay(timeoutMs).then(() => Symbol('timeout'));
  const result = await Promise.race([reader, timeout]);
  if (typeof result === 'symbol') {
    throw new Error(`stdin read timed out after ${timeoutMs}ms`);
  }
  return result;
}
