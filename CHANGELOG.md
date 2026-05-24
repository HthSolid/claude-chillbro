# Changelog

## 0.1.8 — 2026-05-24

Dev-loop coverage audit. The static allowlist was missing most non-read-only dev verbs (`cp`, `mv`, `rsync`, `git checkout`, `git stash`, `git fetch`, `git tag -a`, `git diff`, `git show`, `git rev-parse`, `git reset --soft`, `git rebase --(abort|continue|skip)`, `git cherry-pick --(abort|continue|skip)`, `git branch`, `git remote`, `git reflog`, `gh pr/issue/release view|list`, `chmod +x`, `python3 -m`, `node app.js`, `npm run X`, `./scripts/foo.sh`, `diff`, `sha256sum`, etc.). Every one of these forced the LLM fallback or asked.

**Added to allow.list** (83 new patterns):
- File ops: `cp`, `mv`, `rsync`, `ln -sf`.
- Git non-destructive: `checkout/switch` (branch + `-b/-c`), `stash` (all subcommands), `fetch`, `tag -l/-a`, `rev-parse`, `show`, `diff`, `reflog`, `branch` (list/show), `remote` (read), `merge-base`, `blame`, `grep`, `describe`, `ls-files`, `ls-tree`, `cat-file`, `worktree list/add`, `config --get/--list`, `shortlog`, `whatchanged`.
- Git control-only: `cherry-pick --(abort|continue|skip|quit)`, `rebase --(abort|continue|skip|quit|edit-todo|show-current-patch)`, `reset --soft`.
- GitHub CLI read: `gh (pr|issue|release|repo|workflow|run|gist|label|secret) (view|list|status|diff)`, `gh api repos/...` (read endpoints).
- chmod: `+x`, `u+x`, `a+x`, `ugo+x`, three-digit modes `0-6XX` (rwx for owner/group/other but world-executable bit unset).
- Python / Node script run: `python3 -m`, `python3 file.py`, `node file.[mc]?js`, `node test/`, `node scripts/`.
- npm/pnpm/yarn: read ops + `npm run <task>`, `pnpm run <task>`.
- Project scripts: `./scripts/foo`, `scripts/foo.sh`.
- Hashing/diff: `diff`, `cmp`, `sha(1|224|256|384|512)sum`, `md5sum`.

**Safety hole fixed**: the existing ASK pattern `chmod (0?7XX|+s)` missed numeric setuid/setgid (`chmod 4755`, `chmod 2755`, `chmod 6755`) and the symbolic forms `u+s`, `g+s`. Extended to `chmod ([2467]XXX|+s|g+s|u+s|0?7XX)`.

**Destructive variants still ASK** (and are already covered by ask.list): `git push --force[-with-lease]`, `git push --mirror|--delete`, `git push <r> :<tag>`, `git reset --hard`, `git clean -f`, `git branch -D|--delete`, `git tag -d|--delete`, `git checkout -- <file>`, `git commit --amend`, `git rebase -i`, `git filter-(branch|repo)`, `chmod -R`, `chmod 7XX`, `chmod +s`, `gh release delete|edit`, `gh repo delete|archive`, `tar -cf`, `zip -r`.

**Tests**: new `test/smoke-devloop.mjs` (91 cases — every new allow pattern positively + every destructive variant negatively). **498 tests total** across 14 suites.

## 0.1.7 — 2026-05-24

chillbro now handles `Read` and `mcp__*` tool calls in addition to `Bash` and `Write/Edit`. Previously these went directly to Claude Code's permission UI and required entries in `settings.json` `permissions.allow`. Now they're classified by the same allow/ask/learn pipeline.

**Cases that now auto-allow**:
- `mcp__playwright__browser_fill_form` (and `browser_press_key`, `browser_hover`, `browser_select_option`, `browser_drag`, `browser_drop`, `browser_handle_dialog`, etc.) — anything safe in a sandboxed browser context.
- Reading `~/.claude.json` and other dotfiles in `$HOME` — config files are not credentials.
- `.env` / `.env.local` — the model needs to read configuration; chmod the file if you need to keep it private.

