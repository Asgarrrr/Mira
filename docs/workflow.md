# Workflow

## Goal

Mira should be built in small, verifiable vertical slices.

Do not build a large platform first.

V0 vertical slice:

```txt
command -> raw evidence -> CommandObservation
```

V0.1 extension:

```txt
recent observations -> ContextPack
```

V0.2 extension:

```txt
working-tree state -> ArchitectureSignal[] -> ContextPack.suspectedFiles
```

V0.3 extension:

```txt
existing kernels -> MCP server (stdio) -> insight tools
```

## Phase 1: Evidence Store (V0)

Implement local evidence storage.

`.mira/` is created automatically on the first `mira run` — no `mira init` command in V0.

Required files per command run:

```txt
.mira/runs/<run-id>/
  metadata.json
  stdout.log
  stderr.log
  combined.log
  observation.json
  observation.md
```

`run-id` format: `run_YYYYMMDDTHHMMSSmmmZ_<random6>` (filesystem-safe, lexicographically sortable, no external id library). Full spec in `docs/architecture.md`.

Definition of done:

* raw stdout is stored
* raw stderr is stored
* metadata is stored
* evidence can be read by run id
* parallel runs in the same `cwd` produce distinct run directories
* tests cover storage

## Phase 2: Command Observation (V0)

Implement:

```txt
mira run "<command>"
```

It should:

* execute the command
* capture stdout (no real-time streaming; print after the run completes)
* capture stderr
* preserve exit code
* measure duration
* enforce a default 300-second timeout
* store evidence
* generate `CommandObservation`
* print compact output

Out of scope: interactive stdin/TTY commands, configurable timeout.

Definition of done:

* successful command test
* failed command test
* exit code preservation test
* timeout test (long-running command is killed at the default timeout)
* observation snapshot test

## Phase 3: Summarizer (V0)

Add a deterministic generic summarizer.

Rules:

* summarizer must not hide raw evidence
* summarizer must produce evidence references
* summarizer must be fixture-tested
* summarizer must not claim unsupported facts

Command-specific summarizers (test output, TypeScript errors, git diff/status) are explicitly post-V0. They will be added when a real task needs them, not preemptively.

## Phase 4: Context Pack (V0.1)

Implement:

```txt
mira context "<task>"
```

`task` is free text. The pack reads the **last 10** `CommandObservation`s for the current project. The "since last ContextPack" selection mode is post-V0.1.

It should:

* read the last 10 observations
* reference observations by id (no embedding of full observations in the pack)
* select relevant evidence refs
* generate markdown
* generate json
* suggest verification commands
* list risks
* suggest next action

`context-id` format: `ctx_YYYYMMDDTHHMMSSmmmZ_<random6>`. Pack files are stored under `.mira/context/<context-id>.{json,md}`.

Definition of done:

* context pack generated from fixture observations
* context pack references observations by id and points at raw evidence
* "last 10" selection is tested with a fixture of >10 observations
* output is snapshot-tested

## Phase 5: Architecture sensing (V0.2)

Add minimal structural awareness, as Mira's own version of the capability — not a port of Sentrux.

The vertical slice:

```txt
working-tree state -> ArchitectureSignal[] -> ContextPack.suspectedFiles
```

`ArchitectureSignal` is computed on demand inside `mira context`. It is not embedded in `CommandObservation` and is not persisted as standalone evidence in V0.2. Its only consumer in V0.2 is `ContextPack.suspectedFiles`. Full type, scope, and population policy: ADR 0005.

Scope:

* `changed-file` — git working-tree paths (modified or untracked) relative to `HEAD`, deleted paths excluded.
* `related-file` — same directory, shared basename stem.
* `test-file` — `*.test.ts`, `*.test.tsx`, `*.spec.ts`, `*.spec.tsx`, in the same directory or under a sibling `tests/`.
* `import-hint` — textual `from "…<basename>"` grep, no AST.

Out of scope (V0.2): full import graph, ownership, package boundaries, global codebase scoring, AST or TypeScript Compiler API usage, cross-language conventions beyond TS / TSX, persisting signals as standalone evidence, embedding signals in `CommandObservation`, configurable or pluggable sensors.

Definition of done:

* `git status` / `git diff` is the source for `changed-file`; modified and untracked are included; deleted paths are excluded.
* `related-file`, `test-file`, and `import-hint` are derived purely from filesystem inspection (`readdir`, basename, dirname, glob, textual grep). No AST.
* Every emitted `ArchitectureSignal` references a filesystem path that exists on disk; existence is verified before emission.
* `ContextPack.suspectedFiles` is populated deterministically: insertion order `changed-file` → `related-file` → `test-file` → `import-hint`; alphabetical within each kind; deduplicated; capped at 20.
* Each heuristic kind is unit-tested against a fixture working tree.
* Integration: `mira context` against a fixture project produces a `ContextPack` whose `suspectedFiles` matches a snapshot.
* `bun run typecheck && bun run lint && bun test` all pass.
* No new npm dependency.
* Sensing logic is contained in a single `src/architecture/` module — no plugin layer, no `Sensor<T>` interface.

Expected files touched (impl PR):

