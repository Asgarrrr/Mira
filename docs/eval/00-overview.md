# Eval foundation — overview

This folder cadres the work needed to *demonstrate*, not just claim, that Mira helps an AI coding agent. After V0/V0.1/V0.2/V0.3 the infrastructure is solid and internally coherent — but no closed loop has shown that an agent does measurably better with Mira's MCP tools available than without.

## Why this branch exists

V0.3 (the MCP boundary) gives Mira a standard agent-facing surface: any MCP-capable client (Claude Code, Cursor, Goose, …) can consume the five tools without per-agent integration. The next question is empirical: when an agent actually has these tools in its belt, does anything actually improve?

This branch ships **only** docs (and a Sentrux config). No `src/` change. The actual eval implementation comes in follow-up PRs cadrés by `05-first-experiment.md`.

## Two tracks

- **Track 1 — defensive:** lock the dependency invariants of [ADR 0006](../adr/0006-mcp-server-v0-3-scope.md) (`mcp → kernels → core types`, never the inverse) into a `.sentrux/rules.toml`. Single task: [`01-sentrux-rules.md`](./01-sentrux-rules.md).
- **Track 2 — eval foundation:** thesis, metrics, harness, scenarios, first experiment. Files [`02-`](./02-thesis-and-metrics.md) through [`05-`](./05-first-experiment.md). This branch *designs*; follow-up PRs *implement*.

## Reading order

1. [`01-sentrux-rules.md`](./01-sentrux-rules.md) — small, defensive, do first
2. [`02-thesis-and-metrics.md`](./02-thesis-and-metrics.md) — what "better" means
3. [`03-harness-design.md`](./03-harness-design.md) — how runs are produced
4. [`04-scenario-corpus.md`](./04-scenario-corpus.md) — what runs are over
5. [`05-first-experiment.md`](./05-first-experiment.md) — the smallest concrete run we'll execute

## Branch protocol

- Branch name: `chore/eval-foundation`, branched from `main`
- Pre-flight: `bun test`, `bun run typecheck`, `bun run check` all pass on `main` before branching
- This PR adds: `docs/eval/*.md`, optionally `.sentrux/rules.toml`
- Follow-up PRs add a top-level `eval/` directory (designed in `03-harness-design.md`)

## Out of scope (this PR)

- Any code under `src/`
- Any change to root `package.json` or runtime dependencies
- Any actual eval run

## Out of scope (eval foundation as a whole)

- Multi-agent comparison (Claude Code vs Codex vs Goose) — the first experiment uses the Anthropic SDK directly, controlled environment, one variable at a time
- Public benchmark integration (SWE-bench, etc.) — synthetic scenarios on Mira itself give faster iteration with fewer moving parts
- Claims about Mira's performance against RTK / Sentrux / soulforge as products — this is internal validation, not competitive benchmarking
