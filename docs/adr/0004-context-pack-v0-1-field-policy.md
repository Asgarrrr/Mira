# ADR 0004: ContextPack V0.1 field population policy

## Status

Accepted

## Context

`docs/domain-model.md` defines `ContextPack` with these fields:

```ts
type ContextPack = {
  id: string
  task: string
  createdAt: string
  summary: string
  observationIds: string[]
  evidenceRefs: EvidenceRef[]
  suspectedFiles: string[]
  verificationCommands: string[]
  risks: string[]
  nextRecommendedAction: string
}
```

`CLAUDE.md` requires deterministic behavior in V0/V0.1, and the canonical invariants in ADR 0001 forbid context packs from inventing facts. Several `ContextPack` fields cannot be filled deterministically from the last 10 `CommandObservation`s alone — `suspectedFiles` needs filesystem awareness (Phase 5), `risks` and `nextRecommendedAction` need heuristics or an LLM. Without an explicit policy, Phase 4 implementation will either silently invent values or scope-creep.

## Decision

`mira context "<task>"` populates `ContextPack` fields in three tiers:

### Tier 1 — Deterministic, always populated

| Field | Source |
|---|---|
| `id` | `ctx_YYYYMMDDTHHMMSSmmmZ_<random6>` (architecture.md format) |
| `task` | the CLI argument, verbatim |
| `createdAt` | `new Date().toISOString()` at pack creation |
| `observationIds` | ids of the most recent ≤10 observations, newest first |
| `evidenceRefs` | the `metadata` `EvidenceRef` of each selected observation, in the same order |
| `summary` | one-line counts: ``Context pack for `<task>` based on N recent observations (M succeeded, K failed).`` |
| `verificationCommands` | unique `command` strings from selected observations whose `status === "success"`, in reverse-chronological order |

`evidenceRefs` deliberately points at `metadata.json` rather than every `stdout.log`/`stderr.log`/`combined.log`/`observation.json`/`observation.md`. The pack is meant to be compact: a consumer can always follow `metadata.json` (which contains every other path) or `observationIds` to reach the full evidence.

### Tier 2 — Empty in V0.1

| Field | Reason |
|---|---|
| `suspectedFiles` | requires Phase 5 (architecture sensing) |
| `risks` | requires heuristics or an LLM; no source of truth in V0.1 |
| `nextRecommendedAction` | same reason; populated as `""` |

These ship as `[]` / `""` so the schema stays stable. Future phases fill them in without breaking consumers.

### Tier 3 — Not in scope

The "since last ContextPack" selection mode is post-V0.1, per `workflow.md`. V0.1 implements only "last 10".

## Consequences

- The Phase 4 implementation has a closed-form spec: every populated field is mechanically derivable from the selected observations.
- ADR 0001 invariant *"context packs must not invent facts"* is mechanically enforced: there is no field whose value comes from outside the observation set.
- The schema's empty fields signal future intent without paying for it now (same pattern as `Finding`/`EvidenceExcerpt` defined-but-unused in V0).
- If a user expects `risks` or `nextRecommendedAction` to be filled, the empty values make it obvious that no claim is being made, which is preferable to a fabricated string.

## Out of scope

- Any per-command-type extraction (test failures, TypeScript errors, git diff). Those land with command-specific summarizers post-V0.
- LLM-backed summarization or risk inference.
- Persistence guarantees across `ContextPack` schema changes — V0.1 keeps the same "no historical guarantee" stance as V0.
