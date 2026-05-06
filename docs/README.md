# Vision

Mira is the substrate that owns the context layer for AI coding agents.

Not an agent. Not a tool among tools. The layer.

## The bet

The bottleneck for agentic coding is not generation quality — it is context quality. Models keep getting better; agents keep failing on real codebases. The reason is consistent: agents reason from the wrong context. Missed patterns, irrelevant files in scope, raw terminal output mistaken for signal, no memory across tasks.

The industry treats context as a side-effect of building agents. Mira treats it as the product. Everything else follows from that inversion.

This bet has a window. The agent market is consolidating around a few runtimes — Claude Code, Codex, Cursor, Goose, and the next ones already in motion. The layer beneath them stays unowned. Whoever owns that layer becomes the canonical point of entry for every agent on every project that adopts it.

## The unlock

The shape that makes this work is the evidence model.

Every agent-facing observation Mira produces is **compact** — small enough for a context window — and **traceable** — the agent can drill into raw bytes if it needs to. These two properties are usually opposed: compact systems lose information, verifiable systems flood context. The evidence model resolves the contradiction by separating them at storage time and re-uniting them at read time.

Raw bytes go to disk under `.mira/`, never overwritten. Structured observations reference those bytes by path. The agent always sees the structured layer; the raw layer is one hop away when needed. This is the trick that lets Mira scale: the more activity flows through it, the richer the evidence becomes — and the agent's working memory does not grow with it.

## The terminal shape

In two to three years, Mira is a local daemon that sits between the developer's workflow and any agent the developer uses. It wraps every command, captures every relevant signal, and builds a durable understanding of the project that survives across sessions. The agent never sees raw bytes — only structured observations with traceable links. The developer keeps a replayable trace of every action their agents took.

Multiple surfaces, one spine:

- CLI for direct human use.
- MCP server for any MCP-compatible client.
- API for runtime integration.
- IDE bindings for inline workflows.
- Bridges into other agent runtimes as they appear.

All of them expose the same evidence model. None of them is the product — the model is.

The accumulation compounds. A project that has used Mira for six months has a body of evidence no fresh agent can match. New agents inherit it. New developers inherit it. The substrate accrues value the way a git history accrues value — but for agent-relevant facts, not source code.

## Why Mira rebuilds RTK and Sentrux

RTK reduces command output. Sentrux senses architecture. Both solve real problems that Mira will solve too. Mira does not wrap them, port them, or import them — it rebuilds their capabilities natively, inside the evidence model.

The reason is structural. RTK distills output and discards the raw bytes; Sentrux emits opaque grades and discards the underlying signals. Their outputs are terminal: useful in isolation, hard to combine. Integrating them would inherit those terminations.

Inside the evidence model, output filtering and structural sensing are not separate features — they are dimensions of the same observation. A single `ContextPack` can carry both *"this command ran, here is the distilled signal"* and *"the change touched 14 files with these coupling concerns"* as one coherent payload. Neither RTK nor Sentrux can produce that payload alone, because their outputs were never designed to compose.

That composability is the strategic difference. Dependency on either project would cap Mira at the lower of the two ceilings. Rebuilding inside the evidence model removes the ceiling.

## Reading order

This document is the entry point. After this:

1. **[`thesis.md`](./thesis.md)** — long-form expansion of the bet. The full argument behind "context is the bottleneck" and the design principle "boring at the core, powerful at the edges".
2. **[`comparables.md`](./comparables.md)** — what Mira learns from RTK, Sentrux, and existing agents, and where it deliberately diverges.
3. **[`architecture.md`](./architecture.md)** — the kernel structure, dependency direction, source layout. Read before touching code.
4. **[`domain-model.md`](./domain-model.md)** — every type Mira manipulates, with TypeScript signatures. Read before designing a feature that produces or consumes evidence.
5. **[`workflow.md`](./workflow.md)** — the phase plan and the definition-of-done per slice. Read before opening a PR.
6. **[`non-goals.md`](./non-goals.md)** — what Mira deliberately is not, especially during V0. Read when you feel an urge to add scope.
7. **[`adr/`](./adr/)** — canonical architectural decisions. Each ADR records one binding choice and its reasoning.
