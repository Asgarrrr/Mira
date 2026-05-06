#!/bin/bash
# Probe 2: parallel mira run — race on createRun, file collisions, partial writes
set -u

# Resolve the CLI relative to this script so the probe runs on any checkout.
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
MIRA_CLI="${MIRA_CLI:-$(cd "$SCRIPT_DIR/../.." && pwd)/src/cli/index.ts}"

PROJECT=$(mktemp -d -t mira-probe2-XXXXXX)
echo "projectRoot=$PROJECT"
echo "miraCli=$MIRA_CLI"

cd "$PROJECT" || exit 1

# Launch many parallel runs against the same project root.
# 50 matches the figure cited in audit/findings.md § "What was probed and held up".
N="${N:-50}"
echo "launching $N parallel mira runs..."
for i in $(seq 1 $N); do
  (bun "$MIRA_CLI" run "echo run-$i" >/dev/null 2>&1) &
done
wait
echo "all $N runs done"

# Inspect
RUN_COUNT=$(ls -1 "$PROJECT/.mira/runs" 2>/dev/null | wc -l | tr -d ' ')
echo "run dirs created: $RUN_COUNT (expected $N)"

# Check for any duplicate ids
ls -1 "$PROJECT/.mira/runs" | sort | uniq -d > /tmp/probe2-dupes.txt
if [ -s /tmp/probe2-dupes.txt ]; then
  echo "*** DUPLICATE RUN IDS FOUND:"
  cat /tmp/probe2-dupes.txt
else
  echo "no duplicate ids"
fi

# Check for partial writes (missing observation.json or empty stdout/stderr)
PARTIAL=0
for d in "$PROJECT/.mira/runs/"*; do
  [ -f "$d/observation.json" ] || { echo "MISSING observation.json: $d"; PARTIAL=$((PARTIAL+1)); }
  [ -f "$d/stdout.log" ] || { echo "MISSING stdout.log: $d"; PARTIAL=$((PARTIAL+1)); }
  [ -f "$d/metadata.json" ] || { echo "MISSING metadata.json: $d"; PARTIAL=$((PARTIAL+1)); }
done
echo "partial-writes: $PARTIAL"

# Verify each observation has the right command
WRONG=0
for d in "$PROJECT/.mira/runs/"*; do
  cmd=$(grep '"command"' "$d/observation.json" 2>/dev/null | head -1)
  expected_pattern='"command": "echo run-'
  case "$cmd" in
    *"$expected_pattern"*) ;;
    *) echo "WRONG command in $d: $cmd"; WRONG=$((WRONG+1)) ;;
  esac
done
echo "wrong-command observations: $WRONG"

# Cleanup
rm -rf "$PROJECT"
