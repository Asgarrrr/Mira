# ADR 0009: V0.5 filter roster — git status, git diff, bun test

## Status

Accepted

## Context

V0.4 (ADR 0008) shipped the filter subsystem with `tsc` as the single registered consumer. Three architectural pieces from 0008 remain unexercised in production:

1. **Longest-prefix multi-token dispatch** (`src/filter/dispatch.ts:findRegistryEntry`) — only test-mocked. No live registry holds two keys sharing a first token.
2. **The `<program>/shared/` convention** for sub-program parser reuse (`src/filter/README.md`, "Adding an umbrella filter with sub-programs") — documented, never built.
3. **The per-filter plan-doc pattern** — `docs/plans/filter-engine/` is the only instance.

The README pins next filters as `git`, `eslint`, `bun test`, `cargo`, `vitest`, but does not lock order, scope, or whether V0.5 bundles engine infra upgrades. `docs/plans/filter-engine/00-decisions.md § 9c` lists five Mira-native upgrades deferred from V0.4: (a) cache-stable header, (b) severity-ranked rendering, (c) quarantine-don't-drop, (d) render-format negotiation, (e) token-budgeted rendering. None shipped in V0.4; (a) and (b) were marked "V0.4 candidate" but slipped, (c)–(e) are tagged V0.5+.

This ADR locks V0.5's scope so subsequent per-filter PRs cite a single decision instead of re-litigating it. **What this ADR does not decide:** no `lib/` creation, no `MAX_KEY_TOKENS` bump, no quarantine, no JSON output, no token budget, no fixture-capture rework. 0008's foundation stays load-bearing.

## Decision

V0.5 is shaped by five sub-decisions.

### 1. Roster: `git status`, `git diff`, `bun test`

Three new registry entries:

- **`git status`** — smallest umbrella shape; porcelain output is line-oriented and stable across git versions. Smallest validation surface for the multi-token registry path.
- **`git diff`** — second umbrella entry. Pulls from `filters/git/shared/` already populated by `git status` (porcelain helpers, hunk-header parsing).
- **`bun test`** — largest scope, most format variability. High agent value: every failing run dumps verbose output today.

This roster is the **first real consumer of 0008's longest-prefix dispatch**: `git status` and `git diff` share the `git` first token, so a 2-token miss falls through to a 1-token miss → passthrough exactly as 0008 § 2 specifies.

Out of scope: `git log`, `npm test`, `pnpm test`, `yarn test`, `eslint`, `cargo`, `vitest`, `jest`. No eval scenario forces them today.

### 2. Layout — umbrella + flat sibling

```
src/filter/filters/
  git/
    shared/      porcelain + hunk parsers shared by status and diff
    status/      glue + parser + render + version + __fixtures__/
    diff/        glue + parser + render + version + __fixtures__/
    entries.ts   exports gitEntries (two tuples)
  bun-test/
    index.ts parser.ts cluster.ts? render.ts version.ts
    entries.ts   exports bunTestEntries (one tuple)
    __fixtures__/
```

Mirrors `src/filter/README.md` "Adding an umbrella filter" layout literally. No `filters/js/` ecosystem layer (0008 § 4 still binds — speculative until ≥5 JS filters share real primitives).

### 3. Implementation order: status → diff → bun-test

Three sequential PRs, independently revertable, no shared schema migration. Each PR ships its filter, its tests, its fixtures, its plan-doc, its `README.md` update. Ordering is forced by:

- `git status` validates multi-token registration with the simplest sub-program shape.
- `git diff` lands second so `shared/` is already populated.
- `bun test` lands last; the largest parser surface benefits from fixture-capture lessons learned in the git PRs.

### 4. `bun test` registry key is `"test"`, not `"bun test"`

This is the load-bearing friction in V0.5. `src/filter/dispatch.ts:9` lists `bun` as a wrapper (per `00-decisions.md § 3`). After wrapper-stripping, `bun test foo` resolves to tokens `["test", "foo"]` — `bun` is consumed, `test` is the program. The registry key must therefore be `"test"`, not `"bun test"`.

- **Directory name vs. registry key diverge.** Directory is `filters/bun-test/` (semantic slug); registry key is `"test"` (mechanical, post-wrapper-stripping).
- **Latent collision.** `npm test`, `pnpm test`, `yarn test` all resolve to `"test"` after their respective wrappers are stripped. They collide on the same registry entry. Acceptable today (no second test-runner filter exists); the day a second one ships, that PR — not this one — picks the differentiation strategy.
- **Removing `bun` from the wrapper set is rejected** (Alternative D). The wrapper list is older than this ADR and supports `bun src/cli/index.ts run` and `bun run <script>` patterns Mira's own dev loop relies on.

### 5. Plan-doc convention: per-filter directories

Each filter gets its own plan-doc directory mirroring `docs/plans/filter-engine/`'s structure (`00-decisions.md`, `01-types.md`, …). Three new directories at implementation time, one per landing PR:

