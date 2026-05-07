# A2 — cap-suspected-files

Archetype A (test-driven bug fix). Spec: `docs/eval/04-scenario-corpus.md`.

**Bug:** `base.patch` lowers `SUSPECTED_FILES_CAP` in
`src/context/context-pack-generator.ts` from `20` to `10`. The existing
test "caps suspectedFiles at 20" then fails its length assertion.

**Ground-truth fix:** restore `SUSPECTED_FILES_CAP = 20` (per ADR 0005).

**Success:** `bun test tests/architecture-signal.test.ts` exits 0.

**Hypothesis:** calibration scenario — single-line diff, single locus.
Low gain expected; primarily checks the harness, not the agent.
