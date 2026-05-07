# B1 — verbose-typescript-failure

Archetype B (investigation under verbose output). Spec:
`docs/eval/04-scenario-corpus.md`.

**Bug:** `base.patch` strips the array wrapper from the `evidenceRefs`
schema in `src/core/command-observation.ts`
(`z.array(evidenceRefSchema)` → `evidenceRefSchema`). Because
`CommandObservation` is `z.infer`-ed, `evidenceRefs` flips from
`EvidenceRef[]` to a single `EvidenceRef`. `tsc --noEmit` then surfaces
~14 errors across `src/` and `tests/`.

**Ground-truth fix:** restore `evidenceRefs: z.array(evidenceRefSchema)`.

**Success:** `bun run typecheck && bun test` exits 0.

**Hypothesis:** Mira mode — `run_command("bun run typecheck")` returns a
one-line summary + `EvidenceRef`. The agent fetches the raw output once,
recognizes the type-shape pattern after a handful of errors, and stops
reading. Baseline mode dumps the full wall into the prompt unconditionally.
The gap is the test of whether opt-in retrieval is exercised.

**Risk:** baseline mode may exceed the 200k token cap; the harness reports
`stopReason = token_cap_exceeded` and `success = false`. That is a
legitimate observation, not a harness bug (per plan).
