# Task 05 — `tsc` parser + renderer + cascade-dedup + did-you-mean

## Goal

Implement `tscFilter: Filter` (`src/filter/filters/tsc.ts`): a deterministic parser that turns `tsc --noEmit` output into `Finding[]`, applies a minimal cascade-dedup pass (00-decisions.md § 9b), surfaces `Did you mean` suggestions emitted by tsc, and renders the result as compact markdown using `path:line:col` location format. Snapshot-tested against the three Task 04 fixtures.

## Context recap

The dispatcher (Task 02) calls a `Filter` with `{ stdout, stderr, exitCode, signal, durationMs }`. For `tsc`, diagnostics typically land on stdout (occasionally stderr depending on the wrapper). The parser ingests `stdout + stderr` concatenated (the on-disk `combined.log` shape) and emits one `Finding` per diagnostic.

`Finding` (`src/core/finding.ts:13`) requires: `id`, `severity`, `title`, `description`, `excerpts: EvidenceExcerpt[]`, `evidenceRefs: EvidenceRef[]`, optional `relatedFiles: string[]`. The schema is fixed; this task fills it out.

Decisions doc § 10 mandates **information preservation**: every `(file, line, ruleId)` triple in raw output must appear verbatim in the rendered markdown. The renderer is a deterministic projection, not a summary.

## Files touched

Module layout is split by concern from day 1 (00-decisions.md § 11). Even at ~280 LOC, splitting now beats refactoring later:

