// Classifier for the Read tool.
//
// Default: ALLOW for anything that isn't obviously sensitive. Re-prompting on
// every file read is the same kind of annoyance as re-prompting on every
// Bash ls, and the Read tool is read-only by definition.
//
// ASK only for genuinely sensitive targets:
//   - SSH private keys (.ssh/id_*, .ssh/*.pem)
//   - Cloud credential files (.aws/credentials, .gcloud/credentials.db)
//   - .netrc (FTP/HTTP creds), .pgpass (Postgres creds)
//   - Anything matching a credentials path naming convention
//
// `.env` files are intentionally NOT on the ask list — the model reads them
// all the time to understand configuration, and asking for them on every
// startup is the exact annoyance this plugin exists to fix. If the user
// wants to keep secrets out of reads, they should chmod the file or list it
// in ~/.claude-chillbro/read-deny.list (user override below).

import { resolve, isAbsolute } from 'node:path';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ASK_PATTERNS = [
  /(^|\/)\.ssh\/(id_|.+\.pem$|.+\.key$)/,
  /(^|\/)\.aws\/credentials\b/,
  /(^|\/)\.gcloud\/credentials/i,
  /(^|\/)\.netrc$/,
  /(^|\/)\.pgpass$/,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.|$)/,
  /(^|\/)private[-_]?key/i,
];

const READ_DENY_FILE = join(homedir(), '.claude-chillbro', 'read-deny.list');

function loadUserReadDeny() {
  try {
    return readFileSync(READ_DENY_FILE, 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .map(l => resolve(l.replace(/^~/, homedir())));
  } catch { return []; }
}

export function classifyRead(filePath, cwd) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return { decision: 'ask', reason: 'missing file_path', source: 'read-classify' };
  }

  const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd || process.cwd(), filePath);

  for (const re of ASK_PATTERNS) {
    if (re.test(abs)) {
      return { decision: 'ask', reason: `sensitive path: ${re.source}`, source: 'read-classify' };
    }
  }

  for (const denied of loadUserReadDeny()) {
    if (abs === denied || abs.startsWith(denied + '/')) {
      return { decision: 'ask', reason: `user-denied: ${denied}`, source: 'read-classify' };
    }
  }

  return { decision: 'allow', reason: 'read-only and not on sensitive list', source: 'read-classify' };
}

export const _internal = { ASK_PATTERNS, loadUserReadDeny, READ_DENY_FILE };
