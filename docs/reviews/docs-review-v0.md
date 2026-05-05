# Mira Docs Review — V0

Review of all markdown in the repository against the V0 charter:
*Mira is the context, evidence, and quality layer for AI coding agents; the first vertical slice is `command -> raw evidence -> observation -> context pack`; Mira must stay épurée and must not clone RTK or Sentrux.*

Files reviewed:

- `README.md`
- `CLAUDE.md`
- `docs/mira-thesis.md`
- `docs/architecture.md`
- `docs/domain-model.md`
- `docs/comparables.md`
- `docs/non-goals.md`
- `docs/workflow.md`
- `docs/adr/0001-core-abstractions.md`

---

## Summary

The conceptual direction is coherent: evidence-backed observations as the central object, a small CLI vertical slice, deliberate distance from RTK and Sentrux. The thesis, ADR, and non-goals all point in the same direction.

The execution of the docs has three structural problems:

1. **Doc volume outpaces code.** ~1300 lines of markdown cover ~30 lines of TypeScript. The docs describe a V0–V6 product while the repo has not built V0 yet. This is the opposite of épurée.
2. **The product definition drifts between files.** The README describes a *different product* than CLAUDE.md and the thesis (different one-line definition, different primitives, no mention of `mira run`). The set of "core abstractions" varies between CLAUDE.md, the ADR, and the domain model.
3. **V0 boundaries leak.** ArchitectureSignal, multiple summarizers, an "Architecture Kernel", and a `mira context` command appear inside the V0 scope in some files and outside it in others. The most direct violations of the non-goals (RTK clone, Sentrux clone) come from Mira's own internal docs, not from external pressure.

These issues are fixable without rewriting the thesis. The ideas are right; the surface area is too large.

---

## Major issues

### M1. README and CLAUDE.md disagree on what Mira is

- `README.md:3`: *"Mira is a context operating system for coding agents."*
- `CLAUDE.md:7` and `docs/mira-thesis.md:6`: *"Mira is the context, evidence, and quality layer for AI coding agents."*

"Operating system" implies a broad orchestration product. "Layer" implies a narrow infrastructure component. The non-goals doc explicitly rejects orchestration (`docs/non-goals.md:85-95`) and UI products. The README definition contradicts the rest.

### M2. README lists primitives that are not in V0

`README.md:35-43` lists Mira's "early scope" as:

- repository maps
- file ranking for a given task
- context packs
- signal digestion for command output
- explanations for why context was selected

CLAUDE.md V0 is `mira run`, evidence capture, `CommandObservation`, observation markdown, and a simple `ContextPack`. Repository maps, file ranking, and selection explanations are not in any V0 scope statement, are not in the four kernels, and are not in the ADR. The README does not mention `mira run` at all.

A new reader of the README would build a different product than a new reader of CLAUDE.md.

### M3. The set of "core abstractions" is inconsistent across files

| Source | Abstractions |
|---|---|
| `CLAUDE.md:55-60` | EvidenceStore, CommandObserver, CommandObservation, ContextPack, ToolAdapter, **ArchitectureSignal** |
| `docs/adr/0001-core-abstractions.md:23-31` | EvidenceStore, CommandObserver, CommandObservation, ContextPack, ToolAdapter — *ArchitectureSignal explicitly deferred* |
| `docs/domain-model.md` | Evidence, EvidenceRef, CommandRun, CommandObservation, Finding, ImportantLine, ContextPack, ArchitectureSignal, ToolAdapter |

The ADR says ArchitectureSignal is V0+1. CLAUDE.md lists it as V0. The domain model adds five more concepts (`Evidence`, `EvidenceRef`, `CommandRun`, `Finding`, `ImportantLine`) that are not on either list, and never explains why they were promoted to V0. A reader cannot tell which set is authoritative.

### M4. ContextPack is V0 in some files, V1 in another

- `CLAUDE.md:49`: V0 includes "generate a simple `ContextPack` from recent evidence".
- `docs/workflow.md:84-105`: Phase 4 of V0 is "Context Pack" with `mira context "<task>"`.
- `docs/mira-thesis.md:208-216`: roadmap says **V0 = Evidence + CommandObservation, V1 = ContextPack generation**.

This is a direct contradiction. It also blurs whether `mira context` is part of the first vertical slice CLI.

### M5. The "Architecture Kernel" violates the non-goals doc

`docs/architecture.md:102-126` defines an Architecture Kernel and gives it a V0 scope (changed-files summary, repo tree summary, related-file hints, test detection). `docs/non-goals.md:34-51` says Mira should not start with architecture features and should not become a Sentrux clone. `docs/workflow.md:107-120` puts architecture signals in Phase 5, after V0.

