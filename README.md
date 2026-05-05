# Mira

Mira is the context, evidence, and quality layer for AI coding agents.

It helps agents understand a software project before they act: what matters, what changed, what should enter context, and what should stay out.

The core premise is simple: an agent does not fail only because it generates poorly. It often fails because it reasons from the wrong context.

## Why

Coding agents are powerful, but remain fragile in real-world codebases.

They can miss existing patterns, overload their context with irrelevant files, confuse raw terminal output with useful signal, or rebuild the same mental model at every task.

Mira focuses on the layer beneath the agent: how context is discovered, selected, compressed, updated, and delivered.

## What Mira is

Mira is not an autonomous coding agent.

It is infrastructure for agents: tools and conventions for building better context loops around repositories, commands, and project state.

The long-term shape is a context layer that can expose the same evidence model through a CLI, MCP server, API, editor integration, or another agent runtime.

## Principles

- Discover the project before reasoning.
- Prefer compact, typed signals over raw output.
- Keep irrelevant files out of the active context.
- Preserve durable understanding across tasks.
- Stay agent-agnostic: Mira should improve existing agents, not replace them.

## Status

V0 in progress. The first vertical slice:

```txt
mira run "<command>" -> raw evidence -> CommandObservation
```

V0.1 adds `mira context "<task>"` to bundle recent observations into a ContextPack.

The rule is simple: Mira should not dump raw project or terminal output into an agent by default. It extracts signal first, and every conclusion links back to raw evidence on disk.

## Documentation

- `docs/thesis.md` — why Mira exists
- `docs/architecture.md` — V0 architecture
- `docs/domain-model.md` — core types
- `docs/workflow.md` — phase plan
- `docs/non-goals.md` — what V0 deliberately excludes
- `docs/comparables.md` — relationship with RTK and Sentrux
