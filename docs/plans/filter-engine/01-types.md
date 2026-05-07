# Task 01 — Filter types + empty registry module

## Goal

Create the `src/filter/` module with type definitions for `FilterInput`, `FilterContext`, `FilteredView`, `Filter`, and an empty `REGISTRY` map. No filter implementations, no dispatch logic.

## Context recap

Mira has buffered command output reaching `runCommand` in `src/cli/run.ts:23`. Today, raw stdout/stderr go to the agent verbatim. The plan introduces a **filter dispatcher** that runs after evidence is persisted (ADR 0007 — hook is the data layer; filtering is data-shaping). The dispatcher needs a typed contract before any filter or wiring lands.

`Finding` already exists in `src/core/finding.ts:13` (zod schema, with `severity`, `evidenceRefs`, `excerpts`). The new types reuse it; they do not redefine it. `CommandObservation.findings: Finding[]` (`src/core/command-observation.ts:24`) is currently always `[]` and is the persistence target.

## Files touched

- `src/filter/types.ts` — created (type definitions only).
- `src/filter/registry.ts` — created (exports an empty `Map<string, Filter>`).
- `tests/filter-types.test.ts` — created (compile-time + structural checks).

The folder `src/filter/filters/` is created empty in this task — it lands populated in Tasks 05/06. Creating it now signals the layout. Module structure: see 00-decisions.md § 11.

## Interface / API change

```ts
// src/filter/types.ts
import type { Finding } from "../core/finding.ts";

export type FilterContext = {
  command: string;       // the original command string (post-strip is internal to the dispatcher)
  cwd: string;
  runId: string;
};

export type FilterInput = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: string;
  durationMs: number;
};

export type FilteredView = {
  findings: Finding[];
  markdown: string;
};

export type Filter = (input: FilterInput, ctx: FilterContext) => FilteredView;

// Tagged result returned by `dispatchFilter`. Three cases are made explicit so
// `runCommand` can branch on intent (write filtered.md, emit warning, or just
// passthrough) without inferring from a `null`. See 03-wire-into-run.md.
export type DispatchResult =
  | { kind: "miss" }
  | { kind: "hit"; view: FilteredView; filterVersion: string }
  | { kind: "error"; program: string; cause: unknown };
```

```ts
// src/filter/registry.ts
import type { Filter } from "./types.ts";

// Registry entries: { filter, version }. The version string is recorded into
// `observation.json.filterVersion` on hit so V0.5+ can re-render old runs and
// diff against the persisted markdown (Axis 3, observation-pipeline.md).
export type RegistryEntry = { filter: Filter; version: string };
export const REGISTRY: Map<string, RegistryEntry> = new Map();
```

## Implementation notes

- `Filter` is a **pure function** — no async. Reasoning: the dispatcher runs synchronously after `await observer.observe(...)`, and a sync contract makes the try/catch wrapping in Task 03 trivial. If a future filter needs IO, change the signature in one place and revisit the dispatcher; YAGNI today.
- `FilterContext.command` is the **original** command string, not the stripped one. The wrapper-stripping in Task 02 is internal to the dispatcher; the filter sees the verbatim user input. Reasoning: a filter may want to emit the original command verbatim in its markdown title.
- No imports from `src/cli/`, `src/store/`, `src/command/`, `src/mcp/`, `src/architecture/`, or `src/context/` — `src/filter/` is reusable from any caller (CLI today, MCP if ever needed). Code-review-enforced; see 00-decisions.md § 11 dependency direction.
- The registry is **not exported as a singleton with mutators**. It is a const `Map`. Mutating it from outside the module is not part of the API; Task 06 will add an entry by importing the module and calling `.set` from a setup point. (Reconsidered: adding via `.set()` from a single setup file is preferred to inlining the map literal because it lets each filter live in its own file with its own tests, while keeping the registry shape unchanged.)

> ASSUMPTION: `Filter` stays sync.
> Revision trigger: a future filter needs to read evidence from disk or call out (e.g. an LSP ping). Change to `Promise<FilteredView>` then.

## Verification

Test name: `tests/filter-types.test.ts`.

Three checks:

1. `import { REGISTRY } from "../src/filter/registry.ts"; expect(REGISTRY.size).toBe(0);`
2. Compile-time test: a fixture `Filter` that returns `{ findings: [], markdown: "ok" }` type-checks under the exported types.
3. Snapshot of the type module structure: `expect(typeof Filter).toBe("function") // can't really; instead, check the existence of the exports via dynamic import.

```bash
bun test tests/filter-types.test.ts
```

## Exit criterion

- `bun test tests/filter-types.test.ts` passes.
- `bun tsc --noEmit` is green.
- `src/filter/types.ts` exports exactly: `FilterContext`, `FilterInput`, `FilteredView`, `Filter`.
- `src/filter/registry.ts` exports `REGISTRY` of type `Map<string, Filter>` with size 0.

## Depends on

- (none — entry point)

## Estimated diff size

~80 lines (40 LOC types, 5 LOC registry, 35 LOC tests).