- `src/filter/filters/tsc/index.ts` — created (~30 LOC). Exports `tscFilter: Filter`. Glue only.
- `src/filter/filters/tsc/version.ts` — created (~3 LOC). Exports `TSC_FILTER_VERSION = "tsc/1"`.
- `src/filter/filters/tsc/parser.ts` — created (~80 LOC). Exports `parseTscOutput`, `parseTscOutputWithStats`, `TscDiagnostic`, `ParseStats`.
- `src/filter/filters/tsc/cluster.ts` — created (~30 LOC). Exports `clusterDiagnostics`, `TscCluster`.
- `src/filter/filters/tsc/render.ts` — created (~70 LOC). Exports `renderTscMarkdown`.
- `tests/filter-tsc-parser.test.ts` — created.
- `tests/filter-tsc-cluster.test.ts` — created.
- `tests/filter-tsc-render.test.ts` — created (snapshot tests against the three fixtures).
- `src/filter/filters/tsc/__fixtures__/snapshots/` — created at first test run (Bun's snapshot dir convention; track in git).

## Interface / API change

```ts
// src/filter/filters/tsc.ts
import type { Filter } from "../types.ts";

export const tscFilter: Filter;
export const TSC_FILTER_VERSION = "tsc/1";  // recorded in observation.json.filterVersion

// Visible for tests:
export type TscDiagnostic = {
  file: string;          // path verbatim from output
  line: number;
  column: number;
  severity: "error" | "warning" | "info";
  ruleId: string;        // e.g. "TS2304"
  message: string;       // first line of the diagnostic message
  continuation: string;  // remaining indented lines joined with \n; "" if none
  suggestion?: string;   // extracted from `Did you mean 'X'?` patterns; undefined otherwise
};

export type TscCluster = {
  ruleId: string;
  normalizedMessage: string;     // see 00-decisions § 9b
  members: TscDiagnostic[];      // ≥1; sorted by file then line
};

export function parseTscOutput(text: string): TscDiagnostic[];
export function clusterDiagnostics(diags: TscDiagnostic[]): TscCluster[];   // see 00-decisions § 9b
export function renderTscMarkdown(clusters: TscCluster[], opts: { command: string; durationMs: number; exitCode: number | null }): string;

// Diagnostic — total raw bytes / lines that did NOT match any parser rule.
// Surfaced via the `parserCoverage` field in the bench's preservation gate.
export type ParseStats = { linesTotal: number; linesParsed: number };
export function parseTscOutputWithStats(text: string): { diags: TscDiagnostic[]; stats: ParseStats };
```

## Implementation notes

**Parser — regex over stripped-ANSI text:**

```
^(?<file>[^\s(][^(]*?)\((?<line>\d+),(?<col>\d+)\):\s+(?<sev>error|warning|info)\s+(?<rule>TS\d+):\s+(?<msg>.*)$
```

- ANSI-strip first: `text.replace(/\x1b\[[0-9;]*m/g, "")`.
- Iterate lines. For each match, start a new diagnostic; subsequent indented lines (regex `^\s{2,}`) append to the current `continuation` (NOT `message`) until the next match or blank line.
- Lines that don't match and aren't continuation are *counted* (towards `ParseStats.linesTotal`) but dropped from output. The bench's parser-coverage gate (decisions § 10) catches the case where < 85% of input lines parsed.
- The `Found N errors in M files` summary line is dropped; renderer regenerates from `diags.length`. (Counted as parsed for coverage purposes via a dedicated regex match.)

**Pretty-mode detection.** If at least one input line matches the pretty regex `^[^\s].*?:\d+:\d+\s+-\s+(error|warning)\s+TS\d+:` and ZERO lines match the non-pretty regex above, treat as pretty mode and **return zero findings** (parser coverage will be 0%, the bench will mark it failed, and the dispatcher will fall through to passthrough — the agent gets the raw pretty output instead of a wrong "tsc — pass" header). Document `--pretty` as unsupported in V0.4.

**Severity mapping:** `error → "error"`, `warning → "warning"`, anything else (rare for tsc) → `"info"`.

**`Did you mean` extraction.** When the message text matches `/Did you mean ['"]([^'"]+)['"]\s*\?$/`, extract the captured group as `diag.suggestion` and strip the suggestion clause from `diag.message` so it isn't duplicated in the rendered bullet. The renderer surfaces it on a continuation line:

```
- **TS2551** src/user.ts:3:38 — Property 'firstNme' does not exist on type 'User'
  💡 Did you mean 'firstName'?
```

(The hint icon is the only emoji in the renderer; emoji exception justified because the visual cue is the entire point of surfacing this as a separate line.)

**Finding shape produced from a TscDiagnostic:**

```ts
{
  id: `tsc-${idx}`,
  severity: diag.severity,
  title: `${diag.ruleId}: ${diag.message.split("\n")[0].slice(0, 120)}`,
  description: diag.continuation ? `${diag.message}\n${diag.continuation}` : diag.message,
  excerpts: [{
    ref: { path: ".mira/runs/${runId}/combined.log", kind: "combined" },
    text: original-line(s) verbatim,
    lineStart, lineEnd,  // line numbers within combined.log
  }],
  evidenceRefs: [{ path: ".mira/runs/${runId}/combined.log", kind: "combined" }],
  relatedFiles: [diag.file],
}
```

**Findings reflect pre-cluster diagnostics.** `Finding[]` keeps one entry per parsed diagnostic — the cascade-dedup pass acts on the renderer, not on the persisted `findings`. Reasoning: future cross-run diff (Axis 3) needs to compare individual findings; clustering is a presentation concern. `findings.length` and the rendered bullet count diverge by design when a cluster fires.

The dispatcher passes `ctx.runId`, so paths resolve correctly. `combined.log` is the existing file written by the observer.

**Cascade-dedup pass (`clusterDiagnostics`):**

Per 00-decisions.md § 9b. Implementation outline:

```ts
export function clusterDiagnostics(diags: TscDiagnostic[]): TscCluster[] {
  const buckets = new Map<string, TscDiagnostic[]>();
  for (const d of diags) {
    const norm = d.message.replace(/'[^']+'/g, "<x>");
    const key = `${d.ruleId}::${norm}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(d);
    buckets.set(key, bucket);
  }
  const clusters: TscCluster[] = [];
  for (const [key, members] of buckets) {
    const [ruleId, normalizedMessage] = key.split("::", 2) as [string, string];
    members.sort((a, b) =>
      a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)
    );
    clusters.push({ ruleId, normalizedMessage, members });
  }
  // Sort: descending size, then ruleId asc, then first-member path asc.
  clusters.sort((a, b) =>
    b.members.length - a.members.length ||
    a.ruleId.localeCompare(b.ruleId) ||
    a.members[0]!.file.localeCompare(b.members[0]!.file)
  );
  return clusters;
}
```

~25 LOC. No new dependency.

**Renderer — markdown shape (SOTA: copy-pastable locations, cluster-aware, semantic-preserving):**

```md
# tsc — 12 errors in 3 files (1240ms)

