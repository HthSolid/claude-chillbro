# claude-chillbro

A Claude Code plugin that stops the model from asking permission for every `grep`, `cat`, `ls`, and new file you ask it to create.

> "Allow Bash(ls -la)?"
> "Allow Write to src/foo.ts?"
> "Allow Bash(grep -r foo .)?"

You know the feeling. chillbro fixes it.

## What it does

Six layers, in order:

1. **Static asklist** (~75 patterns). Destructive operations like `rm -rf`, `sudo`, `git push --force`, `git reset --hard`, `prisma migrate reset`, `curl -X POST`, `kill -9`, anything touching `.env*` or `~/.ssh/id_*` always prompt you. Never auto-allowed.
2. **Context-aware probes**. `git push` to `main`/`master` asks, push to feature branch allows. `gh pr|issue|release create|merge` asks on public repos, allows on private.
3. **Inline interpreter scanner**. `python -c`, `node -e`, `perl -e`, `ruby -e`, `deno`, `bun` invocations have their inline code statically scanned for dangerous tokens. Clean code (pure data inspection, arithmetic, JSON parsing) auto-allows with no LLM call. Suspect code defers to the next layer.
4. **Learned auto-allow**. Commands you've manually approved twice (in their normalized form) get appended to `~/.claude-chillbro/learned-allow.txt` and auto-allowed thereafter. See [Self-learning](#self-learning) below.
5. **Static allowlist** (~110 patterns). Read-only operations like `ls`, `cat`, `grep`, `rg`, `git status`, `git log`, `git diff`, `pnpm test`, `pnpm install`, `tsc --noEmit`, `cargo check`, `pytest` get auto-approved. No prompt, no delay.
6. **LLM waterfall** for anything still unknown:
   - **Layer A**: direct Anthropic API call to Haiku 4.5 (~400-900ms). Active when `ANTHROPIC_API_KEY` is set.
   - **Layer B**: headless `claude -p --model haiku` (slow cold start, no key needed). Reuses your existing Claude Code authentication.
   - **Layer C**: defaults to `ask`. Always reachable.

The LLM also receives the model's `description` field as `intent`. A destructive command can classify SAFE if the intent describes an equivalent scope (e.g. `rm -rf <dir>` + intent "remove the now-empty old branch dir after move"). A command that exceeds the stated scope still classifies RISKY.

For file writes: in-project paths auto-allow (creating new files is the whole point of asking the model to create new files). Out-of-cwd writes, `.env*`, `.aws/credentials`, `.ssh/id_*`, `secrets/`, and `credentials.{json,yml,toml,env}` always prompt.

## Self-learning

After **two successful executions** of the same command (in its normalized form) that wasn't already on the static allow list, chillbro promotes it to `~/.claude-chillbro/learned-allow.txt` and auto-allows it on every future invocation. Promotion is based on `PostToolUse` hook firings with exit code 0 — typically that means you approved the command at the permission prompt, and then it ran clean. Static-allow commands never get counted (they're already auto-allowed; no need to track).

Every promotion is recorded in `~/.claude-chillbro/learned-allow.log` (timestamp + source + normalized command) so you can audit what was added and when. Inspect / curate from the CLI:

```bash
chillbro learn list                # alphabetical dump of learned patterns
chillbro learn audit               # recent promotions, newest first
chillbro learn add "<cmd>"         # manually promote a command (source=manual in audit)
chillbro learn forget "<cmd>"      # remove a learned pattern (use exact normalized form)
``` Normalization replaces variable bits (paths, hashes, URLs, branch names) with placeholders so different invocations of the "same" command map to the same key:

```
git checkout feature/foo  ->  git checkout <ref>
pnpm test src/foo.test.ts ->  pnpm test <path>
curl https://api.x.io/y   ->  curl <url>
```

Edit `~/.claude-chillbro/learned-allow.txt` directly to prune mistakes.

## Context-aware probes

A handful of patterns need runtime context to classify correctly. chillbro inspects the environment and decides:

- **`git push`**: targets `main` or `master`, ask. Targets a feature branch, allow.
- **`gh pr|issue|release create|merge`**: public repo (per `gh repo view`), ask. Private or internal repo, allow.

Probe results are cached in memory for the lifetime of the hook process.

## Install

Source repo:

```bash
git clone https://github.com/HthSolid/claude-chillbro ~/Documents/projects/claude-chillbro
```

Symlink into Claude Code's plugin directory so edits to source apply live:

```bash
mkdir -p ~/.claude/plugins
ln -s ~/Documents/projects/claude-chillbro ~/.claude/plugins/claude-chillbro
```