**Read classifier** ([src/classifyRead.mjs](src/classifyRead.mjs)):
- Default ALLOW for everything that isn't on the sensitive list.
- ASK for SSH private keys (`.ssh/id_*`, `*.pem`, `*.key` in `.ssh`), AWS/GCloud credentials, `.netrc`, `.pgpass`, files named `id_rsa`/`id_ed25519`/`id_ecdsa`/`id_dsa`, anything matching `private[-_]?key`.
- Public keys (`known_hosts`, `authorized_keys`, `.ssh/config`) explicitly stay ALLOW.
- User override: `~/.claude-chillbro/read-deny.list` for extra paths to ASK on.

**MCP classifier** ([src/classifyMcp.mjs](src/classifyMcp.mjs)):
- Per-server allow patterns. Currently bundled: `playwright` (every `browser_*` minus `_unsafe`), `dejavu-auditor` (audit/list/get), `claude-mem` (search/explore/timeline/make-plan), `hugging-face` (search/fetch/details), `mcp-search` (search/outline/timeline), `remotion` (docs), `claude-flow` (read/query/status/health/metrics).
- Always-ASK suffix list runs first and wins over server allows: `*_unsafe`, `*_(delete|destroy|drop|remove|rm|purge|wipe|reset|terminate|kill|cancel|shutdown|stop|halt)`, `*_(publish|release|deploy|push|upload)`, `*_(send|transfer|pay|charge|withdraw|refund|spawn|create_pr|merge)`, `*_(write|create|update|insert|set|put|patch|modify|replace)`, `authenticate*`, `complete_authentication`.
- Unknown server or unmatched tool → no decision (Claude Code default flow handles).
- User override: `~/.claude-chillbro/mcp-allow.list` (glob patterns) for unknown servers / case-by-case allows.

**Hook matcher** ([hooks/hooks.json](hooks/hooks.json)): `Bash|Write|Edit|MultiEdit|NotebookEdit|Read|mcp__.*`.

**Tests**: new `test/smoke-read.mjs` (23 cases) and `test/smoke-mcp.mjs` (30 cases). **407 tests total** across 13 suites.

## 0.1.6 — 2026-05-23

Subshell substitutions (`$(...)`, backticks) now route to the LLM fallback instead of being auto-asked at the splitter layer.

**The bug**: examples like `TOKEN=$(curl -s localhost/auth/login | python3 -c "import sys,json; print(...)"); curl -s localhost/api -H "Authorization: Bearer $TOKEN"` were always asking. The splitter bails on unquoted `$(...)` because it can't safely segment around a subshell, and that bail was previously turned into a deterministic ASK — the LLM never got a chance to weigh in even though it can read the whole command including the subshell body.

**The fix**: distinguish the two splitter bail-reasons. `subshell` now returns `source: 'unknown'`, which makes the `classify()` waterfall fall through to the LLM. `unbalanced` (unterminated quote) is still a deterministic ASK because that's almost always user error.

**What changes for users**:
- `VAR=$(read-only-cmd ...)` patterns get classified by the LLM and (when localhost-only, etc.) auto-approved.
- `eval "$(starship init bash)"` style still asks because `eval` is on the static-ask list — the subshell bail no longer hides the real reason.
- `cd "$(git rev-parse --show-toplevel)"` was already working (quoted subshell passes through the splitter); behavior unchanged.
- Quotes-never-closed cases (`echo "oops`) still ask — likely typo, not worth burning an LLM call on.

**Tests**: new `test/smoke-subshell.mjs` with 15 cases (splitter bail-reasons, real-world TOKEN=$(curl) routing, common patterns, unbalanced-quote, regression negatives). **354 tests total** across 11 suites.

## 0.1.5 — 2026-05-22

Broader allow-list audit: catch the common shell verbs that were silently forcing first-time users into LLM-or-ask for unambiguously safe commands.

**Sourcing well-known shell init files** (the case that triggered the audit):

