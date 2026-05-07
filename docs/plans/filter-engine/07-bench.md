# Task 07 — Bench: tokenizer-based, 3 preservation gates

## Goal

Implement `bench/filter/tsc.ts` — a runnable script that measures the `tsc` filter on the three Task 04 fixtures and asserts the V0.4 hard-gate pass criteria: tokenizer-based compression ratio + absolute tokens-saved floor, three information-preservation gates, and parse+render latency.

## Context recap

Decisions doc § 10 binds V0.4 to:

| Criterion | Threshold |
|---|---|
| Median compression ratio (tokens, via committed `tokens.json`) | ≤ 0.30 |
| Absolute tokens saved on B1 fixture | ≥ 800 |
| Triple coverage (forward) | 100% of parsed `(file, line, ruleId)` triples present |
| Message-body coverage | every non-cluster message body reachable in markdown (truncation OK); cluster exemplar verbatim |
| Parser line coverage | `linesParsed / linesTotal ≥ 0.85` per fixture |
| Bijection (reverse) | every `(file, line, ruleId)` in markdown maps back to a parsed finding |
| Token-count drift vs committed `tokens.json` | ≤ 5% per fixture |
| Trend regression vs last committed `bench/results/*.json` | ≤ 10% ratio drift per fixture |
| Parse + render + dedup p95 | ≤ 30ms on the largest fixture |

The bench is the **hard gate**. The soft gate is Task 09 (manual Claude Code A/B). The bench measures *filter* token economy as a proxy for what an agent will see; the soft gate measures *what the agent actually consumes* with the real client, including prompt caching and tool descriptions.

## Files touched

- `bench/filter/tsc.ts` — created.
- `package.json` — edited (add `"bench:filter:tsc": "bun bench/filter/tsc.ts"`).
- `bench/README.md` — created (one paragraph: what `bench/` is, how it differs from `tests/` and `eval/`).
- `bench/results/.gitkeep` — created (the trend-tracking directory; per-run JSON results land here).

**No new runtime dependency for tokenization.** Token counts are read from the committed `src/filter/filters/tsc/__fixtures__/tokens.json` (Task 04), itself produced via `anthropic.messages.count_tokens` at fixture capture time. The bench is fully offline at run time.

## Interface / API change

```bash
bun bench/filter/tsc.ts            # exits 0 on pass, non-zero on any failed criterion
bun run bench:filter:tsc           # via package.json script
```

No exported API.

## Implementation notes

**Script structure:**

```ts
// bench/filter/tsc.ts
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { dispatchFilter } from "../../src/filter/dispatch.ts";
import { parseTscOutputWithStats, clusterDiagnostics } from "../../src/filter/filters/tsc/parser.ts";

const FIXTURE_DIR = join(import.meta.dirname, "..", "..", "src", "filter", "filters", "tsc", "__fixtures__");
const RESULTS_DIR = join(import.meta.dirname, "..", "results");
const FIXTURES = ["small.txt", "medium.txt", "large.txt"];

// Load committed authoritative token counts (Task 04, captured via Anthropic's
// `messages.count_tokens`). The bench never calls the API itself.
const TOKENS = JSON.parse(readFileSync(join(FIXTURE_DIR, "tokens.json"), "utf8"));

type Row = {
  fixture: string;
  tokensIn: number;             // from tokens.json (raw)
  tokensOut: number;            // from tokens.json (filtered_expected) AND verified against actual render
  tokensOutDriftPct: number;    // |actual - expected| / expected — must be < 5%
  ratio: number;
  tokensSaved: number;
  findings: number;
  triplePass: boolean;          // gate (a)
  bodyPass: boolean;            // gate (b)
  parserCoverage: number;       // gate (c) actual
  coveragePass: boolean;        // gate (c) ≥ 0.85
  bidirectionalPass: boolean;   // gate (d) every bullet maps back to a finding
  parseRenderMs: number;
};

function benchOne(name: string): Row { /* ... */ }

const args = new Set(process.argv.slice(2));
const jsonOut = args.has("--json");
const rows = FIXTURES.map(benchOne);

const result = checkCriteria(rows);
const trendCheck = checkTrend(rows);  // compares to last committed bench/results/*.json

if (jsonOut) {
  process.stdout.write(JSON.stringify({ rows, ...result, trendCheck }, null, 2) + "\n");
} else {
  printTable(rows);
  printVerdict(result, trendCheck);
}

// Persist this run's result so future runs can compare. Always write.
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(join(RESULTS_DIR, `${stamp}.json`), JSON.stringify({ rows, result, trendCheck }, null, 2));

process.exit(result.passed && trendCheck.passed ? 0 : 1);
```

