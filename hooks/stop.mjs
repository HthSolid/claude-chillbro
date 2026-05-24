#!/usr/bin/env node
// Stop hook for chillbro auto-continue mode.
//
// Fires when Claude Code is about to end an assistant turn. If auto-continue
// is enabled, evaluates the assistant's final message via Haiku and either:
//   - emits decision:"block" with the next-phase instruction (Claude resumes)
//   - emits decision:"block" with a clarifying question (Claude answers, hook
//     fires again next time to re-evaluate)
//   - exits 0 (Claude stops normally, user gets the prompt)
//
// Failsafe contract identical to pretool/posttool: env-var killswitches,
// recursion guard, swallow-and-degrade on errors.

import { readFileSync, existsSync } from 'node:fs';
import {
  loadState,
  recordIteration,
  recordFailure,
  isPhaseRangeExhausted,
  isIterationCapReached,
  disable,
} from '../src/autoContinueState.mjs';
import { evaluateAutoContinue } from '../src/autoContinueEval.mjs';
import { debugLog } from '../src/debug.mjs';
import { readStdinSafe } from '../src/stdinSafe.mjs';

// Read the JSONL transcript and return the most recent assistant message text.
// Returns '' if the transcript is missing or has no assistant turn.
function lastAssistantText(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return '';
  let raw;
  try { raw = readFileSync(transcriptPath, 'utf8'); }
  catch { return ''; }
  const lines = raw.split('\n');
  // Walk backwards; assistant messages have type:"assistant" with content array.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    let entry;
    try { entry = JSON.parse(lines[i]); }
    catch { continue; }
    const msg = entry?.message;
    if (entry?.type === 'assistant' && msg?.role === 'assistant') {
      const content = Array.isArray(msg.content) ? msg.content : [];
      const text = content
        .filter(c => c && c.type === 'text' && typeof c.text === 'string')
        .map(c => c.text)
        .join('\n');
      if (text.trim()) return text;
    }
  }
  return '';
}

function emitBlock(reason) {
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: `[chillbro auto-continue] ${reason}`,
  }));
}

try {
  if (process.env.CHILLBRO_DISABLED === '1') process.exit(0);
  if (process.env.CHILLBRO_RECURSION_GUARD === '1') process.exit(0);

  const raw = await readStdinSafe();
  if (!raw.trim()) process.exit(0);
  let evt;
  try { evt = JSON.parse(raw); }
  catch { process.exit(0); }

  const state = loadState();
  if (!state.enabled) process.exit(0);

  // Hard caps before any LLM cost.
  if (isIterationCapReached(state)) {
    process.stderr.write(`[chillbro] auto-continue iteration cap reached (${state.iterations}/${state.iterations_max}) — disabling\n`);
    disable();
    debugLog({ tool: 'Stop', verdict: 'STOP', reason: 'iteration cap reached', state });
    process.exit(0);
  }
  if (isPhaseRangeExhausted(state)) {
    process.stderr.write(`[chillbro] auto-continue phase range exhausted (last done: ${state.current_phase} of ${state.phase_range?.[1]}) — disabling\n`);
    disable();
    debugLog({ tool: 'Stop', verdict: 'STOP', reason: 'phase range exhausted', state });
    process.exit(0);
  }

  // Read the last assistant message.
  const lastText = lastAssistantText(evt.transcript_path);
  if (!lastText) {
    debugLog({ tool: 'Stop', verdict: 'STOP', reason: 'no assistant text found in transcript', state });
    process.exit(0);
  }

  // Ask Haiku for the verdict.
  const startedAt = Date.now();
  const v = await evaluateAutoContinue(state, lastText);
  const ms = Date.now() - startedAt;

  if (!v) {
    recordFailure();
    process.stderr.write(`[chillbro] auto-continue: LLM eval failed; letting Claude stop normally\n`);
    debugLog({ tool: 'Stop', verdict: 'STOP', reason: 'LLM eval failed', ms, state });
    process.exit(0);
  }

  debugLog({ tool: 'Stop', verdict: v.verdict, question: v.question?.slice(0, 200), phase_just_done: v.phase_just_done, reasoning: v.reasoning, ms });

  if (v.verdict === 'STOP') {
    process.stderr.write(`[chillbro] auto-continue: STOP — ${v.reasoning || 'no continuation needed'}\n`);
    process.exit(0);
  }

  // Anti-fabrication: the LLM only authors the message for ASK (a clarifying
  // question). For CONTINUE, we use the user's directive VERBATIM from state.
  // This prevents the LLM from inventing context that wasn't in the directive
  // (e.g., hallucinating "6 phases" or "deferred items file" the user never
  // mentioned).
  let messageToInject;
  if (v.verdict === 'CONTINUE') {
    messageToInject = state.message_template;
    if (!messageToInject || !messageToInject.trim()) {
      process.stderr.write(`[chillbro] auto-continue: CONTINUE but message_template empty — letting Claude stop\n`);
      process.exit(0);
    }
  } else {
    // ASK
    messageToInject = v.question;
    if (!messageToInject || !messageToInject.trim()) {
      process.stderr.write(`[chillbro] auto-continue: ASK but no clarifying question — letting Claude stop\n`);
      process.exit(0);
    }
  }

  const updated = recordIteration({
    phase: v.phase_just_done,
    summary: lastText.slice(0, 200),
  });

  process.stderr.write(
    `[chillbro] auto-continue ${v.verdict} (${updated.iterations}/${updated.iterations_max})` +
    (v.phase_just_done != null ? ` phase ${v.phase_just_done}/${state.phase_range?.[1] ?? '?'}` : '') +
    `: ${messageToInject.slice(0, 120)}\n`
  );

  emitBlock(messageToInject);
} catch (err) {
  process.stderr.write(`[chillbro] stop hook error: ${err.message}\n`);
}
