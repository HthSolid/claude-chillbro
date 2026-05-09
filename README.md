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

After you manually approve the same command twice (in its normalized form), chillbro promotes it to `~/.claude-chillbro/learned-allow.txt` and auto-allows it on every future invocation. Normalization replaces variable bits (paths, hashes, URLs, branch names) with placeholders so different invocations of the "same" command map to the same key:

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
  allow.list                   # ~110 regex patterns
  ask.list                     # ~75 regex patterns
  classify.mjs                 # Bash classifier pipeline (sync + async)
  classifyWrite.mjs            # Write/Edit classifier
  splitter.mjs                 # quote-aware command splitter
  probes.mjs                   # git current branch + gh repo visibility
  inlineInterpreters.mjs       # static safety scan for python -c, node -e, etc.
  llmAnthropic.mjs             # direct Anthropic API call (sub-second)
  llmFallback.mjs              # waterfall: api → claude -p → ask
  state.mjs                    # ~/.claude-chillbro/ state
  normalize.mjs                # placeholder substitution for learning
  lists.mjs                    # regex compilation
test/
  smoke.mjs                    # Bash classifier (36 cases)
  smoke-write.mjs              # Write classifier (14 cases)
  smoke-inline.mjs             # inline interpreter scanner (30 cases)
```

## Tests

```bash
CHILLBRO_TEST_NO_LLM=1 node test/smoke.mjs
node test/smoke-write.mjs
node test/smoke-inline.mjs
```

## License

MIT, see [LICENSE](LICENSE).

## Author

[HTE Switzerland](https://hendrikthurau.enterprises)
