# claude-chillbro Pattern Catalog

The two pattern files in this directory are the **data product** behind chillbro's classifier. They control which Bash commands auto-approve without prompting the user.

- **`allow.list`** — commands that match these regexes auto-approve.
- **`ask.list`** — commands that match these always prompt the user, regardless of any allow match.

The classifier checks `ask.list` first; an ASK match always wins over an ALLOW match. This keeps `~/.cargo/bin/rm -rf /tmp/foo` asking even when path-prefix normalization would otherwise route it through the allow list.

## Versioning

The catalog is versioned independently of the plugin in [`META.json`](./META.json). See [`CHANGELOG.md`](./CHANGELOG.md) for what changed in each version.

Inspect the active catalog from the CLI:

```bash
chillbro patterns status      # version, counts, categories
chillbro patterns list        # full pattern list (allow + ask)
```

## User-local overrides

You can add your own patterns without modifying the plugin install. Two optional files in your state dir take effect immediately (re-read on every hook fire — no Claude Code restart needed):

- `~/.claude-chillbro/user-allow.list`
- `~/.claude-chillbro/user-ask.list`

Same regex-per-line format. CLI shortcut:

```bash
chillbro patterns add-allow '^my-internal-cli\s+(status|list)'
chillbro patterns add-ask   '^my-deploy\s+--prod'
```

## Pattern conventions

Patterns are JavaScript regexes, one per line. Lines starting with `#` are comments; blank lines are ignored.

**Anchoring:**
- Always anchor at the start with `^` — patterns match against the trimmed command segment, not anywhere in the line.
- End single-word patterns with `(\s|$)` to avoid matching prefixes (`^rm(\s|$)` — not `^rm`, which would also match `rmdir`).

**Normalization-aware:**
- Patterns are tested against the **normalized** segment (path-prefix, env-prefix, and wrap-prefix stripped). So `^cargo\s+build` automatically catches `~/.cargo/bin/cargo build`, `KEY=val cargo build`, `time cargo build`, etc.
- The ASK list runs against the **original** segment too, so destructive substrings can't be hidden by normalization.

**Specificity:**
- Prefer narrow patterns over broad ones. `^git\s+status(\s|$)` is safer than `^git`.
- For commands with subcommands, list each safe form explicitly: `^npm\s+(test|t|lint|build|typecheck|check)(\s|$)`.
- For dangerous-by-default verbs, allow only specific safe forms (e.g., `^unzip\s+-l\s` for list-archive, never bare `^unzip`).

**Compose-with-ask:**
- When an allow pattern would let a destructive variant through (e.g., `^find(\s|$)` matches `find . -delete`), add the destructive variant to ask.list first. ASK wins, so the safety is preserved.

## Contributing a pattern

1. Write the pattern in the right file under `patterns/`.
2. Add at least one positive test case (matches the intended form) and one negative test case (doesn't over-match a destructive sibling) in `test/smoke.mjs`.
3. Run the test suite: `node test/smoke.mjs`.
4. Bump `patterns/META.json#patterns_version` (semver: `MAJOR` if you remove or narrow an existing pattern, `MINOR` for additions, `PATCH` for clarifications).
5. Add an entry to `patterns/CHANGELOG.md` describing what category and why.
6. Open a PR against the public `claude-chillbro` repo.

### When in doubt

- If a command can have a destructive option (`rm -i` is safe, `rm` alone is dangerous), put both the safe form in `allow` AND the broad dangerous form in `ask`. ASK wins, so the safety holds.
- Read-only flags of inherently destructive tools (`gh pr view`, `psql -c "SELECT"`, `unzip -l`) are good candidates for allow. Their write counterparts are good candidates for ask.
- For interpreters (`python -c`, `node -e`), don't add a top-level allow — `src/inlineInterpreters.mjs` handles those with a static safe-code scan.

## Safety model

- The static lists are the first line of defense and the dominant code path. The LLM fallback only fires on commands neither list matches.
- The static ASK list always wins, so even a perfectly normalized destructive command (`~/.cargo/bin/rm -rf /`) escalates to the user prompt.
- User overrides extend, never bypass, the safety model: a user-allow pattern that matches a destructive command will still be overruled by the static ASK list.
