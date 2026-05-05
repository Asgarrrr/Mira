# ADR 0003: Phase 3 (summarizer) closed by the inline V0 summarizer

## Status

Accepted

## Context

`docs/workflow.md` Phase 3 calls for "a deterministic generic summarizer" with four DoD rules:

1. must not hide raw evidence
2. must produce evidence references
3. must be fixture-tested
4. must not claim unsupported facts

`docs/architecture.md` originally promised a `src/summarizers/generic-summarizer.ts` module to host that logic. In practice the V0 summarizer is implemented inline as `buildSummary` inside `src/core/command-observation.ts`. Reviewing whether that satisfies Phase 3 became necessary before opening Phase 4.

## Decision

Phase 3 is closed without a separate `summarizers/` module.

Justification against the four DoD rules:

1. **Hides no raw evidence.** `buildObservation` always emits `evidenceRefs` pointing at `stdout.log`, `stderr.log`, `combined.log`, and `metadata.json`. The summary string is additive.
2. **References evidence.** Every observation carries `evidenceRefs`, and `renderObservationMd` links each one in the markdown.
3. **Fixture-tested.** `tests/command-observation.test.ts` covers success, failure, timeout, and externally-signalled runs against a fixture `CommandRun`. `tests/render-observation.test.ts` is an exact-string snapshot of the rendered markdown for the same shapes.
4. **No unsupported claims.** ADR 0002 made `exitCode: number | null` the source of truth, so the summary can never say "exited with code N" when the run was signal-killed. The two summary forms ("exited with code N", "killed by ... after Xms") are exhaustive over the modeled state.

Command-specific summarizers (test runners, TypeScript errors, git diff) remain explicitly post-V0 per `workflow.md`.

## Consequences

- No new module is created. Adding a `summarizers/` directory with a single inline-equivalent function would violate the "épurée by default" principle from `architecture.md`.
- If Phase 5 or a new Phase introduces command-specific dispatch, extracting `buildSummary` becomes worthwhile and is a localized change (one function, two test files already pinning behavior).
- `architecture.md` has been updated to reflect the actual V0 source layout and to note the inline-summarizer choice.
