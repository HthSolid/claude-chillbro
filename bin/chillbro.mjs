#!/usr/bin/env node
// chillbro CLI — control plane for the auto-continue mode.
//
// Invoked by the slash command (commands/chillbro.md) as:
//   node ${CLAUDE_PLUGIN_ROOT}/bin/chillbro.mjs <subcommand> [args]
// Or directly by the user from a shell.
//
// Subcommands:
//   auto-continue on [phases X-Y] [message "..."] [iterations N]
//   auto-continue off
//   auto-continue-message "..."
//   auto-continue phases X-Y          (or just N for "1-N")
//   auto-continue iterations N
//   status
//   reset
//   help

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  loadState,
  enable,
  disable,
  setMessage,
  setPhases,
  setIterationsMax,
  reset,
  parsePhaseRange,
} from '../src/autoContinueState.mjs';
import { patternCounts, patternsMeta, USER_PATHS } from '../src/lists.mjs';
import { loadLearned, appendLearned, forgetLearned, readLearnAudit, PATHS } from '../src/state.mjs';
import { normalize } from '../src/normalize.mjs';

const argv = process.argv.slice(2);

function usage() {
  process.stdout.write(`chillbro — control plane

Usage:
  chillbro auto-continue on [phases <X-Y>] [message "<text>"] [iterations <N>]
  chillbro auto-continue off
  chillbro auto-continue-message "<text>"
  chillbro auto-continue phases <X-Y | N>
  chillbro auto-continue iterations <N>

  chillbro patterns status                    Show pattern catalog version + counts
  chillbro patterns list                      Dump full allow + ask lists
  chillbro patterns add-allow "<regex>"       Append to ~/.claude-chillbro/user-allow.list
  chillbro patterns add-ask   "<regex>"       Append to ~/.claude-chillbro/user-ask.list
  chillbro patterns edit-allow                Show the user-allow file path
  chillbro patterns edit-ask                  Show the user-ask file path

  chillbro learn list [--limit N]             Show learned-allow patterns (alphabetical)
  chillbro learn add "<command>"              Manually promote a normalized command to auto-allow
  chillbro learn forget "<command>"           Remove a learned pattern (use exact normalized form)
  chillbro learn audit [--limit N]            Show audit log of recent learn-allow promotions
  chillbro learn audit-path                   Print the path to learned-allow.log

  chillbro status                             Auto-continue state
  chillbro reset                              Wipe auto-continue state
  chillbro help

Examples:
  chillbro auto-continue on phases 1-6 message "audit, then continue, dont commit"
  chillbro patterns status
  chillbro patterns add-allow '^my-internal-cli\\s+(status|list)'
  chillbro patterns add-ask '^my-deploy\\s+--prod'
`);
}

// Append a user pattern to the right file. Creates the file with a header
// the first time. Refuses obvious garbage (empty or invalid regex).
function addUserPattern(kind, pattern) {
  if (!pattern || !pattern.trim()) {
    process.stderr.write(`patterns ${kind}: pattern text required\n`);
    process.exit(2);
  }
  try { new RegExp(pattern); }
  catch (e) {
    process.stderr.write(`patterns ${kind}: invalid regex "${pattern}" (${e.message})\n`);
    process.exit(2);
  }
  const path = kind === 'add-allow' ? USER_PATHS.USER_ALLOW : USER_PATHS.USER_ASK;
  const which = kind === 'add-allow' ? 'allow' : 'ask';
  try { mkdirSync(join(homedir(), '.claude-chillbro'), { recursive: true }); } catch {}
  let prefix = '';
  if (!existsSync(path)) {
    prefix = `# claude-chillbro :: user-local ${which} patterns\n# One regex per line. Lines starting with # are comments.\n# These ${which === 'ask' ? 'force the user prompt' : 'auto-approve commands'}.\n# See patterns/PATTERNS.md for conventions.\n\n`;
  }
  // Avoid duplicates if user adds the same pattern twice
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8');
    if (existing.split('\n').some(l => l.trim() === pattern.trim())) {
      process.stdout.write(`patterns ${kind}: "${pattern}" already in ${path} — skipped\n`);
      return;
    }
  }
  appendFileSync(path, prefix + pattern + '\n');
  process.stdout.write(`patterns ${kind}: added to ${path}\n  "${pattern}"\n`);
}

