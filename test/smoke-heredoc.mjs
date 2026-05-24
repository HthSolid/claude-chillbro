#!/usr/bin/env node
// Tests for heredoc body stripping + line-continuation collapse.

import {
  stripLineContinuations,
  stripHeredocBodies,
  preprocessCommand,
} from '../src/heredoc.mjs';

function runCases(transform, cases) {
  let pass = 0, fail = 0;
  for (const [input, expected, label] of cases) {
    const got = transform(input);
    if (got === expected) {
      pass++;
      console.log(`  ok    ${label}`);
    } else {
      fail++;
      console.error(`  FAIL  ${label}`);
      console.error(`        input:    ${JSON.stringify(input)}`);
      console.error(`        expected: ${JSON.stringify(expected)}`);
      console.error(`        got:      ${JSON.stringify(got)}`);
    }
  }
  return { pass, fail };
}

console.log('=== stripLineContinuations ===');
const lc = runCases(stripLineContinuations, [
  ['ls\\\n-la',                    'ls -la',                       'simple backslash-newline collapses to space'],
  ['a\\\nb\\\nc',                  'a b c',                        'multiple continuations'],
  ['no continuations here',         'no continuations here',        'no-op when no \\\\n'],
  ['echo "hi"',                     'echo "hi"',                    'unchanged regular command'],
  ['',                              '',                             'empty unchanged'],
]);

console.log('\n=== stripHeredocBodies ===');
const hd = runCases(stripHeredocBodies, [
  // basic heredoc
  ['cat <<EOF\npub fn main() {\n    let x = 1;\n}\nEOF\n', 'cat <<EOF\nEOF\n',         'basic heredoc body removed'],

  // heredoc with redirect on the start line
  ['cat <<EOF > out.rs\npub fn main() {}\nEOF\n', 'cat <<EOF > out.rs\nEOF\n',          'preserves > redirect on start line'],

  // <<- variant strips leading tabs from terminator
  ['cat <<-EOF\n\tfoo\n\tEOF\n', 'cat <<-EOF\n\tEOF\n',                                 '<<- strips tabs from terminator match'],

  // quoted delimiter (no expansion)
  ['cat <<\'EOF\'\n$VAR\nEOF\n', 'cat <<\'EOF\'\nEOF\n',                                'single-quoted delimiter'],
  ['cat <<"EOF"\n$VAR\nEOF\n',   'cat <<"EOF"\nEOF\n',                                  'double-quoted delimiter'],

  // escaped delimiter
  ['cat <<\\EOF\n$VAR\nEOF\n', 'cat <<\\EOF\nEOF\n',                                    'backslash-escaped delimiter'],

  // multiple heredocs
  ['cmd1 <<A\nbody1\nA\ncmd2 <<B\nbody2\nB\n', 'cmd1 <<A\nA\ncmd2 <<B\nB\n',           'two heredocs in one command'],

  // unterminated heredoc — body consumed to EOF
  ['cat <<EOF\nbody\nbody\n', 'cat <<EOF\n',                                            'unterminated heredoc consumes to EOF'],

  // false positive: << that isn't a heredoc (no delimiter follows)
  ['echo "<<<<"',     'echo "<<<<"',                                                    'literal << inside string is unchanged'],

  // mixed content
  ['ls && cat <<EOF\ncontent\nEOF\n && echo done', 'ls && cat <<EOF\nEOF\n && echo done', 'heredoc inside compound command'],

  // no heredoc at all
  ['ls -la && echo done', 'ls -la && echo done',                                        'no heredoc unchanged'],
  ['', '', 'empty unchanged'],
]);

console.log('\n=== preprocessCommand (full pipeline) ===');
const pp = runCases(preprocessCommand, [
  // heredoc + line continuation in one
  ['ls \\\n-la && cat <<EOF\nbody\nEOF\n', 'ls  -la && cat <<EOF\nEOF\n',               'continuation + heredoc'],
  ['echo hello', 'echo hello', 'plain command unchanged'],
]);

const total = lc.pass + hd.pass + pp.pass;
const failed = lc.fail + hd.fail + pp.fail;
console.log(`\n${total} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
