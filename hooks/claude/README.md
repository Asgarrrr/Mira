# Claude Code hook

`mira-rewrite.sh` is the `PreToolUse(Bash)` delegate for Claude Code. Hook protocol reference: [Claude Code hooks documentation](https://docs.claude.com/en/docs/claude-code/hooks).

## Install

```
bun src/cli/index.ts hooks install --agent claude
```

The installer:

1. Locates `~/.claude/settings.json` (creates it if missing).
2. Adds an entry under `hooks.PreToolUse` matched on `Bash`, pointing at the absolute path of `mira-rewrite.sh` in this checkout.
3. Preserves any existing hooks on the same matcher (chained execution; e.g. RTK then Mira).
4. Idempotent: re-running detects an existing entry and is a no-op.

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

- `jq` (used to extract `tool_input.command` and produce shell-safe escaping via `@sh`)
- Either `mira` on `$PATH` or `MIRA_CMD` env override:
  ```
  MIRA_CMD="/usr/local/bin/mira"   # or
  MIRA_CMD="bun /abs/path/Mira/src/cli/index.ts"
  ```

## Skip rules

The hook returns passthrough (exit 0, no stdout) for any command matching:

- Already wrapped: starts with `mira run` or contains `src/cli/index.ts run`
- Interactive / TTY: `vim`, `nvim`, `nano`, `emacs`, `less`, `more`, `top`, `htop`, `tail -f`, `watch`
- Watchers: any `--watch`
- Backgrounded: trailing ` &` or ` &;`
- Heredocs: contains `<<`

Patterns live in the two `case "$CMD"` blocks. Edit there to add skips.

## Coexistence with RTK

If `~/.claude/settings.json` already has an `rtk hook claude` entry on `PreToolUse(Bash)`, the installer adds Mira as a second hook in the same matcher's `hooks` array. Claude Code chains them in declaration order; with RTK first and Mira second, the agent's command goes RTK-rewritten before Mira wraps it (`git status` → `rtk git status` → `mira run 'rtk git status'`). RTK compresses, Mira observes the compressed output.

To remove only Mira's entry while keeping RTK:
```
bun src/cli/index.ts hooks uninstall --agent claude
```

## Testing the hook in isolation

```
printf '%s' '{"tool_input":{"command":"git status"}}' | bash hooks/claude/mira-rewrite.sh
```

Expected stdout: a JSON object with `hookSpecificOutput.updatedInput.command` set to the wrapped form.

```
printf '%s' '{"tool_input":{"command":"vim foo.ts"}}' | bash hooks/claude/mira-rewrite.sh
```

Expected: empty stdout (passthrough; `vim` is in the skip list).
