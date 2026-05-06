# Architecture

## Why this shape

Mira's architecture follows from one constraint: every agent-facing conclusion must be backed by traceable raw evidence. That constraint dictates the rest.

The system is split into **kernels** — small, single-responsibility units — rather than layered services. Each kernel either produces or consumes evidence and does nothing else. This keeps kernels independently testable, replaceable, and composable. The dependency direction is one-way by design: CLI and MCP adapt to the kernels, never the inverse.

A separate **boundary layer** (the MCP server is the first instance) re-exposes kernels without becoming one. Boundaries translate; they do not produce evidence. Keeping them outside the kernel set lets new boundaries (HTTP, IDE bindings, agent-specific bridges) be added later without touching what kernels do.

Two background principles run across the whole architecture:

- Épurée by default: small API surface, compact outputs, clear files, minimal concepts.
- Details are recoverable through evidence references, not dumped into every response.

## Overview

Mira V0 is organized around two kernels:

```txt
Evidence Kernel
Command Kernel
```

V0.1 adds:

```txt
Context Kernel
```

V0.2 adds:

```txt
Architecture Kernel
```

V0.3 adds:

```txt
MCP Boundary (not a kernel)
```

Each kernel produces or consumes evidence. The MCP Boundary produces nothing; it re-exposes the existing kernels to MCP-compatible agents (Claude Code, Cursor, Goose, …) over stdio.

The core rule is:

> Every agent-facing conclusion must be backed by traceable raw evidence.

## High-level flow

V0 vertical slice:

```txt
User / Agent
    |
    v
mira run "<command>"
    |
    v
CommandObserver
    |
    v
Raw stdout/stderr + metadata
    |
    v
EvidenceStore
    |
    v
CommandObservation
    |
    v
Agent-facing output
```

V0.1 extension:

```txt
mira context "<task>"
    |
    v
read last 10 CommandObservations
    |
    v
ContextPack (references observations by id)
    |
    v
Agent-facing output
```

V0.2 extension (inside the Context Kernel pipeline):

```txt
mira context "<task>"
    |
    v
Architecture Kernel: senseArchitecture(cwd)
    |
    v
ArchitectureSignal[] (changed / related / test / import-hint)
    |
    v
ContextPack.suspectedFiles (deterministic projection)
```

V0.3 boundary (alternate entry point, same kernels):

```txt
MCP client (Claude Code / Cursor / Goose / …)
    |
    v   stdio (JSON-RPC)
MCP Boundary (src/mcp/)
    |
    v
existing kernels (Evidence / Command / Context / Architecture)
    |
    v
CommandObservation / ContextPack / EvidenceRef (returned verbatim)
```

## Evidence Kernel

The Evidence Kernel stores raw and derived evidence.

It is the most important part of Mira.

Responsibilities:

* store command metadata
* store raw stdout
* store raw stderr
* store generated observations
* store context packs
* expose evidence by id
* keep files human-readable

Initial storage layout:

```txt
.mira/                     created automatically on first `mira run`
  runs/                    V0
    <run-id>/
      metadata.json
      stdout.log
      stderr.log
      combined.log
      observation.json
      observation.md
  context/                 V0.1
    <context-id>.json
    <context-id>.md
```

`.mira/` should be added to project-level `.gitignore`. There is no `mira init` command in V0; the directory is created lazily.

### ID formats

- `run-id`: `run_YYYYMMDDTHHMMSSmmmZ_<random6>` — ISO-8601 compact UTC timestamp with millisecond precision, plus 6 random alphanumeric characters.
- `context-id`: `ctx_YYYYMMDDTHHMMSSmmmZ_<random6>` — same shape with the `ctx_` prefix.

Examples:

```txt
run_20260505T143025123Z_a4f2k9
ctx_20260505T143027001Z_z1m8q3
```

The format is filesystem-safe (ASCII alphanumeric and underscores only) and lexicographically sortable. The random suffix lets parallel `mira run` executions in the same directory share an `.mira/` without a global lock. No external id library is used.

## Command Kernel

The Command Kernel observes command execution.

Responsibilities:

* execute commands
* capture stdout and stderr
* preserve exit codes
* measure duration
* generate command observations
* route outputs through the summarizer

Initial command:

```txt
mira run "<command>"
```

V0 behaviour:

