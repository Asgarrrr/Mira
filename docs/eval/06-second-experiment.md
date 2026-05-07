# 06 — Second experiment (Claude Code as the client)

## Why a second experiment

`postmortem-001.md` made the case: the first experiment compared two configurations of a synthetic agent (raw `messages.create()` loop, custom tool wrappers, no prompt caching). Mira's actual consumer is Claude Code. Claude Code has prompt caching, a different system prompt, different tool descriptions, and — when Mira's plugin is installed — already routes `bash` through `mira run` via the `mira-rewrite.sh` hook. None of that was modeled in the first experiment, so the Loss 4/4 verdict says nothing about Mira's real-world behavior.

This second experiment re-runs the four scenarios against headless Claude Code, with two configurations that match the install / no-install reality.

## Configurations under test

| Mode | CC invocation | Hook | MCP | Notes |
|---|---|---|---|---|
| `baseline` | `claude --bare -p ...` | off | none | `--bare` skips hooks, plugins, auto-memory — clean "no Mira anywhere" |
| `mira` | `claude -p --mcp-config <mira.json> ...` | on (`mira-rewrite.sh`) | `mira` server exposing the 5 V0 tools | Matches what a user gets after `mira hooks install` + plugin enable |

The point of *not* gating the hook independently is to test the realistic install. We are not interested in "MCP only, hook off" or "hook only, MCP off" combinations in this round; if `mira` loses, sub-task vii (ablation) splits them.

## New cell type: pre-seeded `.mira/`

The first experiment ran every cell on a fresh worktree → `.mira/` empty → `generate_context_pack` produced `runs: []`. That is Mira's worst-case workload by design.

The second experiment adds a **multi-session** dimension:

| Cell variant | Pre-seed |
|---|---|
| `single-shot` | Fresh `.mira/`, same as experiment 1 |
| `multi-session` | Run a related "session 1" task in `mira` mode, persist `.mira/`, then run the scenario in a second invocation against the same `.mira/` |

`multi-session` is the cell that tests the actual thesis (`02-thesis-and-metrics.md`): "where prior session evidence is reusable". Without it, the eval is structurally rigged against Mira.

## Configuration

| Knob | Value | Why |
|---|---|---|
| Scenarios | A1, A2, A3, B1 (unchanged from exp 1) | Calibration parity |
| Modes | `baseline`, `mira` | The two we're comparing |
| Cell variants | `single-shot`, `multi-session` | Tests V0 thesis on its actual workload, not the worst-case |
| Repeats | 3 | Same as exp 1 |
| Total runs | 4 × 2 × 2 × 3 = **48** | Twice exp 1 |
| Model | Whatever CC defaults to (Sonnet 4.6 today) | Match production |
| Cost | Bounded by user's CC subscription (no API top-up) | Side benefit of using CC |
| Wall-clock cap / cell | 600s via `timeout 600 claude -p ...` | Same as exp 1 |
| Turn cap | CC's default | We don't override |

## Implementation tasks

### Sub-task vii — Surgical reset of the harness

Delete (the synthetic-agent machinery):

- `eval/harness/agent.ts` + `eval/harness/agent.test.ts`
- `eval/harness/tools/{bash,read,write,grep,mira-mcp}.ts`
- The smoke-test code path in `eval/harness/run.ts`
- The `experiment first` subcommand and `runScenario` wiring in `run.ts`

Keep:

- `eval/scenarios/{A1,A2,A3,B1}/` — client-agnostic
- `eval/harness/scenario.ts` (`loadScenario`, `applyScenario`, `checkScenario`) — client-agnostic
- `eval/harness/scenario.test.ts`
- `eval/harness/report.ts` + `report.test.ts` + `__fixtures__/synthetic-results/` — aggregation rules from `02-thesis-and-metrics.md` are independent of how runs were generated
- `eval/harness/types.ts` `RunMetrics` — likely usable as-is (`model`, `success`, `tokensInput`, `tokensOutput`, `tokensTotal`, `toolCallsByName`, `wallClockMs`); minor adjustments only if CC reports something we can't map

### Sub-task viii — `cc-runner.ts`

A thin wrapper around `spawn("claude", [...])`:

