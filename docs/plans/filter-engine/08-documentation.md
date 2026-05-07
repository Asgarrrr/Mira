# Task 08 — ADR 0008 + observation-pipeline update

> **Scope adjusted post-V0.4.x restructure.** ADR 0008 was written ahead of
> this task as part of the filter subsystem restructure (see the V0.4.x
> section in `README.md` of this plan). The ADR landed under
> `docs/adr/0008-filter-architecture.md` rather than the originally-planned
> `0008-filter-engine-v0-4-tsc-pilot.md` — the broader "subsystem
> architecture" framing matches what was actually decided. This task's
> remaining scope: revisit the ADR with bench-derived numbers from Task 07
> (calibrated thresholds, measured ratios), update
> `docs/observation-pipeline.md` to reflect V0.4 as shipped, and add the
> `CLAUDE.md` § V0.4 scope paragraph.

## Goal

Lock V0.4 in writing: a new ADR (`docs/adr/0008-filter-engine-v0-4-tsc-pilot.md`) commits the filter contract, the registry shape, and the pilot. `docs/observation-pipeline.md` is updated from "research + roadmap" to "this is what V0.4 ships". `CLAUDE.md` § V0.4 scope gets one paragraph. Bench result is recorded.

## Context recap

The existing `docs/observation-pipeline.md` is explicitly *not an ADR* (last section: "What this document deliberately is NOT"). It sketches V0.4 = A+B+C+D. V0.4 as planned here ships **only Slice A (typed `Finding` pipeline) with one parser** — narrower than the doc's original sketch. The narrower commitment must be reflected in writing so the implementing agent and future contributors don't drift.

Per `CLAUDE.md` § Workflow ("After implementation: summarize changed / verified / risks / next step"), the docs update is also where V0.5 hooks are anchored: a doc paragraph naming "the second filter when it lands" prevents the registry from accidentally calcifying around `tsc`-only assumptions.

## Files touched

- `docs/adr/0008-filter-engine-v0-4-tsc-pilot.md` — created.
- `docs/observation-pipeline.md` — edited (§ "Recommended slice for V0.4", § "Pipeline shape (V0.4 target)" trimmed to reality; § "Open questions" pruned of items now decided).
- `CLAUDE.md` — edited (add § V0.4 scope paragraph after § V0.3).
- `docs/README.md` — edited (link the new ADR + this plan; one line each).
- `README.md` (project root) — edited (Quickstart paragraph: `mira run "tsc --noEmit"` now produces compact markdown automatically).

## Interface / API change

None. Documentation only.

## Implementation notes

**ADR 0008 outline** (~140-170 lines, matches the style of ADRs 0005-0007):

```md
# ADR 0008: Filter engine V0.4 — typed Finding pipeline with tsc pilot

## Status
Accepted

## Context
- V0.0–V0.3 deliver structure + traceability; not compactness.
- Postmortem-001 + ADR 0007 split layers: hook = data, MCP = insight.
- The hook today does no transformation — agent token efficiency vs no-Mira: 0%.
- `docs/observation-pipeline.md` sketched V0.4 = A+B+C+D; this ADR narrows it to A with one filter (`tsc`) plus a minimal cascade-dedup pass (a slice of C).

## Decision
- A `Filter` is `(input, ctx) → { findings: Finding[]; markdown: string }`. (decisions § 2)
- Dispatcher strips wrappers (incl. `pnpm --filter`, `yarn workspace`, `bunx`, quoted args), returns a tagged result `miss | hit | error`, never throws. (§ 3, § 4)
- Filter sits in `runCommand` post-buffer, pre-print. Schema-validates the observation before write. (§ 1)
- Raw evidence untouched; `findings[]` populates `CommandObservation.findings`; `filterVersion: "tsc/1"` recorded in observation.json; new `filtered.md` for audit. (§ 6)
- Markdown uses `path:line:col` format (copy-pastable into editors); cascade-dedup clusters findings by `(ruleId, normalized-message)` and renders each cluster as 3 lines (template + concrete exemplar + locations) — semantic content preserved, not just structural shape; "Did you mean" suggestions are surfaced. (§ 9, § 9b, parser task)
- Markdown ends with `_evidence: .mira/runs/<id>/_`; stderr suppressed on filter hit; filter-exception case emits a one-line warning. (§ 7, § 8)
- Pilot: `tsc`. Pass gate (hard): `bench/filter/tsc.ts` — uses authoritative Anthropic `count_tokens` (committed in `tokens.json`), median ratio ≤ 0.30, ≥ 800 tokens saved on B1 fixture, 4 preservation gates (forward triple, body, parser line ≥ 0.85, reverse bijection), drift ≤ 5% vs committed counts, trend ≤ 10% drift vs last result, p95 ≤ 30ms. JSON output mode for CI. Pass gate (soft): manual Claude Code A/B on B1 (Task 09). (§ 9, § 10)
- Generic fallback: identity passthrough. (§ 5)

## Bench result (recorded at ship time, hard gate)
| fixture | tokens_in | tokens_out | drift | ratio | findings | preservation (T/B/C/bij) | p95 |
| ... | ... | ... | ... | ... | ... | ... | ... |
median ratio: X.XX
B1 tokens saved: XXXX
trend vs last: ±X.X% (within 10%)
verdict: PASS

## Manual Claude Code A/B result (recorded at ship time, soft gate)
- Baseline B1 median tokens: XXXXX
- Filter-on B1 median tokens: XXXXX
- Δ%: X.X%
- Success rate: baseline X/2, filter-on X/2
- verdict: PASS / FAIL / inconclusive (with note)

## Out of scope (V0.4)
- Cross-run diff (Axis 3), cross-file cascade clustering, speculative pre-fetch (Axis 4), LSP (Axis 2).
- A second filter. (V0.5+ — needs its own decision pass.)
- TOML registry / user-supplied filters.
- Streaming.
- Full SARIF compatibility (only `filterVersion` field added to schema; full SARIF is a separate later ADR).
- Fully-automated headless `claude -p` driven harness (post-V0.4 work).

## Invariants
- Raw evidence never touched on filter hit.
- Exit code preserved verbatim (tsc exits 2, NOT 1, on errors).
- Filter exception → tagged `error` result, stderr warning emitted, passthrough used; never crashes the agent's tool call.
- Wrapper-strip is pure; no filesystem checks.
- Information preservation: 4 gates — triple coverage (forward), body coverage (incl. cluster exemplar verbatim), parser-line coverage ≥ 0.85, bijection (reverse — every markdown triple maps back to a finding).
- Module dependency direction: `cli → filter → core` (one-way; `filter/` does not import from `cli/`, `store/`, or `command/`).

## Consequences
- Agents reading `mira run`-wrapped `tsc` output see ~70% fewer tokens on failure (measured against `o200k_base`).
- A second filter is one file (`src/filter/filters/<x>.ts`) + one registry line + fixtures + bench. The file split (parser/cluster/render/glue) becomes the convention.
- `filterVersion` field in observations enables Axis 3 (diff-on-rerun) in V0.5+.
- The next V0.5 decision is "build the headless `claude -p` harness" or "second filter" — both depend on whether the V0.4 soft gate landed PASS, FAIL, or inconclusive.
```

