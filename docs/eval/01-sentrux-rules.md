# 01 — Sentrux architectural rules

## Goal

Lock the dependency invariants of [ADR 0006](../adr/0006-mcp-server-v0-3-scope.md) into a Sentrux rules file so the architecture sensing tool stops being only an observatory and becomes a guard-rail.

## Why now

V0.3 added a clear directional rule: `mcp → kernels → core types`, never the inverse. Currently this rule is enforced by code review only. Sentrux can verify it on every scan.

## Invariants to encode

Transcribed from ADR 0006 § *Dependency direction*, [`docs/architecture.md`](../architecture.md) § *Dependency direction*, and ADR 0001:

- `core/**` may import only from `core/**` — the core domain types stay free of all boundaries
- `architecture/**` may import only from `core/**` — one-way (ADR 0005)
- `store/**` may import only from `core/**`
- `render/**` may import only from `core/**` — pure markdown formatters, depended on by `cli/**` and `mcp/**` for byte-for-byte parity (extracted out of `cli/**` in PR #21)
- `command/**` may import from `core/**` and `store/**`
- `context/**` may import from `core/**`, `architecture/**`, `store/**`
- `cli/**` may import from `core/**`, `command/**`, `context/**`, `architecture/**`, `store/**`, `render/**`, and — for the bin entry / composition root only — `mcp/**` (see § Resolution)
- `mcp/**` may import from `core/**`, `command/**`, `context/**`, `architecture/**`, `store/**`, `render/**` — but **not** from `cli/**`
- `@modelcontextprotocol/sdk` may be imported only from `mcp/**` (boundary dep stays scoped)

## Implementation steps

1. Read the Sentrux rules schema from [sentrux/.sentrux/rules.toml](https://github.com/sentrux/sentrux/blob/main/.sentrux/rules.toml) and the project README
2. Translate the invariants above into the schema (`[[layers]]` + `[[boundaries]]`)
3. Run `mcp__plugin_sentrux_sentrux__rescan` then `mcp__plugin_sentrux_sentrux__check_rules`
4. Verify zero violations on the current branch

## Schema ambiguity discovered (resolved — see § Resolution)

A first attempt at `.sentrux/rules.toml` was made on `chore/eval-foundation` using the schema from sentrux's own example:

```toml
[[layers]]
name = "core"     # order 0 (intended: "lowest in the stack, depended on by all")
[[layers]]
name = "store"    # order 1 (intended: "depends on core only")
```

This produced 4 `layer_direction` violations of the form:

> `src/store/evidence-store.ts (store) imports src/core/command-observation.ts (core). store must not depend on core.`

This is **the opposite of the convention** documented by sentrux's repo comment ("higher order depends on lower order only"). Reading sentrux's own source resolved the contradiction; see § Resolution below.

## Resolution

Reading [`sentrux-core/src/metrics/rules/mod.rs`](https://github.com/sentrux/sentrux/blob/main/sentrux-core/src/metrics/rules/mod.rs) `check_layers`:

```rust
// Lower order = more foundational = can be depended on
if from_ord > to_ord {
    // layer_direction violation
}
```

A layer at order N may import only from layers at order **≥** N. So in sentrux's effective semantics, **higher `order` is more foundational** (depended on by more layers, can import nothing below); **lower `order` is the top of the stack** (depends on more, restricted by little). This is the inverse of the natural-language reading the README example invites — the README's "higher order depends on lower order" comment matches the surface assignment (`core = 0`, `app = 5`) but contradicts the actual check direction. The first attempt was bitten by this gap. Both the README example and the Mira rules file are valid; the convention is just inverted from intuition.

Mira's `.sentrux/rules.toml` therefore assigns:

- `core = 6` (most foundational; nothing below it)
- `store / architecture / render = 5` (depend on core only; peers)
- `command = 4`
- `context = 3`
- `cli / mcp = 1` (top of stack; depend on most)

Layer ordering catches all "downward leak" violations (e.g., `core → mcp`, `store → command`). Same-order peer constraints (`store → architecture`, `arch → render`, etc.) cannot be expressed via `order` alone and ship as explicit `[[boundaries]]`.

### Two related findings surfaced and were fixed before the rules file landed

1. **`mcp/** → cli/**` was real on `main`.** `src/mcp/tools/generate-context-pack.ts` and `src/mcp/tools/run-command.ts` imported `renderContextMd` / `renderObservationMd` from `src/cli/`, where the markdown formatters happened to live for historical reasons. The rules cannot match `main` if `main` violates the ADR they encode, so the renderers were extracted into a new `src/render/` layer in PR #21 (file move + import-path update; no behavioural change). The corresponding `mcp/** → cli/**` boundary in this rules file guards the regression.

2. **`cli/** → mcp/**` is intentionally **not** forbidden.** `src/cli/index.ts` (the package `bin` entry) dispatches `mira mcp` by importing `runStdioServer` from `src/mcp/server.ts`. This file is the composition root, not CLI feature logic — and as Mira moves toward an invisible hook-based posture (commands intercepted via Claude Code `PreToolUse` hooks rather than `mira run` / `mira context`), the CLI surface shrinks toward "launch the mcp server", and a synthetic `bin/` extraction layer would be deck-rearranging on a transitional surface. The rule encoded is one-sided: `mcp` does not import `cli` (the leak that matters, since it would propagate the SDK into kernels), but the bin shim is allowed to compose both surfaces.

## Verification

- `sentrux check .` reports no violations on `main`
- canary: temporarily inserting `import "../mcp/server.ts"` from `src/core/evidence.ts` produces a `layer_direction` violation; reverting restores the green report
- `bun test`, `bun run typecheck`, `bun run check src/ tests/` remain green
- The file lives at `.sentrux/rules.toml` (repo root), not under `docs/`

## Notes on what Sentrux cannot enforce

- The "`@modelcontextprotocol/sdk` may be imported only from `mcp/**`" rule targets an npm package import, not a path-based one. Sentrux's `[[boundaries]]` use path globs; this rule needs a separate mechanism (a custom lint rule, or a `grep` check in CI) — currently still on code-review enforcement.
- "Sensing logic confined to `src/architecture/`" (ADR 0005). Sentrux rules target imports, not symbols, so the rule cannot detect that a sensing-style function lives outside `src/architecture/`. The rules approximate this by forbidding every other layer from importing `src/architecture/**` *transitively* (only `context`, `cli`, `mcp` may import it), which removes the obvious avenues for sensing logic to leak — but a hand-rolled `senseFoo` in `src/context/` would not be flagged.
- Sentrux's free-tier MCP plugin (`mcp__plugin_sentrux_sentrux__check_rules`) only validates **2–3 rules per call** (`truncated.message`: "Checking up to 3 rules. More available with sentrux Pro"). Use the local CLI (`sentrux check .`) for a full validation.

## Out of scope

- Adding rules for *future* layers (`adapters/`, `summarizers/`) — they ship when those folders ship
- Encoding non-import constraints (e.g., "no `process.cwd()` outside CLI") — Sentrux rules target imports, not symbols
- Lowering the rule bar to make existing code pass — if a real violation surfaces, fix the violation, not the rule
