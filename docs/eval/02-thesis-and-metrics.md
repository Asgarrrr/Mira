# 02 — Thesis and success metrics

## The hypothesis under test

> Adding Mira's five MCP tools to an agent's standard toolbelt reduces tokens consumed and increases task success rate on coding tasks where context selection matters, with no regression on tasks where it doesn't.

One falsifiable claim. The eval either supports it or kills it.

## What we are *not* testing

- Whether Mira is faster than RTK or Sentrux on their own primary axes
- Whether Mira's specific summarizer is optimal
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
- Mira "wins overall" if it wins on ≥2 of 3 first-experiment scenarios
- Negative-control scenarios (archetype D, designed to be context-insensitive — see [`04-scenario-corpus.md`](./04-scenario-corpus.md)) should produce Neutral verdicts. A Win or Loss on D is a red flag pointing at confounders (token accounting bug, task wording leaks the answer, etc.) — investigate before drawing conclusions about A/B/C.

## Honesty axis

The eval is local and small. Failure modes to flag in every report:
- N=3 is small; one bad run shifts the median heavily
- Synthetic scenarios may overfit (we know the answer; the agent might too via over-suggestive task wording)
- Anthropic SDK token accounting may not match what users see in production tools (cache reads, e.g.)
- The harness is the test instrument; if it's wrong, every result is wrong

The point of the first experiment is to learn what the harness *itself* needs, not to declare Mira a success or a failure.

## What "next" looks like depending on the verdict

- **Win:** scope a larger second experiment with more scenarios, more repeats, and an external corpus (probably SWE-bench-lite samples)
- **Neutral:** dig into per-tool histograms — was Mira even called? If not, the agent had no reason to; either the task didn't need it or the prompt didn't surface its existence well enough
- **Loss:** ablate by tool — remove tools one at a time to find which one introduces the regression; if the regression is universal, the issue is upstream of any single tool