**`benchOne` per fixture:**

1. Read `src/filter/filters/tsc/__fixtures__/<fixture>` as `raw`.
2. Invoke via the dispatcher (so wrapper-stripping path is exercised in the bench too):
   `dispatchFilter("pnpm tsc --noEmit", { stdout: raw, stderr: "", exitCode: 2, durationMs: 0 }, { command: "pnpm tsc --noEmit", cwd: ".", runId: "bench" })`.
   The `pnpm` prefix forces the dispatcher to actually strip a wrapper before lookup. (REVIEW.md K.2.)
3. Time the dispatch + render call (use `performance.now()`; run **5** times and take p95 to smooth jitter).
4. **Token counts.** Read from `TOKENS.fixtures[fixture].raw` (committed) and `TOKENS.fixtures[fixture].filtered_expected` (committed). Then re-render locally and call a small approximate counter (`Buffer.byteLength` ÷ 4 as a rough heuristic — used ONLY for drift detection, not for the ratio itself) to compute `actual_filtered_tokens_estimate`. Drift = `|estimate - filtered_expected| / filtered_expected`. If drift > 5%, the renderer changed since the last `tokens.json` capture — fail with a message instructing to re-run `bun scripts/capture-tokens.ts`.
5. **Gate (a) — triple coverage (forward).** Re-parse the raw fixture (`parseTscOutputWithStats`), iterate diagnostics, assert each `${file}:${line}:${col}` substring AND `**${ruleId}**` substring appear somewhere in `view.markdown`.
6. **Gate (b) — body coverage.** For each diagnostic NOT in a cluster of size ≥2, assert the message body's first 60 chars (or its truncated `…`-suffixed form) appears in `view.markdown`. For cluster members [0] (the exemplar), assert verbatim message text appears.
7. **Gate (c) — parser line coverage.** Read `stats.linesParsed / stats.linesTotal`; pass if ≥ 0.85.
8. **Gate (d) — bijection (reverse).** Extract `(file, line, col)` triples from `view.markdown` via `extractMarkdownTriples` (a small walker, ~15 LOC, lives next to `benchOne`). The walker handles two shapes per 00-decisions.md § 9b:
   - **Inline shape** — single-finding bullets and cluster `e.g.` exemplars: line-level regex `/(?:\*\*TS\d+\*\*|e\.g\.) (\S+):(\d+):(\d+)/`.
   - **Grouped shape** — cluster `also:` lines: split the line on `; ` to get per-file groups, parse each group as `<path> at (\d+:\d+(?:, \d+:\d+)*)`, and emit one triple per `<line>:<col>` token associated with the group's path.

   Build the result `Set<\`${file}:${line}:${col}\`>` and assert set-equality against the Set built from parsed Findings. Catches renderer hallucinations (wrong cluster count, off-by-one in either form, copy-paste in template substitution). Walker has its own unit test in `tests/filter-tsc-render.test.ts` so the bench's failure modes are bounded to "parser disagrees with renderer", not "regex bug in the bench".
9. **Exit code:** the bench feeds `exitCode: 2` (real tsc exits 2 on errors).
10. Return a `Row`.

**Trend check (`checkTrend`):**

