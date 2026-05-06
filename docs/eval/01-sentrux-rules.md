# 01 — Sentrux architectural rules

## Goal

Lock the dependency invariants of [ADR 0006](../adr/0006-mcp-server-v0-3-scope.md) into a Sentrux rules file so the architecture sensing tool stops being only an observatory and becomes a guard-rail.

## Why now

V0.3 added a clear directional rule: `mcp → kernels → core types`, never the inverse, and never `cli → mcp` or `mcp → cli`. Currently this rule is enforced by code review only. Sentrux can verify it on every scan.

## Invariants to encode

Transcribed from ADR 0006 § *Dependency direction*, [`docs/architecture.md`](../architecture.md) § *Dependency direction*, and ADR 0001:

- `core/**` may import only from `core/**` — the core domain types stay free of all boundaries
- `architecture/**` may import only from `core/**` — one-way (ADR 0005)
- `store/**` may import only from `core/**`
- `command/**` may import from `core/**` and `store/**`
- `context/**` may import from `core/**`, `architecture/**`, `store/**`
- `cli/**` may import from `core/**`, `command/**`, `context/**`, `architecture/**`, `store/**` — but **not** from `mcp/**`
- `mcp/**` may import from `core/**`, `command/**`, `context/**`, `architecture/**`, `store/**` — but **not** from `cli/**`
- `@modelcontextprotocol/sdk` may be imported only from `mcp/**` (boundary dep stays scoped)

## Implementation steps

1. Read the Sentrux rules schema from [sentrux/.sentrux/rules.toml](https://github.com/sentrux/sentrux/blob/main/.sentrux/rules.toml) and the project README
2. Translate the invariants above into the schema (`[[layers]]` + `[[boundaries]]`)
3. Run `mcp__plugin_sentrux_sentrux__rescan` then `mcp__plugin_sentrux_sentrux__check_rules`
4. Verify zero violations on the current branch

## Schema ambiguity discovered (gap to resolve before shipping the file)

A first attempt at `.sentrux/rules.toml` was made on `chore/eval-foundation` using the schema from sentrux's own example:

```toml
[[layers]]
name = "core"     # order 0 (intended: "lowest in the stack, depended on by all")
[[layers]]
name = "store"    # order 1 (intended: "depends on core only")
```

This produced 4 `layer_direction` violations of the form:

> `src/store/evidence-store.ts (store) imports src/core/command-observation.ts (core). store must not depend on core.`

This is **the opposite of the convention** documented by sentrux's repo comment ("higher order depends on lower order only"). Either the free-tier `check_rules` enforces an inverted reading of `order`, or the response message is mis-rendered, or the schema requires a different layout than the example suggests.

The file was therefore **not shipped** in this PR. The doc and the directional invariants are the durable artifact. Resolving the schema interpretation requires either:
- Reading the sentrux source code that implements `layer_direction`, or
- Opening an issue / discussion on the sentrux repo to confirm the order semantics

Until then the directional invariants live here and in ADR 0006; they remain enforced by code review.

## Verification (when the file finally lands)

- `mcp__plugin_sentrux_sentrux__check_rules` reports no violations on the current branch
- `bun test`, `bun run typecheck`, `bun run check` remain green
- The file lives at `.sentrux/rules.toml` (repo root), not under `docs/`

## Notes on what Sentrux likely cannot enforce

- The "`@modelcontextprotocol/sdk` may be imported only from `mcp/**`" rule targets an npm package import, not a path-based one. Sentrux's `[[boundaries]]` use path globs; this rule may need a separate mechanism (a custom lint rule, or a `grep` check in CI) — document the gap if so.

## Out of scope

- Adding rules for *future* layers (`adapters/`, `summarizers/`) — they ship when those folders ship
- Encoding non-import constraints (e.g., "no `process.cwd()` outside CLI") — Sentrux rules target imports, not symbols
- Lowering the rule bar to make existing code pass — if a real violation surfaces, fix the violation, not the rule