- `source` (and POSIX `.` shorthand) for these specific paths: `~/.cargo/env`, `~/.local/share/cargo/env`, `~/.nvm/nvm.sh`, `~/.bashrc`, `~/.zshrc`, `~/.profile`, `~/.bash_profile`, `~/.bash_aliases`, `~/.zprofile`, `~/.zshenv`, `~/.fzf.bash`, `~/.fzf.zsh`, `~/.asdf/asdf.sh`, `~/.rbenv/rbenv.sh`, `~/.sdkman/bin/sdkman-init.sh`, `~/.deno/env`, `~/.bun/_bun`.
- Both `~/` and `$HOME/` paths supported, quoted or unquoted.
- Generic `source <anything>` still goes through the LLM/ask path.

**Shell environment / option toggles** (local to shell, no exec):

- `export VAR=...`, `unset VAR`, `set -e/x/+e/-o pipefail`, `shopt -s/-u`, `alias`, `unalias`. Subshell substitutions (`set $(...)`) still bail at the splitter level.

**Filesystem create** (idempotent or empty; out-of-cwd writes typically fail on perms):

- `mkdir -p`, `touch <file>`, `ln -s`. Hard links (`ln <src> <dst>` without `-s`) intentionally NOT auto-allowed.

**Job control** (shell-internal state, no new exec):

- `disown`, `wait`, `jobs`, `bg`, `fg`, `history`.

**Documentation lookup**:

- `man`, `whatis`, `apropos`, `info`, `help`.

**Read-only inspection of compressed files**:

- `zcat`, `bzcat`, `xzcat`, `zless`, `zgrep`, `unzip -l`. Extract forms (`unzip <file>`, `unzip -o`) intentionally NOT auto-allowed.

**Read-only archive listing**:

- `tar -tf`, `tar -tzf`, `tar -tjf`, `tar --list`, etc. Extract/create (`tar -xf`, `tar -cf`, `tar -rf`, `tar -uf`) intentionally NOT auto-allowed.

**Clipboard read**:

- `pbpaste`, `xclip -o`, `xsel -o`.

**Hex / binary inspection**:

- `xxd`, `od`, `hexdump`, `strings`.

**Why this audit**: relying on user reports to discover missing patterns is bad UX — new users would get prompted forever on the same patterns and never know to flag them. This sweep captures the shell verbs that are unambiguously safe but were previously falling through to the LLM (slow path) or default ask (annoying path). 95%+ of typical dev-loop bash invocations should now classify in the static layer.

**Tests**: 61 new cases in `test/smoke.mjs` covering positive variants of every new pattern plus negatives for look-alike-but-destructive forms (`unzip -o`, `tar -xf`, `tar -cf`, hard `ln`, `set $(...)`). **141 tests total** across all suites (97 smoke + 30 inline + 14 write), all passing.

## 0.1.4 — 2026-05-13

Architectural hardening: real-world session data showed broad classes of safe commands escalating to LLM-or-ask for systemic reasons (path prefixes, env-var prefixes, wrap commands, heredocs) plus several failure modes that could silently break the whole plugin. This release patches both the patterns and the architecture.

### Pattern coverage (new allow patterns)

- **Sourcing well-known shell init files**: `source` / `.` shorthand for `~/.cargo/env`, `~/.local/share/cargo/env`, `~/.nvm/nvm.sh`, `~/.bashrc`, `~/.zshrc`, `~/.profile`, `~/.bash_profile`, `~/.bash_aliases`, `~/.zprofile`, `~/.zshenv`, `~/.fzf.bash`, `~/.fzf.zsh`, `~/.asdf/asdf.sh`, `~/.rbenv/rbenv.sh`, `~/.sdkman/bin/sdkman-init.sh`, `~/.deno/env`, `~/.bun/_bun`. Both `~/` and `$HOME/` paths, quoted or unquoted.
- **Shell environment / option toggles**: `export`, `unset`, `set` (any flags), `shopt`, `alias`, `unalias`.
- **Filesystem create**: `mkdir`, `touch`, `ln -s`. Hard links (`ln` without `-s`) intentionally NOT auto-allowed.
- **Job control**: `disown`, `wait`, `jobs`, `bg`, `fg`, `history`.
- **Documentation**: `man`, `whatis`, `apropos`, `info`, `help`.
- **Compressed-file inspection**: `zcat`, `bzcat`, `xzcat`, `zless`, `zgrep`, `unzip -l`. Extract forms intentionally NOT auto-allowed.
- **Archive listing**: `tar -tf`, `tar -tzf`, `tar --list`, etc. Extract / create intentionally NOT auto-allowed.
- **Clipboard read**: `pbpaste`, `xclip -o`, `xsel -o`.
- **Hex / binary inspection**: `xxd`, `od`, `hexdump`, `strings`.

