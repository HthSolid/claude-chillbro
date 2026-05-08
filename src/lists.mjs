// Load and compile static + learned regex lists. Cached at module load.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadLearned } from './state.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadListFile(name) {
  const path = join(__dirname, name);
  const txt = readFileSync(path, 'utf8');
  return txt.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(pattern => {
      try { return new RegExp(pattern); }
      catch (e) { console.error(`[chillbro] bad regex in ${name}: ${pattern} (${e.message})`); return null; }
    })
    .filter(Boolean);
}

export const ALLOW = loadListFile('allow.list');
export const ASK = loadListFile('ask.list');

export function loadLearnedRegexes() {
  return loadLearned().map(line => {
    // Learned entries are normalized command strings. Convert to a tight regex
    // that matches the same normalized form. We'll re-normalize at match time
    // and compare strings; this returns the literal strings instead of regexes.
    return line;
  });
}
