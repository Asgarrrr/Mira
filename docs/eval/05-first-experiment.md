# 05 — First experiment

## Configuration

| Knob | Value | Why |
|---|---|---|
| Scenarios | A1, A2, A3, B1 (see [`04-scenario-corpus.md`](./04-scenario-corpus.md)) | A1–A3 calibrate on small bug-fix tasks; B1 probes the structural opt-in advantage on a verbose typecheck failure |
| Modes | `baseline`, `mira` | The two we're comparing |
| Repeats | 3 | Smallest N that produces a median |
| Total runs | 4 × 2 × 3 = **24** | |
| Model | Sonnet 4.6 (default; Opus 4.7 optional) | Cost — 24 Opus runs would multiply the bill ~3× |
| Temperature | 0 | Reduce variance |
| Max turns / run | 30 | Cap iteration |
| Token cap / run | 200,000 | Cost guard |
| Wall-clock cap / run | 600s | Cost guard |
| Cost ceiling (total) | ~$20 (Sonnet) / ~$60 (Opus) | Estimate; harness aborts if exceeded |

## Implementation tasks (post-design)

These are sub-tasks for follow-up PRs. *This* PR only writes this design document. Implementation begins after the design is approved.

### Sub-task i — Harness scaffold

- Create `eval/package.json` with `@anthropic-ai/sdk` dep
- Create `eval/harness/agent.ts` with the loop described in [`03-harness-design.md`](./03-harness-design.md)
- Create the four baseline tool wrappers (`bash`, `read`, `write`, `grep`)
- Create the Mira MCP wrapper (`mira-mcp.ts`) using `createMiraMcpServer()` and `InMemoryTransport`
- **Smoke test (harness validation only — does NOT test Mira's value):** launch the agent on a trivial in-prompt task ("write 'hello world' to `<workdir>/hello.txt`") in baseline mode, then in mira mode. The smoke test's only purpose is to confirm the agent loop, the tool wrappers, and the MCP forwarding all work end-to-end. It says **nothing** about whether Mira helps an agent do real work — that's what the scenarios in sub-tasks ii–vi are for.

### Sub-task ii — Scenario format + checker

- Define the `Scenario` type (id, base.patch path, task.txt path, success.sh path)
- Implement `applyScenario(workdir, scenario)`: clone repo into workdir, apply patch, return new workdir
- Implement `checkScenario(workdir, scenario)`: spawn `success.sh`, return exit code
- Test on a single scenario in isolation before plugging into the agent loop

### Sub-task iii — Build A1, A2, A3, B1

- For each scenario:
  - Identify the precise line(s) to change (per [`04-scenario-corpus.md`](./04-scenario-corpus.md))
  - For A1: write the new rename-status test in `tests/architecture-signal.test.ts` first (and make sure it passes on the fixed code)
  - Generate `base.patch` from a clean state by manually breaking the line, then `git diff > base.patch`
  - Verify `git apply base.patch` cleanly applies and the failing test fails
  - Verify `git apply --reverse base.patch` cleanly returns to good state
  - Write `task.txt` with no leading hints about file location
  - Write `success.sh` that runs the right `bun test` / `bun run typecheck` command
  - Write `README.md` with bug summary, ground-truth fix location, and hypothesis
- For B1 specifically: confirm the typecheck error count is large (≥ ~10 errors) so the in-prompt-vs-opt-in distinction has room to manifest

### Sub-task iv — Run baseline pass

- 4 scenarios × 3 repeats = 12 baseline runs
- Save transcripts and metrics under `eval/results/<timestamp>/`

### Sub-task v — Run Mira-augmented pass

- 12 mira runs
- Save under same `<timestamp>` directory as iv so they're paired

### Sub-task vi — Aggregate and report

- `eval/harness/report.ts` reads all `metrics.json` files, produces `summary.md`
- Table rows = scenarios, columns = (baseline median tokens, mira median tokens, delta %, baseline success rate, mira success rate, mira tool histogram)
- Verdict per scenario per [`02-thesis-and-metrics.md`](./02-thesis-and-metrics.md) decision rules
- Overall verdict + honest caveats

## Go / no-go gates

The first experiment is **go** when:
- Sub-tasks i–iii are complete
- Pre-flight: a single dry-run scenario completes end-to-end without harness errors, in both modes
- Cost estimate confirms ≤ ceiling

The first experiment is **no-go** if:
- The harness itself doesn't converge on the trivial smoke-test task — that means the agent loop is broken before we even compare modes

## Reporting

- Output: `eval/results/<timestamp>/summary.md`, committed back into the branch (or attached to the PR)
- Raw transcripts (`transcript.jsonl`) are kept — they're worth more than the aggregate, because they show *how* the agent reasoned with each toolset
- Whatever the verdict, write a short post-mortem in `docs/eval/postmortem-001.md` covering: surprising tool patterns, harness limitations surfaced, decisions for the next iteration

## After the first experiment

If the verdict is mixed or unclear, the next iteration is **not** "more scenarios". It's:
1. Read the transcripts
2. Find the surprising tool-call pattern (or absence)
3. Decide whether the next iteration is: (a) different scenarios, (b) different system prompt, (c) fix a Mira bug surfaced by the run, (d) abandon and re-think

The eval is a feedback loop, not a benchmark. Each round should change something downstream.
