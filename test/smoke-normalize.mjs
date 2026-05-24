#!/usr/bin/env node
// Tests for command-prefix normalization (path / env / wrap).
//
// These run a single transform per case and check the output. End-to-end
// cases that verify the normalizer actually causes static-allow matches live
// in test/smoke.mjs.

import {
  stripPathPrefix,
  stripEnvPrefix,
  stripWrapPrefix,
  normalizeForMatching,
} from '../src/commandNormalize.mjs';

const cases = [
  // [transform, input, expected, label]

  // --- path prefix ---
  [stripPathPrefix, '~/.cargo/bin/cargo build',                  'cargo build',     'tilde cargo bin'],
  [stripPathPrefix, '$HOME/.cargo/bin/cargo --version',          'cargo --version', '$HOME cargo bin'],
  [stripPathPrefix, '/home/me/.cargo/bin/cargo test',            'cargo test',      'absolute cargo bin'],
  [stripPathPrefix, '/usr/local/bin/rg foo',                     'rg foo',          'usr/local/bin'],
  [stripPathPrefix, '/opt/homebrew/sbin/launchd',                'launchd',         'sbin variant'],
  [stripPathPrefix, '~/.local/share/cargo/bin/cargo run',        'cargo run',       'nested .local/share'],
  [stripPathPrefix, '~/.bun/bin/bun install',                    'bun install',     'bun bin'],
  [stripPathPrefix, 'cargo build',                                'cargo build',     'no prefix unchanged'],
  [stripPathPrefix, '/home/me/myproject/binfoo',                 '/home/me/myproject/binfoo', 'no /bin/ in path'],
  [stripPathPrefix, '~/.cargo/bin/cargo build --release && echo ok', 'cargo build --release && echo ok', 'preserves trailing args'],
  // npm convention: project-local node_modules/.bin/ executables
  [stripPathPrefix, './node_modules/.bin/jest --testPathPattern=foo', 'jest --testPathPattern=foo', 'node_modules/.bin (jest)'],
  [stripPathPrefix, './node_modules/.bin/eslint src/',           'eslint src/',           'node_modules/.bin (eslint)'],
  [stripPathPrefix, './node_modules/.bin/prettier --write src/', 'prettier --write src/', 'node_modules/.bin (prettier)'],
  [stripPathPrefix, '../tools/bin/foo --bar',                    'foo --bar',             'relative ../ path'],

  // --- env prefix ---
  [stripEnvPrefix, 'FOO=bar cargo run',                           'cargo run',       'single env var'],
  [stripEnvPrefix, 'FOO=1 BAR=2 BAZ=qux cmd arg',                 'cmd arg',         'multiple env vars'],
  [stripEnvPrefix, 'DEJAVU_AUDIT_DISABLED=1 cargo build',         'cargo build',     'long env name'],
  [stripEnvPrefix, '_PRIVATE=x cmd',                              'cmd',             'underscore-prefixed env'],
  [stripEnvPrefix, 'NODE_ENV=production npm start',               'npm start',       'real-world example'],
  [stripEnvPrefix, 'cargo build',                                  'cargo build',    'no env prefix unchanged'],
  [stripEnvPrefix, 'lowercase=foo cmd',                            'lowercase=foo cmd', 'lowercase NOT stripped (not env-var convention)'],
  [stripEnvPrefix, 'FOO',                                          'FOO',            'env var name alone is unchanged'],

  // --- wrap prefix ---
  [stripWrapPrefix, 'time cargo test',                            'cargo test',      'time wrap'],
  [stripWrapPrefix, 'nice -n 10 cargo build',                     '-n 10 cargo build', 'nice with arg (becomes args of next)'],
  [stripWrapPrefix, 'nohup ./serve.sh',                           './serve.sh',      'nohup wrap'],
  [stripWrapPrefix, 'ionice -c3 cargo test',                      '-c3 cargo test',  'ionice with arg'],
  [stripWrapPrefix, '\\rm -rf /tmp/foo',                          'rm -rf /tmp/foo', 'escape prefix to bypass alias'],
  [stripWrapPrefix, 'cargo build',                                 'cargo build',    'no wrap unchanged'],
  // `command <verb>` strips, `command -v <verb>` does NOT (dual-usage preservation)
  [stripWrapPrefix, 'command rg foo',                             'rg foo',          'command bypass strips'],
  [stripWrapPrefix, 'command grep -n pat file',                   'grep -n pat file','command + flagged subcmd'],
  [stripWrapPrefix, 'command -v rg',                              'command -v rg',   'command -v stays (where-is form)'],
  [stripWrapPrefix, 'command -V grep',                            'command -V grep', 'command -V stays'],
  [stripWrapPrefix, 'command --help',                             'command --help',  'command --help stays'],
  [stripWrapPrefix, 'command rm -rf foo',                         'rm -rf foo',      'command rm strips → ASK list still catches rm -rf'],

  // --- combined (fixed-point) ---
  [normalizeForMatching, 'time cargo build',                      'cargo build',     'wrap only'],
  [normalizeForMatching, 'KEY=val cargo build',                   'cargo build',     'env only'],
  [normalizeForMatching, '~/.cargo/bin/cargo build',              'cargo build',     'path only'],
  [normalizeForMatching, 'KEY=val time cargo build',              'cargo build',     'env + wrap'],
  [normalizeForMatching, 'time KEY=val cargo build',              'cargo build',     'wrap + env (different order)'],
  [normalizeForMatching, 'KEY=val time ~/.cargo/bin/cargo build', 'cargo build',     'all three combined'],
  [normalizeForMatching, '~/.cargo/bin/cargo build',              'cargo build',     'idempotent on second pass'],
  [normalizeForMatching, 'cargo build',                            'cargo build',    'no transforms needed'],
  [normalizeForMatching, '',                                       '',               'empty unchanged'],
];

let pass = 0, fail = 0;
for (const [fn, input, expected, label] of cases) {
  const got = fn(input);
  if (got === expected) {
    pass++;
    console.log(`  ok    ${label}  →  "${got}"`);
  } else {
    fail++;
    console.error(`  FAIL  ${label}`);
    console.error(`        input:    "${input}"`);
    console.error(`        expected: "${expected}"`);
    console.error(`        got:      "${got}"`);
  }
}
console.log(`\n${pass} passed, ${fail} failed (of ${cases.length})`);
process.exit(fail === 0 ? 0 : 1);
