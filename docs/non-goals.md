# Non-goals

This document defines what Mira should not become, especially during V0.

## Not a coding agent

Mira should not generate, modify, or autonomously commit code in V0.

Coding agents already exist.

Mira should improve their context, evidence, and verification loop.

## Not a port of RTK

Mira will eventually do its own form of command output handling — but inside the evidence model, not as an RTK lookalike.

V0 must not:

- support a long catalogue of command-specific filters
- optimize for token reduction as the primary goal
- treat "smaller output" as equivalent to "better output"

Bad direction:

```txt
mira = shorter command output
```

Good direction:

```txt
mira = traceable command understanding
```

## Not a port of Sentrux

Mira will eventually do its own form of architecture sensing — but as task-aware signals tied to evidence, not as a port of Sentrux.

V0 must not:

- compute a global architecture health score
- ship visual architecture dashboards
- treat the codebase, rather than the task, as the unit of analysis

Bad direction:

```txt
mira = architecture score
```

Good direction:

```txt
mira = task-aware quality signal backed by evidence
```

## Not a generic RAG system

Mira should not start as a document search tool.

It should not blindly index everything and retrieve semantically similar chunks.

Mira is evidence-first, not embedding-first.

Repository understanding may come later, but the first layer should be based on observed development activity.

## Not cloud-first

V0 should be local-first.

No accounts, no team sync, no hosted dashboard, no telemetry by default.

The local evidence store should be simple, inspectable, and human-readable.

## Not a plugin marketplace

V0 should not include a plugin marketplace, plugin registry, or complex extension system.

Adapters should be simple internal boundaries first.

## Not a UI product yet

No web dashboard in V0.

No complex terminal UI in V0.

The first interface should be a CLI and generated markdown/json files.

## Not an orchestration platform yet

Mira should not start by coordinating multiple agents.

The first useful loop is:

```txt
command -> evidence -> observation -> context pack
```

Multi-agent orchestration can come later.

## Not magic

Mira should not hide uncertainty.

Mira should not produce unsupported conclusions.

Every summary, hint, or next action should be grounded in evidence or explicitly marked as heuristic.

## Not noisy

Mira should not become another noisy developer tool.

Avoid:

- verbose default outputs
- dashboards before primitives
- too many commands too early
- large generated reports
- vague recommendations
- decorative metrics
- excessive configuration

Mira should be épurée by default.

Advanced detail should be available on demand, not pushed into the main output.
