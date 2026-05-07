# ADR 0008: Filter subsystem architecture

## Status

Accepted

## Context

V0.4 ships the first command-output filter (`tsc`) and proves the hook
(ADR 0007) can carry a structured rendering layer. The original wiring was
the smallest thing that worked: a single `Map.set("tsc", …)` in
`src/filter/registry.ts` and a single-token resolver in
`src/filter/dispatch.ts` that returns `extractProgramToken(command)`.

That shape does not scale to V0.5+. Two pressures surface as soon as a
second filter approaches:

1. **Single-token keys break for umbrella programs.** `git diff` and
   `git status` produce diagnostics in completely different formats
   (porcelain vs. unified diff vs. log lines) and need their own parsers and
   renderers. They share `git` as their first token, so a single-token
   registry can host one of them at most. RTK works around this with a
   monolithic `git.rs` that pattern-matches on a `GitCommand` enum and
   dispatches internally; that pushes a second resolver inside each
   umbrella filter and bloats the file size beyond Mira's 250-LOC ceiling
   the moment the umbrella has more than two sub-programs.
2. **`registry.ts` becomes a magnet.** Every new filter forces an edit to
   the central file: a new import, a new tuple in the `Map` literal, a
   merge conflict whenever two PRs land in parallel. By V0.7 (tsc + eslint +
   biome + prettier + git diff + git status + git log + jest + vitest), the
   central file would carry ~10 imports and a non-trivial Map literal,
   pulling filter authors into a coordination point that adds nothing.

The design also has to commit on a few smaller-but-real questions before V0.5:

- Where do cross-filter primitives (ANSI strip, message truncation, the
  `_top:` summary helper) live, and when do we create that home?
- Should we group filters by language ecosystem (`filters/js/tsc/`,
  `filters/git/diff/`) like RTK does, or stay flat?
- Do we expose multi-token resolution as part of the public dispatch API or
  hide it behind `extractProgramToken`?

## Decision

The Filter subsystem is shaped by five binding decisions.

### 1. Per-program `entries.ts` for registry contributions

Each filter directory under `src/filter/filters/<program>/` exports a single
`entries.ts` of shape:

```ts
export const <program>Entries: ReadonlyArray<readonly [string, RegistryEntry]> = [
  ["<key>", { filter: …, version: … }],
  // …
];
```

`src/filter/registry.ts` imports and spreads each program's entries:

```ts
export const REGISTRY = new Map([...tscEntries, ...gitEntries, …]);
```

Adding a filter is one import line + one spread. No central inline `Map.set`
calls, no per-program ownership of `registry.ts`. The registry stays the
**single source of truth for which programs Mira filters** — a flat
debuggable lookup table you can `console.log` to enumerate the surface.

### 2. Longest-prefix multi-token key resolution

The dispatcher exposes `extractTokens(command): string[]` (returns up to
`MAX_KEY_TOKENS` post-wrapper tokens) and `findRegistryEntry(tokens, registry)`
(longest-prefix match: tries the N-token key first, falls back through
shorter prefixes). `extractProgramToken(command)` is preserved as the
single-token query for callers that want the program identity without a
registry lookup.

`MAX_KEY_TOKENS = 2` covers the umbrella patterns we care about today
(`git diff`, `npm test`, `cargo build`). Bumping to 3 the day a
`kubectl get pods` style key needs to register is a one-line constant change
with no API impact, because the resolver always tries the longest available
prefix first and falls back to shorter ones.

### 3. No internal sub-program dispatch inside a filter

`git diff` and `git status` are **separate registry entries**, not branches
inside a single `git` filter. Each entry has its own glue, its own parser,
its own renderer, its own version literal. Sub-programs that share parsing
primitives reach into a sibling `<program>/shared/` module rather than
co-habiting a single filter file.

This is the key departure from RTK's monolithic `git.rs`. Trade-off: more
files for an umbrella program, but each file stays small, each filter has a
single mental model, and the registry remains the canonical map of what
Mira can filter.

### 4. No language/ecosystem grouping (yet)

Filters live flat under `src/filter/filters/<program>/`. We do not introduce
`filters/js/tsc/`, `filters/python/`, etc. The directory layer would be
speculative scaffolding for filters we haven't written, violating Mira's
"no speculative abstractions" principle. Reconsider when ≥5 filters share a
real ecosystem layer (e.g. JS toolchain filters all needing the same
`tsconfig`-aware path resolution); until then, the flat layout is more
discoverable and adds zero indirection.

### 5. `lib/` for cross-filter primitives stays lazy

`src/filter/lib/` is reserved for **cross-filter universal** primitives
(ANSI strip, ellipsizing truncation, the `_top:` summary line helper). It is
**not pre-created**. The first time two filters need to share a primitive,
the second filter author lifts it from the first into `lib/`. Pre-creating
the directory before there's real duplication is speculation.

