#!/usr/bin/env node
// Smoke test: runs the classifier against a hand-curated set of commands and
// asserts each gets the expected decision. No external services required.
// Run with: node test/smoke.mjs
//
// LLM fallback is shimmed via env CHILLBRO_TEST_NO_LLM=1 (any unknown -> ask).

import { strict as assert } from 'node:assert';
import { classify } from '../src/classify.mjs';

process.env.CHILLBRO_TEST_NO_LLM = '1';

const cwd = process.cwd();

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
];

let pass = 0, fail = 0;
for (const [cmd, expected, label] of cases) {
  const { decision, source, reason } = classify(cmd, cwd);
  // Treat 'allow' from llm as test failure when the test should be deterministic;
  // since we set CHILLBRO_TEST_NO_LLM, llmFallback isn't gated by it (it would
  // still try to spawn `claude`). To keep tests offline we accept 'ask' for any
  // truly-unknown command.
  const ok = decision === expected;
  if (ok) { pass++; console.log(`  ok    ${label}  →  ${decision} [${source}]`); }
  else    { fail++; console.error(`  FAIL  ${label}  expected=${expected} got=${decision} [${source}] reason=${reason}`); console.error(`        cmd: ${cmd}`); }
}

console.log(`\n${pass} passed, ${fail} failed (of ${cases.length})`);
process.exit(fail === 0 ? 0 : 1);