### Command normalization (fixes the bulk of misses)

Real-world bash invocations carry baggage that defeated anchored regex patterns. `src/commandNormalize.mjs` strips this baggage BEFORE matching:

- **Path prefixes**: `~/.cargo/bin/cargo`, `$HOME/.local/bin/foo`, `/usr/local/sbin/x` → matched as plain `cargo` / `foo` / `x`.
- **Env-var prefixes**: `KEY=val cmd` → matched as plain `cmd`.
- **Wrap prefixes**: `time cmd`, `nice cmd`, `nohup cmd`, `ionice cmd`, `\cmd` (escape) → matched as plain `cmd`.

A fixed-point loop applies all three so any combination/order works (`KEY=val time ~/.cargo/bin/cargo build` → `cargo build`). The ASK list still matches against the ORIGINAL segment so a normalized form can't smuggle a destructive substring past the deny list (`~/.cargo/bin/rm -rf /` still asks).

### Splitter improvements

- **Heredoc bodies are stripped** before splitting (`src/heredoc.mjs`). Previously `cat <<EOF\npub fn x() { let y = 1; }\nEOF` split on `;` inside the body producing garbage segments like `}` or `let`. Handles `<<EOF`, `<<-EOF` (tab-stripping), `<<'EOF'` (quoted), `<<"EOF"`, `<<\EOF` (escaped), multiple heredocs in one command, and unterminated heredocs.
- **Line continuations** (`\\\n`) are collapsed to a single space before splitting so multi-line shell statements are treated as one segment.

### Failsafe contract

- **`CHILLBRO_DISABLED=1`** killswitch — emergency disable without uninstalling. Both pretool and posttool exit 0 immediately when set.
- **`CHILLBRO_RECURSION_GUARD=1`** — set automatically by `llmFallback.mjs` when spawning `claude -p`. The nested Claude Code process's chillbro hook detects the guard and no-ops, breaking any hook → claude -p → hook recursion loop.
- **Per-layer try/catch** in `classify.mjs`. Every layer (normalize, ask-match, git-push-probe, gh-visibility-probe, inline-scanner, learn-normalize, allow-match, preprocess, split, load-learned) is wrapped so a thrown error degrades to "no opinion" rather than killing the whole classification.
- **Atomic state writes** (`src/state.mjs`) — write to temp file then rename. Avoids torn writes that produce malformed JSON if the process is killed mid-write.
- **State-file corruption recovery** — `loadCounters` detects bad JSON / wrong shape, logs to stderr, moves the corrupt file aside (`counters.json.corrupt.<timestamp>`), and returns empty so subsequent runs work.
- **Lists.mjs degradation** — if `allow.list` or `ask.list` can't be read, log + return empty list instead of throwing. Plugin still functions (everything goes to LLM/ask) instead of failing hard.

### Observability

- **`CHILLBRO_DEBUG=1`** — when set, every classification appends a JSON line to `~/.claude-chillbro/debug.log` with `{ts, pid, command, intent, decision, source, reason, ms}`. Use `tail -f` to see exactly which layer made each decision.

### Tests

130 cases passing across all suites (110 smoke + 30 inline + 14 write + 33 normalize + 19 heredoc + 7 failsafe). Three new test files: `smoke-normalize.mjs`, `smoke-heredoc.mjs`, `smoke-failsafe.mjs`.

## 0.1.3 — 2026-05-09

Audit follow-ups + speed for the no-key path.

