# Changelog

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
