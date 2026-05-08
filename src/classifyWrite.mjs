// Classifier for Write / Edit / MultiEdit tools.
//
// Default: ALLOW. The whole point of asking the model to write a file is for it
// to write the file — re-prompting on every save is the prime annoyance.
//
// ASK only for genuinely sensitive targets: env files, credential stores, SSH
// keys, anything outside the cwd subtree (i.e., the model is reaching out of
// the project), and explicitly-marked secrets directories.

import { resolve, relative, isAbsolute } from 'node:path';

const ASK_PATTERNS = [
  /(^|\/)\.env(\..+)?$/,
  /(^|\/)\.env$/,
  /(^|\/)\.aws\/credentials\b/,
  /(^|\/)\.ssh\/(id_|authorized_keys\b|known_hosts\b)/,
  /(^|\/)secrets?\//i,
  /(^|\/)private\//i,
  /(^|\/)credentials?\.(json|ya?ml|toml|env)$/i,
  /(^|\/)\.netrc$/,
  /(^|\/)\.pgpass$/,
];

export function classifyWrite(filePath, cwd) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return { decision: 'ask', reason: 'missing file_path', source: 'write-classify' };
  }

  const abs = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);

  // Outside the project tree → ask. The model is touching files beyond the
  // working directory, which usually means system config or another project.
  const rel = relative(cwd, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { decision: 'ask', reason: `outside cwd: ${abs}`, source: 'write-classify' };
  }

  for (const re of ASK_PATTERNS) {
    if (re.test(abs)) return { decision: 'ask', reason: `sensitive path: ${re.source}`, source: 'write-classify' };
  }

  return { decision: 'allow', reason: 'in-project file write', source: 'write-classify' };
}
