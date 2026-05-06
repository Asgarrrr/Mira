# 02 — Thesis and success metrics

## The hypothesis under test

> Adding Mira's five MCP tools to an agent's standard toolbelt changes the *default* delivery of raw command output and prior observations from "in-prompt" to "opt-in via a tool call". On scenarios where the agent's reasoning permits skipping some raw fetches — or where prior session evidence is reusable — total tokens consumed drop without hurting success rate.

One falsifiable claim, with a refinement that matters: Mira V0's summarizer is a single deterministic generic one-liner. It does **not** actively compress content, it *defers* it. Where Mira wins is in **agent autonomy over retrieval**, not in summarization quality. This is a smaller, more honest claim than "Mira reduces tokens"; it acknowledges that if every query forces a raw fetch, Mira-augmented runs cost baseline + one round trip per fetch.

## What we are *not* testing

- Whether Mira is faster than RTK or Sentrux on their own primary axes
- Whether Mira's V0 summarizer **actively compresses** content (it doesn't — command-specific summarization is explicitly post-V0)
- Whether the CLI is ergonomic
- Whether agents *prefer* Mira (subjective)

## Operationalizing "better"

A run = one (scenario, mode) execution, terminated when the agent stops or when guard-rails fire (token cap, turn cap, wall-clock cap). Per run we capture:

| Metric | Source | Why |
|---|---|---|
| `tokens_input` | Anthropic SDK `usage.input_tokens` summed over turns | Cost / context economy |
| `tokens_output` | `usage.output_tokens` summed over turns | Verbosity of model thinking |
| `tokens_total` | sum of both | Headline metric |
| `turns` | count of model invocations | Iteration depth |
| `tool_calls` | count of all tool invocations | Action count |
| `tool_calls_by_name` | histogram per tool | Which Mira tools (if any) the agent actually used |
| `wall_clock_ms` | harness clock | User-perceived time |
| `files_read`, `files_modified` | tool-call inspection | Navigation efficiency |
| `success` | scenario `success.sh` exit code | Did the task get done correctly? |

## Aggregation

Per (scenario, mode), with N=3 repeats:
- Median + range for token metrics
- Mean for success rate (3 boolean outcomes → fraction)
- Order-preserved for `tool_calls_by_name` distributions

Why median: with N=3 the median is robust to one outlier. Don't compute p-values — N=3 doesn't justify them.

## Decision rules

For each scenario, compare baseline vs Mira-augmented:

| Outcome | Condition | Verdict |
|---|---|---|
| **Win** | `tokens_total` median ↓ ≥20% **AND** success_rate ≥ baseline | Mira helps |
| **Loss** | `tokens_total` median ↑ **OR** success_rate < baseline | Mira hurts |
| **Neutral** | between the two | No effect detected |

Across the corpus:
- Mira "wins overall" if it wins on ≥3 of 4 first-experiment scenarios (A1 + A2 + A3 + B1)
- B1 (verbose typescript failure) is the scenario where Mira's structural opt-in advantage *should* be most visible — a clear loss on B1 alone is enough to question the hypothesis even if A1–A3 land neutral
- Negative-control scenarios (archetype D, designed to be context-insensitive — see [`04-scenario-corpus.md`](./04-scenario-corpus.md)) should produce Neutral verdicts when added in a later experiment. A Win or Loss on D would be a red flag pointing at confounders (token accounting bug, task wording leaks the answer, etc.).

## Honesty axis

The eval is local and small. Failure modes to flag in every report:
- N=3 is small; one bad run shifts the median heavily
- Synthetic scenarios may overfit (we know the answer; the agent might too via over-suggestive task wording)
- The hypothesis depends on the agent **choosing** to skip raw fetches when the structured observation is enough; if Sonnet 4.6 always fetches everything by default, Mira's opt-in advantage doesn't manifest on a single-shot task and only surfaces on multi-turn re-investigation
- A1–A3 run on Mira's own 24-file codebase, where context-selection has little room to differentiate; expect modest gaps. B1 has more headroom because the typecheck output is structurally large
- Anthropic SDK token accounting may not match what users see in production tools (cache reads, e.g.)
- The harness is the test instrument; if it's wrong, every result is wrong

The point of the first experiment is to learn what the harness *itself* needs, not to declare Mira a success or a failure.

## What "next" looks like depending on the verdict

- **Win:** scope a larger second experiment with more scenarios, more repeats, and an external corpus (probably SWE-bench-lite samples)
- **Neutral:** dig into per-tool histograms — was Mira even called? If not, the agent had no reason to; either the task didn't need it or the prompt didn't surface its existence well enough
- **Loss:** ablate by tool — remove tools one at a time to find which one introduces the regression; if the regression is universal, the issue is upstream of any single tool
