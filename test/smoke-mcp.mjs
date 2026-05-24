// MCP classifier: per-server allowlist + always-ask deny suffixes.

import { classifyMcp } from '../src/classifyMcp.mjs';

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.error(`  FAIL  ${label}\n        expected: ${JSON.stringify(expected)}\n        got:      ${JSON.stringify(actual)}`); }
}

function decisionOf(name) {
  const r = classifyMcp(name);
  return r === null ? 'null' : r.decision;
}

// Common case: playwright form/input tools → allow
eq(decisionOf('mcp__playwright__browser_fill_form'),  'allow', 'playwright browser_fill_form → allow');
eq(decisionOf('mcp__playwright__browser_press_key'),  'allow', 'playwright browser_press_key → allow');
eq(decisionOf('mcp__playwright__browser_hover'),      'allow', 'playwright browser_hover → allow');
eq(decisionOf('mcp__playwright__browser_select_option'), 'allow', 'playwright select_option → allow');
eq(decisionOf('mcp__playwright__browser_click'),      'allow', 'playwright click → allow');
eq(decisionOf('mcp__playwright__browser_navigate'),   'allow', 'playwright navigate → allow');
eq(decisionOf('mcp__playwright__browser_snapshot'),   'allow', 'playwright snapshot → allow');
eq(decisionOf('mcp__playwright__browser_close'),      'allow', 'playwright close → allow');

// Playwright _unsafe → always ask
eq(decisionOf('mcp__playwright__browser_run_code_unsafe'), 'ask', 'playwright run_code_unsafe → ask (deny suffix)');

// dejavu read-only audits → allow
eq(decisionOf('mcp__dejavu-auditor__audit_files'),    'allow', 'dejavu audit_files → allow');
eq(decisionOf('mcp__dejavu-auditor__list_patterns'),  'allow', 'dejavu list_patterns → allow');
eq(decisionOf('mcp__dejavu-auditor__get_session_events'), 'allow', 'dejavu get_session_events → allow');

// hugging-face search/read → allow
eq(decisionOf('mcp__hugging-face__hf_doc_search'),    'allow', 'huggingface doc_search → allow');
eq(decisionOf('mcp__hugging-face__hub_repo_search'),  'allow', 'huggingface repo_search → allow');
eq(decisionOf('mcp__hugging-face__paper_search'),     'allow', 'huggingface paper_search → allow');

// mcp-search → allow
eq(decisionOf('mcp__mcp-search__search'),             'allow', 'mcp-search search → allow');
eq(decisionOf('mcp__mcp-search__smart_search'),       'allow', 'mcp-search smart_search → allow');
eq(decisionOf('mcp__mcp-search__timeline'),           'allow', 'mcp-search timeline → allow');

// claude-flow read-only patterns
eq(decisionOf('mcp__claude-flow__memory_search'),     'allow', 'claude-flow memory_search → allow');
eq(decisionOf('mcp__claude-flow__swarm_status'),      'allow', 'claude-flow swarm_status → allow');
eq(decisionOf('mcp__claude-flow__system_health'),     'allow', 'claude-flow system_health → allow');
eq(decisionOf('mcp__claude-flow__autopilot_history'), 'allow', 'claude-flow autopilot_history → allow');

// Deny-by-suffix wins over server allowlist
eq(decisionOf('mcp__claude-flow__memory_delete'),     'ask', 'memory_delete → ask (deny suffix)');
eq(decisionOf('mcp__claude-flow__agent_terminate'),   'ask', 'agent_terminate → ask (deny suffix)');
eq(decisionOf('mcp__claude-flow__swarm_shutdown'),    'ask', 'swarm_shutdown → ask (shutdown in deny suffix)');

// Auth flows → always ask
eq(decisionOf('mcp__claude_ai_Gmail__authenticate'),  'ask', 'gmail authenticate → ask');
eq(decisionOf('mcp__claude_ai_Gmail__complete_authentication'), 'ask', 'gmail complete_authentication → ask');

// Unknown server → null (let Claude Code default flow handle)
eq(decisionOf('mcp__unknown-server__random_tool'),    'null', 'unknown server → null (default flow)');

// Not an MCP tool → null
eq(decisionOf('Bash'),                                 'null', 'Bash tool → null (not MCP)');
eq(decisionOf('Read'),                                 'null', 'Read tool → null (not MCP)');

console.log(`\n${pass} passed, ${fail} failed (of ${pass+fail})`);
process.exit(fail === 0 ? 0 : 1);
