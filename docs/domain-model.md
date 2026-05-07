# Domain Model

Types are listed in the order they appear in the V0 vertical slice, then V0.1, then V0.2, then post-V0. Each type exists once in this document and is labelled with the layer it belongs to.

## Why these types

The types below are not arbitrary. They are the smallest set that makes one invariant enforceable: every agent-facing conclusion is backed by traceable raw evidence.

Three design choices follow:

- **`Evidence` is a typed object, not a category.** It carries the path, kind, and provenance of a real file under `.mira/`. Without that concreteness, "evidence-backed" devolves into a slogan.
- **`EvidenceRef` is separate from `Evidence`.** Refs travel inside observations, packs, and findings — bytes do not. This split is what lets observations stay compact while remaining traceable.
- **`Finding` is separate from `EvidenceExcerpt`.** A finding is an interpreted signal; an excerpt is the raw lines that justify it. Splitting them prevents interpretation from drifting away from the source.

Every other type either composes these three (`CommandObservation`, `ContextPack`) or extends the evidence model into a new dimension (`ArchitectureSignal` for structural sensing, `ToolAdapter` for external integrations).

## Evidence (V0)

Evidence is the stored artifact produced or observed by Mira. Every evidence file lives under `.mira/` and is reachable by its path. Evidence is concrete — it is not just a category, it is a typed object whose fields describe what is on disk.

```ts
type EvidenceKind =
  | "stdout"
  | "stderr"
  | "combined"
  | "metadata"
  | "observation"
  | "context"
  | "other"

type Evidence = {
  path: string                                        // path under .mira/, used as the identity
  kind: EvidenceKind
  bytes: number
  createdAt: string                                   // ISO 8601 UTC
  runId?: string                                      // present for run-scoped evidence
  contextId?: string                                  // present for context-scoped evidence
}
```

Evidence files are human-readable. V0 never silently rewrites or deletes them.

## EvidenceRef (V0)

A pointer to stored evidence, used inside `CommandObservation`, `Finding`, `EvidenceExcerpt`, and `ContextPack`. The ref carries the same `path` and `kind` as the underlying `Evidence` so that consumers can render the reference without a lookup.

```ts
type EvidenceRef = {
  path: string                                        // matches Evidence.path
  kind: EvidenceKind
  description?: string                                // why this ref was attached
}
```

## CommandRun (V0)

Raw execution metadata for a single command. Stored at `.mira/runs/<run-id>/metadata.json`.

```ts
type CommandRun = {
  id: string                                          // run-id, format defined in docs/architecture.md
  command: string
  cwd: string
  startedAt: string                                   // ISO 8601 UTC
  durationMs: number
  exitCode: number | null                             // null when the process was killed by signal
  signal?: string                                     // signal name, e.g. "SIGKILL", when the process was killed
  killedByTimeout: boolean                            // true when Mira's timeout enforcer killed the process
  stdoutPath: string
  stderrPath: string
  combinedPath: string
  metadataPath: string                                // file the rest of CommandRun is serialized into
}
```

A `CommandRun` keeps signal-level facts at the source. When Mira's timeout enforcer kills the process, `killedByTimeout` is `true`, `signal` is `"SIGKILL"`, and `exitCode` is `null`. When an external signal terminates the process, `signal` is set and `exitCode` is `null`, but `killedByTimeout` is `false`. When the process exits cleanly, `exitCode` is the integer status and `signal` is absent. This lets the Phase 3 summarizer read structured fields instead of inferring intent from shell-conventional codes (137, 124).

## CommandObservation (V0)

The structured interpretation of a `CommandRun`. Every field is grounded in evidence — the observation never carries claims that the underlying raw files cannot back.

```ts
type CommandObservation = {
  id: string                                          // observation id (matches run-id in V0)
  runId: string
  command: string
  status: "success" | "failure"
  exitCode: number | null                             // mirrors CommandRun.exitCode
  signal?: string                                     // mirrors CommandRun.signal
  killedByTimeout: boolean                            // mirrors CommandRun.killedByTimeout
  durationMs: number
  summary: string
  findings: Finding[]
  relatedFiles: string[]
  suggestedNextActions: string[]
  verificationHints: string[]
  evidenceRefs: EvidenceRef[]
}
```

## Finding (V0)

A specific interpreted signal extracted from evidence. Every finding is backed by at least one `EvidenceExcerpt` (verbatim raw lines) or `EvidenceRef` (a broader pointer).

```ts
type Finding = {
  id: string
  severity: "info" | "warning" | "error"
  title: string
  description: string
  excerpts: EvidenceExcerpt[]                         // verbatim raw lines that justify the finding
  evidenceRefs: EvidenceRef[]                         // additional supporting evidence
  relatedFiles?: string[]
}
```

## EvidenceExcerpt (V0)

