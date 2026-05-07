#!/usr/bin/env bash
# Mira PreToolUse(Bash) hook for Claude Code.
#
# Rewrites the agent's bash command to run through `mira run`, so every shell
# invocation produces a CommandObservation in <projectRoot>/.mira/runs/.
# Today this is passthrough + footer (no compression yet); the agent sees the
# same stdout, plus a one-line footer pointing at the evidence dir.
#
# Compression is planned in V0.4 — see docs/observation-pipeline.md.
#
# Hook protocol (Claude Code PreToolUse):
#   stdin  = JSON with `.tool_input.command`
#   stdout = JSON with `hookSpecificOutput.{permissionDecision,updatedInput}`
#   exit 0 with output → rewrite + auto-allow
#   exit 0 with no output → passthrough unchanged
#
# Requires: jq, and either `mira` on PATH or MIRA_CMD set explicitly.

set -euo pipefail

if ! command -v jq &>/dev/null; then
  echo "[mira-hook] jq not found; passthrough" >&2
  exit 0
fi

INPUT=$(cat)
CMD=$(jq -r '.tool_input.command // empty' <<<"$INPUT")

if [ -z "$CMD" ]; then
  exit 0
fi

# Idempotent: if the command already starts with `mira run` (or a `bun .../cli/index.ts run`
# variant), don't double-wrap.
case "$CMD" in
  "mira run "*|*"mira run "*) exit 0 ;;
  *"src/cli/index.ts run "*) exit 0 ;;
esac

# Skip commands the V0 command-observer cannot handle:
#   - interactive / TTY (vim, less, top, watch modes)
#   - background jobs (& at end)
#   - heredocs (<<EOF)
#   - long-running dev servers (dev|serve|--watch)
case "$CMD" in
  *vim*|*nvim*|*nano*|*emacs*) exit 0 ;;
  *less\ *|*more\ *|*tail\ -f*|*top\ *|*htop*|*watch\ *) exit 0 ;;
  *--watch*) exit 0 ;;
  *' &'|*' &;'*) exit 0 ;;
  *'<<'*) exit 0 ;;
esac

# Resolve the Mira CLI. Override via MIRA_CMD if needed (e.g. CI, alternate install).
MIRA_CMD="${MIRA_CMD:-bun /Users/asgarrrr/Documents/Projects/Mira/src/cli/index.ts}"

# Shell-escape the original command so it can be safely embedded as a single
# argument to `mira run`. `jq -Rs '@sh'` produces a single-quoted shell string
# with proper '\'' escaping for embedded single quotes.
ESCAPED=$(printf '%s' "$CMD" | jq -Rrs '@sh')
REWRITTEN="$MIRA_CMD run $ESCAPED"

jq -nc --arg cmd "$REWRITTEN" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    permissionDecisionReason: "Mira: capture observation under .mira/runs/",
    updatedInput: { command: $cmd }
  }
}'
