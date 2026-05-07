# Claude Code hook

`mira-rewrite.sh` is the `PreToolUse(Bash)` delegate for Claude Code. Hook protocol reference: [Claude Code hooks documentation](https://docs.claude.com/en/docs/claude-code/hooks).

## Architecture

```
Claude Code
   │  stdin: { "tool_input": { "command": "git status" } }
   ▼
hooks/claude/mira-rewrite.sh   (~20 lines, portable; resolves repo from $BASH_SOURCE)
   │  exec bun "$MIRA_REPO/src/cli/index.ts" rewrite --client claude
   ▼
mira rewrite                   (src/cli/rewrite.ts; all logic, all tests)
   │  stdout: { "hookSpecificOutput": { "permissionDecision": "allow", "updatedInput": { "command": "..." } } }
   ▼
Claude Code substitutes the rewritten command; bash runs `mira run "git status"`
```

## Install

```
mira hooks install --agent claude
```

Patches `~/.claude/settings.json`:

- Locates the existing `PreToolUse` entry with `matcher: "Bash"`, or creates one.
- Appends a `{ "type": "command", "command": "<absolute path to mira-rewrite.sh>" }` entry to its `hooks` array.
- Preserves any existing hooks on the same matcher (chained execution; e.g. RTK then Mira).
- Idempotent: re-running detects an existing entry and is a no-op.
- Atomic: writes to a sibling `.tmp` file then renames.

For project-scope (`<cwd>/.claude/settings.json` instead of user-scope):

```
mira hooks install --agent claude --scope project
```

## Hook protocol

**Input** (stdin):
```json
{ "tool_name": "Bash", "tool_input": { "command": "git status" } }
```

**Output** (stdout, when rewriting):
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "Mira: capture observation under .mira/runs/",
    "updatedInput": { "command": "bun /abs/path/src/cli/index.ts run 'git status'" }
  }
}
```

**Output** (passthrough): exit 0 with empty stdout. Claude Code runs the original command unchanged.

## Requirements

- `bun` on PATH at hook-fire time. If absent, the script falls back to silent passthrough rather than crashing the agent's tool call.
- (Test-only) `jq` for `test-mira-rewrite.sh`. Not used by the production hook.

Override the bun invocation via `MIRA_CMD` env if `bun` is in an unusual location:

```
export MIRA_CMD="/opt/bun/bin/bun /Users/me/code/Mira/src/cli/index.ts"
```

## Skip rules

Implemented in `src/cli/rewrite.ts:shouldSkip`. The hook returns passthrough for:

- Already wrapped: starts with `mira run` or contains `src/cli/index.ts run`
- Interactive programs (first-token exact match): `vim`, `nvim`, `vi`, `nano`, `emacs`, `pico`, `less`, `more`, `top`, `htop`, `man`, `info`
- `tail -f` (with any leading flags)
- `watch <cmd>` and `--watch` flag (word-anchored)
- Trailing ` &` / ` &;` / ` &|` (excluding `&&`)
- Heredocs (` << EOF`, ` <<- 'EOF'`)

Unit tests in `tests/cli-rewrite.test.ts` cover both happy-path skips and the false-positive guards (`bunvim` not skipped, `&&` not skipped, etc.).

## Coexistence with RTK

If `~/.claude/settings.json` already has an `rtk hook claude` entry on `PreToolUse(Bash)`, the installer adds Mira as a second hook in the same matcher's `hooks` array. Claude Code chains them in declaration order; with RTK first and Mira second, the agent's command goes RTK-rewritten before Mira wraps it (`git status` → `rtk git status` → `mira run 'rtk git status'`). RTK compresses, Mira observes the compressed output.

To remove only Mira's entry while keeping RTK:

```
mira hooks uninstall --agent claude
```

## Testing the hook in isolation

End-to-end (pipes payloads through the real shell + bun + TS):

```
bash hooks/claude/test-mira-rewrite.sh
```

Or one-shot:

```
printf '%s' '{"tool_input":{"command":"git status"}}' | bash hooks/claude/mira-rewrite.sh
```

Expected stdout: a JSON object with `hookSpecificOutput.updatedInput.command` set to the wrapped form.

```
printf '%s' '{"tool_input":{"command":"vim foo.ts"}}' | bash hooks/claude/mira-rewrite.sh
```

Expected: empty stdout (passthrough; `vim` is in the skip list).