* default timeout: **300 seconds** (configurable timeout is post-V0)
* no real-time streaming — stdout/stderr are captured fully, then the observation is printed once the run completes
* interactive stdin/TTY commands are out of scope
* parallel `mira run` executions in the same `cwd` are supported; uniqueness comes from the `run-id` random suffix, not a global lock

The Command Kernel should not depend on a specific summarizer or external proxy.

## Context Kernel (V0.1)

The Context Kernel generates task-specific context packs.

Responsibilities:

* read the **last 10** `CommandObservation`s for the current project
* reference observations by id — never embed full observation objects
* produce agent-readable markdown
* produce machine-readable json
* list verification commands
* list risks and next actions

A context pack should never invent facts. It can include heuristics, but they must be labeled as heuristics.

The "since last ContextPack" selection mode is explicitly out of scope for V0.1.

## Architecture Kernel (V0.2)

The Architecture Kernel produces task-aware structural signals tied to evidence — `ArchitectureSignal`s — that the Context Kernel projects onto `ContextPack.suspectedFiles`.

Responsibilities:

* read git working-tree state (`changed-file` signals)
* find related files in the same directory by basename stem (`related-file`)
* find conventional test counterparts (`test-file`)
* find files containing a textual import reference to a changed file (`import-hint`)
* verify that every emitted signal references a path that exists on disk

Non-responsibilities:

* no AST, no TypeScript Compiler API, no semantic analysis
* no transitive import graph
* no module ownership or package boundary detection
* no global codebase scoring (Phase 5 is task-aware impact, not health-of-codebase)
* no plugin layer, no `Sensor<T>` interface, no dispatch table
* no persistence as standalone evidence in V0.2 — signals are computed on demand at `mira context` time
* not embedded in `CommandObservation` — that surface stays for command activity

Full type, scope, and population policy: ADR 0005.

## MCP Boundary (V0.3)

The MCP Boundary is **not a kernel**. It is a single boundary file that re-exposes the existing kernels to MCP-compatible agents over stdio.

Responsibilities:

* speak the Model Context Protocol over stdio using `@modelcontextprotocol/sdk`
* register exactly five tools: `run_command`, `get_observation`, `get_raw_evidence`, `generate_context_pack`, `list_recent_runs`
* validate tool inputs (notably: every tool takes an explicit absolute `projectRoot`; the server never reads `process.cwd()` to resolve a project)
* call the matching kernel and return the existing core type (`CommandObservation`, `ContextPack`, `EvidenceRef`) verbatim
* report protocol-level failures via the SDK's `McpError` envelope (`INVALID_INPUT`, `NOT_FOUND`, `PATH_OUTSIDE_EVIDENCE`, `INTERNAL`)

Non-responsibilities:

* no new kernel, no new core type, no new persisted artifact
* no re-encoding, truncation, or summarization of `CommandObservation` or raw evidence
* no re-pagination or extension of `ContextPack.suspectedFiles` (the cap of 20 is enforced by the Context Kernel; ADR 0005)
* no exposure of `ArchitectureSignal[]` outside the `generate_context_pack` pack projection
* no plugin layer — clients cannot register new tools; the five tools are hard-coded
* no transport other than stdio in V0.3; HTTP, SSE, WebSocket, auth, and multi-project sessions are post-V0.3
* no streaming; results are returned once the underlying kernel completes
* no Claude-Code-specific, Codex-specific, Cursor-specific, or Goose-specific surface; the boundary is the protocol, not an agent

Process-level command outcomes (non-zero exit, signal, timeout) are returned via `CommandObservation` fields, never via MCP errors. The boundary preserves exit codes by definition.

Full type, transport, SDK choice, tool contracts, and out-of-scope list: ADR 0006.

## Dependency direction

Preferred dependency direction:

```txt
cli -> kernels -> core types
mcp -> kernels -> core types
adapters -> core types
summarizers -> core types
store -> core types
architecture -> core types
```

Core types should not depend on CLI, adapters, storage implementation, the architecture kernel, or the MCP boundary. The architecture kernel depends on core types only — never the inverse. The MCP boundary depends on kernels and core types only — never the inverse, and it does not import other boundaries (no `mcp -> cli`, no `cli -> mcp`).

## Initial source structure

V0 (current):

