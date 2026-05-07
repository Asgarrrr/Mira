# 00 — Architectural decisions

Each section: the question, the position, the reasoning. Decisions are binding; assumptions are flagged with `> ASSUMPTION:` and a revision trigger.

---

## 1. Where the filter sits in the `mira run` pipeline

**Position.** Post-process, after buffered capture, inside `runCommand` (`src/cli/run.ts`). The dispatcher fires between `store.writeObservationJson(...)` and `process.stdout.write(stdout)`.

**Why.** V0 invariants forbid streaming (`docs/architecture.md` § Design constraints, ADR 0001). Buffered output is already a domain fact: `CommandObserver.observe()` returns `stdout` and `stderr` as strings (`src/command/command-observer.ts:106`). Inserting the filter at the print-out boundary needs **one** insertion point, no changes to the observer, no changes to the evidence store.

**Latency.** A regex-driven parser over a few-hundred-line buffer is <30ms p95 (matches the budget the observation-pipeline doc already quotes). Negligible against shell process launch + run time.

**Memory.** No new memory cost. The buffer already exists. The filter consumes it.

**Rejected alternative.** Streaming (filter-as-a-line-pipe). Would force tearing apart `CommandObserver`, contradicts the V0 streaming invariant, and adds zero value at this stage — the filter design must work with buffered input first; streaming becomes meaningful only when long-running commands matter (out of scope per `docs/observation-pipeline.md` § "Open questions").

---

## 2. Filter data model

**Position.**

```ts
type FilterContext = { command: string; cwd: string; runId: string };

type FilterInput = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: string;
  durationMs: number;
};

type FilteredView = {
  findings: Finding[];          // existing src/core/finding.ts type, persisted in CommandObservation.findings
  markdown: string;             // what the agent reads on stdout
};

type Filter = (input: FilterInput, ctx: FilterContext) => FilteredView;
```

**What the agent receives.** Stdout is replaced by `view.markdown`. Stderr is suppressed when a filter fires (the markdown is the unified view of both streams). Exit code is preserved verbatim. Raw `stdout.log` / `stderr.log` / `combined.log` remain on disk under `.mira/runs/<id>/` — unchanged invariant from ADR 0001.

**Why both `findings[]` and `markdown`.** `findings[]` is the structured artifact other Mira features compose on (cross-run diff, cascade dedup, MCP insight tools — `docs/observation-pipeline.md` Axes 1+3). `markdown` is what the agent's tool-result rendering displays today; we cannot ship a typed surface without a render step. Returning both means the parser writes `Finding[]` once and the renderer is a deterministic projection.

**Findings round-trip through existing schema.** `CommandObservation.findings: Finding[]` already exists in `src/core/command-observation.ts:24` and is currently always set to `[]`. Filling it costs zero schema migration.

---

## 3. Command detection

**Position.** Strip a small set of wrappers, then dispatch on the first remaining token.

**Wrapper list (canonical, leading tokens consumed):**

- `pnpm`, `pnpm run`, `pnpm exec`, `pnpm dlx`
- `npm`, `npm run`, `npm exec`, `npx`
- `yarn`, `yarn run`, `yarn dlx`
- `bun`, `bun run`, `bun x`
- environment prefixes: leading `VAR=value` assignments

The stripper consumes the wrapper tokens (and their leading flags like `--silent`) and returns the underlying program name. Lookup is `O(1)` against the registry.

**Why first-token, not regex on the full command.** Regexes on the full command line are notoriously brittle (`docs/observation-pipeline.md` § Open questions implicitly notes RTK uses regex per-command and pays a maintenance tax). First-token matching is cheap, deterministic, and inspectable.

**False-positive risk.** Effectively zero. After stripping wrappers, the first token must literally equal a registered program name. A user-named local script called `tsc` would be mis-matched — but that is an edge case we accept (and would also be mis-handled by `which tsc`).

**False-negative risk.** A novel wrapper (e.g. `corepack pnpm exec tsc`) yields a miss → passthrough. No harm; just no benefit.

> ASSUMPTION: the wrapper list above is exhaustive enough for V0.4.
> Revision trigger: bench fixture testing reveals a real-world wrapper shape that misses (e.g. `dotenv -- tsc`); add it to the strip list.

---

## 4. Registry shape

**Position.** A bare `Map<string, Filter>` keyed by canonical program name.

```ts
const REGISTRY: Map<string, Filter> = new Map([
  ["tsc", tscFilter],
]);
```

That is the entire registry in V0.4. No metadata, no priority, no plugin loader, no JSON config. Adding a filter = one line.

**Why not `{ matcher, filter }[]`?** Matchers add power Mira does not need at this stage (the pilot has one filter; the second filter, when it lands, will key on a single program name too). YAGNI.