- **TS2739** ×8 — same shape: Type X is missing properties Y, Z from type T
  e.g. src/foo.ts:34:7 — Type '{ x: number; }' is missing the following properties from type 'Point': y, z
  also: src/foo.ts at 52:14; src/bar.ts at 67:3, 89:21; src/baz.ts at 102:5, 118:9; src/qux.ts at 134:12, 156:8
- **TS2551** src/user.ts:3:38 — Property 'firstNme' does not exist on type 'User'
  💡 Did you mean 'firstName'?
- **TS2304** src/foo.ts:14:9 — Cannot find name 'Bar'
- **TS2345** src/baz.ts:9:3 — Argument of type '{ name: string; }' is not assignable to parameter of type '{ name: string; age: number; }'
  Property 'age' is missing in type '{ name: string; }' but required in type '{ name: string; age: number; }'
```

Format rules:

- **Header line.** `# tsc — N errors in F files (Tms)` for failures, or `# tsc — pass (Tms)` when no findings. `N` = total diagnostics (sum of cluster sizes); `F` = unique files across all members.
- **No `## <file>` section headers.** Single-finding bullets and the cluster `e.g.` exemplar use the inline `<path>:<line>:<col>` form so the agent can copy-paste one location into VS Code, Claude Code's `read` tool, ripgrep, or any editor's "go to file:line" affordance. The cluster `also:` line uses a grouped form (below).
- **Single-finding bullet (cluster size 1).** `- **TSxxxx** <path>:<line>:<col> — <message>`. If `continuation` is non-empty, include it on the next line indented by 2 spaces (truncate to 240 chars per continuation, suffix with `…` when truncated). If `suggestion` is non-empty, render as `  💡 Did you mean '<X>'?` on its own indented line.
- **Cluster bullet (cluster size ≥ 2).** Three lines:
  1. `- **TSxxxx** ×N — same shape: <human-readable template>` — substitute `<x>` placeholders with capital letters X, Y, Z, T, U, V, W in order of first occurrence (max 7; deeper structures keep `<x>`).
  2. `  e.g. <path>:<line>:<col> — <verbatim message of cluster.members[0]>` — first cluster member, full original message text.
  3. `  also:` followed by `members[1..]` **grouped by file**. Each group is `<path> at <line>:<col>, <line>:<col>, …`; groups are separated by `; `. Within a group, locations sort by line ascending; across groups, by path ascending. When all remaining members share one file, render `also: <path> at <line>:<col>, …` (single group, no separator). When the cluster has exactly 2 members, the `also:` line carries one group with one location.
- **Ordering.** Per `clusterDiagnostics` output order: clusters sorted by descending size, then ruleId asc, then first-member path asc. `cluster.members` itself is sorted by `(file asc, line asc)` so that `members[0]` (the exemplar) is deterministic and the `also:` line's per-file groups appear in path-asc order.
- **No trailing newline magic** — `view.markdown` ends with `\n` exactly once.

**Pass case rendering:** when `parseTscOutput` returns `[]`, render `# tsc — pass (Tms)\n`. The bench will not test compression on pass cases (raw output is already trivial), but the contract must be defined.

**Information preservation in the renderer:**

