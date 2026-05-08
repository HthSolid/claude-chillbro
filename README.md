# claude-chillbro

A Claude Code plugin that stops the model from asking permission for every `grep`, `cat`, `ls`, and new file you ask it to create.

> "Allow Bash(ls -la)?"
> "Allow Write to src/foo.ts?"
> "Allow Bash(grep -r foo .)?"

You know the feeling. chillbro fixes it.

## What it does

Three layers, in order:

1. **Static allowlist** (~110 patterns). Read-only operations like `ls`, `cat`, `grep`, `rg`, `git status`, `git log`, `git diff`, `pnpm test`, `pnpm install`, `tsc --noEmit`, `cargo check`, `pytest` get auto-approved. No prompt, no delay.
2. **Static asklist** (~75 patterns). Destructive operations like `rm -rf`, `sudo`, `git push --force`, `git reset --hard`, `prisma migrate reset`, `curl -X POST`, `kill -9`, anything touching `.env*` or `~/.ssh/id_*` always prompt you. Never auto-allowed.
3. **LLM fallback**. Anything not on either list gets classified by a one-shot `claude -p --model haiku` call (no API key required, uses your existing Claude Code authentication). Verdict is `SAFE` or `RISKY`; on timeout or parse failure, defaults to `RISKY` so you get the standard prompt.

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

- `src/allow.list` — JavaScript regexes, one per line, `#` for comments.
- `src/ask.list` — same format. Checked first; an ask-list match always wins over an allow-list match.

To extend either list, append a regex and restart Claude Code. To shadow a built-in pattern, add a narrower ask pattern that fires earlier.

## Disabling the LLM fallback

Set `CHILLBRO_TEST_NO_LLM=1` in your shell. Unknown commands then fall through to ask without invoking `claude -p`. Useful for offline work, testing, or if you want strictly deterministic behavior.

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
  classify.mjs                 # Bash classifier pipeline
  classifyWrite.mjs            # Write/Edit classifier
  splitter.mjs                 # quote-aware command splitter
  probes.mjs                   # git current branch + gh repo visibility
  llmFallback.mjs              # claude -p subprocess wrapper
  state.mjs                    # ~/.claude-chillbro/ state
  normalize.mjs                # placeholder substitution for learning
  lists.mjs                    # regex compilation
test/
  smoke.mjs                    # 25 Bash classifier cases
  smoke-write.mjs              # 14 Write classifier cases
```

## Tests

```bash
node test/smoke.mjs        # Bash classifier
node test/smoke-write.mjs  # Write classifier
```

## License

MIT, see [LICENSE](LICENSE).

## Author

[HTE Switzerland](https://hendrikthurau.enterprises)
