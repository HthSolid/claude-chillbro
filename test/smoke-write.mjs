#!/usr/bin/env node
import { classifyWrite } from '../src/classifyWrite.mjs';

const cwd = '/home/me/projects/myapp';
const cases = [
  ['src/foo.ts',                 'allow', 'in-project relative'],
  ['./src/new.tsx',              'allow', 'in-project explicit relative'],
  ['/home/me/projects/myapp/x',  'allow', 'in-project absolute'],
  ['/etc/foo',                   'ask',   'system path'],
  ['/home/me/.bashrc',           'ask',   'home outside cwd'],
  ['../other-project/x.ts',      'ask',   'sibling project'],
  ['.env',                       'ask',   'env file'],
  ['.env.production',            'ask',   'env production'],
  ['config/.env.local',          'ask',   'nested env file'],
  ['secrets/api-key.json',       'ask',   'secrets dir'],
  ['credentials.yaml',           'ask',   'credentials file'],
  ['package.json',               'allow', 'normal config'],
  ['README.md',                  'allow', 'normal doc'],
  ['src/components/Button.tsx',  'allow', 'normal source'],
];

let pass = 0, fail = 0;
for (const [path, expected, label] of cases) {
  const { decision, reason } = classifyWrite(path, cwd);
  if (decision === expected) { pass++; console.log(`  ok    ${label}  →  ${decision}`); }
  else { fail++; console.error(`  FAIL  ${label}  expected=${expected} got=${decision} reason=${reason}`); console.error(`        path: ${path}`); }
}
console.log(`\n${pass} passed, ${fail} failed (of ${cases.length})`);
process.exit(fail === 0 ? 0 : 1);
