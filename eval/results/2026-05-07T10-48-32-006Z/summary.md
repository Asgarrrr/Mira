# Mira eval — first experiment summary

| scenario | baseline median | mira median | Δ% | baseline success | mira success | mira tools (top 3) | verdict |
|---|---:|---:|---:|---:|---:|---|---|
| A1 | 120218 | 137638 | +14.5% | 100% | 100% | bash(19), read(10), generate_context_pack(3) | Loss |
| A2 | 74140 | 156623 | +111.3% | 100% | 100% | read(12), bash(11), get_raw_evidence(6) | Loss |
| A3 | 33510 | 47361 | +41.3% | 100% | 67% | read(5), get_raw_evidence(4), run_command(4) | Loss |
| B1 | 73687 | 102774 | +39.5% | 100% | 100% | read(17), run_command(9), bash(6) | Loss |

## Verdict

Global: **Loss** (Win=0, Loss=4, Neutral=0, scenarios=4)

> Note: B1 is the scenario where Mira's structural advantage is expected to be most visible. A B1 Loss alone is enough to question the hypothesis even if A1–A3 land Neutral.

## Honesty axis

- N=3 per cell — one bad run shifts the median, so close calls should not be over-read.
- Synthetic scenarios know the answer; over-suggestive task wording can leak it.
- Mira's opt-in advantage only materializes when the agent chooses to skip raw fetches; if Sonnet always fetches everything, Wins won't surface on a single-shot task.
- A1–A3 run on Mira's own small codebase, where context selection has little room to differentiate. B1 has more headroom (large typecheck output).
- SDK-level token accounting may diverge from production tools (cache reads, etc.). The harness itself is the instrument; if it is wrong, every result is wrong.

---
_resultsDir: `/Users/asgarrrr/Documents/Projects/Mira/eval/results/2026-05-07T10-48-32-006Z` · generated: 2026-05-07T12:36:00.499Z_