Naming a kernel "Architecture Kernel" and giving it V0 scope is the exact Sentrux-clone failure mode the non-goals doc warns against. Either drop the kernel from V0 or rename it to "Repo Hints" with sharply reduced scope.

### M6. Multiple specialized summarizers are an RTK-clone failure mode

- `docs/architecture.md:191-194` proposes three summarizer files in `src/summarizers/`: `command-output-summarizer.ts`, `generic-summarizer.ts`, `test-output-summarizer.ts`.
- `docs/workflow.md:67-82` lists Phase 3 summarizers as: generic, test output, **TypeScript error**, git diff/status.
- `docs/non-goals.md:14-31` says Mira must not start by supporting "100+ command filters" and must not equal "shorter command output".

A "TypeScript error summarizer" is the canonical RTK pattern. Building three to four command-specific summarizers in V0 is precisely the RTK-clone trajectory the non-goals doc rejects. V0 should ship one generic deterministic summarizer, with command-specific ones gated behind V1+.

### M7. ArchitectureSignal is over-typed for V0

`docs/domain-model.md:121-143` defines `ArchitectureSignal.kind` as a union of seven values: `"changed-files" | "dependency-risk" | "boundary-risk" | "missing-test" | "cycle" | "complexity" | "unknown"`. Five of those (dependency-risk, boundary-risk, missing-test, cycle, complexity) are Sentrux concepts that V0 explicitly does not implement. Putting them into the V0 type system encourages someone to start producing them.

If the type must exist in V0 at all (questionable per ADR 0001), it should be `kind: "changed-files" | "unknown"`, with the union grown when each kind is actually implemented.

### M8. `Evidence` (the domain primitive) is described but never typed

`docs/domain-model.md:3-21` introduces `Evidence` prose-only. `EvidenceRef` is typed (`docs/domain-model.md:25-31`). `CommandRun` is typed. There is no `Evidence` type. The reader is left guessing whether `Evidence` is a type, a category, or just a label for "stuff in the EvidenceStore". Given that "every conclusion must link to evidence" is the project's central invariant, this is the abstraction that most needs precision.

---

## Minor issues

### m1. RTK/Sentrux comparison is duplicated three times

The same comparison appears in `docs/mira-thesis.md:100-145`, `docs/comparables.md` (entire file), and `docs/non-goals.md:14-51`. `comparables.md` should be the canonical place. Thesis and non-goals should reference it instead of restating it.

### m2. Four overlapping lists of constraints

- `docs/mira-thesis.md:189-202` "Core invariants" (10)
- `docs/adr/0001-core-abstractions.md:124-131` "Invariants" (6)
- `CLAUDE.md:13-26` "Core principles" (12)
- `docs/architecture.md:222-230` "Quality bar" (6)

