#!/usr/bin/env bash
# mira-hook-version: 1
# Mira PreToolUse(Bash) hook for Claude Code — thin shell delegate.
#
# All logic (skip patterns, shell escaping, JSON I/O) lives in `mira rewrite`
# (src/cli/rewrite.ts) so it's testable in TS instead of bash. This script:
#   1. Locates the Mira repo from its own filesystem path (portable).
#   2. Pipes Claude Code's hook payload (stdin) through `mira rewrite`.
#   3. Streams the result on stdout. Claude Code reads the JSON.
#
# Requires: bun on PATH at hook-fire time. If absent, falls back to
# silent passthrough rather than crashing the agent's tool call.

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
MIRA_REPO=$(cd -- "$SCRIPT_DIR/../.." && pwd)

if ! command -v bun >/dev/null 2>&1; then
  exit 0
fi

exec bun "$MIRA_REPO/src/cli/index.ts" rewrite --client claude
