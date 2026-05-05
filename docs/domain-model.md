# Domain Model

Types are listed in the order they appear in the V0 vertical slice, then V0.1, then post-V0. Each type exists once in this document and is labelled with the layer it belongs to.

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
  exitCode: number
  stdoutPath: string
  stderrPath: string
  combinedPath: string
}
```

When a run hits the default 300-second timeout, the process is killed; the exit code reflects the kill (typically 124 or 137 depending on the shell), and `durationMs` is approximately the timeout. V0 does not model the timeout with a dedicated field.

## CommandObservation (V0)

The structured interpretation of a `CommandRun`. Every field is grounded in evidence — the observation never carries claims that the underlying raw files cannot back.

```ts
type CommandObservation = {
  id: string                                          // observation id (matches run-id in V0)
  runId: string
  command: string
  status: "success" | "failure"
  exitCode: number
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
- The canonical invariant list lives in `docs/adr/0001-core-abstractions.md`.
