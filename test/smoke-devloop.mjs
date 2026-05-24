// v0.1.8: dev-loop coverage. Audited from a real session full of
// useless prompts on cp/mv/git checkout/sed -i/etc.

import { classifyStatic } from '../src/classify.mjs';
process.env.CHILLBRO_TEST_NO_LEARN = '1';

let pass = 0, fail = 0;
const cwd = '/home/me/proj';
function check(cmd, expected, label) {
  const r = classifyStatic(cmd, cwd);
  const got = r.decision;
  const ok = got === expected;
  if (ok) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.error(`  FAIL  ${label}\n        expected=${expected} got=${got} source=${r.source} reason=${r.reason}`); console.error(`        cmd: ${cmd}`); }
}

// === file ops ===
check('cp a.txt b.txt',                                'allow', 'cp basic');
check('cp -p a.txt b.txt',                             'allow', 'cp -p preserve');
check('cp file.json file.json.bak',                    'allow', 'cp to .bak');
check('mv a.txt b.txt',                                'allow', 'mv basic');
check('mv dir1 dir2',                                  'allow', 'mv dirs');
check('rsync -a src/ dst/',                            'allow', 'rsync -a');
check('rsync -av --delete src/ dst/',                  'allow', 'rsync -av --delete');
check('ln -sf target link',                            'allow', 'ln -sf');

// === git ===
check('git checkout main',                             'allow', 'git checkout branch');
check('git checkout feat/foo',                         'allow', 'git checkout slash branch');
check('git checkout -b new-feature',                   'allow', 'git checkout -b new branch');
check('git switch main',                               'allow', 'git switch');
check('git switch -c new-feature',                     'allow', 'git switch -c');
check('git stash',                                     'allow', 'git stash bare');
check('git stash push -m "wip"',                       'allow', 'git stash push -m');
check('git stash pop',                                 'allow', 'git stash pop');
check('git stash list',                                'allow', 'git stash list');
check('git fetch',                                     'allow', 'git fetch bare');
check('git fetch origin',                              'allow', 'git fetch origin');
check('git fetch --all --prune',                       'allow', 'git fetch --all --prune');
check('git tag -l',                                    'allow', 'git tag -l');
check('git tag -a v1.2.3 -m "release"',                'allow', 'git tag -a annotated');
check('git rev-parse HEAD',                            'allow', 'git rev-parse');
check('git rev-parse --show-toplevel',                 'allow', 'git rev-parse --show-toplevel');
check('git show HEAD',                                 'allow', 'git show HEAD');
check('git show abc1234',                              'allow', 'git show hash');
check('git diff',                                      'allow', 'git diff bare');
check('git diff --cached',                             'allow', 'git diff --cached');
check('git diff --stat origin/main...HEAD',            'allow', 'git diff vs upstream');
check('git cherry-pick --abort',                       'allow', 'git cherry-pick --abort');
check('git cherry-pick --continue',                    'allow', 'git cherry-pick --continue');
check('git cherry-pick --skip',                        'allow', 'git cherry-pick --skip');
check('git rebase --abort',                            'allow', 'git rebase --abort');
check('git rebase --continue',                         'allow', 'git rebase --continue');
check('git rebase --skip',                             'allow', 'git rebase --skip');
check('git reset --soft HEAD~1',                       'allow', 'git reset --soft');
check('git reflog',                                    'allow', 'git reflog');
check('git remote -v',                                 'allow', 'git remote -v');
check('git remote show origin',                        'allow', 'git remote show');
check('git branch',                                    'allow', 'git branch bare');
check('git branch -a',                                 'allow', 'git branch -a');
check('git branch --show-current',                     'allow', 'git branch --show-current');
check('git merge-base HEAD origin/main',               'allow', 'git merge-base');
check('git blame file.ts',                             'allow', 'git blame');
check('git grep needle',                               'allow', 'git grep');
check('git describe --tags',                           'allow', 'git describe');
check('git ls-files',                                  'allow', 'git ls-files');
check('git config --get user.email',                   'allow', 'git config --get');

// === destructive git stays ASK ===
check('git push --force origin main',                  'ask',  'git push --force ASK');
check('git push --force-with-lease=main:abc origin main', 'ask','git push --force-with-lease ASK');
check('git push origin :v1.0',                         'ask',  'git push delete tag ASK');
check('git reset --hard HEAD~1',                       'ask',  'git reset --hard ASK');
check('git checkout -- file.ts',                       'ask',  'git checkout -- file ASK');
check('git commit --amend',                            'ask',  'git commit --amend ASK');
check('git tag -d v1.0',                               'ask',  'git tag -d ASK');
check('git branch -D feat/wip',                        'ask',  'git branch -D ASK');
check('git rebase -i HEAD~3',                          'ask',  'git rebase -i ASK');
check('git clean -fd',                                 'ask',  'git clean -fd ASK');

// === gh read-only ===
check('gh pr view 123',                                'allow', 'gh pr view');
check('gh pr list',                                    'allow', 'gh pr list');
check('gh release list',                               'allow', 'gh release list');
check('gh release view v1.0',                          'allow', 'gh release view');
check('gh issue list',                                 'allow', 'gh issue list');
check('gh repo view',                                  'allow', 'gh repo view');
check('gh workflow view',                              'allow', 'gh workflow view');
check('gh run list',                                   'allow', 'gh run list');
// gh release/repo destructive stay ASK
check('gh release delete v1.0',                        'ask',  'gh release delete ASK');
check('gh repo delete me/proj',                        'ask',  'gh repo delete ASK');

// === chmod ===
check('chmod +x script.sh',                            'allow', 'chmod +x');
check('chmod u+x script.sh',                           'allow', 'chmod u+x');
check('chmod 644 file.txt',                            'allow', 'chmod 644');
check('chmod 600 file.txt',                            'allow', 'chmod 600');
check('chmod 755 script.sh',                           'ask',   'chmod 755 → ask (world-executable)');
check('chmod -R 755 dir',                              'ask',   'chmod -R ASK');
check('chmod 4755 binary',                             'ask',   'chmod 4755 setuid ASK');
check('chmod 2755 binary',                             'ask',   'chmod 2755 setgid ASK');
check('chmod +s file',                                 'ask',   'chmod +s ASK');

// === python / node script run ===
check('python3 script.py',                             'allow', 'python3 script.py');
check('python3 -m pytest',                             'allow', 'python3 -m pytest');
check('node app.js',                                   'allow', 'node app.js');
check('node test/smoke.mjs',                           'allow', 'node test/smoke.mjs');
check('node scripts/build.mjs',                        'allow', 'node scripts/');

// === npm/pnpm read-only + run ===
check('npm ls',                                        'allow', 'npm ls');
check('npm outdated',                                  'allow', 'npm outdated');
check('npm run build',                                 'allow', 'npm run build');
check('pnpm list',                                     'allow', 'pnpm list');

// === ./scripts/ ===
check('./scripts/local-ci.sh full',                    'allow', './scripts/local-ci.sh');
check('./scripts/install-hooks.sh',                    'allow', './scripts/install-hooks.sh');

// === hashing/diff ===
check('diff file1 file2',                              'allow', 'diff files');
check('sha256sum file.bin',                            'allow', 'sha256sum');
check('md5sum file.bin',                               'allow', 'md5sum');

console.log(`\n${pass} passed, ${fail} failed (of ${pass+fail})`);
process.exit(fail === 0 ? 0 : 1);
