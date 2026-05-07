# Task 03 — Wire dispatcher into `runCommand`

## Goal

Insert `dispatchFilter` into `src/cli/run.ts` so that, when the registry has a matching filter, the agent receives `view.markdown` on stdout (with an evidence pointer) and `findings[]` lands in `observation.json`. Raw evidence is unchanged. With an empty registry (Phase 1 state), behavior is bit-for-bit identical to today.

## Context recap

`runCommand` (`src/cli/run.ts`) currently does, in order:
1. `await observer.observe(command, cwd)` → `{ run, stdout, stderr }` (`run.ts:23`)
2. `buildObservation(run)` → observation with `findings: []` (`run.ts:25`)
3. Persist `observation.json` and `observation.md` (`run.ts:26-27`)
4. Print `stdout` to stdout, `stderr` to stderr (`run.ts:29-30`)
5. Print the `[mira] …` footer to stderr unless `--quiet` (`run.ts:32-41`)
6. Return `run.exitCode ?? 1` (`run.ts:43`)

This task inserts the filter call between step 2 (build) and step 3 (persist) so that observation persistence sees the populated `findings`. Print-out (step 4) checks if a filter fired and emits markdown instead of raw.

The decisions doc § 7 specifies: `--quiet` only suppresses the stderr footer; the in-markdown evidence pointer is appended on filter hit regardless of `--quiet`.

## Files touched

- `src/cli/run.ts` — edited (insert dispatch, branch print path, persist `filtered.md`, schema-validate before write, error warning).
- `src/store/evidence-store.ts` — edited (one new method: `writeFiltered(runId, markdown)`; add `"filtered_md"` to `RunFileKey`).
- `src/core/command-observation.ts` — edited (add optional `filterVersion: z.string().optional()` to schema).
- `tests/cli-run-filter.e2e.test.ts` — created (4 paths: miss, hit-with-quiet, hit-without-quiet, error-with-warning).
- `tests/cli-run.e2e.test.ts` — re-run to confirm no regression.

## Interface / API change

```ts
// src/store/evidence-store.ts — new public method
writeFiltered(runId: string, markdown: string): void;
```

Internally this writes `<runDir>/filtered.md` via the existing `writeRunFile` helper. Add `"filtered_md"` to `RunFileKey` and `FILENAMES`.

`runCommand`'s exported signature is unchanged.

## Implementation notes

**Modified `runCommand` flow** (pseudocode, not literal):

```ts
const { run, stdout, stderr } = await observer.observe(command, cwd);

// dispatchFilter returns null on miss, on filter exception (caught), or on
// pretty-mode passthrough (parser coverage = 0). It NEVER throws.
const dispatchResult = dispatchFilter(
  command,
  { stdout, stderr, exitCode: run.exitCode, signal: run.signal, durationMs: run.durationMs },
  { command, cwd, runId: run.id },
);

const observation = buildObservation(run);
if (dispatchResult.kind === "hit") {
  observation.findings = dispatchResult.view.findings;
  observation.filterVersion = dispatchResult.filterVersion;
}
// Validate the persisted shape — defensive parse against schema drift after the
// mutation. Cheap, catches a class of regressions where a future filter returns
// a Finding with extra/missing fields.
const validated = commandObservationSchema.parse(observation);
store.writeObservationJson(run.id, validated);
store.writeObservationMarkdown(run.id, renderObservationMd(validated, run));

if (dispatchResult.kind === "hit") {
  store.writeFiltered(run.id, dispatchResult.view.markdown);
  process.stdout.write(dispatchResult.view.markdown);
  if (!dispatchResult.view.markdown.endsWith("\n")) process.stdout.write("\n");
  process.stdout.write(`_evidence: .mira/runs/${run.id}/_\n`);
  // stderr suppressed on filter hit (decisions § 8).
} else {
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  // dispatchResult.kind === "error" → filter was registered for this program
  // but threw. Emit a one-line stderr warning so the agent can see the failure
  // (passthrough was used). REVIEW.md § K.5 — silent fallback is worse than a
  // visible notice.
  if (dispatchResult.kind === "error") {
    process.stderr.write(`[mira] filter threw for "${dispatchResult.program}"; passthrough used\n`);
  }
}

if (!quiet) { /* unchanged stderr footer */ }
return run.exitCode ?? 1;
```

**Dispatcher returns a tagged result, not just `FilteredView | null`.** Three cases:

```ts
type DispatchResult =
  | { kind: "miss" }                                         // no filter registered
  | { kind: "hit"; view: FilteredView; filterVersion: string }
  | { kind: "error"; program: string; cause: unknown };     // registered but threw or returned coverage = 0
```

