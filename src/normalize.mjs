// Normalize a command for learning. Replaces variable bits (paths, hashes, urls,
// numeric ports, branch names) with placeholders so different invocations of the
// "same" command map to the same key.
//
// Examples:
//   git checkout feature/foo  -> git checkout <branch>
//   pnpm test src/foo.test.ts -> pnpm test <path>
//   curl https://x.io/y       -> curl <url>

const RULES = [
  [/\bhttps?:\/\/\S+/g, '<url>'],
  [/\b[a-f0-9]{7,40}\b/g, '<hash>'],
  [/\b\d{2,}\b/g, '<num>'],
  [/(?:^|\s)(\.{0,2}\/[^\s'"]+)/g, ' <path>'],
  [/(?:^|\s)(~\/[^\s'"]+)/g, ' <path>'],
  [/(?:^|\s)(\/[^\s'"/][^\s'"]*)/g, ' <path>'],
  // Branch refs after common git verbs
  [/\b(git\s+(?:checkout|switch|merge|rebase|push|pull|cherry-pick|branch))\s+\S+/g, '$1 <ref>'],
];

export function normalize(cmd) {
  let s = cmd.trim();
  for (const [re, rep] of RULES) s = s.replace(re, rep);
  return s.replace(/\s+/g, ' ').trim();
}