function fmtState(s) {
  const phaseRange = s.phase_range ? `${s.phase_range[0]}-${s.phase_range[1]}` : '(unspecified)';
  const lastDone = s.current_phase != null ? s.current_phase : '(none yet)';
  return `chillbro auto-continue
  enabled:        ${s.enabled ? 'YES' : 'no'}
  enabled at:     ${s.enabled_at || '(never)'}
  phase range:    ${phaseRange}
  last done:      ${lastDone}
  iterations:     ${s.iterations}/${s.iterations_max}
  recent failures:${s.consecutive_failures}
  message:        "${s.message_template}"
  completions:    ${s.completions.length}
${s.completions.slice(-5).map(c => `    - phase ${c.phase} @ ${c.ts}: ${c.summary || '(no summary)'}`).join('\n')}
`;
}

// Parse the rest of argv after a subcommand for inline options:
//   `phases X-Y`, `message "..."`, `iterations N`
// Returns { opts: { phases?, message?, iterations? }, error?: string }.
// Errors on unknown tokens instead of silently treating them as message —
// previously `chillbro auto-continue on typo "text"` would parse `typo "text"`
// as the message and the user wouldn't know it was a typo.
function parseInlineOpts(args) {
  const opts = {};
  const KNOWN = new Set(['phases', 'message', 'iterations']);
  let i = 0;
  while (i < args.length) {
    const tok = args[i];
    if (!KNOWN.has(tok)) {
      return { error: `unknown token "${tok}" (expected one of: phases, message, iterations)` };
    }
    if (i + 1 >= args.length) {
      return { error: `option "${tok}" requires a value` };
    }
    const val = args[i + 1];
    if (tok === 'phases') {
      if (parsePhaseRange(val) === null) {
        return { error: `invalid phases value "${val}" (expected "N" or "X-Y" with X<=Y)` };
      }
      opts.phases = val;
    } else if (tok === 'message') {
      opts.message = val;
    } else if (tok === 'iterations') {
      const n = parseInt(val, 10);
      if (!Number.isFinite(n) || n <= 0) {
        return { error: `invalid iterations value "${val}" (expected positive integer)` };
      }
      opts.iterations = n;
    }
    i += 2;
  }
  return { opts };
}

const cmd = argv[0];
const sub = argv[1];

