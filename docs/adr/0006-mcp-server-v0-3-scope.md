# ADR 0006: MCP server V0.3 — scope, transport, and tool contracts

## Status

Superseded by ADR 0007 (in part). This ADR's transport choice (stdio), SDK choice (`@modelcontextprotocol/sdk`), `projectRoot` invariant, and error envelope still hold. The five-tool list does not: ADR 0007 deprecated and removed `run_command`, `get_observation`, and `get_raw_evidence`. The current insight surface is `generate_context_pack` and `list_recent_runs`.

## Context

`docs/workflow.md` Phase 6 was a fuzzy menu of "possible integrations" (CLI output, Mira as an MCP server, Claude Code commands, Codex awareness docs) with a five-tool sketch and no contract. V0, V0.1, and V0.2 have all shipped. Before any Phase 6 code lands, the agent-facing surface must be locked: which protocol, which transport, which tools, which inputs and outputs, which errors. Otherwise the implementation will either fork into per-agent integrations (Claude Code-specific, Codex-specific) or invent a bespoke RPC surface (an ADR 0001 invariant violation in spirit — Mira's evidence model would leak into a custom protocol).

ADR 0001 reserved MCP explicitly:

> MCP is not an adapter; it is the protocol Mira will use to expose its evidence model to agents.

ADR 0001 also forbids "broad plugin system in V0" and "no LLM calls in V0", and `docs/architecture.md` design constraints reinforce that. V0.3 must show that adopting the MCP standard is *not* a plugin layer and *not* a reinterpretation of the evidence model — it is a single boundary that re-exposes the existing kernels.

ADR 0005 established a precedent for V0.2: `senseArchitecture` resolves the project root via `git rev-parse --show-toplevel` from a passed-in `cwd`. An MCP server is launched by the client (Claude Code, Cursor, Goose, …) from an arbitrary working directory, so any tool that touches the project tree must take an explicit `projectRoot` input rather than reading `process.cwd()`. V0.3 carries this constraint forward.

## Decision

### Scope (V0.3)

V0.3 ships a single boundary: an MCP server over stdio that exposes Mira's existing kernels as five tools. No new kernel, no new core type, no new persisted artifact.

- **Protocol**: Model Context Protocol.
- **Transport**: stdio. One transport, local only.
- **Tools**: exactly the five listed below.
- **SDK**: `@modelcontextprotocol/sdk` (npm). Justification in §SDK choice.

The five tools:

1. `run_command`
2. `get_observation`
3. `get_raw_evidence`
4. `generate_context_pack`
5. `list_recent_runs`

Each tool re-uses an existing kernel; none introduces new domain types.

### SDK choice

V0.3 takes a runtime dependency on `@modelcontextprotocol/sdk`.

Hand-rolling JSON-RPC 2.0 framing, content-length headers, and the MCP handshake is in the same risk class as hand-rolling parsing or auth: a deep, well-maintained domain where reinvention buys nothing and breaks subtly under real clients. The user-level dependency rule (CLAUDE.md) explicitly puts protocol parsing in the "do add a library" bucket.

This is not a violation of ADR 0001's "no broad plugin system in V0":

- A *plugin layer* exposes Mira's internals to third-party code via a registry or interface (`Sensor<T>`, `ToolAdapter`, dispatch table). Mira does not gain one in V0.3.
- A *boundary* re-exposes Mira's already-existing kernels to external consumers via a fixed protocol. The MCP server is a boundary. The five tools are hard-coded; clients cannot register new ones.

The SDK is consumed in exactly one place: `src/mcp/server.ts` (and its tool handlers). It does not leak into `core/`, `command/`, `context/`, `architecture/`, or `store/`. The dependency direction is `mcp -> kernels -> core types`, never the inverse.

### Tool contracts

All input and output types are expressed in TypeScript. Existing types (`CommandObservation`, `ContextPack`, `EvidenceRef`) are imported from `src/core/`. Errors are reported via the SDK's `McpError` mechanism using the JSON-RPC error model; codes are listed per tool below. Process-level outcomes (non-zero exit, signal termination, timeout) are **never** MCP errors — they are part of the structured observation. This preserves exit codes through the boundary (ADR 0001 invariant).

#### 1. `run_command`

Wraps the Command Kernel. Equivalent to `mira run "<command>"` executed in `projectRoot`.

```ts
type RunCommandInput = {
  command: string                                       // shell command, non-empty
  projectRoot: string                                   // absolute path; must exist and be a directory
}

type RunCommandOutput = {
  observation: CommandObservation                       // re-used verbatim, never re-encoded
}
```

Behaviour:

- Default 300-second timeout (V0 invariant). Not configurable in V0.3.
- No streaming. Result is returned once the command completes.
- Non-zero exit, signal termination, and timeout are returned via `observation.exitCode`, `observation.signal`, and `observation.killedByTimeout` — not via MCP errors.

MCP errors:

- `INVALID_INPUT` — `command` is empty, `projectRoot` does not exist, or `projectRoot` is not a directory.
- `INTERNAL` — spawn failure unrelated to the command's own exit (e.g., fork/exec error).

#### 2. `get_observation`

Wraps the Evidence Store. Returns the persisted observation by id.

```ts
type GetObservationInput = {
  observationId: string                                 // in V0, equal to run-id
  projectRoot: string                                   // absolute path; resolves which .mira/ to read
}

type GetObservationOutput = {
  observation: CommandObservation                       // loaded from .mira/runs/<id>/observation.json
}
```

Behaviour:

- Reads `.mira/runs/<observationId>/observation.json` under `projectRoot`. Does not re-derive any field; the persisted JSON is the source of truth.
- `ArchitectureSignal[]` is **not** part of `CommandObservation` and is therefore never returned by this tool (ADR 0005 invariant).

MCP errors:

- `NOT_FOUND` — no run directory for `observationId`, or `observation.json` missing.
- `INTERNAL` — `observation.json` exists but is unreadable or malformed.

#### 3. `get_raw_evidence`

Wraps the Evidence Store. Returns the raw bytes of a stored evidence file by reference.

```ts
type GetRawEvidenceInput = {
  ref: EvidenceRef                                      // ref.path is a relative path under .mira/
  projectRoot: string
}

type GetRawEvidenceOutput = {
  ref: EvidenceRef
  bytes: number
  content: string                                       // file decoded as UTF-8; invalid sequences become U+FFFD. V0 evidence is text-only (architecture.md)
}
```

Behaviour:

- `ref.path` is resolved against `<projectRoot>/.mira/`. Any resolved path that escapes `<projectRoot>/.mira/` (path traversal, absolute paths, symlinks pointing outside) is rejected before any read.
- The file is read as UTF-8 text and surfaced as `content: string`. Invalid UTF-8 sequences are replaced with `U+FFFD` per the platform's `readFileSync(_, "utf8")` semantics. `bytes` always reports the on-disk size.
- This contract is sufficient for V0 evidence kinds (`stdout`, `stderr`, `combined`, `metadata`, `observation`, `context`, `other`), which are all produced from `TextDecoder`-decoded shell output and are therefore already text on disk. Extending this tool to binary evidence (e.g. screenshots, packed coverage) requires a new ADR — for instance an `encoding: "utf8" | "base64"` field on `GetRawEvidenceOutput`. ADR 0001's "raw evidence must remain accessible" is honored because the underlying file is untouched on disk; the boundary does not truncate or summarize.

MCP errors:

- `INVALID_INPUT` — `ref.path` is empty or not a string.
- `PATH_OUTSIDE_EVIDENCE` — resolved path escapes `<projectRoot>/.mira/`.
- `NOT_FOUND` — file does not exist.
- `INTERNAL` — read failure.

#### 4. `generate_context_pack`

Wraps the Context Kernel. Equivalent to `mira context "<task>"` executed in `projectRoot`.

```ts
type GenerateContextPackInput = {
  task: string                                          // free text, may be empty
  projectRoot: string                                   // explicit; never inferred from process.cwd()
}

type GenerateContextPackOutput = {
  pack: ContextPack                                     // re-used verbatim; observationIds, not embedded observations
}
```

Behaviour:

- Reads the last 10 `CommandObservation`s for `projectRoot` (V0.1 selection rule, ADR 0004).
- Computes `ArchitectureSignal[]` on demand via `senseArchitecture(projectRoot)` and projects them onto `pack.suspectedFiles` (V0.2, ADR 0005). The cap of 20 paths is the kernel's responsibility; this tool **does not re-paginate, re-order, or extend** the result.
- Persists the pack to `.mira/context/<context-id>.{json,md}` exactly as the CLI does. The boundary's behaviour matches the CLI's behaviour byte-for-byte.
- An empty observation set is not an error — the returned pack has `observationIds: []` and follows ADR 0004 Tier 2 (empty `risks`, empty `nextRecommendedAction`).

MCP errors:

- `INVALID_INPUT` — `projectRoot` does not exist or is not a directory.
- `INTERNAL` — store read failure or filesystem failure during sensing.

#### 5. `list_recent_runs`

Wraps the Evidence Store. Returns a slim projection of recent observations for browsing — not a substitute for `get_observation`.

```ts
type ListRecentRunsInput = {
  projectRoot: string
  limit?: number                                        // default 10, max 50
}

type ListRecentRunsOutput = {
  runs: Array<{
    id: string                                          // run-id
    command: string
    status: "success" | "failure"
    exitCode: number | null
    signal?: string
    killedByTimeout: boolean
    durationMs: number
    startedAt: string                                   // ISO 8601 UTC, mirrors CommandRun.startedAt
  }>
}
```

Behaviour:

- Each `runs[i]` is a projection of fields already present on the persisted `CommandRun` / `CommandObservation`. No new field is introduced; this is a slim view, not a re-encoding.
- Order: most recent first. Empty result is not an error.

MCP errors:

- `INVALID_INPUT` — `limit < 1`, `limit > 50`, or `projectRoot` does not exist.
- `INTERNAL` — store read failure.

### Error model

Errors are reported through `@modelcontextprotocol/sdk`'s `McpError` using the JSON-RPC error envelope. The Mira-specific code names listed above are carried as the `data.code` field of the error; the `message` field carries a human-readable summary. No new domain type is introduced in `docs/domain-model.md` for errors.

### projectRoot input

Every tool that touches a project (all five) requires an explicit absolute `projectRoot`. The MCP server **never** falls back to `process.cwd()`. The server process is launched by the client (Claude Code, Cursor, Goose, …) from an arbitrary working directory, and inferring the project from the server's cwd would break in every multi-project setup. The constraint inherits from ADR 0005's `senseArchitecture(cwd)` precedent.

## Out of scope (V0.3)

- HTTP / SSE / WebSocket transports. Stdio only.
- Authentication, authorization, ACLs.
- Multi-project sessions in a single server process. One `projectRoot` per tool call.
- Streaming command output through MCP (matches V0's "no real-time streaming" constraint).
- Streaming observations or context packs as deltas.
- Claude-Code-specific subagents, slash commands, or bundles.
- Codex awareness documents.
- Cursor- or Goose-specific rule files.
- A sixth tool. Five tools, hard-coded. New tools require a new ADR.
- Configurable timeouts, configurable `.mira/` location, configurable selection windows. V0.3 inherits V0/V0.1/V0.2 defaults.
- Embedding `ArchitectureSignal[]` in `CommandObservation` or in any tool response other than `generate_context_pack`'s `pack.suspectedFiles` projection.
- Persisting MCP-call telemetry as evidence.

## Invariants (V0.3-specific)

- Raw evidence remains untouched on disk. `get_raw_evidence` reads the file as UTF-8 text (invalid sequences replaced with `U+FFFD`); it does not truncate or summarize. This is sufficient for V0's text-only evidence kinds — a binary evidence kind would require a new ADR extending the contract (ADR 0001).
- No tool re-encodes `CommandObservation`. `run_command` and `get_observation` return the existing type as-is. `list_recent_runs` returns a slim projection of fields already present on `CommandObservation`/`CommandRun` — it introduces no new field.
- `ContextPack.suspectedFiles` is projected and capped by the Context Kernel per ADR 0005. `generate_context_pack` does not re-paginate or extend the cap of 20.
- `ArchitectureSignal[]` is not exposed outside `generate_context_pack`'s pack projection (ADR 0005).
- Exit codes, signals, and timeouts are preserved via `CommandObservation` fields (`exitCode`, `signal`, `killedByTimeout`), never via MCP errors. Process-level failures are not protocol-level failures.
- All five tools take an explicit absolute `projectRoot`. The server never reads `process.cwd()` to resolve a project.
- `path` inputs are constrained to `<projectRoot>/.mira/`. Path traversal is rejected before any filesystem read.
- Dependency direction: `mcp -> kernels -> core types`. The MCP layer is a boundary, not a plugin layer; clients cannot register new tools.
- One transport (stdio), one boundary file (`src/mcp/server.ts`), one runtime dependency (`@modelcontextprotocol/sdk`).
- No LLM call. No new persisted artifact. No new core type.

## Consequences

- The Phase 6 implementation has a closed-form spec: every tool has a typed input, a typed output, an enumerated error set, and a single corresponding kernel. Implementation work is wiring, not design.
- Mira gains a standard agent surface that any MCP-compatible client (Claude Code, Cursor, Goose, Codex via MCP, …) can consume. No per-agent integration is required, kept, or supported in V0.3.
- The boundary takes a single new dependency (`@modelcontextprotocol/sdk`). The cost is bounded: the dep is consumed in `src/mcp/` only, and the rest of the codebase is unaffected. The benefit is correct JSON-RPC framing, transport handling, and forward-compatibility with the protocol.
- Long-running commands wrapped via `run_command` may exceed a client's own RPC timeout. This is a client-configuration concern, not a Mira concern: V0's 300-second default is preserved.
- A future V0.4+ that adds an HTTP/SSE transport, auth, or a sixth tool extends this ADR rather than reinterpreting it.