A verbatim slice of raw output, attached to a `Finding`. Replaces the previous `ImportantLine` concept: raw lines no longer float at the top of an observation; they hang off the interpreted finding that needed them.

```ts
type EvidenceExcerpt = {
  ref: EvidenceRef                                    // pointer to the source evidence
  lineStart?: number                                  // 1-based start line
  lineEnd?: number                                    // 1-based end line, inclusive; same as lineStart for a single line
  text: string                                        // verbatim excerpt
}
```

## ContextPack (V0.1)

A task-specific bundle of references and guidance for an AI agent. The pack references observations by id — it does **not** embed full `CommandObservation` objects.

```ts
type ContextPack = {
  id: string                                          // context-id, format defined in docs/architecture.md
  task: string                                        // free text from `mira context "<task>"`
  createdAt: string                                   // ISO 8601 UTC
  summary: string
  observationIds: string[]                            // CommandObservation ids, in selection order
  evidenceRefs: EvidenceRef[]                         // refs into the underlying raw evidence
  suspectedFiles: string[]
  verificationCommands: string[]
  risks: string[]
  nextRecommendedAction: string
}
```

V0.1 selects the **last 10** `CommandObservation`s for the current project. The "since last ContextPack" selection mode is not implemented in V0.1.

V0.1 leaves `suspectedFiles` empty (ADR 0004 Tier 2). V0.2 promotes it to Tier 1: `suspectedFiles` is the ordered, deduplicated list of `ArchitectureSignal.path` values (insertion order: `changed-file` → `related-file` → `test-file` → `import-hint`; alphabetical within each kind; capped at 20). The `ContextPack` schema is unchanged. See ADR 0005.

## ArchitectureSignal (V0.2)

A single structural observation about the working tree, computed on demand by `mira context`. It exists to populate `ContextPack.suspectedFiles`; it is not embedded in `CommandObservation` and is not persisted as standalone evidence in V0.2.

```ts
type ArchitectureSignalKind =
  | "changed-file"                                    // git: modified or untracked relative to HEAD (deleted excluded)
  | "related-file"                                    // filesystem: same directory, shared basename stem
  | "test-file"                                       // filesystem: matches *.test.ts(x) / *.spec.ts(x) for a changed file
  | "import-hint"                                     // filesystem: textual `from "…<basename>"` reference (no AST)

type ArchitectureSignal = {
  kind: ArchitectureSignalKind
  path: string                                        // relative to project root; must exist on disk at signal-creation time
  reason: string                                      // deterministic short string explaining why the path was selected
  source: "git" | "filesystem"
  relatedTo?: string                                  // for related-file / test-file / import-hint: the changed path that triggered inclusion
}
```

V0.2 sensing is filesystem-only: it reads `git status` / `git diff` for changed files and uses `readdir`, basename / dirname, glob, and textual grep for the rest. No AST, no TypeScript Compiler API, no semantic analysis, no new npm dependency. Full scope, exclusions, and invariants live in ADR 0005.

## MCP layer (V0.3)

V0.3 introduces no new domain type.

The MCP boundary re-exposes Mira's insight kernels over stdio. Per ADR 0007, the data layer is the hook (`mira run` + Evidence Store) and the MCP is the insight layer; the original five-tool surface has been trimmed to the insight tools. Each tool takes typed inputs and returns existing types verbatim:

- `generate_context_pack` returns `ContextPack` (whose `suspectedFiles` already projects `ArchitectureSignal[]` per ADR 0005).
- `list_recent_runs` returns a slim projection of fields already present on `CommandObservation` and `CommandRun` — it introduces no new field.

Errors are reported through the SDK's `McpError` envelope; no domain-level error type is added in V0.3. Full input/output/error contracts live in ADR 0006; the post-deprecation surface is summarised in ADR 0007.

## ToolAdapter (post-V0)

Adapters are the planned integration boundary for external tools (RTK, Sentrux, git, test runners). They are **not built in V0 or V0.1**.

When introduced, the adapter contract requires that every adapter call return both a structured observation and the evidence references it points at — adapters cannot return arbitrary ungrounded outputs.

```ts
type AdapterOutput = {
  observation: CommandObservation
  evidenceRefs: EvidenceRef[]
}

type ToolAdapter<TInput> = {
  name: string
  observe(input: TInput): Promise<AdapterOutput>
}
```

## Key invariants

- No generated object replaces raw evidence.
- Every `Finding` is backed by at least one `EvidenceExcerpt` or `EvidenceRef`.
- `ContextPack` references `CommandObservation`s by id; it never embeds them.
- Every `ArchitectureSignal` references a filesystem path that exists on disk at signal-creation time (V0.2).
- The MCP layer (V0.3) consumes existing types and introduces none. Process-level command outcomes (non-zero exit, signal, timeout) are preserved through `CommandObservation` fields, never via MCP errors.
- The canonical invariant list lives in `docs/adr/0001-core-abstractions.md`.
