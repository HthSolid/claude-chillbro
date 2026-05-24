// Classifier for MCP tool calls.
//
// MCP tool names have the form `mcp__<server>__<tool>`. The matcher in
// hooks.json catches all of them, so this classifier decides which to
// auto-allow.
//
// Strategy: per-server allowlist by tool-name pattern. The patterns capture
// "obviously read-only or non-destructive" tool operations — search, list,
// get, snapshot, navigate, fill/click/type in a sandboxed browser, etc.
// Anything not matched falls through to Claude Code's default ask flow.
//
// User override: ~/.claude-chillbro/mcp-allow.list (one pattern per line,
// glob-like with * supported).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MCP_ALLOW_FILE = join(homedir(), '.claude-chillbro', 'mcp-allow.list');

// Per-server allow patterns. Tool name (without mcp__server__ prefix) is
// matched against these regexes. If any match → allow.
const ALLOW_BY_SERVER = {
  playwright: [
    /^browser_(navigate|navigate_back|snapshot|click|type|press_key|hover|fill|fill_form|select_option|drag|drop|wait_for|handle_dialog|tabs|resize|close|file_upload)$/,
    /^browser_(screenshot|take_screenshot|console_messages|network_request|network_requests|evaluate|run_code)$/,
  ],
  'dejavu-auditor': [/^(audit_files|audit_diff|list_patterns|get_session_events)$/],
  'claude-mem':     [/^(mem-search|smart-explore|timeline-report|make-plan)$/],
  'hugging-face': [
    /^(hf_doc_search|hf_doc_fetch|hf_whoami|hub_repo_search|hub_repo_details|paper_search|space_search)$/,
    /^(gr1_z_image_turbo_generate)$/,
  ],
  'mcp-search': [/^(search|smart_search|smart_outline|smart_unfold|get_observations|timeline)$/],
  remotion:     [/^remotion-documentation$/],
  'claude-flow': [
    /^(.*_(list|status|info|get|search|health|metrics|stats|history|read|show))$/,
    /^(.*_(query|recall|retrieve|find|describe))$/,
    /^(memory_(store|retrieve|search|list|search_unified))$/,
    /^(agentdb_(pattern-(store|search)|hierarchical-(store|recall|delete)|session-(start|end)|context-synthesize))$/,
    /^(swarm_(init|status|health))$/,
    /^(hooks_(list|metrics|explain|intelligence|model-stats|coverage-suggest|coverage-gaps))$/,
    /^(coordination_metrics)$/,
    /^(performance_(metrics|profile|report|benchmark))$/,
    /^(neural_(status|predict|patterns))$/,
    /^(session_(current|list|info|save))$/,
    /^(task_(list|status|summary))$/,
    /^(autopilot_(status|history|log|progress|predict))$/,
    /^(claims_(list|board|status|load|stealable))$/,
    /^(aidefence_(scan|analyze|stats|is_safe|has_pii))$/,
    /^(workflow_(list|status|validate))$/,
    /^(config_(get|list))$/,
    /^(system_(status|health|info|metrics))$/,
  ],
};

// Tool-name patterns that ALWAYS ASK regardless of server.
const ALWAYS_ASK_TOOL_RX = [
  /_unsafe$/i,
  /_(delete|destroy|drop|remove|rm|purge|wipe|reset|terminate|kill|cancel|shutdown|stop|halt)$/i,
  /_(publish|release|deploy|push|upload)$/i,
  /_(send|transfer|pay|charge|withdraw|refund|spawn|create_pr|merge)$/i,
  /_(write|create|update|insert|set|put|patch|modify|replace)$/i,
  /^auth(enticate|orize)?$/i,
  /^complete_authentication$/i,
];

function parseMcpName(toolName) {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(toolName);
  if (!m) return null;
  return { server: m[1], tool: m[2] };
}

function loadUserMcpAllow() {
  try {
    return readFileSync(MCP_ALLOW_FILE, 'utf8')
      .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  } catch { return []; }
}

function globToRegex(glob) {
  const esc = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + esc + '$');
}

export function classifyMcp(toolName) {
  if (typeof toolName !== 'string' || !toolName.startsWith('mcp__')) return null;
  const parsed = parseMcpName(toolName);
  if (!parsed) return { decision: 'ask', reason: 'unparseable MCP tool name', source: 'mcp-classify' };
  const { server, tool } = parsed;

  for (const pat of loadUserMcpAllow()) {
    const rx = pat.includes('*') ? globToRegex(pat) : null;
    if (rx ? rx.test(toolName) : pat === toolName) {
      return { decision: 'allow', reason: `user mcp-allow: ${pat}`, source: 'mcp-classify' };
    }
  }

  for (const re of ALWAYS_ASK_TOOL_RX) {
    if (re.test(tool)) {
      return { decision: 'ask', reason: `tool name suggests mutation/destruction: ${re.source}`, source: 'mcp-classify' };
    }
  }

  const serverAllow = ALLOW_BY_SERVER[server];
  if (serverAllow) {
    for (const re of serverAllow) {
      if (re.test(tool)) {
        return { decision: 'allow', reason: `mcp:${server}: ${re.source}`, source: 'mcp-classify' };
      }
    }
  }
  return null;
}

export const _internal = { ALLOW_BY_SERVER, ALWAYS_ASK_TOOL_RX, parseMcpName, loadUserMcpAllow, MCP_ALLOW_FILE };
