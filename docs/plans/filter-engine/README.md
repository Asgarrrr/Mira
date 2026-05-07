# Filter engine — implementation plan

Plan for V0.4 of Mira: an intelligent filter that turns raw shell command output into a typed, compact `FilteredView` for the agent — the first piece of work that delivers the thesis at the **hook layer** (where token economics live, per ADR 0007).

This `README.md` is the global plan. The 10 architectural decisions are locked in [`00-decisions.md`](./00-decisions.md). Atomic tasks live in `01-*.md` … `08-*.md`.

---

## Problem

Today, Mira's hook captures every command's raw stdout/stderr and persists it under `.mira/runs/<id>/` — but the agent still receives the **raw bytes verbatim**. Token efficiency vs. no-Mira: 0%. Postmortem-001 (`docs/eval/postmortem-001.md`) showed the V0.3 MCP layer adding tokens rather than saving them; ADR 0007 reframed the layering: **hook = data layer, MCP = insight layer**. The hook is where compression lives.

The thesis: every agent-facing observation should be **compact, structured, and traceable**. V0.0–V0.3 delivered traceability and structure for metadata. V0.4 must deliver compactness, without losing the other two.

## Thesis (this plan)

> A typed, deterministic filter applied to one painful command (`tsc`) at the hook boundary reduces agent-visible **tokens** ≥70% on failure fixtures while preserving every parsed diagnostic (triple + message body + parser coverage) — and it does so without changing how the hook is installed, how evidence is stored, or how exit codes propagate.

The 70% target is unreachable with line-level rendering alone (measured: ~0.55 ratio on the eval B1 fixture, ~0.85 on small failures). It becomes reachable with a small **cascade-dedup pass** — clustering findings by `(ruleId, normalized-message-pattern)` so 8 identical "missing array wrapper" errors render as one bullet with a count + locations list. That's the lever; without it the pilot's own selling point (00-decisions.md § 9: "Cascade clustering ROI: very high") goes unused.

If we can show that for one command, we have a shape we can apply to a second command, then a third, in V0.5+. If we can't, the failure is informative: the bench surfaces which axis (compression, preservation, perf) failed, and Phase 4-onwards work pivots on data instead of guesses.

## Phases

### Phase 1 — Scaffolding (Tasks 01, 02, 03)

Build the filter module, dispatcher, and pipeline integration. **No filters yet.** When Phase 1 ships, every command still passes through unchanged on the wire — the dispatcher is wired in but the registry is empty.

**Exit criterion:** `mira run "anything"` behaves bit-for-bit identically to today (verified by re-running existing `tests/cli-run.e2e.test.ts`). The scaffolding is invisible until a filter registers.

### Phase 2 — Pilot filter: `tsc` (Tasks 04, 05, 06)

Capture real `tsc --noEmit` failure fixtures, write the parser + renderer, register `tsc` in the registry. After Phase 2, `mira run "tsc --noEmit"` produces compact markdown on stdout and `findings[]` in `observation.json`; `mira run "ls"` is still passthrough.

**Exit criterion:** All three fixtures parse to `Finding[]`, render to markdown, and the e2e test for a `tsc` run shows the agent receiving the rendered view (not raw output).

### Phase 3 — Measurement and documentation (Tasks 07, 08)

Bench script with hard pass criteria. Documentation update: this is the V0.4 commitment, the surface is now stable.

**Exit criterion:** `bun bench/filter/tsc.ts` exits 0 with median ratio ≤ 0.3, p95 ≤ 30ms, and information-preservation snapshot passing. The doc update points new contributors at the registry shape so V0.5+ can add filters by following the pilot.

---

## Dependency DAG

```txt
              ┌──────────────────── Phase 1 ────────────────────┐
              │                                                 │
              │   01 (types) ─→ 02 (dispatcher) ─→ 03 (wire)    │
              │       │                                  │      │
              └───────┼──────────────────────────────────┼──────┘
                      │                                  │
              ┌───────┼──────── Phase 2 ─────────────────┼──────┐
              │       ▼                                  ▼      │
              │   05 (tsc parser/renderer) ──→ 06 (register)    │
              │       ▲                                         │
              │       │                                         │
              │   04 (fixtures) ───┘                            │
              │                                                 │
              └─────────────────────────────────────────────────┘
                                          │
                                          ▼
              ┌────────────────── Phase 3 ──────────────────────┐
              │       07 (bench) ──→ 08 (docs)                  │
              └─────────────────────────────────────────────────┘
```

**Critical path:** 01 → 02 → 03 → 06 → 07 → 08 (six tasks).

**Parallelizable:**
- 04 (fixture capture) is independent of all code; can start day 1.
- 05 (tsc parser) needs 01 (types) + 04 (fixtures) only — can land alongside 03 in parallel.

---

## Success metrics

Two gates: a deterministic bench (hard) and a manual Claude Code A/B (soft).

### Hard gate — bench (Task 07)

Measured by `bench/filter/tsc.ts`. See [`00-decisions.md`](./00-decisions.md) § 10 for full justification.