- `docs/plans/git-status/`
- `docs/plans/git-diff/`
- `docs/plans/bun-test/`

Co-location matches 0008 § 11 / § 9c bullet 3 ("fixtures, parser, render move as one cohesive unit"). Format-stability questions, fixture sets, and bench gates are filter-specific; they belong with the filter, not in a single V0.5 plan-doc.

This ADR locks the roster. Per-filter `00-decisions.md` files lock parser/render shape.

## Consequences

**Positive**

- 0008's longest-prefix dispatch gets its first real consumer; latent design becomes load-bearing.
- `<program>/shared/` is exercised on git porcelain/hunk parsers before V0.6 needs it.
- Fixture corpus broadens (~9 captures across small/medium/large per filter, 3 new `tokens.json`).
- Plan-doc-per-filter template establishes the V0.5+ pattern; later filters copy the directory.
- The "one import + one spread" claim in 0008 § 1 is validated against three new entries.

**Negative / accepted trade-offs**

- Three sequential PRs over V0.5, not one. Accepted; per-filter atomicity is the architecture's whole point.
- `docs/plans/` grows from 1 directory to 4. Accepted; co-location matches 0008 § 9c.
- Snapshot count grows by ~10–15 across the three filters. Review burden tracks linearly.
- **`bun test` registry key collision under `"test"`.** `npm test`, `pnpm test`, `yarn test` all map to the same key after wrapper-stripping. No solution committed; the deferral is on the record.
- `src/filter/README.md` and `docs/architecture.md` need a per-filter touch on each landing PR.
- The five `00-decisions.md § 9c` items remain deferred. No V0.5.x or V0.6 commitment beyond "evaluate when filter count or agent feedback forces them".

**Operational**

- Each landing PR updates `src/filter/README.md` Layout block and `docs/architecture.md` Filter subsystem section.
- `tests/filter-dispatch.test.ts` gains real-registry coverage of git-umbrella longest-prefix paths (today only mock-registry-tested).
- Bench gates from `00-decisions.md § 10` apply per-filter. Each filter's `__fixtures__/tokens.json` carries committed Anthropic `count_tokens` numbers.

## Alternatives considered

### A. Bundle the five `§ 9c` infra upgrades into V0.5

A V0.5 release bundling the deferred infra items (cache-stable header, severity-ranked render, quarantine-don't-drop, render-format negotiation, token-budgeted render) alongside the new filters. **Rejected** because each infra upgrade is a horizontal change touching every filter's render path; bundling them with three vertical filters multiplies PR risk and obscures attribution when a bench gate fails. Re-evaluated as V0.5.x or V0.6 when there's evidence the agent or filter author needs them.

### B. Replace `bun test` with `eslint`

`eslint --format json` is a trivial parser per `00-decisions.md § 9` ("the win is small"). **Rejected** because V0.5's value is exercising both the umbrella sub-program pattern AND a high-volume parser; `eslint` exercises neither. Picked up later when a real eval scenario forces it.

### C. Single-filter V0.5 (`bun test` only)

Ship one filter, defer git to V0.6. **Rejected** because it skips validation of 0008's longest-prefix dispatch and the `<program>/shared/` convention. Both designs would remain theoretical through V0.5; their first real consumer would be V0.6, by which point we'd be locking in patterns we never tested.

### D. Drop `bun` from the wrapper set so `bun test` resolves as `["bun", "test"]`

A registry key of `"bun test"` would be cosmetically clearer than `"test"`. **Rejected** because the wrapper list (`00-decisions.md § 3`) is older than this ADR and supports `bun src/cli/index.ts run` and `bun run <script>` patterns critical to Mira's dev loop and `mira hooks install`. Revisiting wrapper semantics for cosmetic naming inverts the cost-benefit.

## References

- ADR 0008 — filter subsystem architecture; this ADR is the first roster expansion under it.
- ADR 0007 — hook is the data layer; rendered markdown is the artifact this ADR multiplies.
- `docs/plans/filter-engine/` — V0.4 plan-doc; structural template each new per-filter plan-doc mirrors.
- `docs/plans/filter-engine/00-decisions.md` — § 3 (wrapper list, anchors Decision § 4); § 9 (pilot-command table, anchors Alternative B); § 9c (deferred upgrades, anchors Context and Alternative A); § 10 (bench discipline, anchors Operational); § 11 (V0.5+ layout convention, anchors Decision § 2).
- `src/filter/README.md` — contributor walkthrough; "Adding an umbrella filter with sub-programs" is the literal procedure for the git PRs.
- `src/filter/filters/tsc/` — canonical reference impl; each new filter is patterned on it.
- Forward references — `docs/plans/git-status/`, `docs/plans/git-diff/`, `docs/plans/bun-test/` (created in V0.5 alongside each landing PR).