switch (cmd) {
  case undefined:
  case 'help':
  case '--help':
  case '-h':
    usage();
    process.exit(0);
    break;

  case 'auto-continue': {
    if (sub === 'on') {
      const { opts, error } = parseInlineOpts(argv.slice(2));
      if (error) {
        process.stderr.write(`auto-continue on: ${error}\n`);
        usage();
        process.exit(2);
      }
      const s = enable(opts);
      process.stdout.write(`auto-continue: ENABLED\n${fmtState(s)}`);
    } else if (sub === 'off') {
      const s = disable();
      process.stdout.write(`auto-continue: disabled\n${fmtState(s)}`);
    } else if (sub === 'phases' && argv[2]) {
      const range = parsePhaseRange(argv[2]);
      if (!range) {
        process.stderr.write(`could not parse phases: "${argv[2]}" (expected "1-6", "5", or "1..6")\n`);
        process.exit(2);
      }
      const s = setPhases(argv[2]);
      process.stdout.write(`auto-continue phases set to ${s.phase_range[0]}-${s.phase_range[1]}\n`);
    } else if (sub === 'iterations' && argv[2]) {
      const n = parseInt(argv[2], 10);
      if (!Number.isFinite(n) || n < 1) {
        process.stderr.write(`iterations must be a positive integer\n`);
        process.exit(2);
      }
      const s = setIterationsMax(n);
      process.stdout.write(`auto-continue iterations cap set to ${s.iterations_max}\n`);
    } else {
      process.stderr.write(`unknown auto-continue subcommand: "${sub}"\n`);
      usage();
      process.exit(2);
    }
    break;
  }

  case 'auto-continue-message': {
    const msg = argv.slice(1).join(' ').replace(/^["']|["']$/g, '');
    if (!msg) {
      process.stderr.write(`message text required\n`);
      process.exit(2);
    }
    const s = setMessage(msg);
    process.stdout.write(`auto-continue message updated:\n  "${s.message_template}"\n`);
    break;
  }

  case 'status': {
    const s = loadState();
    process.stdout.write(fmtState(s));
    break;
  }

  case 'reset': {
    reset();
    process.stdout.write(`auto-continue state reset to defaults\n`);
    break;
  }

  case 'learn': {
    if (sub === 'list') {
      const items = loadLearned().sort();
      const idx = argv.indexOf('--limit');
      const limit = idx >= 0 ? parseInt(argv[idx + 1] || '50', 10) : items.length;
      process.stdout.write(`learned-allow patterns (${items.length} total, showing ${Math.min(limit, items.length)}):\n`);
      items.slice(0, limit).forEach(p => process.stdout.write(`  ${p}\n`));
    } else if (sub === 'add' && argv[2]) {
      const cmd = argv.slice(2).join(' ');
      const norm = normalize(cmd);
      const added = appendLearned(norm, 'manual');
      if (added) {
        process.stdout.write(`learn add: promoted "${norm}" to learned-allow\n  (audit log: ${PATHS.LEARN_AUDIT})\n`);
      } else {
        process.stdout.write(`learn add: "${norm}" was already in learned-allow\n`);
      }
    } else if (sub === 'forget' && argv[2]) {
      const cmd = argv.slice(2).join(' ');
      const norm = normalize(cmd);
      const removed = forgetLearned(norm);
      if (removed) {
        process.stdout.write(`learn forget: removed "${norm}" from learned-allow\n`);
      } else {
        process.stderr.write(`learn forget: "${norm}" was not in learned-allow\n`);
        process.exit(2);
      }
    } else if (sub === 'audit') {
      const idx = argv.indexOf('--limit');
      const limit = idx >= 0 ? parseInt(argv[idx + 1] || '50', 10) : 50;
      const entries = readLearnAudit(limit);
      if (entries.length === 0) {
        process.stdout.write(`learn audit: no entries yet at ${PATHS.LEARN_AUDIT}\n`);
      } else {
        process.stdout.write(`learn audit (most recent first, showing ${entries.length}):\n`);
        for (const e of entries) {
          process.stdout.write(`  ${e.ts}  [${e.source}]  ${e.normalized}\n`);
        }
      }
    } else if (sub === 'audit-path') {
      process.stdout.write(`${PATHS.LEARN_AUDIT}\n`);
    } else {
      process.stderr.write(`unknown learn subcommand: "${sub}"\n`);
      usage();
      process.exit(2);
    }
    break;
  }

  case 'patterns': {
    if (sub === 'status') {
      const counts = patternCounts();
      const meta = patternsMeta();
      process.stdout.write(`chillbro pattern catalog
  schema:         v${meta?.schema_version ?? '?'}
  catalog:        v${meta?.patterns_version ?? '?'} (${meta?.updated ?? '?'})
  allow (core):   ${counts.allow_core}
  allow (user):   ${counts.allow_user}  ${counts.allow_user ? `(${USER_PATHS.USER_ALLOW})` : ''}
  ask   (core):   ${counts.ask_core}
  ask   (user):   ${counts.ask_user}    ${counts.ask_user ? `(${USER_PATHS.USER_ASK})` : ''}

precedence: ask wins over allow. user lists extend (never bypass) the core lists.
`);
    } else if (sub === 'list') {
      const allowPath = '../patterns/allow.list';
      const askPath = '../patterns/ask.list';
      const fileURL = new URL(import.meta.url);
      const allowAbs = join(fileURL.pathname, '..', '..', 'patterns', 'allow.list');
      const askAbs = join(fileURL.pathname, '..', '..', 'patterns', 'ask.list');
      process.stdout.write('=== patterns/allow.list ===\n');
      try { process.stdout.write(readFileSync(allowAbs, 'utf8')); }
      catch (e) { process.stderr.write(`(could not read: ${e.message})\n`); }
      process.stdout.write('\n=== patterns/ask.list ===\n');
      try { process.stdout.write(readFileSync(askAbs, 'utf8')); }
      catch (e) { process.stderr.write(`(could not read: ${e.message})\n`); }
      if (existsSync(USER_PATHS.USER_ALLOW)) {
        process.stdout.write(`\n=== user-allow.list (${USER_PATHS.USER_ALLOW}) ===\n`);
        process.stdout.write(readFileSync(USER_PATHS.USER_ALLOW, 'utf8'));
      }
      if (existsSync(USER_PATHS.USER_ASK)) {
        process.stdout.write(`\n=== user-ask.list (${USER_PATHS.USER_ASK}) ===\n`);
        process.stdout.write(readFileSync(USER_PATHS.USER_ASK, 'utf8'));
      }
    } else if (sub === 'add-allow' && argv[2]) {
      addUserPattern('add-allow', argv.slice(2).join(' '));
    } else if (sub === 'add-ask' && argv[2]) {
      addUserPattern('add-ask', argv.slice(2).join(' '));
    } else if (sub === 'edit-allow') {
      process.stdout.write(`${USER_PATHS.USER_ALLOW}\n`);
    } else if (sub === 'edit-ask') {
      process.stdout.write(`${USER_PATHS.USER_ASK}\n`);
    } else {
      process.stderr.write(`unknown patterns subcommand: "${sub}"\n`);
      usage();
      process.exit(2);
    }
    break;
  }

  default:
    process.stderr.write(`unknown command: "${cmd}"\n`);
    usage();
    process.exit(2);
}