| Metric | Threshold | Source |
|---|---|---|
| Median compression ratio `tokens(filtered) / tokens(raw)` | ≤ 0.30 | committed `tests/fixtures/tsc/tokens.json` (Anthropic's `messages.count_tokens`) |
| Absolute tokens saved on B1 fixture (`medium.txt`) | ≥ 800 | bench |
| Triple coverage (forward) | 100% of parsed `(file, line, ruleId)` triples in markdown | bench |
| Body coverage | every non-cluster body reachable in markdown; cluster exemplar verbatim | bench |
| Parser line coverage | `lines_parsed / lines_total ≥ 0.85` | bench |
| Bijection (reverse) | every markdown triple maps back to a parsed finding | bench |
| Token-count drift vs `tokens.json` | ≤ 5% per fixture | bench |
| Trend regression vs last `bench/results/*.json` | ≤ 10% ratio drift per fixture | bench |
| Parse + render p95 | ≤ 30ms | bench timing |
| Existing tests still pass | 100% | `bun test` |

### Soft gate — manual Claude Code A/B (Task 09)

A human runs Claude Code on the B1 scenario, with and without the filter, N=2 per arm, and records token consumption from Claude Code's own usage reporting (NOT the Anthropic SDK directly — postmortem-001 demonstrated that's not the same agent). Pass criterion: filter-on tokens ≤ baseline ± 10%, success rate ≥ baseline. Recorded in the V0.4 PR description.

The full `eval/` harness rebuild is **not** part of the V0.4 ship gate. Driving the real `claude -p` headless binary as a fully-automated harness is post-V0.4 work; V0.4 ships with the deterministic bench + manual verification.

**Why both:** the bench measures what the *filter* does (compression of fixed input). The Claude Code A/B measures what the *agent + filter* does together — accounting for prompt caching, tool descriptions, system prompt, the agent loop. Postmortem-001 burned us by conflating these.

---

## Risks + mitigations

**R1. Existing e2e tests break because stdout content changes.**
- Mitigation: Phase 1 ships with an empty registry; Phase 2 only fires on the literal command `tsc`. Audit `tests/cli-run.e2e.test.ts` in Task 03 — confirm none of them invoke `tsc`.

**R2. The `--quiet` ↔ filter interaction breaks the hook.**
- Mitigation: 00-decisions.md § 7 fixes the contract; Task 03 includes a test that exercises both paths (with and without `--quiet`) on the same filter hit and asserts both render the markdown and an evidence pointer.

**R3. Parser regex misses an edge case in `tsc` output (e.g. multiline diagnostics, `--pretty` colors).**
- Mitigation: Task 04 captures fixtures from real failures, including a multiline diagnostic and a colored output (`tsc --pretty`). Task 05's parser strips ANSI before regex matching. The bench runs against all three.

**R4. Filter throws on malformed input → agent receives an error or a half-rendered string.**
- Mitigation: Task 03 wraps the dispatcher call in try/catch — exception → fall back to raw passthrough. A test case feeds the `tsc` filter garbage and asserts raw output is emitted with no exception leak.

**R5. Bench measures bytes, not agent-visible tokens.**
- Mitigation: 00-decisions.md § 10 acknowledges this; the assumption has a revision trigger if a real eval-harness run diverges from the byte ratio by > 30%. Bytes are a defensible proxy at the order-of-magnitude scale we care about (70%+ reduction).

**R6. The wrapper-stripping in Task 02 misclassifies a command shape we did not foresee.**
- Mitigation: false negatives (failing to detect tsc) → passthrough → no harm. False positives are bounded by the literal-token requirement after stripping. Unit tests in Task 02 cover the documented wrapper list with known inputs.

---

## Failure modes (self-grilling)

These are scenarios where the plan fails *as written*. For each one: what we ship anyway, and what we change.

### F1. The `tsc` pilot does not hit the 0.3 ratio even with cascade dedup.

**What it would mean.** Cascade dedup is in V0.4 scope (00-decisions § 9b). If even with it the ratio sits above 0.30, fixtures aren't cascade-shaped enough or the dedup heuristic misses the actual cluster axis.

**What we ship.** Phases 1+2 still ship. The scaffolding is correct; only the pilot's measurement is disappointing. The `Finding[]` is still populated, `filtered.md` still persists.

**What we change.** Three paths:
- (a) Tune the cascade-dedup normalization (`(ruleId, normalized-msg)` keying — try stripping more, e.g. all quoted identifiers/types). Cost: ~half a day.
- (b) Recalibrate the threshold to what the renderer actually achieves on real fixtures (e.g. 0.45 typical / 0.30 cascade) and document that as honest. Cost: 1 hour, just config.
- (c) Pivot the pilot to `bun test`. Tasks 01–03, 07–08 transfer untouched; Tasks 04–06 are rewritten. Cost: ~3 days, no scaffolding waste.

### F2. The bench's information-preservation snapshot fails repeatedly.

