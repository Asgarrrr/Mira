# Thesis

This document expands the vision in [`README.md`](./README.md). Read that first; this is the long-form argument behind it.

## The failure modes Mira targets

AI coding agents do not fail only because they reason poorly. They fail because the context they receive is poor:

- command outputs are too verbose
- logs contain too much noise
- important failures are buried
- raw evidence is lost after summarization
- repository structure is only partially understood
- previous decisions are forgotten
- verification steps are not preserved
- conclusions are not linked to proof

The result is plausible-but-fragile decisions: agents modify the wrong files, miss existing abstractions, hallucinate APIs, ignore failing tests, repeat exploration work across the same session.

Better generation does not fix any of these. Better context input does.

## The central object

The central object in Mira is not a prompt. It is an evidence-backed observation.

A command should not merely produce text. It should produce a structured observation:

- what ran
- whether it passed
- what failed
- what matters
- where the raw proof is stored
- what files may be related
- what the agent should verify next

This is the unit. Everything else — context packs, architecture signals, future kernels — is a composition of this unit and its evidence references.

## Differentiation

RTK asks:

> How do we reduce noisy command output?

Sentrux asks:

> Is the codebase architecture degrading?

Mira asks:

> What evidence and context should the agent use next to complete this task correctly?

The first two are reductive: they compress activity or grade it. Mira is the inverse — it assembles, from that activity, a task-specific answer to a question the other tools were never designed to ask. Compression and grading become inputs to that assembly, not its competitors.

## Épurée

Mira should feel épurée. This does not mean simplistic. It means:

- few concepts
- strong primitives
- clear names
- low visual and cognitive noise
- no decorative complexity
- no feature accumulation without purpose
- no agent-facing output that feels verbose or messy

A good Mira output is short, structured, grounded, and immediately useful. The user should feel that Mira removes noise instead of adding another layer of noise.

## Design principle: boring at the core, powerful at the edges

The core stays boring. Clear types, explicit evidence links, deterministic heuristics, simple storage, replaceable adapters. No magic, no premature abstraction.

The edges become smart later: deterministic distillers, architecture signals, MCP insight tools, native performance modules. Each of these is added when an actual need arrives, not preemptively, and each must compose through the evidence model.

This split is what lets Mira accumulate capability without accumulating complexity. Kernels do not evolve to support new edges, because the contract between core and edges is the evidence model itself.

## V0 thesis

Mira V0 must prove one thing:

> Raw command execution can be transformed into a compact, traceable, useful observation for an AI coding agent.

The first vertical slice is `mira run "<command>"`. It must:

1. execute a command (default 300-second timeout, no real-time streaming, no interactive TTY)
2. capture stdout and stderr
3. preserve the exit code
4. store raw output locally under `.mira/runs/<run-id>/` (created lazily on first run)
5. generate a structured `CommandObservation`
6. generate a human-readable observation markdown
7. print an agent-friendly summary

V0.1 then proves that recent observations can be bundled into a `ContextPack` via `mira context "<task>"`, reading the last 10 observations.

This is enough to prove the foundation. Everything later layers onto it.

## Core invariants

The canonical invariant list lives in [`adr/0001-core-abstractions.md`](./adr/0001-core-abstractions.md). Two of them drive everything else: raw evidence is never silently discarded, and every observation links back to it.

## Product direction

Mira evolves in layers. Each layer is independently useful.

```txt
V0:   Evidence + CommandObservation
V0.1: simple ContextPack
V0.2: architecture sensing (filesystem-only, task-aware)
V0.3: MCP boundary
V1:   deeper ContextPack heuristics + first command-specific summarizers
V2:   command intelligence
V3:   richer architecture sensing
V4:   ToolAdapter + first external integrations
V5:   session memory and review workflows
V6:   richer repository understanding
```

Each layer earns its place by serving the evidence model. None of them is added because another tool has it.
