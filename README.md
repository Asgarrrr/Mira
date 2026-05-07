<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://1gvi2f77a6prtwfg.public.blob.vercel-storage.com/Mira%20Banner%20Dark%402x-h39wBkNDg5T64DQMt1QZVEQzbHRbgI.webp">
    <source media="(prefers-color-scheme: light)" srcset="https://1gvi2f77a6prtwfg.public.blob.vercel-storage.com/Mira%20Banner%20Light%402x-gx0r5gvKRiW8zjd4iaQEJoyOQ5EHSL.webp">
    <img alt="Mira" src="https://1gvi2f77a6prtwfg.public.blob.vercel-storage.com/Mira%20Banner%20Dark%402x-h39wBkNDg5T64DQMt1QZVEQzbHRbgI.webp">
  </picture>
</p>

Not an agent. Not a tool among tools. **The layer.**

Coding agents do not fail because they generate poorly. They fail because they reason from the wrong context — missed patterns, irrelevant files in scope, raw terminal output mistaken for signal, no memory across tasks.

Mira sits beneath the agent and treats context as the product. Every command, every output, every change becomes typed, traceable evidence. Agents ask Mira what to look at — and what to ignore — instead of dumping the world into their window.

## The loop

```
commands → evidence → observations → context → action
```

- **commands** — every execution is wrapped and captured with stdout, stderr, exit code, signals, timing.
- **evidence** — raw bytes preserved under `.mira/`, never overwritten.
- **observations** — typed, structured summaries (`CommandObservation`) referencing evidence by id.
- **context** — a `ContextPack` assembled on demand from recent observations and the project's structural understanding.
- **action** — any agent consumes the pack through the CLI, the MCP server, the API, or the IDE.

Compact enough for an agent's window. Traceable enough to drill into raw bytes when it needs to.

## What Mira does

Three kernels feed the agent, all inside the unified evidence model.

**Live map** — a typed, queryable cartography of the codebase: modules, exports, types, signatures, locations. The agent reads it before exploring, instead of burning tokens grepping for definitions and call sites.

**Distillation** — command-specific summarizers (`bun test`, `tsc`, `git diff`, `eslint`, …) turn raw output into typed `Finding[]` at capture time. Raw bytes are never discarded; the agent always has a one-hop drill-in.

**Structural sensing** — coupling, cohesion, co-changes, hotspots — emitted as `ArchitectureSignal[]` tied to specific paths, never as opaque global grades.

They compose. *"3 test failures"* becomes *"3 failures in core/middleware — imported by 14 call sites, recently refactored, here are the verification commands to run next."* No single kernel produces that payload alone.

The substrate accumulates. A project that has lived with Mira for six months carries a body of evidence a fresh agent cannot match — and every new agent that connects inherits it.

## Surfaces

Two local surfaces, one model.

- **CLI** — `mira run`, `mira context`, `mira hooks install`. Direct human use, scripts, automatic agent capture.
- **MCP server** — local stdio. Any MCP-compatible client (Claude Code, Cursor, Goose, Codex, …) consumes Mira through typed tools.

## Quick start

```bash
# from a clone of this repo
bun install && bun link
mira run "bun test"
```

The first run creates `.mira/`. Each run gets a stable id, a raw evidence directory, and a structured observation:

```
.mira/runs/<run-id>/
├── stdout.log
├── stderr.log
└── observation.json
```

Assemble context for a task:

```bash
mira context "fix flaky test in auth"
```

Plug Mira into Claude Code — every Bash command the agent runs is captured as an observation, automatically:

```bash
mira hooks install --agent claude
```

The installer is idempotent, project-scoped (`--scope project`) or user-scoped (default), and coexists with any other PreToolUse hooks already configured. Run `mira hooks status` to see what's active. Other MCP-compatible clients consume Mira through the stdio server:

```bash
mira mcp
```

## Principles

- **One primitive, many surfaces.** The evidence model is the spine. CLI, MCP, API, IDE — all expose the same types.
- **Local-first, deterministic.** No network in the kernel. No LLM in the kernel. Same input, same observation.
- **Compact signal over raw output.** Mira refuses to dump terminal bytes into an agent's window.
- **Traceable.** Every conclusion in an observation links to bytes on disk.
- **Agent-agnostic.** Mira improves the agents you already use. It does not replace them.