Restart Claude Code. The hooks fire automatically. No `~/.claude/settings.json` changes needed.

You can also install via the [hte-claude-tools](https://github.com/HthSolid/hte-claude-tools) marketplace:

```bash
claude plugin add-marketplace github:HthSolid/hte-claude-tools
claude plugin install claude-chillbro
```

## Requirements

- Node 18+ (for the hook scripts).
- Claude Code CLI on `PATH` (for the LLM fallback).
- Optional: `gh` CLI on `PATH` (for the `gh pr|issue|release` repo-visibility probe). Without it, those commands fall through to ask.

Zero npm dependencies. The hook scripts hand-parse everything.

## Editing the lists

The static lists live in:

- `src/allow.list`: JavaScript regexes, one per line, `#` for comments.
- `src/ask.list`: same format. Checked first; an ask-list match always wins over an allow-list match.

To extend either list, append a regex and restart Claude Code. To shadow a built-in pattern, add a narrower ask pattern that fires earlier.

## Speed: set `ANTHROPIC_API_KEY`

`claude -p` carries a 6-16s cold start (plugin discovery, MCP, hooks). Way too slow for a per-command classifier. If you set `ANTHROPIC_API_KEY` in your shell, chillbro skips `claude -p` and calls Haiku directly via HTTPS. Typical end-to-end is 400-900ms. Falls back to `claude -p` automatically when no key is set.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

## Disabling the LLM fallback

Set `CHILLBRO_TEST_NO_LLM=1` in your shell. Unknown commands then fall through to ask without invoking any LLM (neither the Anthropic API nor `claude -p`). Useful for offline work, testing, or if you want strictly deterministic behavior.

## Emergency killswitch

Set `CHILLBRO_DISABLED=1` and chillbro's hooks no-op immediately. Use this if chillbro is misbehaving and you don't want to uninstall the plugin while diagnosing. Restart Claude Code (or set the env in the launching shell) for the change to take effect.

## Debug log

Set `CHILLBRO_DEBUG=1` and every classification decision is appended as a JSON line to `~/.claude-chillbro/debug.log`. Each entry includes the command, intent, decision, source layer, reason, and latency. Useful when you want to know *why* a particular command went to ask instead of allow.

```bash
tail -f ~/.claude-chillbro/debug.log
```

## Pattern catalog (extensible)

The allow/ask patterns live in [`patterns/`](./patterns) as a versioned data product. See [`patterns/PATTERNS.md`](./patterns/PATTERNS.md) for contribution guide and [`patterns/CHANGELOG.md`](./patterns/CHANGELOG.md) for what each version adds.

**Inspect the active catalog:**

```bash
chillbro patterns status   # version, counts, file paths
chillbro patterns list     # dump all allow + ask + your user-locals
```

**Extend with your own patterns** (no plugin restart needed — the lists re-read on every hook):

```bash
chillbro patterns add-allow '^my-internal-cli\s+(status|list)'
chillbro patterns add-ask   '^my-deploy\s+--prod'
```

User patterns land in `~/.claude-chillbro/user-allow.list` and `~/.claude-chillbro/user-ask.list`. You can also edit those files directly — the CLI is just a convenience wrapper.

**Safety invariant:** user patterns extend, never bypass, the core lists. If you add `^rm\s+-rf` to user-allow, the static ASK list still catches it first because ASK wins.

## Auto-continue mode (multi-phase plans)

For long multi-phase tasks ("execute the 6-phase plan"), Claude normally stops after each phase and waits for you to type "continue". chillbro's auto-continue mode handles that for you: when the assistant stops, a Stop hook reads its final message, asks Haiku whether the plan is mid-flight, and if so emits the configured directive as the next instruction so Claude resumes automatically.

**Toggle mid-session via the `/chillbro` slash command:**

```
/chillbro auto-continue on phases 1-6 message "audit each phase, then continue, dont commit"
/chillbro auto-continue off
/chillbro status
```

The single inline form sets all four things at once: enable, phase range, custom directive, (optional iterations cap). Sub-forms work too:

- `/chillbro auto-continue-message "<text>"` — change the directive
- `/chillbro auto-continue phases <X-Y | N>` — update the range
- `/chillbro auto-continue iterations <N>` — change the safety cap
- `/chillbro reset` — wipe state back to defaults

State persists in `~/.claude-chillbro/auto-continue.json`. The Stop hook reads it on every stop event, so changes take effect immediately (no Claude Code restart).

**How the LLM decides** — for each stop, Haiku gets the assistant's final message plus context (phase range, last completed phase, iteration counter, your directive) and returns one of:

- **CONTINUE** — phase finished, more to go. Hook emits the next-phase instruction as a block reason; Claude resumes.
- **ASK** — ambiguous. Hook emits a clarifying question; Claude answers; hook re-evaluates next time.
- **STOP** — phase range done, blocker detected, or no multi-phase pattern. Hook exits 0; you get the normal prompt.

**Safety belts:**

- Hard iteration cap (default 50, configurable) regardless of phase tracking.
- Phase exhaustion auto-disable: when LLM-detected current phase reaches the upper bound (e.g., phase 6 of `1-6`), auto-continue disables.
- 3 consecutive LLM failures auto-disable to prevent broken sessions from looping.
- `CHILLBRO_DISABLED=1` killswitch disables Stop hook just like the others.
- Every continuation prints `[chillbro auto-continue] CONTINUE (5/50) phase 5/6: <message>` to stderr so you see what's happening.

**Status snapshot:**

```bash
chillbro status
# auto-continue
#   enabled:        YES
#   enabled at:     2026-05-13T14:30:00Z
#   phase range:    1-6
#   last done:      4
#   iterations:     4/50
#   message:        "audit each phase, dont commit"
#   completions:    4
#     - phase 4 @ ...: <summary>
```

## Limits

- The compound-command splitter respects single quotes, double quotes, and backslash escapes, but bails (treats the whole thing as ask) on command substitution (`$(...)` or backticks). This is deliberate, classifying half-evaluated commands is a security trap.
- The learning file is plain text and grows monotonically. There's no automatic pruning; review periodically.
- Probes for `git push` and `gh` add roughly 50 to 200ms of latency on commands matching those prefixes. Cached per hook-process lifetime.
- LLM fallback adds roughly 1 to 2 seconds per call. Only fires on commands the static lists missed; the long tail.

## Project structure

```
.claude-plugin/plugin.json     # Claude Code plugin manifest
hooks/
  hooks.json                   # PreToolUse + PostToolUse registration
  pretool.mjs                  # dispatcher: Bash or Write classifier
  posttool.mjs                 # learning counter, promotion at 2 hits
src/
  allow.list                   # ~150 regex patterns
  ask.list                     # ~75 regex patterns
  classify.mjs                 # Bash classifier pipeline (sync + async, per-layer try/catch)
  classifyWrite.mjs            # Write/Edit classifier
  splitter.mjs                 # quote-aware command splitter
  heredoc.mjs                  # heredoc body stripping + line continuation
  commandNormalize.mjs         # path-prefix / env-prefix / wrap-prefix stripping
  probes.mjs                   # git current branch + gh repo visibility
  inlineInterpreters.mjs       # static safety scan for python -c, node -e, etc.
  llmAnthropic.mjs             # direct Anthropic API call (sub-second)
  llmFallback.mjs              # waterfall: api → claude -p → ask (sets recursion guard)
  state.mjs                    # ~/.claude-chillbro/ state (atomic writes, corruption recovery)
  normalize.mjs                # placeholder substitution for learning
  lists.mjs                    # regex compilation (degrades to [] on read failure)
  debug.mjs                    # CHILLBRO_DEBUG log writer
  autoContinueState.mjs        # auto-continue state (toggle / message / phase range / iterations)
  autoContinueEval.mjs         # Haiku CONTINUE/ASK/STOP evaluator
bin/
  chillbro.mjs                 # CLI control plane for auto-continue
commands/
  chillbro.md                  # /chillbro slash command
test/
  smoke.mjs                    # Bash classifier (110 cases)
  smoke-write.mjs              # Write classifier (14 cases)
  smoke-inline.mjs             # inline interpreter scanner (30 cases)
  smoke-normalize.mjs          # path/env/wrap prefix stripping (33 cases)
  smoke-heredoc.mjs            # heredoc + line continuation (19 cases)
  smoke-failsafe.mjs           # killswitch, recursion guard, corrupt state (7 cases)
  smoke-autocontinue.mjs       # auto-continue state + CLI + Stop hook (18 cases)
```

## Tests

```bash
CHILLBRO_TEST_NO_LLM=1 node test/smoke.mjs
node test/smoke-write.mjs
node test/smoke-inline.mjs
node test/smoke-normalize.mjs
node test/smoke-heredoc.mjs
node test/smoke-failsafe.mjs
```

## License

MIT, see [LICENSE](LICENSE).

## Author

[HTE Switzerland](https://hendrikthurau.enterprises)
