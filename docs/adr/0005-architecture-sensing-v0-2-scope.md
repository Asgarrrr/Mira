# ADR 0005: Architecture sensing V0.2 — scope, type, and population policy

## Status

Accepted

## Context

`docs/workflow.md` Phase 5 promised "minimal structural awareness, as Mira's own version of the capability — not a port of Sentrux", with a fuzzy bullet list (changed files, suspected related files, test hints, basic import hints) and an explicit deferral of the type:

> The exact type for these signals is not committed in the V0 docs and will be defined when Phase 5 starts.

V0.1 has shipped (PR #7). Before any Phase 5 code lands, the type and the population policy must be locked. Otherwise the implementation will either drift toward Sentrux (global codebase scoring) or invent values (an ADR 0001 invariant violation).

ADR 0004 established the precedent: every populated `ContextPack` field has a closed-form, deterministic spec. V0.1 left `suspectedFiles` in Tier 2 — *empty, requires Phase 5 (architecture sensing)*. V0.2 closes that gap with a strictly filesystem-sourced rule.

## Decision

### Scope (V0.2)

V0.2 introduces a single new abstraction: `ArchitectureSignal`. It is computed on demand inside `mira context` and its only consumer in V0.2 is `ContextPack.suspectedFiles`.

The four heuristics V0.2 ships:

1. **`changed-file`** — paths reported by git as modified or untracked in the working tree relative to `HEAD`. Deleted paths are excluded; an invariant requires every signal to reference a path that exists on disk.
2. **`related-file`** — for each `changed-file`, files in the **same directory** whose basename shares a stem (e.g., `foo.ts` ↔ `foo.types.ts` ↔ `foo.helpers.ts`).
3. **`test-file`** — for each `changed-file`, the conventional test counterpart matching `*.test.ts`, `*.test.tsx`, `*.spec.ts`, `*.spec.tsx`, in (a) the same directory, (b) a co-located `tests/` or `__tests__/` directory, or (c) the repo-root `tests/` or `__tests__/` directory.
4. **`import-hint`** — for each `changed-file`, files containing a textual `from "<spec>"` reference where `<spec>` is a relative path (starts with `.` or `/`) that **resolves to the changed file's path** under POSIX path math, with `.ts`, `.tsx`, and `/index.ts(x)` suffix recovery. Bare specifiers (`from "react"`) and tsconfig-paths aliases (`from "@/x"`) are excluded; the rule prefers false negatives over false positives. This is a grep against on-disk source files combined with deterministic path resolution. It is not a parser.

These heuristics rely on filesystem inspection and the project's `git` executable. No AST, no TypeScript Compiler API, no semantic analysis.

### `ArchitectureSignal` type

```ts
type ArchitectureSignalKind =
  | "changed-file"
  | "related-file"
  | "test-file"
  | "import-hint"

type ArchitectureSignal = {
  kind: ArchitectureSignalKind
  path: string                                        // relative to project root; must exist on disk at signal-creation time
  reason: string                                      // deterministic short string explaining why the path was selected
  source: "git" | "filesystem"
  relatedTo?: string                                  // for related-file / test-file / import-hint: the changed path that triggered inclusion
}
```

`ArchitectureSignal` does **not** appear in `CommandObservation`. Command observations are produced by `mira run` and reflect command activity. Architecture signals are produced by `mira context` and reflect working-tree state at pack-creation time. The lifecycles are different and must remain separate.

### Population policy (V0.2)

This extends ADR 0004's Tier 1 / Tier 2 / Tier 3 model:

| Field of `ContextPack` | V0.1 | V0.2 |
|---|---|---|
| `suspectedFiles` | Tier 2 — empty | **Tier 1 — deterministic, populated** |
| `risks` | Tier 2 — empty | Tier 2 — empty (unchanged) |
| `nextRecommendedAction` | Tier 2 — empty | Tier 2 — empty (unchanged) |

In V0.2, `ContextPack.suspectedFiles` is the ordered, deduplicated list of `ArchitectureSignal.path` values, computed at pack-creation time:

1. **Insertion order across kinds:** `changed-file` first, then `related-file`, then `test-file`, then `import-hint`.
2. **Within each kind:** alphabetical by `path`.
3. **Deduplication:** keep the first occurrence; drop later duplicates.
4. **Cap:** the first 20 paths are kept; the rest are dropped to keep the pack épurée.

The `ContextPack` schema is unchanged in V0.2: `suspectedFiles: string[]`. Only the population rule changes. Consumers that read V0.1 packs continue to work; the field becomes non-empty for V0.2 packs.

## Out of scope (V0.2)

- Full import graph (recursive traversal, transitive resolution).
- Module ownership and package boundaries.
- Global codebase scoring — no Sentrux-style `quality_signal` or aggregate health grade. Phase 5 = task-aware impact, not health-of-codebase.
- AST-level analysis or any TypeScript Compiler API usage.
- Cross-language heuristics beyond TS / TSX file conventions.
- Persisting `ArchitectureSignal[]` as standalone evidence on disk.
- Embedding architecture signals inside `CommandObservation`.
- Configurable or pluggable sensors. No `Sensor<T>` interface, no plugin registry, no dispatch table.

## Invariants (V0.2-specific)

- Every `ArchitectureSignal` references a filesystem path that exists on disk at signal-creation time. No invented files.
- `ArchitectureSignal` is computed on demand at `mira context` time; it is never persisted as standalone evidence in V0.2.
- `ArchitectureSignal` is not a field of `CommandObservation`.
- Phase 5 V0.2 introduces zero new npm dependencies.
- All sensing logic lives under a single module: `src/architecture/`. No dispatch, no plugin layer.

## Consequences

- The Phase 5 implementation has a closed-form spec: every Tier 1 field of `ContextPack` is mechanically derivable from working-tree state and the previously selected observations.
- ADR 0001 invariant *"context packs must not invent facts"* remains mechanically enforced: `suspectedFiles` paths come from `git` and `readdir`, and existence is verified before emitting a signal.
- The rule prefers false negatives (a genuine related file might be missed) over false positives (a fabricated path). This is consistent with Mira's *not magic* non-goal.
- If a future phase needs a richer graph (transitive imports, ownership, package boundaries), it extends the kernel rather than reinterpreting V0.2 signals — the V0.2 type is intentionally narrow.

## Amendments

- **V0.2.1**: tightened bullets 3 and 4 of the heuristic list. `test-file` now also covers co-located `__tests__/` and the repo-root `tests/` / `__tests__/` directories (the dominant convention in this repo and in Bun-style projects). `import-hint` switched from basename-only matching to deterministic relative-path resolution, eliminating cross-directory basename collisions and bare-specifier false matches; the comparison stays filesystem-only (path math, no AST).