Walk `bench/results/*.json` newest-first; pick the most recent file. For each fixture, compute `|current_ratio - prev_ratio| / prev_ratio`. If any drift > 10%, fail with a per-fixture diff. If `bench/results/` is empty, skip the trend check (first run on a fresh checkout).

```ts
function checkTrend(rows: Row[]): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!existsSync(RESULTS_DIR)) return { passed: true, reasons };
  const prior = readdirSync(RESULTS_DIR).filter(n => n.endsWith(".json")).sort().reverse();
  if (prior.length === 0) return { passed: true, reasons };
  const last = JSON.parse(readFileSync(join(RESULTS_DIR, prior[0]!), "utf8"));
  for (const r of rows) {
    const lastRow = last.rows?.find((x: { fixture: string }) => x.fixture === r.fixture);
    if (!lastRow) continue;
    const drift = Math.abs(r.ratio - lastRow.ratio) / lastRow.ratio;
    if (drift > 0.10) {
      reasons.push(`${r.fixture}: ratio drifted ${(drift * 100).toFixed(1)}% (was ${lastRow.ratio.toFixed(2)}, now ${r.ratio.toFixed(2)})`);
    }
  }
  return { passed: reasons.length === 0, reasons };
}
```

**Output table** (default, human-readable; printed to stdout):

```
| fixture    | tok_in | tok_out | drift | ratio | saved | findings | T | B | C    | bij | p95_ms |
|------------|-------:|--------:|------:|------:|------:|---------:|:-:|:-:|-----:|:---:|-------:|
| small.txt  |    93  |    32   | 0.0%  | 0.34  |   61  |    1     | ✓ | ✓ | 0.95 |  ✓  |   1.2  |
| medium.txt |   612  |   164   | 1.2%  | 0.27  |  448  |    9     | ✓ | ✓ | 0.91 |  ✓  |   3.1  |
| large.txt  |  4830  |   980   | 0.4%  | 0.20  | 3850  |   34     | ✓ | ✓ | 0.88 |  ✓  |  12.4  |

median ratio: 0.27
B1-fixture saved: 448 tokens   (warn: < 800 if marginal)
max p95: 12.4ms
preservation: 12/12 gate-fixture cells passed
trend vs 2026-05-06T08-12-09-Z: +1.4% / +0.7% / -0.3% (all within 10%)
verdict: PASS
```

`T` = triple-coverage (forward), `B` = body-coverage, `C` = parser-line coverage fraction, `bij` = bijection (reverse). `drift` = `|estimate - filtered_expected| / filtered_expected`.

**JSON output** (`--json` flag; emitted on stdout, table suppressed):

```json
{
  "schemaVersion": "bench-tsc-v1",
  "rows": [
    { "fixture": "small.txt", "tokensIn": 93, "tokensOut": 32, "ratio": 0.34,
      "tokensSaved": 61, "findings": 1, "triplePass": true, "bodyPass": true,
      "parserCoverage": 0.95, "coveragePass": true, "bidirectionalPass": true,
      "tokensOutDriftPct": 0.0, "parseRenderMs": 1.2 },
    ...
  ],
  "result": { "passed": true, "reasons": [] },
  "trendCheck": { "passed": true, "reasons": [], "comparedTo": "2026-05-06T08-12-09-Z.json" }
}
```

CI consumers parse the JSON; humans read the table. Both come from the same `Row[]` so they cannot diverge.

**`checkCriteria`:**