The agent (and the user reading evidence) can distinguish "no filter for this command" from "filter crashed". The `error` case still means passthrough — the dispatcher swallows the actual exception so the agent's tool call never fails — but the warning line tells someone to look. **NB:** Task 02's contract changes accordingly; the simpler `null` return type in 02-dispatcher.md becomes this tagged result. Dispatcher implementation is still ~90 LOC; the additional code is the result construction.

**Why mutate `observation.findings`.** `buildObservation` returns a fresh object; mutating its `findings` field once before persistence is contained. An alternative is to thread the view into `buildObservation`, but that couples the core type to the filter module. Mutate-then-validate-then-persist keeps the boundary clean **and** catches schema drift. The `commandObservationSchema.parse` call costs <1ms and zero LOC of new logic.

**Exit-code preservation.** Real `tsc` exits with code 2 on errors, not 1. The current `runCommand` already returns `run.exitCode ?? 1` verbatim (`src/cli/run.ts:43`); the filter has zero authority over this. Tests must assert exit code 2 on a tsc failure, not exit code 1 (REVIEW.md missed-finding 7).

**`filterVersion` in the schema.** `commandObservationSchema` gains an optional field:

```ts
filterVersion: z.string().optional()
```

Optional because today's runs (no filter, or pre-V0.4 evidence) have no version. Filter-emitted observations always set it. Recorded in 00-decisions.md § 6.

**Evidence pointer format.** `_evidence: .mira/runs/<run-id>/_\n`. Markdown italics. Single line. Always trailing newline. The path is project-relative because the agent's CWD is the project root.

**Wrapper-stripping correctness check.** Task 02's tests cover the dispatch logic. Task 03 only verifies the **integration**: an arbitrary command like `ls` does NOT hit the filter, while a registered one does. Use the throwaway "echo-test" filter pattern from Task 02 (set up before, tear down after).

**No registry mutation outside tests.** Production calls only `dispatchFilter`; only test setup uses `REGISTRY.set(...)`.

**Stderr suppression on filter hit is conditional on `view !== null`.** A filter that returned `null` (ruled out by the type, but defensive) or threw (caught in dispatch, returns null) → passthrough. This guarantees we never silently lose stderr.

## Verification

Test file: `tests/cli-run-filter.e2e.test.ts`. Three scenarios:

1. **No filter registered → unchanged behavior.** Run `mira run "echo hello"`; assert stdout = `hello\n`, stderr = empty (or `[mira] …` if not quiet), exit 0, no `filtered.md` written.

2. **Registered filter → markdown + pointer + `findings` persisted.** Set up a fixture filter that returns `{ findings: [oneFinding], markdown: "## test\nbody" }` for command `"echo-test"`. Run via `runCommand(["echo-test"])`. Assert:
   - stdout matches `## test\nbody\n_evidence: .mira/runs/run_…/_\n`
   - stderr is empty (no `[mira]` footer because tests pass `--quiet`)
   - `.mira/runs/<id>/filtered.md` exists with `## test\nbody`
   - `.mira/runs/<id>/observation.json` has `findings.length === 1`
   - exit code is whatever `echo-test` returned

3. **`--quiet` interaction is correct.** Same setup as (2) but without `--quiet`; assert stdout still contains the markdown + pointer, stderr contains the `[mira] …` line.

4. **Filter exception → stderr warning + raw passthrough.** Register a fixture filter under `"throw-test"` that throws on call. Run `runCommand(["throw-test"])` with `--quiet`. Assert:
   - stdout = raw command output (passthrough)
   - stderr contains `[mira] filter threw for "throw-test"; passthrough used`
   - `.mira/runs/<id>/filtered.md` does NOT exist
   - `observation.json.findings === []` and `filterVersion` is unset
   - exit code is the command's actual exit code

5. **Existing `tests/cli-run.e2e.test.ts` still passes** without modification — confirms Phase 1's "invisible until a filter registers" promise.

```bash
bun test tests/cli-run-filter.e2e.test.ts
bun test tests/cli-run.e2e.test.ts
```

**Pre-implementation audit:** `grep -n "tsc" tests/cli-run.e2e.test.ts` to confirm no existing test invokes `tsc`. (If one does, it would break in Phase 2; flag in the PR.)

## Exit criterion

- All four scenarios above pass.
- `bun test` for the full suite passes.
- `bun tsc --noEmit` green.
- No new external dependencies.
- `src/cli/run.ts` diff is ≤ ~45 added LOC (filter integration only; no refactor of unrelated code). The "Estimated diff size" section below quotes ~40 in `run.ts` — accept that as the realistic budget; the dispatch call + tagged-result branching + schema validation + writeFiltered + error warning do not compress below ~40 without sacrificing readability.

## Depends on

- Task 02 — dispatcher

## Estimated diff size

~140 lines (~40 in `run.ts`, ~10 in `evidence-store.ts`, ~5 in `command-observation.ts` for the optional schema field, ~85 LOC tests across 4 scenarios).