- **Fix (critical)**: hook timeout in `hooks/hooks.json` was 8s but the `claude -p` subprocess timeout was 12s. Claude Code killed the hook before `claude -p` could return, making the no-key fallback layer effectively unreachable. Bumped hook timeout to 16s, giving the slow path the budget it needs.
- **Speed**: added isolation flags to the `claude -p` invocation (`--plugin-dir <empty>`, `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`, `--setting-sources ''`). Without isolation, the nested `claude` process discovers and loads ALL of the user's installed plugins (including chillbro itself, plus dejavu's session_start.py, etc.) at every classification. Cold start drops from 12-16s to **~4s**. No API key required. Cache is also working: ~25k tokens cache_read on the second call.
- **Doc**: README "What it does" now correctly lists six layers (added the missing **learned auto-allow** layer between inline-interpreter and static allow).
- **Cleanup**: removed em-dashes from the LLM SYSTEM prompts (`src/llmAnthropic.mjs`, `src/llmFallback.mjs`), the README, and the on-disk `~/.claude-chillbro/learned-allow.txt` header.
- **Cleanup**: removed redundant `(?:f|file)\.write` regex in `src/inlineInterpreters.mjs` (now subsumed by the broader chain-depth-agnostic `\.(write|...)\(` pattern added in 0.1.2).

## 0.1.2 — 2026-05-09

Speed and context overhaul.

- **Add**: direct Anthropic API call as the first LLM layer. When `ANTHROPIC_API_KEY` is set, classification takes ~400-900ms instead of the 6-16s `claude -p` cold-start. Falls back to `claude -p` automatically when no key is set, and to `ask` if both are unavailable.
- **Add**: tool description ("intent") is now passed to the classifier. The model's own one-line "why I'm running this" is treated as scope-bound authority. `rm -rf <dir>` with intent "remove the now-empty old branch dir after move" classifies SAFE; without that context it stays RISKY.
- **Add**: static safety scanner for inline interpreter calls (`python -c`, `node -e`, `perl -e`, `ruby -e`, `deno`, `bun`). Inline code is parsed and scanned against a deny-list of dangerous-token patterns covering shell-out, filesystem writes, network mutations, eval/import tricks. Clean code auto-allows with no LLM call. Suspect code defers to LLM. Solves the canonical `cargo metadata ... | python3 -c "..."` pattern instantly with zero network.
- **Refactor**: split classifier into sync `classifyStatic` and async `classify`. Used internally by `PostToolUse` to skip the LLM waterfall during the learning pass (was previously firing the LLM on every successful unknown command).
- **Tests**: 30 new inline-interpreter cases + 6 new bash cases. 66 total, all passing.

## 0.1.1 — 2026-05-08

- **Fix**: LLM fallback failed silently on Windows because `spawnSync('claude', ...)` could not resolve `claude.cmd` without `shell: true`. Now uses `shell: true` on Windows, increases the timeout to 12s, and logs spawn/exit/parse failures to stderr so they surface in `claude --debug hooks`.
- **Add**: `cd`, `pushd`, `popd`, `node --check`, `node -c`, `npx tsc`, `npx eslint`, `npx prettier`, `npx vitest`, `npx jest`, and read-only `npx esbuild` invocations to the static allow list. These were previously falling through to the LLM (or, on Windows, all the way to ask) for no reason — they are unambiguously safe.

## 0.1.0 — 2026-05-08

Initial release.

- `PreToolUse` hook for `Bash`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`.
- Static allowlist (~110 regex patterns) covering read-only filesystem, search, git read-only, package-manager queries, build/test/lint, system info, docker read-only, network read-only.
- Static asklist (~75 regex patterns) covering filesystem destruction, privilege escalation, git history rewrites, database destruction, container/IaC destruction, outbound network mutations, secret-touching paths, process-killing, global installs.
- Quote-aware compound-command splitter (handles `&&`, `||`, `;`, `|`; bails on command substitution).
- Context-aware probes: current branch for `git push` (main/master ask, feature branch allow), `gh repo view` for `gh pr|issue|release create|merge` (public ask, private allow).
- File-write classifier: in-project paths allow, out-of-cwd / `.env*` / `.aws/credentials` / `.ssh/id_*` / `secrets/` paths ask.
- `PostToolUse` learning: commands the user approved twice get appended to `~/.claude-chillbro/learned-allow.txt` and auto-allowed thereafter.
- LLM fallback for unknown commands via headless `claude -p --model haiku`. No API key required; reuses the user's existing Claude Code authentication.
- 39 smoke-test cases across Bash and Write classifiers, all passing.
