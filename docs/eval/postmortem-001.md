# Postmortem 001 — first eval, four-loss verdict

## Verdict

**Global: Loss (0 Win, 4 Loss, 0 Neutral).** Mira-augmented runs spent +14.5% to +111.3% more tokens than baseline on every scenario, including B1 where the structural opt-in advantage was supposed to be most visible. Success rates were equal (100% / 100%) on A1, A2, B1, and slightly worse on A3 (100% baseline → 67% mira) due to one wall-clock-cap failure. Mira in its V0 shape is not yet helping an agent on this corpus; in this configuration it is hurting.

## Tool-use patterns

All 12 Mira cells opened with `generate_context_pack` — the tool surfaces correctly through the system prompt. But every pack came out sparse: `runs: []`, because each scenario starts in a fresh worktree with an empty `.mira/`. After the empty pack, the agent fell back to baseline-style exploration (`bash` + `read`), occasionally using `run_command` + `get_raw_evidence` (a 2-call shape) where baseline ran a single `bash`. The Mira tools became additive overhead, not a replacement for cheaper paths.

## Harness limitations surfaced

- A3 mira #1 stalled to `wall_clock_cap` (601s, 4700 tokens). Last action: a successful `read`. The model's next turn never landed an event before the cap fired — likely an API stall or an agent-loop edge case worth isolating; an ungated retry would have hidden it.
- The agent issued `cd /workdir` in A3 mira #1 and got rejected by Mira's bash sandbox. The system prompt or a tool description is leaking a `/workdir` hint that does not match the harness's tmpdir layout.
- `generate_context_pack` is structurally useless on a fresh worktree (chicken-and-egg: the pack summarizes prior `run_command` runs, but each scenario starts with zero of them). The current default tests Mira on its worst possible workload.

## Decisions for the next iteration

Per the Loss → ablate-by-tool rule in `02-thesis-and-metrics.md`:

1. **Ablate to `generate_context_pack` alone.** If `run_command` + `get_raw_evidence` are the regression source, removing them should narrow the gap toward Neutral.
2. **Pre-seed `.mira/` with one or two relevant prior runs** before the agent starts, so the context pack has actual content. Empty-pack-by-default is not a fair test.
3. **Fix the A3-mira-1 stall and the `/workdir` hint** before re-running — both are likely harness bugs that distort the signal independent of Mira itself.
