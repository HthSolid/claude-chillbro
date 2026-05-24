// Subshell routing: unquoted $(...) and backticks used to deterministically
// ASK at the splitter layer, skipping the LLM entirely. After the v0.1.6
// fix they should reach the LLM (source: 'llm') unless static patterns
// catch them earlier.

import { classifyStatic } from '../src/classify.mjs';
import { splitCommandWithReason } from '../src/splitter.mjs';

process.env.CHILLBRO_TEST_NO_LEARN = '1';

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.error(`  FAIL  ${label}\n        expected: ${JSON.stringify(expected)}\n        got:      ${JSON.stringify(actual)}`); }
}

// --- splitter directly: bail reason is surfaced ---
eq(splitCommandWithReason('echo hi').segments, ['echo hi'], 'splitter: plain command → segments');
eq(splitCommandWithReason('a && b').segments, ['a', 'b'], 'splitter: && splits into two segments');
eq(splitCommandWithReason('TOKEN=$(curl localhost)').bail, 'subshell', 'splitter: unquoted $(...) → bail subshell');
eq(splitCommandWithReason('FOO=`whoami`').bail, 'subshell', 'splitter: backtick → bail subshell');
eq(splitCommandWithReason('echo "unterminated').bail, 'unbalanced', 'splitter: unbalanced double-quote → bail unbalanced');
eq(splitCommandWithReason("echo 'unterminated").bail, 'unbalanced', 'splitter: unbalanced single-quote → bail unbalanced');

// --- classifyStatic: subshell-bail is now source=unknown (= LLM-bound) ---
function statusOf(cmd) {
  const r = classifyStatic(cmd, '/tmp');
  return { decision: r.decision, source: r.source };
}

// Common pattern: localhost token fetch + curl + python json pipe.
const userCmd = `TOKEN=$(curl -s 'http://localhost:3010/api/v1/auth/login' -H 'Content-Type: application/json' -d '{}' | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['accessToken'])"); curl -s 'http://localhost:3010/api/v1/data/metrics' -H 'Authorization: Bearer $TOKEN'`;
eq(statusOf(userCmd), { decision: null, source: 'unknown' }, 'classify: TOKEN=$(curl) compound defers to LLM');

// Common shell init patterns also defer to LLM
eq(statusOf('TOKEN=$(curl https://api.example.com/token)'), { decision: null, source: 'unknown' }, 'classify: var=$(curl ...) defers to LLM');
eq(statusOf('VENV=$(python3 -c "import sys; print(sys.prefix)")'), { decision: null, source: 'unknown' }, 'classify: var=$(python3 -c ...) defers to LLM');
eq(statusOf('echo `git rev-parse HEAD`'), { decision: null, source: 'unknown' }, 'classify: echo `cmd` defers to LLM');

// Unbalanced quotes → still deterministic ASK (likely typo)
eq(statusOf('echo "oops'), { decision: 'ask', source: 'splitter' }, 'classify: unbalanced quote → deterministic ASK');
eq(statusOf("git status 'unterminated"), { decision: 'ask', source: 'splitter' }, 'classify: unbalanced single-quote → deterministic ASK');

// Quoted subshell (passes splitter, goes through normal pattern matching) — behavior unchanged
eq(statusOf('cd "$(git rev-parse --show-toplevel)"'), { decision: 'allow', source: 'static-allow' }, 'classify: quoted $(...) goes through static patterns (cd allowed)');

// Plain non-subshell commands — behavior unchanged
eq(statusOf('ls -la'), { decision: 'allow', source: 'static-allow' }, 'classify: plain ls -la still static-allow');
eq(statusOf('rm -rf /'), { decision: 'ask', source: 'static-ask' }, 'classify: rm -rf still static-ask');

console.log(`\n${pass} passed, ${fail} failed (of ${pass+fail})`);
process.exit(fail === 0 ? 0 : 1);
