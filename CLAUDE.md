# CLAUDE.md

## Project

This repository is building **Mira**.

Mira is the context, evidence, and quality layer for AI coding agents.

It helps agents like Claude Code, Codex, Cursor, Goose, or other MCP-compatible tools work better inside real codebases by transforming raw development activity into compact, structured, traceable, task-specific context.

Mira is not a coding agent.

## Core principles

- Keep Mira épurée: minimal surface, clear concepts, no noisy features.
- Prefer one strong primitive over many weak features.
- Prefer deterministic behavior in V0.
- Mira will build its own versions of capabilities found in RTK and Sentrux, inside the unified evidence model — not as feature-for-feature ports, and not in V0 unless part of the vertical slice.

For the canonical invariants (evidence, exit codes, adapters, etc.), see `docs/adr/0001-core-abstractions.md`.

## Product direction

Mira is inspired by:

- RTK: command proxying, output filtering, token reduction.
- Sentrux: architecture sensing, quality gates, structural feedback.

Mira should unify these ideas around one stronger model:

> Every agent-facing observation should be backed by traceable raw evidence.

## V0 scope

The first vertical slice:

- `mira run "<command>"`
- capture stdout and stderr (no real-time streaming in V0; output is printed once the run completes)
- preserve exit code
- enforce a default 300-second timeout
- auto-create `.mira/` on first run
- store raw evidence under `.mira/runs/<run-id>/`
- generate a structured `CommandObservation`
- generate a human-readable observation markdown

Do not add broad orchestration, UI, cloud sync, plugin systems, or many command-specific filters. Mira must stay épurée: focused, readable, and conceptually sharp.

Out of scope for V0: interactive stdin/TTY commands, configurable timeout, output streaming.

## V0.1 scope

- `mira context "<task>"` reads the last 10 observations and produces a simple `ContextPack`.
- The pack references observations by id; it does not embed them.
- `task` is free text.

## Core abstractions (V0)

- `EvidenceStore`: stores raw and derived evidence.
- `CommandObserver`: observes command execution.
- `CommandObservation`: structured command result with evidence references.

V0.1 adds `ContextPack`. `ToolAdapter` is deferred to post-V0. `ArchitectureSignal` is removed from the V0 model and may be reconsidered as a future concept. See `docs/adr/0001-core-abstractions.md`.

## Workflow

Before editing:

- inspect relevant files
- explain the current design briefly
- propose a small plan
- identify risks

During implementation:

- keep diffs small
- make one conceptual change at a time
- add tests for behavior
- avoid dependencies unless justified
- avoid speculative features

After implementation:

- run targeted tests
- summarize changed / verified / risks / next step

## Stack

Use TypeScript/Bun for V0. Do not start with Rust unless explicitly requested.

## Testing

Cover:

- successful command execution
- failed command execution
- exit code preservation
- timeout handling
- raw evidence storage
- observation format
- deterministic summarization
- (V0.1) context pack generation from fixture observations

Prefer realistic fixtures and snapshot tests for generated outputs.
