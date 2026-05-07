# Task 09 — Manual Claude Code A/B verification (soft gate)

## Goal

Before merging V0.4, run Claude Code (the actual binary, the actual client) on the eval B1 scenario in two arms — baseline (no Mira hook) vs filter-on (Mira hook with `tscFilter` registered). Record token consumption, success rate, turn counts. Block the merge if filter-on regresses meaningfully against baseline.

## Why this exists

The V0.4 hard gate (Task 07's bench) measures what the *filter* does to fixed input. It does not measure what an *agent* using Claude Code (with prompt caching, tool descriptions, system prompt, the agent loop) actually consumes when given the filter's output.

Postmortem-001 showed that a synthetic agent (raw Anthropic SDK + hand-rolled tool wrappers) is **structurally a different beast** from Claude Code. Re-running the eval through the SDK would repeat that mistake. The cheap, honest alternative is: run the real client manually, N=2 per arm, on the scenario that V0.4 most directly targets (B1 — `verbose-typescript-failure`).

This is a **soft gate**: it does not run in CI, it requires ~30 minutes of human time per ship. The cost is defensible because V0.4 is the first time Mira changes what the agent reads — and we don't want a silent regression to repeat postmortem-001.

## Files touched

- `docs/plans/filter-engine/09-claude-verification.md` (this file).
- `docs/adr/0008-filter-engine-v0-4-tsc-pilot.md` — bench AND A/B result blocks both filled before merge (08-documentation.md change).
- The V0.4 PR description — the A/B table is copy-pasted into the PR for review visibility.

No code is touched in V0.4. A future task may wrap this procedure into a script driving `claude -p`; that's post-V0.4.

## Procedure

### Setup (once, ~10 min)

1. Make sure Mira is on the V0.4 branch with all of Tasks 01–08 landed (bench passes, all tests green).
2. Make sure Claude Code is installed and signed in (`claude --version`).
3. Make sure the B1 scenario applies cleanly:
   ```bash
   cd /tmp && rm -rf mira-b1-arm-{baseline,filter}
   git -C /Users/asgarrrr/Documents/Projects/Mira archive --format=tar HEAD | tar -x -C mira-b1-arm-baseline
   cp -R mira-b1-arm-baseline mira-b1-arm-filter
   ```
4. In each arm directory, apply `eval/scenarios/B1/base.patch`:
   ```bash
   cd /tmp/mira-b1-arm-baseline && git apply eval/scenarios/B1/base.patch
   cd /tmp/mira-b1-arm-filter   && git apply eval/scenarios/B1/base.patch
   ```
5. In the **filter arm only**, install the Mira hook so Claude Code's Bash tool routes through `mira run`:
   ```bash
   cd /tmp/mira-b1-arm-filter && bun src/cli/index.ts hooks install --agent claude --scope project
   ```
6. In the **baseline arm**, confirm no `.claude/settings.json` is present (no hook).

### Run (per arm, N=2 each, ~5 min per run)

For each arm × repeat:

1. Open Claude Code in the arm's working directory:
   ```bash
   cd /tmp/mira-b1-arm-<arm> && claude
   ```
2. Paste the task verbatim from `eval/scenarios/B1/task.txt`:
   > `bun run typecheck` is failing with many errors. Find the root cause and fix it. Then verify `bun test` is also green.
3. Let Claude Code work to completion (success or give-up). Do NOT intervene, do NOT correct, do NOT answer follow-up clarifying questions beyond "go ahead, your judgement".
4. When the agent stops, in the Claude Code session run `/cost` to read total tokens consumed (input + output across all turns).
5. Record:
   - Total input tokens (from `/cost`)
   - Total output tokens (from `/cost`)
   - Total turns (count assistant messages)
   - Success: did `bun run typecheck && bun test` exit 0 in the worktree? Run it manually post-session.
6. Reset the worktree for the next repeat:
   ```bash
   cd /tmp/mira-b1-arm-<arm> && git reset --hard && git apply eval/scenarios/B1/base.patch
   rm -rf .mira  # so each filter-arm run starts cold
   ```

Total: 4 sessions (2 arms × 2 repeats). Budget 30 minutes including setup.

### Aggregate

Median of the two repeats per arm:

| Arm | input_tokens (median) | output_tokens (median) | total_tokens (median) | turns (median) | success |
|---|---:|---:|---:|---:|:---:|
| baseline | … | … | … | … | x/2 |
| filter-on | … | … | … | … | x/2 |
| Δ% (filter vs baseline) | … | … | … | … | n/a |

## Pass criteria

V0.4 ships only if **all three** hold:

1. **Token economy.** Filter-on `total_tokens` median ≤ baseline `total_tokens` median × 1.10 (i.e., filter does not regress tokens by more than 10% — slack covers single-run variance with N=2).
2. **Success rate.** Filter-on success rate ≥ baseline success rate. We do not ship a filter that breaks task completion.
3. **Tool-result rendering sanity.** Subjectively eyeball one filter-on transcript: the agent's first read of the tsc output should be the rendered markdown (not raw `combined.log`). If the agent reflexively reads `combined.log` immediately, the filter is invisible to the agent — soft fail, investigate before merge.

## What to do on each outcome

- **All three pass:** record numbers in ADR 0008's "Manual Claude Code A/B result" block, copy into PR description, merge.
- **Token economy fails:** likely cause is prompt-cache invalidation (filtered markdown breaks a cache prefix the baseline kept). Investigate by inspecting the filter-on transcript's per-turn `cache_creation_input_tokens` vs `cache_read_input_tokens`. If cache-invalidation is the cause, V0.4 needs a redesign of the markdown shape (likely: stable header that doesn't include duration/timestamp). **Block merge.**
- **Success rate regresses:** open an issue. Inspect transcripts to identify which tool call the filter confused. Do not merge.
- **Inconclusive (one pass + one fail per arm):** run two more repeats to bring N=4. If still inconclusive, document explicitly in ADR 0008 and decide manually whether to ship — note that "inconclusive" is itself a signal that the filter's effect size is small.

