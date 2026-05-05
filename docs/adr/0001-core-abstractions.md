# ADR 0001: Core Abstractions

## Status

Accepted

## Context

Mira aims to improve AI coding agents by giving them better context and evidence.

Related tools already exist:

- RTK focuses on command output compression.
- Sentrux focuses on architecture health and quality gates.
- Claude Code, Codex, Cursor, and Goose perform agentic coding actions.

Mira will build its own versions of capabilities found in RTK and Sentrux, inside a unified evidence model — not as feature-for-feature ports, and not in V0 unless part of the vertical slice.

Mira needs a small domain model that can unify command activity, raw evidence, and (later) context generation and architecture sensing.

## Decision

Mira V0 is built around three core abstractions:

1. `EvidenceStore`
2. `CommandObserver`
3. `CommandObservation`

V0.1 adds a fourth:

4. `ContextPack`

The following abstractions are deliberately deferred to post-V0:

- `ToolAdapter` — typed integration boundary for external tools. Not built in V0 or V0.1.
- Architecture sensing — no `ArchitectureSignal` type is committed in V0; the type will be defined when Phase 5 starts.

The supporting types (`Evidence`, `EvidenceRef`, `CommandRun`, `Finding`, `EvidenceExcerpt`) live in `docs/domain-model.md`. `EvidenceExcerpt` replaces the earlier `ImportantLine` concept.

## EvidenceStore

The `EvidenceStore` is the foundation.

It stores raw and derived evidence.

Raw evidence includes:

- stdout
- stderr
- combined output
- metadata
- command duration
- exit code

Derived evidence includes:

- command observations
- context packs
- future architecture signals

The initial implementation should be local and file-based.

## CommandObserver

A `CommandObserver` observes command execution.

The first implementation is a raw shell observer.

Future implementations may include:

- RTK-backed observer
- sandboxed observer
- fixture observer
- remote observer
- hook observer — receives `{cmd, stdout, stderr, exitCode, durationMs}` from an agent hook (Claude Code PreToolUse/PostToolUse, Codex, etc.) instead of spawning the process itself. Trades the wrapper's enforced timeout for zero-friction integration with agents that already run commands through their own Bash tool.

The rest of Mira should not care which observer is used.

## CommandObservation

A `CommandObservation` is the structured interpretation of a command run.

It should answer:

- what ran?
- did it pass?
- what failed?
- what matters?
- where is the raw evidence?
- what should the agent do next?

It must always reference evidence.

## ContextPack (V0.1)

A `ContextPack` is task-specific context for an AI coding agent.

It should include:

- references to relevant observations (by id, never embedded)
- evidence references
- suspected files
- verification commands
- risks
- next recommended action

It should be useful both as markdown and as JSON.

V0.1 selects the **last 10** `CommandObservation`s for the current project.

## ToolAdapter (post-V0)

A `ToolAdapter` integrates external tools without polluting the core.

Examples:

- RTK adapter
- Sentrux adapter
- git adapter

When introduced, every adapter must return both a structured `CommandObservation` and the `EvidenceRef`s it points at — adapters cannot return arbitrary ungrounded outputs. MCP is not an adapter; it is the protocol Mira will use to expose its evidence model to agents.

## Consequences

This design keeps Mira small and composable.

It allows Mira to start with a simple vertical slice while leaving room for deeper command intelligence and architecture sensing later.

The cost is that Mira will not initially support a large number of command-specific filters, advanced architecture metrics, or external tool adapters.

That is intentional.

## Invariants (canonical)

This is the canonical invariant list for Mira. Other docs reference this section instead of defining their own.

- Raw evidence must remain accessible.
- Every observation must reference evidence.
- Every `Finding` must be backed by at least one `EvidenceExcerpt` or `EvidenceRef`.
- A `ContextPack` references observations by id; it never embeds them.
- Exit codes must be preserved.
- Failed commands must remain inspectable.
- Summaries must not claim more than the evidence supports.
- Context packs must not invent facts.
- The core domain model must remain small.
- Deterministic behavior is preferred in V0.
- Adapters (when introduced) must be replaceable and must return grounded outputs.