**Why not a plugin system?** ADR 0001 invariants forbid broad plugin systems in V0; ADR 0006 reaffirms it for the MCP boundary. The same logic applies here: a registry is not a plugin layer because consumers cannot register handlers from outside. The registry is hard-coded and lives in `src/filter/registry.ts`.

---

## 5. Generic fallback filter

**Position.** **Identity passthrough.** When no specific filter matches, the agent receives the raw output unchanged.

**Why no clever fallback.** Three reasons:

1. **Signal hygiene.** A clever generic filter (dedup repeated lines, first/last N, keep `error|warn|fail`) would silently transform output for every command, including ones we have not measured. That makes the bench in Phase 3 unreadable: we could not tell whether a regression is from the pilot filter or from generic behavior.
2. **Mira is not "shorter output"** (`docs/non-goals.md` § "Not a port of RTK"). The thesis is *traceable command understanding*, not generic compression. A generic dedupper drifts toward RTK without earning the typed `Finding[]` payoff.
3. **Reversibility.** A generic filter is a one-way mutation of the agent's view. Adding it later is easy; removing it once shipped is hard. Defer.

**Graceful degradation.** When a registered filter throws, the dispatcher catches the exception and falls back to passthrough. Identity is the only safe default.

---

## 6. Composition with evidence

**Position.** Raw evidence is untouched. The filtered view is persisted alongside, and `findings[]` flows through the existing observation.

**Files written per filtered run:**

```txt
.mira/runs/<run-id>/
  stdout.log         (unchanged — raw)
  stderr.log         (unchanged — raw)
  combined.log       (unchanged — raw)
  metadata.json      (unchanged)
  observation.json   (existing — `.findings` is now populated, plus `filterVersion: "tsc/1"` field)
  observation.md     (unchanged — buildSummary stays one-line)
  filtered.md        (NEW — what the agent saw on stdout, for audit)
```

**`filterVersion` field.** When a filter fires, `observation.json` carries `filterVersion: "<program>/<schema-version>"` (e.g. `"tsc/1"`). This unblocks Axis 3 (diff-on-rerun) in V0.5+: re-rendering an old run with `tsc/2` against `combined.log` and diffing against the persisted `tsc/1` markdown is a content-addressable operation. Cost: 1 line in the schema (`filterVersion: z.string().optional()`), one assignment in `runCommand` post-mutation. No migration cost — existing observations have no `filterVersion` and the schema is `.optional()`.

**Why a separate `filtered.md`.** Three reasons:

1. **Audit.** A reviewer can diff `filtered.md` against `combined.log` and verify what the filter chose to surface vs what it dropped. Without it, "what did the agent see for run X?" is unanswerable.
2. **Re-render.** A future filter version applied to the same evidence can be compared against the persisted output (Axis 3, diff-on-rerun, in `docs/observation-pipeline.md`).
3. **Cost.** Trivial — one extra `writeFileSync` per filtered run.

**`observation.md` is unchanged.** It is the human-readable observation summary, not the filtered view. Conflating them would muddy two roles.

**ADR 0001 invariants honored.** Raw evidence remains accessible. Every `Finding` in `observation.json.findings[]` carries `evidenceRefs[]` pointing back at `stdout.log` / `stderr.log` (existing `Finding` schema, `src/core/finding.ts:13`).

---

## 7. Composition with `--quiet` and the footer

**Position.** `--quiet` continues to suppress the **stderr** `[mira] <id> · …` footer (current behavior, `src/cli/run.ts:33-40`). When a filter fires, **the markdown view ends with a one-line evidence pointer**:

```txt
_evidence: .mira/runs/run_20260507T120000123Z_a4f2k9/_
```

This pointer is **part of the markdown**, not stderr. Logic: the agent's tool-result view only renders stdout; the pointer must travel on the channel the agent reads. The stderr footer remains a useful direct-CLI affordance.

**Quiet semantics summary:**

| Mode | Filter fires? | stdout | stderr |
|---|---|---|---|
| direct CLI, no `--quiet` | no | raw stdout | raw stderr + `[mira] …` line |
| direct CLI, no `--quiet` | yes | filtered markdown + `_evidence: …_` line | raw stderr + `[mira] …` line |
| hook (`--quiet`) | no | raw stdout | raw stderr |
| hook (`--quiet`) | yes | filtered markdown + `_evidence: …_` line | empty |

The hook path is what matters for agent token economy. Direct CLI use stays unsurprising for humans.

---

## 8. Exit code and stderr

**Exit code.** Preserved verbatim. The filter has zero authority over `process.exit`. (The current `runCommand` returns `run.exitCode ?? 1` — unchanged.) An information loss in the filter must never become an information loss in the exit signal.

**Stderr behavior on filter hit.** Suppressed. The filter's parser ingests `combined` (stdout + stderr) and the rendered markdown reflects diagnostics from both streams. A `tsc` failure with errors on stderr is rendered identically to one with errors on stdout. The agent does not need to reconstruct the split.

