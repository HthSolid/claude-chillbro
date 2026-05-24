# Pattern Catalog Changelog

Pattern-only changes. Plugin-level changes (hooks, classifier behavior, etc.) live in the top-level [`CHANGELOG.md`](../CHANGELOG.md).

## 1.0.0 — 2026-05-18

Initial extraction of patterns into a versioned data package. Lists moved from `src/{allow,ask}.list` to `patterns/{allow,ask}.list`. Added [`PATTERNS.md`](./PATTERNS.md) contribution guide + [`META.json`](./META.json) metadata.

**Allow categories** (~280 patterns):
- File inspection: ls, cat, head, tail, wc, file, stat, tree, pwd, du, df, etc.
- Search: grep, rg, ag, ack, find (without -delete), sort, uniq, sed/awk (without -i)
- Git read: status, log, diff, show, blame, branch (list), remote, ls-files, etc.
- Package managers read: npm/pnpm/yarn list, view, why, outdated
- Package managers local-install: npm install (no -g), pnpm install, etc.
- Build / test / lint: tsc, cargo build|check|test|clippy, pytest, go test/build/vet, vitest, jest, eslint, prettier, biome
- Process / system info: ps, top -n 1, uname, whoami, id, date, lscpu, free
- Tool versions: `<cmd> --version`, `which`, `whereis`
- Shell builtins: echo, printf, clear, true, false, cd, pushd, popd, export, unset, set, shopt, alias
- Filesystem create (idempotent): mkdir, touch, ln -s
- Job control: jobs, wait, disown, bg, fg, history
- Documentation: man, whatis, apropos, info, help
- Compressed inspect: zcat, bzcat, xzcat, zgrep, zless, unzip -l
- Archive list: tar -tf, tar --list, tar -tzf (extract NOT allowed)
- Clipboard read: pbpaste, xclip -o, xsel -o
- Hex / binary: xxd, od, hexdump, strings
- Shell-init sourcing: source ~/.cargo/env, ~/.nvm/nvm.sh, ~/.bashrc, etc.
- gh read-only: gh repo view, pr list, issue list, api, search, auth status
- psql read-only: psql -c "SELECT|SHOW|EXPLAIN|...", psql \\dt, psql -l, psql --version
- Docker read: docker ps, images, logs, inspect, version, info, stats
- Network read: ping -c, dig, nslookup, host

**Ask categories** (~120 patterns):
- Filesystem destruction: rm -rf, find -delete, dd, mkfs, chmod -R, sed -i
- Privilege escalation: sudo, su, doas
- Git history rewrites: push --force, reset --hard, clean -fd, filter-branch, branch -D, rebase -i, etc.
- Database destruction: prisma migrate reset, --accept-data-loss, DROP, TRUNCATE, FLUSHDB
- Containers / IaC destruction: docker rm -f, kubectl delete, helm uninstall, terraform destroy
- Outbound mutations: curl -X POST, gh pr merge, gh release create, ssh, scp, rsync to remote, npm publish
- Secrets / credentials: .env*, .aws/credentials, .ssh/id_*
- Process killing: kill -9, killall, pkill, systemctl stop/restart
- Global installs: npm install -g, pnpm add -g, cargo install
- Shell injection: eval, `curl ... | bash`, `$(curl ...)`

**Safety invariants:**
- ASK list checked first; matches always win
- ASK runs against the original command segment (normalization can't mask)
- User-local overrides extend, never bypass, the static safety patterns