These overlap heavily but none is a strict subset of another. Pick one canonical list (likely the ADR's invariants) and have the others reference it.

### m3. "What Mira is not" is duplicated

- `docs/mira-thesis.md:88-98` "What Mira is not" (7 items)
- `docs/non-goals.md` (entire file, 9 sections)
- `README.md:19` ("Mira is not an autonomous coding agent")
- `CLAUDE.md:11` ("Mira is not a coding agent")

`non-goals.md` is canonical. Trim the thesis section to a single sentence linking out.

### m4. `mira-thesis.md` mixes V0 features with V2–V5 features in the "What Mira is" list

`docs/mira-thesis.md:71-80` lists eight things Mira "provides", including session memory and command intelligence — both explicitly post-V0 per the same file's roadmap (`docs/mira-thesis.md:208-216`). A reader cannot tell which of the eight are real today.

### m5. Source structure is overspecified for V0

`docs/architecture.md:172-208` lays out 13 source files including `architecture-signal.ts`, three summarizers, and a separate `command-runner.ts` alongside `command-observer.ts` and `raw-shell-command-observer.ts`. The actual V0 slice needs roughly: `evidence-store.ts`, `command-observation.ts`, `context-pack.ts`, `cli.ts`, plus tests. Anything beyond that should be added when justified, not pre-committed in a doc.

### m6. `ToolAdapter<TInput, TOutput>` does not enforce the evidence invariant

`docs/domain-model.md:149-154` types `ToolAdapter` as `{ name; observe(input): Promise<TOutput> }`. There is no constraint that the output must produce or reference evidence. Given that "adapters must be replaceable" and "external tools should be converted into Mira-native evidence" are stated invariants, the type should reflect them — e.g., `observe(input): Promise<{ observation; evidenceRefs: EvidenceRef[] }>`.

### m7. `Finding` and `ImportantLine` overlap without clear rules

`docs/domain-model.md:78-100` defines both. A `Finding` has severity, title, description, and evidence refs. An `ImportantLine` has source, line number, text, and reason. There is no guidance on when an extracted line becomes a finding, or whether findings can wrap important lines. Either collapse them or document the relationship.

### m8. "Run id", "context id", "evidence id" are referenced but never specified

`docs/architecture.md:67-79` shows the file layout using `<run-id>` and `<context-id>` placeholders. Nothing defines them. For a project that values determinism, the id format (timestamp, ULID, sequential, hash) is a real V0 decision and worth a sentence.

### m9. "Recent evidence" is undefined

`CLAUDE.md:49`: "generate a simple `ContextPack` from recent evidence". `docs/workflow.md:91`: "read recent observations". Recent in what sense — last N runs, last hour, runs since last context pack? Ambiguous.

### m10. MCP appears as both an adapter and an integration target

`docs/architecture.md:144-156` lists MCP in the adapter layer (Mira consumes external tools). `docs/workflow.md:122-140` lists MCP under "Agent Integration" (Mira exposes tools to agents). These are opposite directions of integration. The doc should distinguish "Mira-as-MCP-server" from "Mira-as-MCP-client".

### m11. CLAUDE.md duplicates the global summary format

`CLAUDE.md:113-131` defines a "Summary format" that overlaps with the format already enforced by the user's global `~/.claude/CLAUDE.md` (visible in the active context: "End-of-turn report: what changed, why, how it was verified, what remains"). Either drop the project-level copy or, if the project format truly differs, mark the difference explicitly.

### m12. Stack speculation in CLAUDE.md

`CLAUDE.md:90-98` lists five future Rust use cases. None of them are V0. Listing them in the agent's primary instruction file is noise; move them to a `docs/stack.md` or to the thesis.

### m13. README does not link to the docs

The README (44 lines) does not point a curious reader to `docs/`. For an open-source-style project, this is a small gap.

### m14. Markdown fence inconsistency

Several code fences in the docs are closed with four backticks instead of three (`docs/mira-thesis.md:174`, `docs/architecture.md:13`, `docs/non-goals.md:25`, `docs/comparables.md:93`, `docs/workflow.md:13`). They render correctly in some renderers and break in others. Worth a pass.

---

## Suggested deletions

Strictly removable without information loss:

1. **`docs/mira-thesis.md` "Related tools" section (lines 100–127)** — fully covered by `docs/comparables.md`.
2. **`docs/mira-thesis.md` "What Mira is not" section (lines 88–98)** — fully covered by `docs/non-goals.md`.
3. **`docs/mira-thesis.md` "Core invariants" list (lines 189–202)** — superset of `docs/adr/0001-core-abstractions.md` Invariants and CLAUDE.md Core principles; duplication.
4. **`docs/architecture.md` "Architecture Kernel" subsection in V0 form (lines 102–126)** — directly contradicts the non-goals doc. Defer to a later doc.
5. **`docs/architecture.md` "summarizers" subdirectory plurality (line 191–194)** — keep `generic-summarizer.ts` only; drop the test-output summarizer until justified.
6. **`docs/workflow.md` Phase 3 specialized summarizer list (lines 70–73)** — leave Phase 3 as "deterministic generic summarizer" and treat command-specific ones as later phases.
7. **`docs/domain-model.md` `ArchitectureSignal` type as currently defined (lines 121–143)** — defer the full enum until each kind is implemented; per ADR 0001 this should not be a V0 concept at all.
8. **`CLAUDE.md` "Stack — Rust may be considered" block (lines 90–98)** — speculative; not actionable for V0 work.
9. **`CLAUDE.md` "Summary format" section (lines 113–131)** — overlaps with the user's global instructions; remove unless the project format genuinely differs.

---

## Suggested rewrites

### R1. README.md

Realign with the canonical one-line definition. Replace the "context operating system" framing and the speculative primitives list with the actual V0 vertical slice. Add a short "Status: V0 in progress" note and link to `docs/`.

Suggested skeleton:

```
# Mira

Mira is the context, evidence, and quality layer for AI coding agents.
[short paragraph from thesis]

## Status

V0 in progress. The first vertical slice is:
mira run "<command>" -> raw evidence -> observation -> context pack

## Documentation
- docs/mira-thesis.md
- docs/architecture.md
- docs/non-goals.md
- docs/workflow.md
```

### R2. CLAUDE.md

Tighten to ~70 lines. Drop the Stack speculation, drop the local Summary format, collapse Core principles by referencing the ADR invariants, and either drop ArchitectureSignal from the core abstractions list or mark it as "post-V0, listed for awareness".

### R3. `docs/mira-thesis.md`

Cut the duplicated comparison and not-this sections (see deletions). Mark the V0–V6 roadmap as "indicative, not committed". Reconcile the "What Mira provides" list with the roadmap so a reader can see which features exist today.

### R4. `docs/architecture.md`

Remove the Architecture Kernel section from V0. Reduce the source structure to the files V0 actually requires. Define the run-id format explicitly. State the evidence-store interface boundary that adapters must respect.

### R5. `docs/domain-model.md`

Add a typed `Evidence` (or remove the prose definition). Reduce `ArchitectureSignal.kind` to `"changed-files" | "unknown"` for V0. Justify or merge `Finding` vs `ImportantLine`. Tighten `ToolAdapter` to require evidence references in its output.

### R6. `docs/workflow.md`

Decide whether ContextPack is V0 (Phase 4) or V1, and align with `mira-thesis.md`. Replace the multi-summarizer list in Phase 3 with one generic summarizer.

### R7. `docs/non-goals.md`

Promote this doc — it is the strongest piece in the set. Add explicit cross-references from architecture.md and the thesis to the relevant non-goals so future drift is harder.

---

## Final recommended doc structure

Keep the doc set small and let each file have a single job.

```
README.md                          public-facing, V0-aligned, links to docs/
CLAUDE.md                          slim agent instructions, ~70 lines
docs/
  thesis.md                        why Mira exists, the épurée principle
  architecture.md                  V0 architecture only
  domain-model.md                  V0 types only; post-V0 marked clearly
  workflow.md                      phase plan with single source of truth on V0 boundary
  non-goals.md                     keep as is, promote to canonical
  comparables.md                   the only RTK/Sentrux comparison in the repo
  adr/
    0001-core-abstractions.md     keep
  reviews/
    docs-review-v0.md              this file
```

This removes one file (consolidate `mira-thesis.md` → `thesis.md` after dedup) and clarifies role boundaries.

---

## Prioritized fix list

P0 — fixes that prevent implementation drift:

1. **Pick one one-line definition of Mira** and replace the README divergence (M1).
2. **Decide whether ContextPack is V0 or V1** and reconcile CLAUDE.md, thesis, and workflow (M4).
3. **Remove ArchitectureSignal from V0 core abstractions** in CLAUDE.md and tighten the domain model type (M3, M7).
4. **Reduce Phase 3 summarizers to one generic summarizer** in workflow.md and architecture.md (M6).
5. **Remove or rename the V0 "Architecture Kernel"** in architecture.md (M5).

P1 — fixes that reduce confusion:

6. Realign README primitives with V0 vertical slice (M2).
7. Type `Evidence` properly or stop calling it a primitive (M8).
8. Specify run-id, context-id, and "recent evidence" semantics (m8, m9).
9. Resolve `Finding` vs `ImportantLine` overlap (m7).
10. Constrain `ToolAdapter` to enforce evidence invariant (m6).

P2 — cleanup:

11. Deduplicate RTK/Sentrux content into `comparables.md` only (m1).
12. Pick one canonical list of invariants/principles (m2).
13. Slim CLAUDE.md (drop Rust speculation and duplicated summary format) (m11, m12, R2).
14. Add docs/ links from README (m13).
15. Distinguish MCP-as-adapter from MCP-as-server (m10).
16. Fix code fence inconsistencies (m14).

---

## Does the architecture support the V0 vertical slice cleanly?

**Yes, with subtraction.** The flow `User → mira run → CommandObserver → EvidenceStore → CommandObservation → ContextPack → Agent output` (`docs/architecture.md:23-46`) is the right shape. The V0 slice maps onto: `EvidenceStore` (file-based), `CommandObserver` (raw shell), `CommandObservation` (typed), `ContextPack` (simple bundle), one CLI entry point.

The architecture document drags in concepts the V0 slice does not need: Architecture Kernel, multiple summarizers, RTK/Sentrux adapters, an MCP integration phase, a 13-file source layout. Stripping those out leaves a clean slice. The conceptual core is sound; the surface area around it is too generous for a project that has not yet executed `mira run`.

---

## Is CLAUDE.md short enough and useful enough?

**Mostly yes, with two trims.** At 132 lines it is acceptable, but:

- The "Stack — Rust may be considered later" block (`CLAUDE.md:90-98`) is speculative and adds nothing for V0 work.
- The "Summary format" block (`CLAUDE.md:113-131`) duplicates the user's global `~/.claude/CLAUDE.md` summary format. Drop unless the project format actually differs.
- The "Core abstractions" list (`CLAUDE.md:55-60`) is the file's most important content but currently misleads by including ArchitectureSignal as core. Either remove it or annotate it as deferred.

After those trims CLAUDE.md should land near 70 lines and become a tight, V0-aligned instruction file.
