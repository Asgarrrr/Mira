# A3 — build-summary-verb

Archetype A (test-driven bug fix). Spec: `docs/eval/04-scenario-corpus.md`.

**Bug:** `base.patch` swaps the verbs in `buildSummary`
(`src/core/command-observation.ts`) so success/failure summaries print the
wrong verb. Two snapshot-style assertions in
`tests/command-observation.test.ts` mismatch.

**Ground-truth fix:** restore `const verb = run.exitCode === 0 ? "exited" : "failed";`.

**Success:** `bun test tests/command-observation.test.ts` exits 0.

**Hypothesis:** the failing tests import the impl directly; `suspectedFiles`
should surface it via test-file/related-file signals.
