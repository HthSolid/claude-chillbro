---
description: Control claude-chillbro plugin (auto-continue mode, status, reset)
---

The user invoked `/chillbro` with arguments: `$ARGUMENTS`

Run the chillbro CLI with these arguments and report what changed. The binary is at `${CLAUDE_PLUGIN_ROOT}/bin/chillbro.mjs`.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/chillbro.mjs" $ARGUMENTS
```

Common forms:

**Auto-continue (multi-phase plan handling):**
- `auto-continue on phases <X-Y> message "<text>"` — enable auto-continue for a multi-phase task. The `phases` and `message` are optional but recommended; defaults are no phase tracking and a generic audit-then-continue directive.
- `auto-continue off` — disable auto-continue for the rest of the session.
- `auto-continue-message "<text>"` — change the directive that gets fed to Claude on each continuation.
- `auto-continue phases <X-Y>` — set or update the phase range (e.g. `1-6`, or just `6` for `1-6`).
- `auto-continue iterations <N>` — raise or lower the safety cap on automatic continuations.
- `status` — show current auto-continue state, iteration counter, and recent completions.
- `reset` — wipe auto-continue state back to defaults.

**Pattern catalog (extend the allow/ask lists with your own commands):**
- `patterns status` — show catalog version + counts (core + user-local).
- `patterns list` — dump every active allow + ask pattern (and your user-locals if any).
- `patterns add-allow '<regex>'` — append a user-local allow pattern (`~/.claude-chillbro/user-allow.list`).
- `patterns add-ask '<regex>'` — append a user-local ask pattern (`~/.claude-chillbro/user-ask.list`).
- `patterns edit-allow` / `patterns edit-ask` — print the path to the user-local file so you can open it directly.

User-local patterns take effect immediately (re-read on every hook fire). They extend the core lists but cannot bypass the static ASK list — safety is preserved.

Run the command, then briefly confirm what was set so the user has visual confirmation.
