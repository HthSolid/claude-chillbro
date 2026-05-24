// Command normalization for pattern matching.
//
// Real-world bash invocations carry baggage that defeats anchored regex
// patterns: full paths to binaries (`~/.cargo/bin/cargo build`), env-var
// prefixes (`KEY=val cargo run`), and command wrappers (`time cargo test`).
//
// We strip these from the front of a segment BEFORE matching against the
// allow/ask lists, so a single `^cargo\s+build` pattern catches all of:
//   cargo build
//   ~/.cargo/bin/cargo build
//   /opt/cargo/bin/cargo build
//   KEY=val cargo build
//   time cargo build
//   KEY=val time ~/.cargo/bin/cargo build
//
// Each stripper is idempotent and returns the input unchanged when it doesn't
// apply. We loop until a fixed point so any combination/order works.

// Path prefix: ~/.cargo/bin/cargo, $HOME/.local/bin/foo, /usr/local/sbin/x,
// ./node_modules/.bin/jest, ../tools/bin/foo.
// Anchor is `~`, `$HOME`, `/`, `./`, or `../`, then any non-whitespace path
// traversal (non-greedy so we stop at the first `/bin/`, `/sbin/`, or
// `/.bin/` boundary), then the binary name, then the remaining args.
// `.bin` matches the npm convention for project-local executables.
const PATH_BIN_RX = /^(?:~|\$HOME|\/|\.{1,2}\/)\S*?\/(?:s?bin|\.bin)\/(\S+)(.*)$/;

export function stripPathPrefix(segment) {
  const m = segment.match(PATH_BIN_RX);
  return m ? m[1] + m[2] : segment;
}

// Env-var prefix: `FOO=bar cmd`, `FOO=bar BAZ=qux cmd`. ALL_CAPS_WITH_DIGITS
// for the var name (matches POSIX env-var convention; case-sensitive). The
// value is `\S+` so quoted values with spaces aren't supported — rare enough
// to not worry about for v1.
const ENV_PREFIX_RX = /^(?:[A-Z_][A-Z0-9_]*=\S+\s+)+(\S.*)$/;

export function stripEnvPrefix(segment) {
  const m = segment.match(ENV_PREFIX_RX);
  return m ? m[1] : segment;
}

// Wrap prefix: `time cmd`, `nice cmd`, `nohup cmd`, `ionice cmd`, and the
// `\cmd` escape (no space — `\rm` directly bypasses an `rm` alias). Also
// `command cmd` (bash builtin to bypass alias), but ONLY when the FIRST
// token after `command` is not a flag — `command -v rg` means "where is rg"
// (read-only, distinct semantics) and stays as-is, while `command rg foo`
// becomes `rg foo` for matching. Subsequent flags in the args are fine
// (they're flags TO the inner command, not to `command` itself).
const WRAP_PREFIX_RX = /^(?:(?:time|nice|nohup|ionice)\s+|\\|command\s+(?=[^-\s]))(\S.*)$/;

export function stripWrapPrefix(segment) {
  const m = segment.match(WRAP_PREFIX_RX);
  return m ? m[1] : segment;
}

// Apply all strippers in a fixed-point loop so any combination (and any order)
// reduces to the bare command. Caps at 8 iterations as a safety belt against
// pathological input.
export function normalizeForMatching(segment) {
  let prev;
  let s = segment;
  let i = 0;
  do {
    prev = s;
    s = stripWrapPrefix(s);
    s = stripEnvPrefix(s);
    s = stripPathPrefix(s);
    i++;
  } while (s !== prev && i < 8);
  return s;
}
