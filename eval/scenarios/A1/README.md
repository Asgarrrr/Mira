# A1 — parse-porcelain-rename

Archetype A (test-driven bug fix). Spec: `docs/eval/04-scenario-corpus.md`.

**Bug:** `base.patch` collapses the rename/copy branch in `parsePorcelainZ`
(`src/architecture/sense.ts`) so `i` advances by 1 always, instead of `i += 2`
on `R`/`C` status entries. The OLD path token is mis-parsed as another entry.

**Ground-truth fix:** restore the `if (X === "R" || X === "C") { i += 2; } else { i += 1; }` branch.

**Success:** `bun test tests/architecture-signal.test.ts` exits 0. The test
"handles rename status without leaking OLD path" is the breakage target.

**Hypothesis:** Mira's `suspectedFiles` (related-file/test-file) should
surface the implementation file from the failing test name; baseline mode
must grep for it.