- Inputs: `{ workdir, task, mode, mcpConfigPath?, transcriptOut, metricsOut, wallClockMs }`
- Spawns `timeout <ms> claude -p --output-format stream-json [--mcp-config <path>] [--bare] "<task>"` in `workdir`
- Streams stdout NDJSON line by line, writes them to `transcript.jsonl`, accumulates: model name, total input/output tokens, tool-use count by name, success criterion (delegated to `checkScenario` after CC exits).
- Returns `RunMetrics` with the same shape `report.ts` expects.

### Sub-task ix — Pre-seeder for multi-session cells

For each scenario, define a `seed.task.txt` (a related, distinct task that produces `.mira/` content the actual scenario can reuse). Examples for A2 (the suspected-files cap scenario):

- Seed: "Run the architecture-signal test suite and tell me which tests are slow."
- Real: the original A2 task.

The seeder runs the seed task in `mira` mode, persists the worktree's `.mira/`, then the actual scenario runs against that `.mira/`. We do not reset the worktree's source tree between the two — only the `base.patch` is applied right before the real task.

Out of scope for the first multi-session pass: cross-scenario seeding, very long seed sequences, AI-generated seed tasks.

### Sub-task x — `experiment second` orchestration

`bun harness/run.ts experiment second` :

- Pre-flight: check `claude` on PATH, check the four scenarios load, check `.mira/` writable.
- Loop 4 × 2 × 2 × 3 = 48 cells. Sequential. Per-cell stderr log.
- Same lost-cell tolerance as exp 1 (~5%, i.e. 2/48).
- Calls `generateReport` at the end. `report.ts` may need a minor patch to surface the `single-shot` vs `multi-session` axis; tracked in sub-task xi.

### Sub-task xi — Report adjustments

`report.ts` aggregates by `(scenario, mode)`. For the second experiment we want `(scenario, mode, variant)`. Either:

- Add `variant` to `RunMetrics` and let `report.ts` emit one table per variant, *or*
- Encode the variant in `scenario` (e.g. `A1-single`, `A1-multi`).

The first option is cleaner and the change is ~30 lines. Done as part of sub-task xi, not bundled with viii.

### Sub-task xii — Run, post-mortem 002

- Run the 48 cells.
- Inspect `summary.md` per variant.
- Write `docs/eval/postmortem-002.md` covering: did the verdict flip, where did Mira help vs hurt, what did `generate_context_pack` actually surface in multi-session cells, harness limits surfaced in the CC environment, decisions for round 3 (or for shutting Mira down).

## Reuse from experiment 1

`eval/results/2026-05-07T10-48-32-006Z/` and `postmortem-001.md` stay in tree as the first-attempt artefact. They are explicitly *not* deleted — they document the synthetic-agent baseline and the reasoning that led to this redesign.

## Honesty axis (carried over and extended)

All caveats from `02-thesis-and-metrics.md` still apply, plus:

- Claude Code's prompt caching changes the cost shape — re-running the same baseline a few times in a row is *cheaper* than running it cold. Sequencing of runs may matter; randomize `(mode, scenario, variant)` order if signal is close.
- `claude -p` shape and stream-json schema are subject to change across CC versions; pin a CC version in the run log, surface it in `summary.md`.
- Multi-session seeds are hand-written, so they bias the eval. Document each seed in the scenario's README so a reviewer can challenge it.
- The `mira-rewrite.sh` hook is shell-based and version-pinned (`mira-hook-version: 1`); a hook upgrade between exp runs invalidates the comparison.

## Go / no-go gates

Go when:

- Sub-tasks vii–xi are complete
- A single dry-run cell (`A1`, `single-shot`, `mira`) finishes end-to-end and produces a parseable `transcript.jsonl` + `metrics.json`
- The CC version is recorded; subscription quota verified

No-go if:

- `claude -p --output-format stream-json` does not surface usage tokens (we cannot compute `RunMetrics` without them)
- The hook upgrade has not stabilized (`mira-hook-version` mismatch between baseline-and-mira runs)

## What success looks like (and what failure means)

- **Win on multi-session, Neutral or Loss on single-shot**: confirms the V0 thesis. Scope V1 around multi-session affordances.
- **Loss on both**: hard call. Either Mira's V0 design is genuinely off-axis for what CC needs (rethink), or the hook overhead alone (independent of MCP) regresses CC's performance (drop the hook).
- **Win on both**: surprising; sanity-check that prompt caching didn't accidentally favor mira (e.g., MCP responses got cached but baseline output didn't).

The first experiment told us what we built isn't tested honestly. The second one is the actual test.