- Single-finding bullets preserve `(file, line, col, ruleId)` ✓ and the message body (truncated, never dropped) ✓.
- Cluster bullets preserve `(file, line, col, ruleId)` for each member ✓ AND a verbatim message of the first member as exemplar ✓ AND the structural template ✓. `members[0]` lives on the `e.g.` line in inline `<path>:<line>:<col>` form; `members[1..]` live on the `also:` line in grouped `<path> at <line>:<col>, …` form. Both shapes are byte-extractable by the bijection walker (decisions § 10 gate d). The remaining members' messages are NOT inlined — but they are byte-identical (after normalization) to the exemplar by construction (cluster invariant), so the agent loses no actionable info. Raw verbatim messages remain in `combined.log` one read away.
- The bench's four preservation gates (decisions § 10) catch a regression where any of these guarantees breaks (incl. the bidirectional gate that asserts every triple — inline OR grouped — maps back to a parsed finding).

**No external dependencies.** Pure regex + string ops. No `chalk` for ANSI stripping, no `parse-tsc-output` from npm. The regex is committed and tested.

**ID generation:** `tsc-${idx}` where `idx` is the 0-based index in parse order. Determinism > uniqueness across runs (the runId in the path makes them globally unique anyway).

**Performance.** ANSI strip + line scan is O(n) on input length. For a 600-line large fixture, expect <5ms. The bench (Task 07) measures p95.

## Verification

Test name: `tests/filter-tsc.test.ts`.

Coverage:

1. **Snapshot test on each fixture.** For each of `small.txt`, `medium.txt`, `large.txt`:
   - Parse → `TscDiagnostic[]`.
   - Render → markdown.
   - Snapshot the rendered markdown via Bun's snapshot facility.
   - Assert `diags.length` equals the expected count documented in `src/filter/filters/tsc/__fixtures__/README.md`.

2. **Information preservation invariant.** Three sub-checks per fixture:
   - (a) **Triple coverage.** For each parsed diagnostic, assert the rendered markdown contains the substring `${file}:${line}:${col}` AND the substring `**${ruleId}**` somewhere in the output.
   - (b) **Message-body coverage.** For each parsed diagnostic NOT belonging to a cluster of size ≥2, assert that the message body (or its truncated form ending in `…`) appears in the markdown. Cluster members are exempt — their messages are normalized into the cluster bullet by design.
   - (c) **Parser line coverage.** Assert `linesParsed / linesTotal ≥ 0.85` per fixture.

3. **Pass case.** Parse `""` → `[]`; render → starts with `# tsc — pass`.

4. **ANSI-stripped input matches non-ANSI.** Wrap a fixture line in ANSI escapes; assert parser produces the identical diagnostic.

5. **Filter-level integration.** Call `tscFilter({ stdout: fixture, stderr: "", exitCode: 1, durationMs: 1234 }, { command: "tsc --noEmit", cwd: "/x", runId: "run_test" })` and assert:
   - Returned `findings.length` matches parsed count.
   - Returned `markdown` starts with `# tsc —`.
   - Each `Finding.excerpts[0].ref.path` includes `run_test`.

```bash
bun test tests/filter-tsc.test.ts
```

## Exit criterion

- All assertions in 1-5 above pass.
- Snapshots committed under `src/filter/filters/tsc/__fixtures__/snapshots/` (or wherever Bun stores them — verify in the test output and add to git).
- `bun tsc --noEmit` green.
- No new dependencies in `package.json`.

## Depends on

- Task 01 — types
- Task 04 — fixtures

## Estimated diff size

~280 lines split across the day-1 file layout (00-decisions.md § 11):

| File | LOC |
|---|---:|
| `src/filter/filters/tsc/index.ts` (glue) | ~30 |
| `src/filter/filters/tsc/version.ts` | ~3 |
| `src/filter/filters/tsc/parser.ts` | ~80 |
| `src/filter/filters/tsc/cluster.ts` | ~30 |
| `src/filter/filters/tsc/render.ts` | ~70 |
| Tests (3 files) | ~100 |

No file > 250 LOC (quality bar #2). No function > 40 LOC (#3).
