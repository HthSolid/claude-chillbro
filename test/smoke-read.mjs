// Read classifier: default allow except for sensitive files.

import { classifyRead } from '../src/classifyRead.mjs';

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.error(`  FAIL  ${label}\n        expected: ${JSON.stringify(expected)}\n        got:      ${JSON.stringify(actual)}`); }
}

function decisionOf(p, cwd) {
  return classifyRead(p, cwd || '/tmp').decision;
}

// Reads of normal project files → allow
eq(decisionOf('/home/me/proj/src/main.ts'),                'allow', 'normal source file → allow');
eq(decisionOf('/home/me/proj/package.json'),               'allow', 'package.json → allow');
eq(decisionOf('/home/me/proj/README.md'),                  'allow', 'readme → allow');
eq(decisionOf('/tmp/scratch.txt'),                         'allow', '/tmp file → allow');
eq(decisionOf('/home/me/.bashrc'),                         'allow', 'dotfile in home → allow (config is fine)');
eq(decisionOf('/home/me/.claude.json'),                    'allow', '~/.claude.json → allow');
eq(decisionOf('/home/me/.claude/settings.local.json'),     'allow', '~/.claude/settings.local.json → allow');
eq(decisionOf('/home/me/proj/.env'),                       'allow', '.env file → allow (intentional: model needs to read config)');
eq(decisionOf('/home/me/proj/.env.local'),                 'allow', '.env.local → allow');

// Genuinely sensitive → ask
eq(decisionOf('/home/me/.ssh/id_rsa'),                     'ask', 'SSH private key → ask');
eq(decisionOf('/home/me/.ssh/id_ed25519'),                 'ask', 'SSH ed25519 → ask');
eq(decisionOf('/home/me/.ssh/server.pem'),                 'ask', 'PEM key → ask');
eq(decisionOf('/home/me/keys/server.key'),                 'allow', '.key file outside .ssh → allow (no way to distinguish public from private)');
eq(decisionOf('/home/me/.aws/credentials'),                'ask', 'AWS credentials → ask');
eq(decisionOf('/home/me/.gcloud/credentials.db'),          'ask', 'GCloud credentials → ask');
eq(decisionOf('/home/me/.netrc'),                          'ask', '.netrc → ask');
eq(decisionOf('/home/me/.pgpass'),                         'ask', '.pgpass → ask');
eq(decisionOf('/home/me/proj/id_rsa'),                     'ask', 'id_rsa anywhere → ask');
eq(decisionOf('/home/me/proj/private-key.pem'),            'ask', 'private-key.* → ask');

// .ssh/known_hosts and authorized_keys are PUBLIC keys / hostname lists — allow
eq(decisionOf('/home/me/.ssh/known_hosts'),                'allow', 'SSH known_hosts → allow (public)');
eq(decisionOf('/home/me/.ssh/config'),                     'allow', 'SSH config → allow (no key material)');

// Missing path
eq(classifyRead('',   '/tmp').decision, 'ask', 'empty path → ask');
eq(classifyRead(null, '/tmp').decision, 'ask', 'null path → ask');

console.log(`\n${pass} passed, ${fail} failed (of ${pass+fail})`);
process.exit(fail === 0 ? 0 : 1);