## Consequences

**Positive**

- Adding a filter is a single-import diff in `registry.ts`. Filter authors
  do not coordinate on the central file beyond that one line.
- The umbrella case (git, npm, cargo) is handled the same way as the simple
  case — no special-cased "umbrella filter" abstraction, no internal
  dispatch tables.
- Each filter file stays under Mira's 250-LOC / 40-LOC limits because the
  parsers and renderers are not crammed together with sub-program routing.
- Resolution is debuggable: `extractTokens(command)` returns the inputs to
  resolution, `findRegistryEntry(tokens, REGISTRY)` returns the output.
  Both are pure and testable in isolation.

**Negative / accepted trade-offs**

- Umbrella programs grow more directories than RTK's single-file approach.
  We accept this; the compensating gain is per-sub-program isolation and
  the absence of an internal dispatch surface.
- The `entries.ts` indirection adds two levels to the longest dependency
  chain (`registry → entries → index → …`). Sentrux's depth dimension drops
  ~700 points as a result. We accept this; the compensating gain is that
  filter authors never edit `registry.ts`'s structure, only its imports.
  The single source of truth — what programs Mira filters — is preserved
  in a flat, inspectable Map; what we lost is shallowness, not clarity.
- `RegistryEntry` lives in `types.ts`, not `registry.ts`, because
  per-program `entries.ts` files reference the type and a placement under
  `registry.ts` would create a type-only import cycle (still a smell, even
  if erased at compile time). Keep types in `types.ts`; let `registry.ts`
  re-export so external consumers don't have to relearn the path.
- `MAX_KEY_TOKENS` is a hard cap. Programs with 3+ token sub-commands
  (`kubectl get pods -n …`) cannot register a 3-token key today. Bumping
  the cap is a one-line change with no API impact, but it is a deliberate
  speed bump: the cap exists to keep resolution cost O(1)-ish per
  dispatch (we try at most `MAX_KEY_TOKENS` lookups, all hashmap-fast).
- Pretty-mode passthrough is the only fallback path: filters that can't
  parse their input must return zero findings, and the dispatcher will
  switch to raw-output passthrough only on non-zero exit. A filter that
  returns zero findings on a *successful* run with non-empty output is
  treated as a legitimate "all clear" — there's no third state.

**Operational**

- `src/filter/README.md` is the contributor entry point with copy-pasteable
  templates. Anyone adding a filter reads it first.
- `docs/architecture.md` carries the kernel-level overview and links to
  this ADR + the README.
- `tests/filter-dispatch.test.ts` carries the contract tests for
  `extractProgramToken`, `extractTokens`, and `findRegistryEntry`. Any
  changes to resolution semantics must update these tests in lockstep.

## Alternatives considered

### A. Monolithic umbrella filter (RTK-style)

A single `git.ts` with an internal `match` over a `GitCommand` enum, one
parser per sub-program inside the same file. **Rejected** because the file
size grows linearly with sub-program count (RTK's `git.rs` is ~700 LOC),
the internal dispatch is a second resolution surface for filter authors to
learn, and the file becomes a coordination magnet for multiple PRs touching
the same umbrella in parallel.

### B. Plugin registration (filter calls `registerFilter(...)` at import time)

Each filter would self-register via a side-effecting import. **Rejected**
because side-effecting imports break tree-shaking, add an implicit ordering
dependency on import sequence, and turn the registry from a static
inspectable map into runtime state. The static `entries.ts` + central spread
keeps the surface declarative and inspectable.

### C. Single-token keys forever, with sub-program detection inside the filter

`git`'s filter receives the full command and parses out the sub-program
itself. **Rejected** for the same reasons as (A), plus the dispatcher
becomes asymmetric: the filter author has to do the work the dispatcher
should be doing. Multi-token keys with longest-prefix matching put the
resolution logic in one place where it can be tested in isolation.

### D. Ecosystem grouping (`filters/js/tsc/`, `filters/git/diff/`)

A directory layer between `filters/` and the program. **Rejected for now**
because we have one filter and even at V0.7 we'd have ~5–6, not enough
volume to justify the indirection. Reconsider when filters in the same
ecosystem share enough primitives that the layer carries real meaning
(e.g. all JS-toolchain filters reading the same `tsconfig.json` resolution).

## References

- ADR 0007 — Hook is the data layer; this ADR refines what the hook
  produces structurally.
- `docs/plans/filter-engine/` — V0.4 implementation plan; the
  Tasks 01-09 sequence delivered the first filter and informed the
  generalization captured here.
- `src/filter/README.md` — contributor walkthrough.