```ts
function checkCriteria(rows: Row[]): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];

  const sorted = rows.map(r => r.ratio).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 1;
  if (median > 0.30) reasons.push(`median ratio ${median.toFixed(2)} > 0.30`);

  const b1 = rows.find(r => r.fixture === "medium.txt");
  if (b1 && b1.tokensSaved < 800) reasons.push(`B1 tokens saved ${b1.tokensSaved} < 800`);

  for (const r of rows) {
    if (!r.triplePass)         reasons.push(`${r.fixture}: triple coverage failed`);
    if (!r.bodyPass)           reasons.push(`${r.fixture}: body coverage failed`);
    if (!r.coveragePass)       reasons.push(`${r.fixture}: parser coverage ${r.parserCoverage.toFixed(2)} < 0.85`);
    if (!r.bidirectionalPass)  reasons.push(`${r.fixture}: bijection failed (markdown contains triples not in findings, or vice versa)`);
    if (r.tokensOutDriftPct > 5)
      reasons.push(`${r.fixture}: token drift ${r.tokensOutDriftPct.toFixed(1)}% > 5% — re-run \`bun scripts/capture-tokens.ts\``);
  }

  const maxLatency = Math.max(...rows.map(r => r.parseRenderMs));
  if (maxLatency > 30) reasons.push(`max p95 ${maxLatency.toFixed(1)}ms > 30ms`);

  return { passed: reasons.length === 0, reasons };
}
```

If any criterion fails, the bench prints each failed reason on its own line (or emits them in `result.reasons` for `--json`) and exits non-zero. The output is greppable; CI logs surface the exact failure axis.

**No CI integration in V0.4.** The bench runs **manually** before merging the V0.4 PR. Adding it to CI is a follow-up. Reasoning: the bench's pass criteria reflect V0.4's specific threshold; once V0.5 adds a second filter, the criteria evolve. Auto-running risks pinning numbers prematurely.

**Trend tracking caveat.** Each bench run writes to `bench/results/<timestamp>.json`. The directory IS committed to git so the trend check has a baseline. To prevent unbounded growth, we keep at most the **last 20** result files (older ones deleted by a one-line script run at PR-prep time, or manually). 20 is plenty to spot regression trends across V0.4 + V0.5 + V0.6 PRs without bloating the repo.

> ASSUMPTION: `o200k_base` token counts track Claude tokenizer counts within ~15% on tsc output.
> Revision trigger: Task 09's manual Claude Code A/B shows the agent's actual token consumption diverges from the bench's `o200k_base` ratio by > 25% on the same fixture. Migrate to Anthropic's official tokenizer if/when published.

**Reproducibility.** The bench is fully deterministic: same fixtures, same parser, same render path. Re-running yields identical bytes (timings vary). This makes the verdict trustworthy across machines.

## Verification

```bash
bun bench/filter/tsc.ts          # human table
bun bench/filter/tsc.ts --json   # machine-readable for CI / scripts
```

Expected: prints the table (or JSON), ends with `verdict: PASS`, exits 0. A new file lands in `bench/results/<timestamp>.json` regardless of pass/fail (trend baseline for next run).

To verify failure handling, temporarily worsen the renderer (e.g. add debug noise) and confirm the bench exits non-zero with the failing criterion identified. Revert before commit.

To verify the trend check, manually edit a recent `bench/results/*.json` to set `rows[i].ratio = 0.10` (artificially good prior result), then re-run the bench: it should fail with `<fixture>: ratio drifted XX% (was 0.10, now 0.27)`. Restore the file before commit.

## Exit criterion

- Bench runs and exits 0 with all hard-gate criteria met against committed fixtures.
- Output table is human-readable; `--json` produces structured output with the same `Row[]`.
- Bench can be re-run from scratch (`rm -rf node_modules; bun install; bun bench/filter/tsc.ts`) without any extra setup or network.
- `package.json` has the `bench:filter:tsc` script entry.
- `bench/results/` exists with a `.gitkeep` and at least one initial result committed (so the trend check has a baseline for V0.5+).

## Depends on

- Task 05 — `tscFilter` implementation

## Estimated diff size

~240 lines (~200 LOC bench, ~5 LOC `package.json`, ~30 LOC `bench/README.md`, plus `bench/results/.gitkeep` + 1 initial baseline result). Bench grows over the previous estimate because of: 4 preservation gates (incl. bidirectional), trend regression check, JSON output mode, drift detection vs committed `tokens.json`.