**Why not preserve stderr.** Two streams of compact-and-structured output is one stream too many. The agent's terminal-emulating tool surface mostly merges them anyway. If the user ever needs the split, raw `stderr.log` is one read away.

**Pass/fail signaling.** Three signals reach the agent:

1. The shell exit code (untouched).
2. The filtered markdown header (e.g. `# tsc — 3 errors in 2 files` vs `# tsc — pass`).
3. The pointer to evidence (always emitted on filter hit).

**Tests must assert** that exit code is preserved across raw, filtered, and crashed-filter paths.

---

## 9. Pilot command

**Position.** **`tsc`** (TypeScript compiler in `--noEmit` mode).

**Reasoning, on three axes:**

| Axis | tsc | vitest | bun test | eslint |
|---|---|---|---|---|
| Output volume on failure | high (cascades) | medium-high | medium | medium |
| Format stability | very stable | unstable across versions | unstable across versions | structured (`--format json`) trivially |
| Eval alignment | direct match for B1 ("verbose typescript failure", `eval/04-scenario-corpus.md`) | indirect | indirect | none |
| Mira-internal use | `bun tsc --noEmit` runs in this repo | `bun test` is the test runner | same | none |
| Cascade clustering ROI | very high (one missing import → 50 errors) | medium | low | low |
| Parser size | ~80 LOC regex | ~150 LOC for the multi-shape output | ~150 LOC | trivial (just `JSON.parse`) |

**Why not eslint despite the trivial parser.** The "compact result is already short" — the win is small. The pilot must demonstrate Mira beating a noisy, real, painful command. ESLint is the wrong proof.

**Why not vitest / bun test despite higher overall ROI.** Format instability across versions creates fixture maintenance churn that eats the V0.4 budget. Punted to V0.5+.

**Why tsc maximizes thesis impact.** B1 (`docs/eval/04-scenario-corpus.md`) was designed as the scenario where Mira's structural opt-in advantage **should** be most visible. Postmortem-001 said Mira lost on B1 too — because Mira had no compression. Picking tsc as pilot points the V0.4 work directly at the eval scenario the thesis was already supposed to win.

