# Hooks

Per-agent hook artefacts that ride between an AI coding agent and Mira's command observer. Each hook script is a **thin shell delegate** — it locates the Mira repo from its own filesystem path and pipes the agent's payload through the `mira rewrite` CLI subcommand, where the actual logic (skip patterns, shell escaping, JSON I/O) lives in TypeScript.

```
hooks/
  README.md              this file
  claude/
    README.md            Claude Code-specific notes
    mira-rewrite.sh      PreToolUse(Bash) delegate (~20 lines, portable)
    test-mira-rewrite.sh integration test (pipes payloads, asserts JSON)
```

## Why thin delegates

Tested in TS, not in bash. Skip patterns like *"don't wrap `vim` but DO wrap `bunvim`"* are word-anchored regex in `src/cli/rewrite.ts` and have unit-test coverage in `tests/cli-rewrite.test.ts`. The shell script is whatever Claude Code's hook system requires (a command on disk it can invoke); inside, it execs `bun .../src/cli/index.ts rewrite --client claude`. No `jq` needed at hook-fire time.

Pattern is borrowed from [`rtk-ai/rtk/hooks/`](https://github.com/rtk-ai/rtk/tree/master/hooks); RTK uses a Rust binary + thin shell, we use a TS module + thin shell.

## Installation

Use the CLI installer:

```
mira hooks install --agent claude                  # add to user scope
mira hooks install --agent claude --scope project  # add to <cwd>/.claude/settings.json
mira hooks install --agent claude --dry-run        # show diff, do not write
mira hooks install --agent claude --verbose        # show full diff + script path
mira hooks status                                  # what's installed
mira hooks uninstall --agent claude                # remove (preserves other hooks)
```

The installer:
- Resolves the script path via `import.meta.url` so the absolute path embedded in `settings.json` is correct on whatever machine runs the install.
- Writes settings.json **atomically** — temp file in the same directory, then `rename`. A partial write or crash leaves the original untouched.
- Uses **exact-match** detection (not substring) to avoid false-positive idempotence on similar paths (e.g. `mira-rewrite.sh.bak`).
- **Preserves any existing hooks** (e.g. `rtk hook claude`) by appending to the same matcher's `hooks` array. Claude Code chains them in declaration order.

## What the hook does today

For Claude Code:

```
Agent runs `git status`
  → Claude Code fires PreToolUse(Bash) with `{ tool_input: { command: "git status" } }`
  → mira-rewrite.sh delegates to `bun .../src/cli/index.ts rewrite --client claude`
  → mira rewrite returns { hookSpecificOutput: { permissionDecision: "allow", updatedInput: { command: "bun .../index.ts run 'git status'" } } }
  → Claude Code substitutes; bash runs the wrapped form
  → Mira's command-observer captures evidence under <projectRoot>/.mira/runs/<id>/
  → Agent sees the original output + a one-line footer pointing at the evidence dir
```

No compression yet — V0 is verbatim passthrough plus persistence. The compression pass (typed `Finding[]`, cascade dedup, diff-on-rerun) is V0.4 — see [`docs/observation-pipeline.md`](../docs/observation-pipeline.md).

## What the hook deliberately skips

The V0 command-observer can't drive interactive TTY commands or background jobs. The TS implementation in `src/cli/rewrite.ts` returns passthrough for any of:

- Already wrapped (`mira run …` or `… src/cli/index.ts run …`)
- Interactive programs by exact first-token match: `vim`, `nvim`, `vi`, `nano`, `emacs`, `pico`, `less`, `more`, `top`, `htop`, `man`, `info`
- `tail -f` (any leading flags)
- `watch <cmd>` (long-running)
- `--watch` flag (word-anchored, accepts `--watch=value`)
- Trailing ` &` or ` &;` / ` &|` (background; `&&` is preserved)
- Heredocs (` << EOF`, ` <<- 'EOF'`)

False-positive cases the previous bash glob caught and we now don't:

- `bunvim foo` — not skipped (`bunvim` is not in the program set)
- `nanopb generate` — not skipped
- `git-vim-helper` — not skipped
- `git add . && git status` — not skipped (`&&` is logical AND, not background)

Edit the program list or regexes in `src/cli/rewrite.ts:shouldSkip`; the change is unit-tested.

## Hook protocol version

The shell script and TS implementation declare `mira-hook-version: 1`. Bumped when the input/output JSON shape changes. Readers can guard via `MIRA_HOOK_VERSION_REQUIRE` env at hook-fire time (not currently enforced; reserved).

## Running the integration test

```
bash hooks/claude/test-mira-rewrite.sh
```

Pipes 15 synthetic payloads through the actual hook script and asserts on JSON shape (rewritten or passthrough). Requires `jq` for the test runner itself (the production hook does not).