**`docs/observation-pipeline.md` edits** (small, targeted):

- § "Recommended slice for V0.4": replace the `A+B+C+D` table with a note that V0.4 shipped Slice A with one pilot (`tsc`); B, C, D moved to V0.5+.
- § "Pipeline shape (V0.4 target)": delete the speculative shape diagram and replace with a one-paragraph note pointing at ADR 0008 for the actual shape.
- § "Open questions": prune items now decided (registry layout, performance budget, cascade rules — partly). Mark schema versioning, streaming, MCP surface as still-open.

**`CLAUDE.md` § V0.4 scope** (new paragraph):

```md
## V0.4 scope

V0.4 ships the filter engine: a typed `Finding[]` pipeline with one pilot parser (`tsc`),
a deterministic cascade-dedup pass (cluster findings by `(ruleId, normalized-message)`),
and a tokenizer-based bench as the hard ship gate. Wrappers (`pnpm`, `npm`, `npx`, `yarn`,
`bun`, `bunx`, plus `pnpm --filter`, `yarn workspace`) are stripped before dispatch. On a
registered command, the agent receives compact markdown on stdout (`path:line:col` format,
copy-pastable) and `findings` populated in `CommandObservation.findings` along with
`filterVersion: "tsc/1"`; raw stdout/stderr/combined remain on disk under `.mira/runs/<id>/`.
Generic fallback: identity passthrough — no clever line-level deduper. Filter exceptions
fall through with a one-line stderr warning. The soft gate is a manual Claude Code A/B on
the eval B1 scenario (Task 09 in the V0.4 plan); a fully-automated headless `claude -p`
harness is post-V0.4 work. See ADR 0008.
```

**README.md (project root) edits:**

In the Quickstart section, after `mira run "bun test"`, add:

```md
For commands Mira recognizes (currently `tsc`), the agent gets a compact, structured view of the
output instead of raw bytes — raw stays one read away under `.mira/runs/<id>/`.
```

**Memory of what's NOT in this ADR** — explicitly leave the following for V0.5+:

- The second filter and the criterion that justifies it.
- Any TOML / config-driven extension.
- Cross-run diff.

This is the bargaining chip that prevents V0.5 work from being attributed to V0.4.

## Verification

- `bun tsc --noEmit` green (no broken markdown rendering in tools that compile docs).
- All in-repo links resolve (`docs/adr/0008-...md`, `docs/observation-pipeline.md`, etc.) — quick check via `grep -r "0008-filter-engine" docs/`.
- The bench result block in ADR 0008 is filled in with **actual** numbers from the most recent `bun bench/filter/tsc.ts` run, not placeholders.
- A reviewer reading ADR 0008 in isolation can implement V0.4 without reading the plan files (the plan is scaffolding; the ADR is the durable artifact).

## Exit criterion

- ADR 0008 committed with bench numbers filled in.
- `docs/observation-pipeline.md` updated and consistent with ADR 0008.
- `CLAUDE.md` § V0.4 scope present.
- `README.md` Quickstart mentions `tsc` recognition.
- `docs/README.md` indexes ADR 0008.
- A `grep -r "V0.4" docs/` shows V0.4 documented in exactly the places listed above (no stragglers in unrelated files).

## Depends on

- Task 07 — bench (need real numbers for the ADR's "Bench result" block)
- Task 09 — manual Claude Code A/B (need real numbers for the "Manual A/B result" block)

## Estimated diff size

~150 lines of documentation (~110 LOC ADR 0008, ~30 LOC edits to observation-pipeline + CLAUDE.md, ~10 LOC misc).