## Constraints / notes

- **N=2 is small.** A single bad run shifts the median heavily. The 10% slack in pass criterion 1 reflects this. If the actual delta is large (>>20%), the gate is unambiguous; if it's marginal, expect to run more repeats or accept inconclusivity.
- **`/cost` reports cumulative session tokens, including any agent thinking before the user message.** For a fresh session this is small (~1-2k). Document this in the recorded numbers as `note: includes ~1-2k session-overhead tokens`. The cross-arm comparison still holds because the overhead is the same on both sides.
- **Claude Code prompt caching is on by default.** This is exactly the property the SDK loop in postmortem-001 lacked, and the reason this manual A/B is the right test instrument.
- **No automated harness in V0.4.** Building a `claude -p` driven harness that records `usage` from `--output-format json` is post-V0.4 work (probably V0.5 task 1). Until then, this manual procedure is the soft gate.

## Verification

The procedure itself (this document) is verified by running it for the V0.4 ship. The ADR 0008 "Manual Claude Code A/B result" block being filled in with real numbers is the proof.

If any step in "Procedure" is ambiguous or under-specified, treat it as a doc bug — open a follow-up to tighten before V0.5 (when the same procedure will be reused).

## Exit criterion

- The 4 sessions are run.
- The aggregated table is in ADR 0008 and in the V0.4 PR description.
- All three pass criteria are evaluated; the verdict is recorded explicitly.
- If the verdict is PASS, V0.4 merges. If FAIL or inconclusive, follow the matching "What to do" path above.

## Depends on

- Tasks 01–08 all complete (i.e., the bench passes; the e2e tests pass; the docs update lands).

## Estimated diff size

- ~50 lines of doc edits in the V0.4 PR description (the table + a paragraph naming the verdict).
- Zero LOC of code.
- ~30 min of human time per V0.4 ship gate.
