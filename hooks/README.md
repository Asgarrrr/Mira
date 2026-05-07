# Hooks

Per-agent hook artefacts that ride between an AI coding agent and Mira's command observer. They are **thin delegates**: parse the agent-specific JSON event, decide whether to rewrite the bash command, and emit the agent-specific response. Today the rewrite logic is small enough to live inline in each script; once V0.4 ships per-tool parsers, the heavier logic moves into `mira rewrite` (a CLI subcommand) and these scripts become pure JSON adapters — same evolution path RTK has already walked.

## Layout

```
hooks/
  README.md              this file
  claude/
    README.md            Claude Code-specific notes
    mira-rewrite.sh      PreToolUse(Bash) hook
```

Other clients (Cursor, Codex, OpenCode, Cline, Windsurf) will land as sibling subdirectories on demand. The pattern is borrowed from [`rtk-ai/rtk/hooks/`](https://github.com/rtk-ai/rtk/tree/master/hooks).

## Installation

Use the CLI installer rather than editing client settings by hand:

```
bun src/cli/index.ts hooks install --agent claude    # add
bun src/cli/index.ts hooks status                    # what's installed
bun src/cli/index.ts hooks uninstall --agent claude  # remove
```

The installer is idempotent and preserves any existing hooks (e.g. RTK's `rtk hook claude`) so multiple compressors can coexist in the chain.

## What the hook does today

For Claude Code, the hook is wired on `PreToolUse(Bash)`:

```
Agent runs `git status`
  → Claude Code fires PreToolUse
  → mira-rewrite.sh receives the JSON, returns updatedInput.command = `mira run 'git status'`
  → Claude Code substitutes; bash runs `mira run 'git status'`
  → Mira's command-observer captures evidence under <projectRoot>/.mira/runs/<id>/
  → Agent sees the original output + a one-line footer pointing at the evidence dir
```

No compression yet — V0 is verbatim passthrough plus persistence. The compression pass (typed `Finding[]`, cascade dedup, diff-on-rerun) is V0.4 — see [`docs/observation-pipeline.md`](../docs/observation-pipeline.md).

## What the hook deliberately skips

The V0 command-observer can't drive interactive TTY commands or background jobs. The hook detects these patterns and lets them through unchanged:

- `vim`, `nvim`, `nano`, `emacs`, `less`, `more`, `top`, `htop`, `tail -f`, `watch`
- `--watch` flags (dev servers)
- Trailing `&` (backgrounded jobs)
- `<<` heredocs
- Already-wrapped commands (`mira run …` / `bun src/cli/index.ts run …`)

Adding new skip patterns: edit the `case "$CMD"` blocks in the relevant `<agent>/mira-rewrite.sh`.
