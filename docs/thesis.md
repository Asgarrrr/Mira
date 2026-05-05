# Mira Thesis
Mira should feel épurée: a quiet layer that removes noise, preserves proof, and gives agents only what matters.

## One-line definition

Mira is the context, evidence, and quality layer for AI coding agents.

It helps agents work better inside real codebases by transforming raw development activity into structured, traceable, task-specific context.

## The problem

AI coding agents do not fail only because they reason poorly.

They often fail because the context they receive is poor:

- command outputs are too verbose
- logs contain too much noise
- important failures are buried
- raw evidence is lost after summarization
- repository structure is only partially understood
- previous decisions are forgotten
- verification steps are not preserved
- conclusions are not linked to proof

As a result, agents make plausible but fragile decisions.

They may modify the wrong files, miss existing abstractions, hallucinate APIs, ignore failing tests, or repeat exploration work across the same session.

## Core belief

Better agent output requires better context input.

Mira does not try to make the model smarter directly.

Mira improves the environment around the model by ensuring that the agent receives context that is:

- relevant
- compact
- structured
- current
- task-specific
- verifiable
- linked to raw evidence

## Épurée

Mira should feel épurée.

This does not mean simplistic.

It means:

- few concepts
- strong primitives
- clear names
- low visual and cognitive noise
- no decorative complexity
- no feature accumulation without purpose
- no agent-facing output that feels verbose or messy

Mira should make complex development activity feel legible.

The user should feel that Mira removes noise instead of adding another layer of noise.

A good Mira output should be short, structured, grounded, and immediately useful.

## What Mira is

Mira is a local-first system that observes development activity and turns it into useful agent context.

It provides:

In V0:

- raw evidence capture
- command observations

In V0.1:

- a simple context pack referencing recent observations

Later:

- adapter-based integrations
- command intelligence
- architecture sensing
- session memory
- verification-oriented workflows

Mira should answer:

> Given this task, this codebase, and the evidence collected so far, what does the agent need to know next?

## What Mira is not

Mira is not a coding agent, not an autonomous developer, not a generic RAG system, and not a UI product in V0. The full list lives in `docs/non-goals.md`.

Mira should improve agents, not replace them.

## Related tools

RTK, Sentrux, and the various coding agents (Claude Code, Codex, Cursor, Goose) are described in `docs/comparables.md`. The short version: Mira will build its own versions of output summarization, architecture sensing, and quality signals — but inside one unified evidence model and only when each capability earns its way in. Mira sits around the coding agents, not in their place.

## Differentiation

RTK asks:

> How do we reduce noisy command output?

Sentrux asks:

> Is the codebase architecture degrading?

Mira asks:

> What evidence and context should the agent use next to complete this task correctly?

Mira’s value is not raw compression alone.

Its value is the transformation from raw activity to actionable context.

## Core abstraction

The central object in Mira is not a prompt.

The central object is an evidence-backed observation.

A command should not merely produce text.

It should produce a structured observation:

- what ran
- whether it passed
- what failed
- what matters
- where the raw proof is stored
- what files may be related
- what the agent should verify next

## V0 thesis

Mira V0 should prove one thing:

> Raw command execution can be transformed into a compact, traceable, useful observation for an AI coding agent.

The first vertical slice is:

```txt
mira run "<command>"
```

It should:

1. execute a command (default 300-second timeout, no real-time streaming, no interactive TTY)
2. capture stdout and stderr
3. preserve the exit code
4. store raw output locally under `.mira/runs/<run-id>/` (created lazily on first run)
5. generate a structured `CommandObservation`
6. generate a human-readable observation markdown
7. print an agent-friendly summary

V0.1 then proves that recent observations can be bundled into a `ContextPack` via `mira context "<task>"`, reading the last 10 observations.

This is enough to prove the foundation.

## Core invariants

The canonical invariants live in `docs/adr/0001-core-abstractions.md`. Two of them drive everything else: raw evidence is never silently discarded, and every observation links back to it.

## Product direction

Mira should evolve in layers:

```txt
V0:   Evidence + CommandObservation
V0.1: simple ContextPack
V1:   deeper ContextPack heuristics + first command-specific summarizers
V2:   command intelligence
V3:   architecture sensing
V4:   ToolAdapter + MCP / agent integration
V5:   session memory and review workflows
V6:   richer repository understanding
```

Each layer should remain useful on its own.

## Design principle

Mira should be boring at the core and powerful at the edges.

The core should contain:

* clear types
* explicit evidence links
* deterministic heuristics
* simple storage
* replaceable adapters

The edges can later become smarter:

* LLM summarization
* architecture signals
* agent-specific workflows
* MCP tools
* dashboards
* Rust-native performance modules

## Final thesis

Mira is not the agent.

Mira is the layer that makes agents work with better evidence.

Its job is to turn the chaos of real development activity into context that is compact enough for an LLM, structured enough for automation, and traceable enough for a human to trust.
