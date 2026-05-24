#!/usr/bin/env bash
# Local-CI runner — authoritative pre-push gate.
#
# Usage:
#   ./scripts/local-ci.sh            # default: all unit suites + manifest validate
#   ./scripts/local-ci.sh fast       # unit suites only (skip manifest validate)
#   ./scripts/local-ci.sh full       # unit + manifest + pattern integrity
#   HTE_SKIP_LOCAL_CI=1 git push     # emergency bypass
#
# Exit 0 only if everything passes. Pre-push hook gates on this exit code.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

if [ -t 1 ]; then BOLD=$'\e[1m'; GREEN=$'\e[32m'; RED=$'\e[31m'; YELLOW=$'\e[33m'; RESET=$'\e[0m'
else BOLD=""; GREEN=""; RED=""; YELLOW=""; RESET=""; fi
step() { printf '%s==>%s %s%s%s\n' "$GREEN" "$RESET" "$BOLD" "$1" "$RESET"; }
fail() { printf '%sFAIL:%s %s\n' "$RED" "$RESET" "$1" >&2; exit 1; }
ok()   { printf '%s ok%s   %s\n' "$GREEN" "$RESET" "$1"; }

mode="${1:-all}"
case "$mode" in
  fast|all|full) ;;
  *) echo "Usage: $0 [fast|all|full]"; exit 2 ;;
esac

# --- 1. Unit suites ---
step "Unit test suites"
SUITES=(
  "smoke.mjs"
  "smoke-inline.mjs"
  "smoke-write.mjs"
  "smoke-write-multicwd.mjs"
  "smoke-normalize.mjs"
  "smoke-heredoc.mjs"
  "smoke-failsafe.mjs"
  "smoke-autocontinue.mjs"
  "smoke-improvements.mjs"
  "smoke-patterns.mjs"
  "smoke-subshell.mjs"
  "smoke-read.mjs"
  "smoke-mcp.mjs"
  "smoke-devloop.mjs"
)
total_pass=0
total_fail=0
for suite in "${SUITES[@]}"; do
  if [ ! -f "test/$suite" ]; then
    printf '%sSKIP%s %s (not found)\n' "$YELLOW" "$RESET" "$suite"
    continue
  fi
  # Don't set CHILLBRO_TEST_NO_LEARN globally — smoke-improvements and
  # smoke-patterns specifically test loadLearnedSet() behavior with/without
  # the flag, and self-manage process.env per-test. smoke.mjs sets the flag
  # itself at the top of the file.
  out=$(CHILLBRO_TEST_NO_LLM=1 node "test/$suite" 2>&1 | tail -1)
  if [[ "$out" == *"failed (of"* ]]; then
    pass=$(echo "$out" | grep -oE '^[0-9]+' | head -1)
    fail=$(echo "$out" | grep -oE '[0-9]+ failed' | grep -oE '^[0-9]+')
    total_pass=$((total_pass + pass))
    total_fail=$((total_fail + ${fail:-0}))
    if [ "${fail:-0}" -gt 0 ]; then
      fail "$suite: $out"
    else
      ok "$suite: $pass passed"
    fi
  elif [[ "$out" == *"passed"*"failed" ]]; then
    # smoke-heredoc.mjs format: "N passed, M failed" no "of"
    pass=$(echo "$out" | grep -oE '^[0-9]+' | head -1)
    fail=$(echo "$out" | grep -oE '[0-9]+ failed' | grep -oE '^[0-9]+')
    total_pass=$((total_pass + pass))
    total_fail=$((total_fail + ${fail:-0}))
    if [ "${fail:-0}" -gt 0 ]; then fail "$suite: $out"; else ok "$suite: $pass passed"; fi
  else
    fail "$suite: unexpected output '$out'"
  fi
done

step "Unit total: ${total_pass} passed, ${total_fail} failed"
[ "$total_fail" -eq 0 ] || fail "unit tests failed"

# --- 2. Manifest validate (skipped in fast mode) ---
if [ "$mode" != "fast" ]; then
  step "Manifest validate"
  if command -v claude >/dev/null 2>&1; then
    out=$(claude plugin validate . 2>&1 | tail -1)
    if [[ "$out" == *"Validation passed"* ]] || [[ "$out" == *"✔"* ]]; then
      ok "manifest validates"
    else
      fail "manifest validation failed: $out"
    fi
  else
    printf '%sSKIP%s claude CLI not on PATH\n' "$YELLOW" "$RESET"
  fi
fi

# --- 3. Pattern catalog integrity (full mode only) ---
if [ "$mode" = "full" ]; then
  step "Pattern catalog integrity"
  node -e "
    import('./src/lists.mjs').then(m => {
      const allow = m.ALLOW, ask = m.ASK;
      if (allow.length < 100) { console.error('FAIL: allow patterns suspiciously few:', allow.length); process.exit(1); }
      if (ask.length < 50) { console.error('FAIL: ask patterns suspiciously few:', ask.length); process.exit(1); }
      // Catastrophic-backtracking probe
      const probes = ['a'.repeat(200), '/a/b/c/'.repeat(50), 'a!@#%^&*()'.repeat(50)];
      const slow = [];
      for (const re of [...allow, ...ask]) {
        for (const p of probes) {
          const t0 = process.hrtime.bigint();
          try { re.test(p); } catch {}
          const ms = Number(process.hrtime.bigint() - t0) / 1e6;
          if (ms > 10) slow.push({ src: re.source, ms });
        }
      }
      if (slow.length > 0) { console.error('FAIL: slow regexes:', slow.length); process.exit(1); }
      console.log('ok    allow:', allow.length, 'ask:', ask.length, 'no slow regexes');
    });
  " || fail "pattern catalog integrity"
fi

printf '\n%sLocal CI:%s all jobs passed (%d tests).\n' "$BOLD$GREEN" "$RESET" "$total_pass"