**What it would mean.** The renderer is dropping findings, or the parser is producing findings that don't trace back to a parseable file:line. Both are bugs, not strategy failures.

**What we ship.** Nothing until the snapshot passes. This is a hard correctness gate — losing diagnostics silently is **exactly** the failure mode Mira's thesis is meant to fix.

### F3. A second filter (V0.5) reveals the registry shape is wrong.

**What it would mean.** `Map<string, Filter>` is too narrow when, e.g., we need to dispatch by both the tool and a sub-command (`vitest run` vs `vitest watch`).

**What we ship.** V0.4 lands with the simple shape. The cost of the wrong shape is ~50 LOC of refactor on the dispatcher when we know V0.5's shape. The cost of pre-empting is permanent over-abstraction. We pay later.

### F4. `tsc` output formats fragment across versions.

**What it would mean.** TS 5.x and TS 4.x produce structurally different diagnostics. Our regex covers one and breaks the other.

**What we ship.** V0.4 supports the format the project's installed `typescript` produces (committed fixtures pin this). The doc explicitly states the supported shape. New shape → new fixture + parser branch → constant time per shape.

### F5. The hook's `--quiet` semantics get more entangled.

**What it would mean.** A future flag (e.g. `--no-filter` for opt-out) creates an N×M flag matrix.

**What we ship.** No new flags in V0.4. The decisions doc § 7 freezes the matrix at 4 rows. Future flags need their own ADR.

### F6. The decision to suppress stderr on filter hit hides a real diagnostic the parser missed.

**What it would mean.** `tsc` writes a non-diagnostic warning on stderr (e.g. "tsconfig.json watch mode unavailable"); the parser doesn't surface it; the suppression deletes it from the agent's view.

**What we ship.** The pointer line in the markdown. The agent can read `.mira/runs/<id>/stderr.log` via the existing evidence path. We accept rare blind spots in exchange for the 70% reduction; the audit trail is intact.

**What we change if this becomes a real problem.** Add an `unparsed_tail` field to `FilteredView` that prepends to the markdown when the parser ate < X% of the input. Defer until evidence shows it.

---

## Out of scope (restated)

The implementing agent must not drift into these:

- **Compiling Mira to a binary** via `bun build --compile`.
- **Multi-agent support** beyond Claude Code (Cursor, Codex, OpenCode, …).
- **User-facing config** (TOML/YAML, exclude lists, `--no-filter` flag).
- **A port of RTK's filter registry.** The pilot is `tsc`. V0.5 may add **one** filter — that's the next ADR.
- **Cross-run memory / diff-on-rerun** (Axis 3 in `docs/observation-pipeline.md`). Out of V0.4.
- **Cross-file cascade clustering.** Out of V0.4. The minimal cascade-dedup pass (in scope, see Task 05) clusters by `(ruleId, normalized-message-pattern)` *within the rendered output* — it does not cluster across files into a single root-cause node.
- **MCP surface changes.** No new tools. ADR 0007 is the binding contract.
- **Streaming output.** Raw observer stays buffered. ADR 0001 invariant.
- **Architecture sensing changes.** ADR 0005 is unchanged.
- **Schema versioning.** `Finding` schema is V0.0 of an internal type; SARIF compatibility is a separate later ADR.
- **Performance regressions of the existing observer.** The filter must not slow down `mira run` by more than 30ms p95 on a 500-line failure.

---

## Tasks

| # | File | Title | Phase | Diff (~) |
|---|---|---|---|---|
| 01 | [`01-types.md`](./01-types.md) | Filter types + empty registry module | 1 | ~80 |
| 02 | [`02-dispatcher.md`](./02-dispatcher.md) | Dispatcher with wrapper stripping | 1 | ~180 |
| 03 | [`03-wire-into-run.md`](./03-wire-into-run.md) | Wire dispatcher into `runCommand` | 1 | ~140 |
| 04 | [`04-fixtures.md`](./04-fixtures.md) | Fixtures + `tokens.json` capture (Anthropic `count_tokens`) | 2 | ~150 (incl. capture script + data) |
| 05 | [`05-tsc-parser.md`](./05-tsc-parser.md) | `tsc` parser + renderer + cascade-dedup + did-you-mean (concrete-exemplar cluster format) | 2 | ~280 |
| 06 | [`06-register-tsc.md`](./06-register-tsc.md) | Register `tsc` and add e2e test | 2 | ~80 |
| 07 | [`07-bench.md`](./07-bench.md) | Bench: authoritative tokens, 4 preservation gates (incl. bijection), `--json`, trend tracking | 3 | ~240 |
| 08 | [`08-documentation.md`](./08-documentation.md) | ADR 0008 + observation-pipeline update | 3 | ~160 (docs) |
| 09 | [`09-claude-verification.md`](./09-claude-verification.md) | Manual Claude Code A/B on B1 (soft gate) | 3 | ~50 (procedure + PR notes) |

Total: ~1360 lines of code + docs + data across 9 atomic tasks.