```txt
src/
  core/
    evidence.ts                  EvidenceKind, Evidence, EvidenceRef
    ids.ts                       generateRunId()
    command-run.ts               CommandRun type
    command-observation.ts       CommandObservation + buildObservation/buildSummary
    finding.ts                   Finding, EvidenceExcerpt (defined, not yet used)
  store/
    evidence-store.ts            FileEvidenceStore
  command/
    command-observer.ts          CommandObserver (raw shell)
  cli/
    index.ts                     CLI entry, subcommand dispatch
    run.ts                       `mira run` orchestration
    render-observation.ts        markdown renderer for CommandObservation
tests/
  ids.test.ts
  evidence-store.test.ts
  command-observer.test.ts
  command-observation.test.ts
  render-observation.test.ts
  cli-run.e2e.test.ts
```

The V0 summarizer is intentionally inline (`buildSummary` inside `command-observation.ts`) rather than a separate `summarizers/` module: in V0 there is one deterministic generic summarizer and no dispatch.

V0.1 will add:

```txt
src/
  core/
    context-pack.ts
  context/
    context-pack-generator.ts
  cli/
    context.ts
tests/
  context-pack.test.ts
```

V0.2 will add:

```txt
src/
  architecture/
    architecture-signal.ts        ArchitectureSignalKind, ArchitectureSignal
    sense.ts                      senseArchitecture(cwd): Promise<ArchitectureSignal[]>
tests/
  architecture-signal.test.ts
```

`src/architecture/` is the single home for sensing logic. The four heuristics (`changed-file`, `related-file`, `test-file`, `import-hint`) may be inlined or split into local helpers inside `sense.ts`; no exposed dispatch surface, no `Sensor<T>` interface. `src/context/context-pack-generator.ts` is extended (not replaced) to call `senseArchitecture` and project signals onto `ContextPack.suspectedFiles`.

V0.3 will add:

```txt
src/
  mcp/
    server.ts                     MCP server bootstrap, stdio transport, tool registration
    tools/                        one file per tool (may be inlined into server.ts if smaller)
tests/
  mcp-tools.test.ts
```

`src/mcp/` is the single home for the boundary. `@modelcontextprotocol/sdk` is consumed there and nowhere else. The five tool handlers may be inlined into `server.ts` if that stays smaller than splitting them; the contract is the tool list and the per-tool input/output/error specs in ADR 0006, not the file split.

Interface/implementation splits, multiple observers, and command-specific summarizers are deferred until they are justified by an actual need.

## Design constraints

* Local-first.
* Human-readable evidence files.
* No database in V0 unless clearly justified.
* No LLM calls in V0.
* No broad plugin system in V0.
* No UI in V0.
* No command-specific explosion in V0.
* No real-time output streaming in V0.
* No interactive stdin/TTY support in V0.
* Default 300-second timeout per `mira run`.
* `.mira/` is created lazily on first run; no `mira init`.

## Quality bar

A feature is not complete unless:

* raw evidence is stored
* generated output references the evidence
* failure mode is tested
* success mode is tested
* exit code behavior is preserved
* behavior is deterministic

## Post-V0 layers

These layers are not part of V0, V0.1, V0.2, or V0.3 but are sketched here so the kernel and boundary surfaces stay clean as Mira grows.

### Adapter layer (post-V0)

`ToolAdapter` becomes the typed integration boundary for external tools (RTK, Sentrux, git, test runners). Adapters convert external output into Mira-native evidence and observations. Their typed output must include the structured observation **and** the evidence references it points at — adapters cannot return arbitrary ungrounded results.

Adapters are not built in V0; they appear when the first real external integration ships, not preemptively.

MCP is not an adapter. MCP is the V0.3 boundary — see § MCP Boundary (V0.3) above and ADR 0006.

### Richer architecture sensing (post-V0.2)

V0.2 ships a single `src/architecture/` module with four filesystem-only heuristics (see the Architecture Kernel section above and ADR 0005). Transitive import graphs, module ownership, package boundaries, AST-level analysis, and cross-language conventions remain explicitly out of scope for V0.2 and are deferred to a later phase.

### Richer MCP surface (post-V0.3)

V0.3 ships a single stdio transport, five hard-coded tools, and no auth. Remote transports (HTTP, SSE, WebSocket), authentication, multi-project sessions in a single server process, streaming, agent-specific bundles (Claude Code subagents, Codex awareness docs, Cursor/Goose rules), and additional tools all remain explicitly out of scope for V0.3 and are deferred to a later phase. Each will require its own ADR.