* `src/architecture/architecture-signal.ts` — `ArchitectureSignalKind`, `ArchitectureSignal` type.
* `src/architecture/sense.ts` — composed `senseArchitecture(cwd): Promise<ArchitectureSignal[]>`. Implementation may inline or split the four heuristics; no exposed dispatch surface.
* `src/context/context-pack-generator.ts` — extended to call `senseArchitecture` and project signals onto `suspectedFiles` (ordering, dedup, cap).
* `tests/architecture-signal.test.ts` — unit tests per heuristic.
* `tests/cli-context.e2e.test.ts` — extended `suspectedFiles` assertions.

The "since last ContextPack" selection mode and richer graph signals remain post-V0.2.

## Phase 6: MCP server (V0.3)

Expose Mira's insight kernels as a single agent-facing boundary.

The vertical slice:

```txt
existing kernels -> MCP server (stdio) -> insight tools
```

V0.3 introduces no new kernel and no new core type. It re-exposes the Context and Evidence kernels through the Model Context Protocol over stdio. Full transport choice and SDK rationale: ADR 0006. Layering split (hook = data, MCP = insight) and the deprecation of the original data-layer tools: ADR 0007.

Tools (current, post-ADR 0007):

* `generate_context_pack` — wraps the Context Kernel; `mira context` equivalent, with V0.2 architecture sensing applied.
* `list_recent_runs` — wraps the Evidence Store; slim projection of recent observations across sessions.

Removed by ADR 0007 (originally part of the V0.3 scope in ADR 0006): `run_command`, `get_observation`, `get_raw_evidence`. The hook (`mira run`) is now the data layer; the MCP is the insight layer.

Out of scope (V0.3): HTTP / SSE / WebSocket transports, auth, multi-project sessions, streaming, Claude-Code-specific subagents or slash commands, Codex awareness docs, Cursor/Goose rule files. See ADR 0006 for the full out-of-scope list.

Definition of done:

* MCP server starts on stdio and responds to the standard handshake using `@modelcontextprotocol/sdk`.
* `generate_context_pack` accepts `{ task, projectRoot }`, runs the V0.1 selection (last 10) and the V0.2 architecture sensing (ADR 0005), persists `.mira/context/<context-id>.{json,md}`, and returns the existing `ContextPack` verbatim. The cap of 20 paths in `suspectedFiles` is enforced by the Context Kernel and not re-paginated by the tool.
* `list_recent_runs` accepts `{ projectRoot, limit? }` (default 10, max 50), returns a slim projection (`id`, `command`, `status`, `exitCode`, `signal?`, `killedByTimeout`, `durationMs`, `startedAt`) of fields already present on `CommandObservation`/`CommandRun` — no new field is introduced.
* Every tool that touches the project tree takes an explicit absolute `projectRoot`; the server never reads `process.cwd()` to resolve a project.
* MCP errors use the SDK's `McpError` envelope with the codes enumerated in ADR 0006 (`INVALID_INPUT`, `NOT_FOUND`, `PATH_OUTSIDE_EVIDENCE`, `INTERNAL`).
* Each tool is unit-tested (input validation, success path, error paths) and integration-tested against a fixture project via the SDK's in-process transport — without spawning a separate process.
* `bun run typecheck && bun run lint && bun test` all pass.
* The single new runtime dependency is `@modelcontextprotocol/sdk`. No other dependency is added.
* Boundary code lives under a single module: `src/mcp/`. The dep is consumed there and nowhere else.

Expected files touched (impl PR):

* `src/mcp/server.ts` — server bootstrap, stdio transport, tool registration.
* `src/mcp/tools/generate-context-pack.ts`
* `src/mcp/tools/list-recent-runs.ts`
* `src/cli/index.ts` — new `mira mcp` subcommand to launch the server (or equivalent bin entry).
* `tests/mcp-*.test.ts` — per-tool unit + integration coverage.
* `package.json` — `@modelcontextprotocol/sdk` added.

## Post-V0.3 integrations

The following are explicitly **not** part of V0.3 and will be considered separately, each with its own ADR if pursued:

* Claude Code subagents, slash commands, or `.claude/` bundles.
* Codex awareness documents (`AGENTS.md`, etc.).
* Cursor rule files, Goose-specific configuration, or any other agent-specific surface.
* MCP HTTP / SSE / WebSocket transports.
* Authentication, authorization, or multi-project sessions in a single server process.
* Streaming command output or context packs as deltas.
* New MCP tools beyond the current insight surface — each one requires its own design pass justified by an observed need (ADR 0007).

## Review protocol

After every phase, run a harsh review.

Review questions:

1. Did we over-engineer?
2. Did we hide raw evidence?
3. Did we preserve exit codes?
4. Did we produce unsupported conclusions?
5. Did we duplicate RTK/Sentrux without adding Mira value?
6. Are tests realistic?
7. Are abstractions still small?

## Anti-vibecoding rule
A feature is not ready if it makes Mira less épurée.

Before adding a feature, ask:

- Does this reduce noise?
- Does this clarify evidence?
- Does this improve agent context?
- Does this preserve the simplicity of the core?
- Could this be an adapter or later layer instead?

If a feature does not improve evidence, context, or quality, do not build it yet.
