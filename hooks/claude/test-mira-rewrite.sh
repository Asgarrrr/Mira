#!/usr/bin/env bash
# Integration test for hooks/claude/mira-rewrite.sh.
#
# The shell script is a thin delegate to `mira rewrite` (TS); the unit tests
# for skip patterns + escaping live in tests/cli-rewrite.test.ts. This file
# pipes a handful of payloads through the actual shell pipeline (bash + bun
# + the rewrite TS) and asserts on the JSON shape — proves the wiring works
# end-to-end.
#
# Run: bash hooks/claude/test-mira-rewrite.sh
# Exit 0 = all green. Non-zero with a summary on the first failure.

set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
HOOK="$SCRIPT_DIR/mira-rewrite.sh"

if [ ! -x "$HOOK" ]; then
  echo "FAIL: hook not executable at $HOOK" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "SKIP: jq not on PATH (needed only by this test, not the hook itself)"
  exit 0
fi

PASS=0
FAIL=0

# Run the hook with a JSON payload and assert on the result.
#   args: <test name> <payload> <"REWRITTEN"|"PASSTHROUGH">
#         [optional: substring that must appear in the rewritten command]
assert_hook() {
  local name="$1"
  local payload="$2"
  local mode="$3"
  local must_contain="${4:-}"

  local out
  out=$(printf '%s' "$payload" | bash "$HOOK" 2>&1)

  case "$mode" in
    REWRITTEN)
      if [ -z "$out" ]; then
        echo "  ✗ [$name] expected rewrite, got passthrough"
        FAIL=$((FAIL + 1))
        return
      fi
      if ! echo "$out" | jq -e '.hookSpecificOutput.permissionDecision == "allow"' >/dev/null; then
        echo "  ✗ [$name] missing permissionDecision=allow in output: $out"
        FAIL=$((FAIL + 1))
        return
      fi
      if [ -n "$must_contain" ]; then
        local cmd
        cmd=$(echo "$out" | jq -r '.hookSpecificOutput.updatedInput.command')
        if [[ "$cmd" != *"$must_contain"* ]]; then
          echo "  ✗ [$name] rewritten command missing substring '$must_contain': $cmd"
          FAIL=$((FAIL + 1))
          return
        fi
      fi
      PASS=$((PASS + 1))
      echo "  ✓ [$name] rewritten"
      ;;
    PASSTHROUGH)
      if [ -n "$out" ]; then
        echo "  ✗ [$name] expected passthrough (empty stdout), got: $out"
        FAIL=$((FAIL + 1))
        return
      fi
      PASS=$((PASS + 1))
      echo "  ✓ [$name] passthrough"
      ;;
    *)
      echo "  ✗ [$name] bad mode '$mode' in test"
      FAIL=$((FAIL + 1))
      ;;
  esac
}

echo "Integration tests for hooks/claude/mira-rewrite.sh"
echo

# Happy path
assert_hook "happy/git-status" \
  '{"tool_input":{"command":"git status"}}' \
  REWRITTEN \
  "run 'git status'"

assert_hook "happy/chained-and" \
  '{"tool_input":{"command":"git add . && git commit -m bar"}}' \
  REWRITTEN \
  "run 'git add . && git commit -m bar'"

assert_hook "happy/single-quoted-arg" \
  "{\"tool_input\":{\"command\":\"echo 'hello world'\"}}" \
  REWRITTEN \
  "run 'echo '\\''hello world'\\'''"

# Skips
assert_hook "skip/vim" \
  '{"tool_input":{"command":"vim foo.ts"}}' \
  PASSTHROUGH

assert_hook "skip/less" \
  '{"tool_input":{"command":"less foo.txt"}}' \
  PASSTHROUGH

assert_hook "skip/tail-f" \
  '{"tool_input":{"command":"tail -f log.txt"}}' \
  PASSTHROUGH

assert_hook "skip/--watch" \
  '{"tool_input":{"command":"bun test --watch"}}' \
  PASSTHROUGH

assert_hook "skip/background-amp" \
  '{"tool_input":{"command":"sleep 30 &"}}' \
  PASSTHROUGH

assert_hook "skip/heredoc" \
  '{"tool_input":{"command":"cat <<EOF\nhi\nEOF"}}' \
  PASSTHROUGH

assert_hook "skip/already-wrapped" \
  '{"tool_input":{"command":"mira run foo"}}' \
  PASSTHROUGH

# False-positive guards (bash-glob-style skips would have caught these)
assert_hook "no-skip/bunvim-not-vim" \
  '{"tool_input":{"command":"bunvim foo.ts"}}' \
  REWRITTEN

assert_hook "no-skip/double-amp-not-background" \
  '{"tool_input":{"command":"git add . && git status"}}' \
  REWRITTEN

# Edge: empty / malformed payload should NOT crash, just passthrough.
assert_hook "edge/empty-payload" \
  '' \
  PASSTHROUGH

assert_hook "edge/malformed-json" \
  '{not valid json' \
  PASSTHROUGH

assert_hook "edge/missing-command" \
  '{"tool_input":{}}' \
  PASSTHROUGH

echo
echo "summary: $PASS pass, $FAIL fail"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