> ASSUMPTION: tsc errors compress to ≤30% of raw tokens on real fixtures **with cascade dedup applied** (§ 9b).
> Empirical baseline (this plan's review, REVIEW.md § B): without cascade dedup, the renderer hits ~0.55 on the eval B1 fixture and ~0.85 on small short-message failures. The 0.30 target requires the dedup pass.
> Revision trigger: bench in Phase 3 shows median ratio > 0.40 *with cascade dedup applied*. Tune the normalization (Path (a) in F1) or recalibrate the threshold (Path (b)) before pivoting pilots.

---

## 9b. Cascade dedup (in scope, V0.4)

**Position.** The renderer applies a single deterministic cascade-dedup pass to `Finding[]` before emitting bullets. Findings sharing `(ruleId, normalizedMessage)` are clustered into one bullet with a count and a comma-separated list of `file:line:col` locations.

**Normalization.** Strip identifiers (quoted bareword tokens) and types (everything inside `'...'`) from the message text, replace with `<id>` / `<type>` placeholders. Two findings cluster iff their normalized message strings are byte-equal.

```ts
function normalizeMessage(msg: string): string {
  return msg.replace(/'[^']+'/g, "<x>");  // strip every quoted token
}
```

Examples that cluster:
- `Type '{ x: number; }' is missing the following properties from type 'Point': y, z` → `Type <x> is missing the following properties from type <x>: y, z`
- `Type '{ a: string; }' is missing the following properties from type 'Other': b, c` → same shape after normalization → **same cluster**

Examples that do NOT cluster:
- `Property 'foo' does not exist` vs `Property 'bar' does not exist` → after norm `Property <x> does not exist` → same cluster (same shape).
- `Cannot find name 'X'` vs `Cannot find module 'X'` → different normalized shapes → different clusters.

**Output shape (rendered) — normalized template + concrete exemplar:**

```md
- **TS2739** ×8 — same shape: Type X is missing properties Y, Z from type T
  e.g. src/foo.ts:34:7 — Type '{ x: number; }' is missing the following properties from type 'Point': y, z
  also: src/foo.ts:52:14, src/bar.ts:67:3, src/bar.ts:89:21, src/baz.ts:102:5, src/baz.ts:118:9, src/qux.ts:134:12, src/qux.ts:156:8
```

Three lines per cluster:

1. **Template line.** `- **TSxxxx** ×N — same shape: <human-readable normalized template>`. The `<x>` placeholders from raw normalization are rewritten to `X`, `Y`, `Z`, `T` for readability — substitute capital letters in order of first occurrence. Tells the agent the *structural* shape.
2. **Exemplar line.** `  e.g. <path>:<line>:<col> — <verbatim message of first cluster member>`. Tells the agent one *concrete instance* — actual types, actual property names. The agent can act on this without reading raw evidence.
3. **Locations line.** `  also: <comma-separated path:line:col list of remaining members>`. Tells the agent every other site to inspect after fixing the root.

**Why both template AND exemplar.** A pure-normalized cluster bullet (`Type <x> is missing properties from <x>: y, z`) saves tokens but loses the actual type names. The agent has to read `combined.log` to recover them — an extra round-trip that defeats the filter's purpose. Adding ~60-80 tokens for a verbatim exemplar buys: agent acts in one read, semantic preservation real, raw evidence becomes optional not mandatory. **This is the cleanest SOTA trade in the renderer.**

For clusters of size 1 (no sibling), render as a normal single-finding bullet (no `×N` annotation, no template, no exemplar — just the verbatim bullet with full message and the optional `Did you mean` suggestion).

**Constraints.**
- **Ordering.** Within a cluster: locations sorted lexicographically. Across clusters: sort by descending cluster size, then by `ruleId`, then by first location's path.
- **Information preservation.** Each clustered finding's location is fully preserved on the continuation line. The verbatim message is not (replaced by the normalized form), but the original messages remain in raw `combined.log` one read away.
- **No cross-rule clustering.** Two findings with different `ruleId` never cluster, even if their normalized messages match.

**Why not `(ruleId, message)` exact match?** The same logical bug emits *different* messages when the involved types differ (B1's bug surfaces as 8 distinct messages all about "missing array wrapper on `evidenceRefs`", but each names a different surrounding type). Exact match clusters too narrowly. Normalization is the cheapest deterministic dedup that catches these.

**Why not AST-based or hash-based clustering?** AST is V0.6+. Hash-based on the raw line wouldn't cluster either (each error names a different file/line). Normalized-message clustering is the deterministic-and-cheap middle.

**Cost.** ~30 LOC inside `src/filter/filters/tsc.ts`. No new dependency.

> ASSUMPTION: normalized-message clustering keys catch the typical tsc cascade shape on the 3 committed fixtures.
> Revision trigger: bench shows a known cascade fixture clustering as N findings instead of 1. Add the missing normalization rule (e.g. strip numeric literals, strip `[<index>]` brackets).

---

## 9c. Where Mira goes beyond RTK (Cluster B/C-relevant upgrades)

A V0.4 review pass on [`rtk-ai/rtk`](https://github.com/rtk-ai/rtk) surfaced patterns that map onto Cluster B/C's surface area. **RTK is one reference, not gospel.** Mira owns a typed `Finding[]` model that RTK does not, so each pattern below is reframed as the *Mira-native upgrade that goes beyond RTK*, not as RTK adoption. The Cluster B/C designer copies the upgrade, not the baseline.

**1. Recovery is line-precise + structured, not free-text "see X".**
When the renderer drops information (cluster of 60 rendered as 8 — § 9b cap), the markdown emits a structured cut-marker next to the cut — not just a path string. RTK's `force_tee_hint()` (`src/core/tee.rs`) emits a free-text pointer; Mira does better because every `Finding` already carries `evidenceRefs[]` and `excerpts[].lineStart/lineEnd` — typed, line-precise, machine-readable.

```md
  also: src/foo.ts:34:7, src/bar.ts:67:3, … +52 more
  (lines 142-198 of `.mira/runs/<id>/combined.log`)
```

The cluster bullet's continuation includes the **line range** in `combined.log`, not just the file path. The agent fetches ~5 lines with `sed -n '142,198p'`, not a 200-line wall. **More elegant** (typed reference, not free text), **more powerful** (line-precise, not file-level), **more performant** (5-line fetch, not 200).

**2. Success short-circuit is a typed guard, not a regex on output.**
`findings.length === 0 && exitCode === 0` → render `# tsc — pass` and return. RTK's `match_output` regex-matches on output text (`^Found 0 errors`); Mira does better because the test runs on *already-computed structured data*. O(1) on the typed result, not regex over output bytes; composable with severity filters that RTK cannot express (`findings.filter(f => f.severity === 'error').length === 0`); cache-stable in the agent's prompt because the rendered prefix is deterministic on success.

Implement as an **early return at the top of the renderer**, not a branch buried mid-function. The shortest case hits the shortest code path AND produces the shortest agent-facing output.

**3. Fixtures are real source files, not strings embedded in test cases.**
RTK inlines `[[tests.foo]]` blocks of input/expected strings in TOML. Mira does better with real `.ts` files under `<fixtures-dir>/sources/` that anyone can compile and re-capture, real `.txt` outputs, real `tokens.json`. Plus: the capture script self-checks — it re-parses each fixture, asserts `parser(fixture).length === expected_count` (committed in `tokens.json` metadata), fails loudly on drift. Catches a TS upgrade silently breaking the regex in a way RTK's bundled tests cannot.

**Decision (Task 04, 2026-05-07):** **co-locate** under `src/filter/filters/tsc/__fixtures__/`. Filter, parser, cluster, render, version, AND fixtures travel as one cohesive unit. The cost is a one-time inconsistency with `tests/fixtures/tsc-e2e/` — accepted because e2e fixtures back the CLI integration test, not the filter module itself. § 11's file-layout block, the V0.5+ naming convention, and Tasks 04 / 05 / 07 paths all reflect this choice.

Rejected alternative: keep fixtures under `tests/fixtures/tsc/` (consistent with existing Mira convention). Cheaper today, but loses the cohesion that pays off when V0.5 adds a second filter — the convention either gets retrofitted or grows into a permanent divergence.

### Other Mira-native upgrades on the table

Listed so they are not lost; the Cluster C designer evaluates each and either adopts in V0.4 or pushes to V0.5 with a one-line rationale.

a. **Cache-stable header.** Move duration `(1240ms)` from the `# tsc — N errors` header line to the footer. Add a stable hash of the structured findings payload in a footer comment: `<!-- mira: filterVersion=tsc/1 hash=abc123 -->`. Agents with prompt caching get hit-stable prefixes when re-runs produce the same set. RTK has no such concept because there's no structured payload to hash. **V0.4 candidate** (~10 LOC).

b. **Severity-ranked rendering.** Findings sorted by severity (`error` > `warning` > `info`), then by cluster size, then by first-member path. Errors surface above warnings even when cluster sizes invert. RTK truncates at `max_lines` blindly. **V0.4 candidate** (~3 LOC, an extra sort key in `clusterDiagnostics`).

c. **Quarantine, don't drop.** Lines the parser cannot match become `Finding[severity:"info", ruleId:"unparsed", excerpts: [...]]` instead of being silently discarded. The renderer emits a footer block: `⚠ 3 unparsed lines — see combined.log:42-44`. The agent KNOWS what was missed; the bench's parser-coverage gate (≥ 0.85) becomes a soft warning instead of a silent loss. **V0.5 candidate** — formalizes what the coverage gate already implies, but adds agent-visible behavior that should bake in V0.4 first.

d. **Render-format negotiation.** `FilterContext.outputFormat: "markdown" | "json"`. Agents that prefer structured input (Codex, future MCP consumers) ask for JSON; Claude Code stays on markdown. RTK is text-only by design. **V0.5+** — V0.4 ships markdown-only, contract supports the rest.

e. **Token-budgeted rendering.** Renderer takes a budget; if exceeded, emits top-K by severity + structured fallback link to `observation.json`. Agent reads the JSON when it wants the rest. RTK's `max_lines` is the unranked equivalent. **V0.5+** — needs the agent's token budget surfaced, which V0.4 does not have.

### Patterns deliberately NOT copied (closed, do not re-litigate)

- **Two-tier matching with overlap** (clap enum + TOML regex fallback) — RTK's "maintenance tax". Mira keeps a single `Map<string, RegistryEntry>` per § 4.
- **Custom invocation rewrites** (e.g. RTK silently runs `git status --porcelain -b` instead of `git status`). Breaks ADR 0001's "raw evidence is what the tool actually emitted" contract; non-negotiable.
- **`chars / 4` token heuristic** — RTK's only metric. Per § 10 we use Anthropic `count_tokens` against committed `tokens.json`; the bench rigor is a competitive advantage, not a parity concern.
- **SQLite analytics layer** — RTK dedicates ~half of `src/core/` to it. `.mira/runs/<id>/` plus `mira list-recent-runs` covers the same surface for V0–V0.5.

---

## 10. Measurability

**Position.** A standalone bench (hard, deterministic gate) plus a manual Claude Code A/B (soft, real-client gate). Both must pass for V0.4 to ship.

### Hard gate — bench

**Metric.** `compression_ratio = tokens(filtered_stdout) / tokens(raw_stdout)`, computed on `N=3` committed fixtures (small, medium, large failures).

**Tokenizer — authoritative.** Anthropic's `client.messages.count_tokens()` endpoint. Run **once at fixture-capture time** (Task 04) for the raw input, and once during bench development for the rendered output of every snapshot fixture; commit the resulting counts to `src/filter/filters/tsc/__fixtures__/tokens.json` next to the `.txt` files. The bench reads pre-computed counts at run time — no network call during `bun bench/filter/tsc.ts`, no API key needed in CI, fully reproducible.

```json
// src/filter/filters/tsc/__fixtures__/tokens.json (committed, regenerated when fixtures change)
{
  "schema": "anthropic-count_tokens-v1",
  "model": "claude-opus-4-7",
  "captured_at": "2026-05-07T14:00:00Z",
  "fixtures": {
    "small.txt":  { "raw": 93,   "filtered_expected": 32 },
    "medium.txt": { "raw": 612,  "filtered_expected": 164 },
    "large.txt":  { "raw": 4830, "filtered_expected": 980 }
  }
}
```

**Why this is SOTA over `js-tiktoken`.** `js-tiktoken/o200k_base` is GPT-4o BPE — a *proxy* for Claude tokenization with 10-15% drift on technical text. `count_tokens` is the same code path Claude bills against. Trading a one-time capture cost for permanent authoritativeness is the right move.

**`filtered_expected` regeneration.** When the renderer or the cascade-dedup logic changes, the recorded `filtered_expected` counts go stale. Treat regeneration as a deliberate part of any PR that touches `src/filter/filters/tsc/render.ts` or `cluster.ts`. The bench fails loudly when actual differs from committed > 5% — see Task 07.

> ASSUMPTION: `count_tokens` against `claude-opus-4-7` tracks the agent's actual consumption within ~5% (model upgrades may shift it).
> Revision trigger: Task 09's manual A/B shows divergence > 15% on the same fixture. Re-capture `tokens.json` against the model the agent actually uses and bump the schema version.

**Four preservation gates** (all must pass):

1. **Triple coverage (forward).** For each parsed `Finding`, the triple `(file, line, ruleId)` MUST appear verbatim in the rendered markdown. Catches: parser produces findings but renderer drops them.
2. **Message-body coverage.** For each parsed `Finding`, the message body MUST be reachable in the rendered markdown — verbatim, or truncated with an explicit `…` suffix. For findings in a cluster of size ≥ 2: the *exemplar* message (cluster member [0]) must be verbatim; remaining members are byte-identical to the exemplar after normalization (cluster invariant), so they are "reachable" through the exemplar. Catches: renderer drops actionable detail.
3. **Parser line coverage.** `lines_parsed / lines_total ≥ 0.85` per fixture. Catches: a tsc format the regex doesn't match (e.g. `--pretty` mode) silently produces zero findings while the renderer asserts "tsc — pass" on a failing build.
4. **Bijection (reverse).** Every `(file, line, ruleId)` triple appearing in the rendered markdown MUST map back to a parsed `Finding`. Catches: renderer hallucinates a bullet (wrong cluster count, copy-paste bug in template substitution, off-by-one in location list). Implemented by parsing the rendered markdown with a small extractor regex (`/\*\*TS\d+\*\*.*?(\S+):(\d+):(\d+)/g`) and asserting set-equality against the parsed Findings' triples.

**Pass criteria for V0.4 ship (hard gate):**

1. Median `compression_ratio` ≤ 0.30 across the 3 fixtures (≥70% reduction in tokens, measured by Anthropic's `count_tokens`).
2. Absolute tokens saved on B1 fixture (`medium.txt`) ≥ 800 tokens. Ratio is misleading when the absolute base is small; this guards against "0.20 ratio on 200-byte input" theatre.
3. All 4 preservation gates pass for all 3 fixtures.
4. Parse + render + dedup p95 ≤ 30ms on the largest fixture.
5. Token-count drift between actual (locally-rendered) and committed `tokens.json` `filtered_expected` is ≤ 5% per fixture. Catches a renderer change that wasn't accompanied by a `tokens.json` regeneration.
6. **Trend regression check.** If `bench/results/` has a previous result, the current `compression_ratio` per fixture must be within 10% of the most recent committed result (i.e., ratio doesn't slowly climb toward 1 across PRs without anyone noticing).

**Where the bench lives.** `bench/filter/tsc.ts`. Run via `bun bench/filter/tsc.ts` — prints a markdown table to stdout and exits non-zero if any pass criterion fails. CI-runnable.

### Soft gate — manual Claude Code A/B (Task 09)

**What.** A human runs Claude Code on the eval B1 scenario (`eval/scenarios/B1`), with and without Mira's hook + filter installed, N=2 per arm. Token consumption is read from Claude Code's own usage reporting (NOT the Anthropic SDK directly — postmortem-001 demonstrated that the synthetic-agent loop is structurally a different beast).

**Pass criteria for V0.4 ship (soft gate):**

1. Filter-on tokens ≤ baseline tokens ± 10% on B1, median over N=2.
2. Filter-on success rate ≥ baseline success rate (binary on `success.sh`).

**What if it fails.** A *bench-pass + eval-fail* outcome is the most informative result V0.4 can produce — it means the filter compresses but the agent doesn't benefit (or actively suffers). Investigation paths: prompt-cache invalidation (the markdown is shorter but breaks a cache prefix); the agent always re-fetches `combined.log` anyway, doubling the cost; the markdown's structure confuses Claude Code's tool-result rendering. **Do not ship V0.4 silently if the soft gate fails — open a follow-up issue, document, and decide.**

### Why both gates

The bench measures what the *filter* does. The Claude Code A/B measures what the *agent + filter* does. Postmortem-001 conflated these by testing a synthetic agent and concluding "Mira hurts" when really "the synthetic harness was the wrong instrument". V0.4 keeps the two measurements separate by construction.

### Why not full automation

A fully-automated headless `claude -p` driven harness would let the bench and eval merge into one CI step. Building it is ~1 week and not core to V0.4's filter work — it's the next ADR after V0.4 ships. Manual A/B is good enough as the soft gate today; "10 minutes of human time per V0.x ship" is a defensible cost.

---

## 11. Module structure & quality bar

V0.4 introduces ~1100 LOC of new code. The shape they take matters as much as the behavior — the next four versions of Mira (V0.5 second filter, V0.6 LSP, V0.7 cross-run diff, V0.8 architectural insight tools) will all extend this surface. Get the boundaries right now.

### File layout

```txt
src/filter/
  types.ts             FilterContext, FilterInput, FilteredView, Filter, DispatchResult
  registry.ts          REGISTRY: Map<string, Filter> — populated at module load only
  dispatch.ts          extractProgramToken, dispatchFilter — pure, no I/O
  filters/
    tsc/
      index.ts         tscFilter: Filter (~30 LOC of glue)
      parser.ts        parseTscOutput, parseTscOutputWithStats, ParseStats, TscDiagnostic
      cluster.ts       clusterDiagnostics, TscCluster
      render.ts        renderTscMarkdown
      version.ts       export const TSC_FILTER_VERSION = "tsc/1"

bench/
  README.md            one paragraph; what bench/ is for
  filter/
    tsc.ts             V0.4 ship-gate bench

tests/
  filter-types.test.ts             unit (Task 01)
  filter-dispatch.test.ts          unit (Task 02)
  filter-tsc-parser.test.ts        unit — parser (Task 05)
  filter-tsc-cluster.test.ts       unit — cluster (Task 05)
  filter-tsc-render.test.ts        unit — renderer + snapshots (Task 05)
  cli-run-filter.e2e.test.ts       integration — wiring (Task 03)
  cli-run-tsc.e2e.test.ts          integration — full pipeline (Task 06)

  fixtures/tsc-e2e/                (Task 06) — minimal real project for e2e

src/filter/filters/tsc/__fixtures__/   (Task 04 — co-located per § 9c)
  small.txt
  medium.txt        (B1-shaped)
  large.txt
  tokens.json       Anthropic count_tokens results (raw + filtered_expected)
  sources/          broken TS that produces the fixtures
  snapshots/        bun snapshot artefacts
  README.md         pinned TS version + capture procedure
```

**Why co-locate fixtures under `src/filter/filters/tsc/__fixtures__/`:** the fixtures, the parser/cluster/render modules, and the version tag move as one cohesive unit (RTK pattern, § 9c bullet 3). When V0.5 adds a second filter, `src/filter/filters/<program>/__fixtures__/` is the convention from day 1. The cost is a one-time inconsistency with `tests/fixtures/tsc-e2e/` (e2e fixtures stay in `tests/` because they back end-to-end CLI tests, not the filter module itself).

**Why split `tsc.ts` into a directory from day 1, not "if it exceeds 320 LOC":** parsing, clustering, and rendering are three different concerns. Each has its own test file. Splitting later is a refactor that touches tests, snapshots, and possibly imports across the bench. Splitting from the start is one minute of mkdir; splitting later is a half-day chore. **State-of-the-art means the right shape from the start.**

### Dependency direction (one-way, enforced by code review)

```txt
cli/run.ts ──▶ filter/dispatch.ts ──▶ filter/registry.ts ──▶ filter/filters/tsc/
filter/* ──▶ core/{finding, command-observation, evidence}
```

`filter/` MUST NOT import from `cli/`, `store/`, `command/`, `mcp/`, `architecture/`, `context/`. The filter module is reusable from any caller (CLI today, MCP if ever needed). A linter rule (`eslint-plugin-import` or hand-rolled) is over-engineering for V0.4 — code review enforces the rule, and the test layout makes a violation visible.

`core/` MUST NOT import from `filter/`. The `Finding` type is the contract; the filter consumes it.

### Function purity & I/O discipline

| Module | Allowed I/O |
|---|---|
| `filter/types.ts` | none (types only) |
| `filter/registry.ts` | none (const Map at module load) |
| `filter/dispatch.ts` | none — pure function. Catches exceptions but emits no log/file. |
| `filter/filters/tsc/parser.ts` | none |
| `filter/filters/tsc/cluster.ts` | none |
| `filter/filters/tsc/render.ts` | none |
| `filter/filters/tsc/index.ts` | none — pure glue |
| `cli/run.ts` (filter integration) | only the existing I/O (writeFiltered, stdout/stderr writes); no new I/O introduced by V0.4 outside this single seam |

**Rationale.** A pure filter is trivial to test (no mocking), trivial to reason about, trivial to reuse. Sync-and-pure today; async appears only when the first filter genuinely needs it (decisions § 2 ASSUMPTION).

### Quality bar (binding, code-review enforceable)

These are the rules a reviewer can fail a PR on. They are MORE strict than `CLAUDE.md`'s defaults because V0.4 is the foundation for V0.5+:

1. **No comments that narrate the diff** ("this function processes the input"). Comments only when *why* is non-obvious — a hidden constraint, a workaround, an invariant. CLAUDE.md rule, restated.
2. **No file > 250 LOC.** If parser/cluster/render/glue would push past, the file split happens *now*, not later.
3. **No function > 40 LOC.** Helpers inline at the top of their consumer.
4. **No public API not consumed in V0.4.** YAGNI strictly: every exported symbol has at least one caller in `src/`, `tests/`, or `bench/`.
5. **No try/catch outside `dispatch.ts`.** Filters propagate exceptions; the dispatcher is the single boundary that catches. This keeps error handling auditable in one place.
6. **No `any`, no `as` outside zod inference paths.** TypeScript's strictness is the contract; `as` defeats it. Reach for type narrowing (discriminants, `instanceof`) instead.
7. **Tests mirror the source layout.** `src/filter/filters/tsc/parser.ts` ↔ `tests/filter-tsc-parser.test.ts`. Reviewers can map at a glance.
8. **Fixtures are committed text, not generated at test time.** Reproducibility > convenience. Re-capture is a deliberate task, never an accident.
9. **No `console.log` left behind.** The dispatcher writes to `stderr` exactly once on the error path (the warning line); no debug prints survive merge.
10. **No abbreviations in identifiers.** `dispatchFilter`, not `dispFilter`. `clusterDiagnostics`, not `clusterDiag`. Code is read 100× more than it is written.

These rules apply to the V0.4 PR. They become the convention for V0.5+ filters by example.

### Naming convention for V0.5+ filters

- Folder: `src/filter/filters/<program>/`
- Glue file: `index.ts`, exports `<program>Filter: Filter` and `<PROGRAM>_FILTER_VERSION = "<program>/1"`
- Sibling files by concern: `parser.ts`, `cluster.ts` (if needed), `render.ts`, `version.ts`
- Tests: `tests/filter-<program>-<concern>.test.ts`
- Fixtures (co-located): `src/filter/filters/<program>/__fixtures__/{small,medium,large}.txt` + `sources/` + `tokens.json` + `README.md`
- Bench: `bench/filter/<program>.ts`
- Registry line: one `.set("<program>", <program>Filter)` in `registry.ts`

**No exceptions in V0.5.** Each filter follows this convention exactly. ADR 0008 names this convention so reviewers have something to point at.

---

## Decisions summary

| # | Decision | One-line position |
|---|---|---|
| 1 | Pipeline placement | Post-process inside `runCommand`, after buffered capture |
| 2 | Data model | `Filter: (input, ctx) → { findings, markdown }`; findings persisted in `CommandObservation` |
| 3 | Command detection | Strip wrappers, dispatch on first token |
| 4 | Registry shape | `Map<string, Filter>` — hard-coded, one line per filter |
| 5 | Generic fallback | Identity passthrough; no generic filter |
| 6 | Evidence composition | Raw untouched; new `filtered.md`; `findings[]` + `filterVersion` in observation |
| 7 | `--quiet` and footer | `--quiet` unchanged; pointer line lives inside the markdown |
| 8 | Exit code / stderr | Exit code preserved verbatim; stderr suppressed on filter hit |
| 9 | Pilot | `tsc` |
| 9b | Cascade dedup | `(ruleId, normalized-msg)` clustering, in V0.4 scope; rendered as template + concrete exemplar + locations (preserves shape AND content) |
| 9c | RTK steals for Cluster B | Per-cut recovery hint, success short-circuit (`match_output`), fixture co-location decision; explicitly NOT copied: dual-tier matching, custom rewrites, `chars/4`, SQLite |
| 10 | Measurement | Hard gate: `bench/filter/tsc.ts` (Anthropic `count_tokens`-based via committed `tokens.json`, 4 preservation gates incl. bijection, drift detection, trend regression, JSON output). Soft gate: manual Claude Code A/B on B1. |
| 11 | Module structure & quality bar | `src/filter/filters/<program>/{index,parser,cluster,render,version}.ts` from day 1; one-way `cli → filter → core`; 10 code-review-enforceable rules |
