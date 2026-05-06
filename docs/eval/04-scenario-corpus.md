# 04 — Scenario corpus

## Archetypes

Four archetypes cover the dimensions where Mira *should* and *shouldn't* matter. Each archetype is a hypothesis about which tools, in which mode, would be most relevant.

### A. Test-driven bug fix

A repository contains a single failing test. Task: make it pass without breaking the others.

**Mira hypothesis:** `generate_context_pack` surfaces the failing test name and the related implementation files via `suspectedFiles` (V0.2 architecture sensing). The agent reaches the right file faster, reads less.

**Why this archetype is most informative for V0.3:** it exercises the Command Kernel (run the test) and the Context Kernel + Architecture sensing (find the right file). Two of the five tools are naturally relevant.

### B. Investigation under verbose output

A repository emits a structurally large failure (many TS errors, many test failures, a stack trace + log dump). Task: diagnose and fix.

**Mira hypothesis (refined per `02-thesis-and-metrics.md`):** `run_command` returns a structured `CommandObservation` with a generic one-line summary and an `EvidenceRef` to the raw output on disk. The agent decides whether to fetch the raw output (`get_raw_evidence`) or proceed with what the structure already tells it (exit code, command, evidence pointers). In baseline mode the full output is in-prompt by default, no choice. The win is *agent autonomy over retrieval*, not active summarization.

**Where the gap should be largest:** when a single root cause produces N>>1 cascading failures — the agent only needs to read a handful of errors, not all of them, to find the root cause. Mira mode lets it stop reading; baseline mode delivers the wall.

### C. Code locality task

"Where is X implemented in this repo?" Task: list the file paths that contain X's logic.

**Mira hypothesis:** `generate_context_pack` returns `suspectedFiles` already; the agent can answer faster.

**Why interesting:** isolates the Architecture sensing. Pure read task, no execution.

### D. Negative control

A pure logic task that doesn't require codebase context. Example: "implement a function that takes an array of integers and returns the longest increasing subsequence's length."

**Mira hypothesis:** zero. Mira's tools are about codebase context; this task has no codebase. Mira shouldn't move the needle.

**Why crucial:** if Mira "wins" here, the experiment has a confounder — probably token accounting or task ambiguity.

## First-experiment scenarios (3× archetype A + 1× archetype B)

Four scenarios, all synthetic on Mira itself. Ground truth = the original commit; automated success checks = existing tests (or `bun run typecheck`). Three archetype A scenarios calibrate the harness on small bug-fix tasks where Mira's gain should be modest. One archetype B scenario (B1) probes the place where Mira's *structural* opt-in advantage should be largest — a single root cause producing many cascading failures.

### A1 — `parse-porcelain-rename`

**Bug to introduce:** in `src/architecture/sense.ts`, `parsePorcelainZ`, change the rename/copy handler:

```ts
// BEFORE (correct)
if (X === "R" || X === "C") { i += 2; }
else { i += 1; }

// AFTER (buggy)
i += 1;  // forgets to consume the OLD path token after R/C
```

**Caveat:** the existing test suite does not directly exercise rename status. Building this scenario requires **adding a rename-status test to `tests/architecture-signal.test.ts`** as part of scenario assembly — the test is what makes the success check automated. This work is part of sub-task iii in [`05-first-experiment.md`](./05-first-experiment.md).

**Task description (for the agent):** "After a `git mv`, `senseArchitecture` returns a path that doesn't exist. The new test `tests/architecture-signal.test.ts` 'handles rename status without leaking OLD path' is failing. Find the bug and fix it. Don't break existing tests."

**Success script:** `bun test tests/architecture-signal.test.ts` exits 0.

### A2 — `cap-suspected-files`

**Bug to introduce:** in `src/context/context-pack-generator.ts`, change `SUSPECTED_FILES_CAP = 20` to `SUSPECTED_FILES_CAP = 10`.

**Test that should fail:** `tests/architecture-signal.test.ts` "caps suspectedFiles at 20" (lines 377–400) — the test expects `length === 20`. With the cap at 10 it fails immediately, no scenario instrumentation needed.

**Task description:** "The test 'caps suspectedFiles at 20' is failing. Make it pass. Make sure no other test breaks."

**Success script:** `bun test` exits 0.

### A3 — `build-summary-verb`

**Bug to introduce:** in `src/core/command-observation.ts`, `buildSummary`, swap the verbs on non-zero exit:

```ts
// BEFORE
const verb = run.exitCode === 0 ? "exited" : "failed";

// AFTER
const verb = run.exitCode === 0 ? "failed" : "exited";
```

**Test that should fail:** `tests/command-observation.test.ts` snapshot tests for the failed-command summary string mismatch on the verb.

**Task description:** "`bun test` reports failures in command-observation tests. Diagnose and fix."

**Success script:** `bun test tests/command-observation.test.ts` exits 0.

### B1 — `verbose-typescript-failure`

**Bug to introduce:** in `src/core/command-observation.ts`, change the field declaration on `CommandObservation`:

```ts
// BEFORE (correct)
evidenceRefs: EvidenceRef[];

// AFTER (buggy)
evidenceRefs: EvidenceRef;
```

A 4-character delete (`[]`). The cascade is large: every consumer of `obs.evidenceRefs.find(...)`, `for (const ref of obs.evidenceRefs)`, the array literal in `buildObservation`, every test snapshot constructing a `CommandObservation`, and every MCP tool returning one. `bun run typecheck` produces dozens of errors across `src/` and `tests/`.

**Why this exact bug:** a single root cause (the wrong type) producing many surface symptoms is exactly the shape where Mira's "raw evidence is opt-in" framing should pay off. The agent doesn't need to read every error to find the root cause — it needs to read a handful, recognize the type-shape problem, and fix the type. In baseline mode all errors flow into the prompt; in Mira mode the agent gets a structured observation and chooses how much detail to pull.

**Task description (for the agent):** "`bun run typecheck` is failing with many errors. Find the root cause and fix it. Then verify `bun test` is also green."

**Success script:** `bun run typecheck` exits 0 **and** `bun test` exits 0.

**Predicted Mira behavior:** if the agent fetches `get_raw_evidence` of stdout once and stops reading after spotting the type-shape pattern, Mira mode burns far fewer tokens than baseline (where the full typecheck output is unconditional). If the agent reads the entire raw output anyway, Mira mode adds one round trip; result ≈ baseline. The gap is the test of whether opt-in retrieval is exercised.

## Scenario format

Each scenario directory contains exactly:

```
scenarios/<id>/
  base.patch        unified diff that, applied with `git apply`, introduces the bug
  task.txt          plain-text task description, no markdown, no leading hints
  success.sh        executable shell script; exits 0 if the agent succeeded
  README.md         human notes: bug summary, ground-truth fix location, hypothesis
```

The harness uses `base.patch` (not a frozen tarball) so scenarios drift forward with the codebase — a scenario that ceases to apply cleanly is a signal to retire or update it.

## Out of scope (first experiment)

- Additional archetype B scenarios beyond B1
- Archetypes C and D — added in a second experiment once the harness has produced first-round data
- External-repo scenarios (SWE-bench-lite samples)
- Multi-step tasks (the agent must do A then B)
- Tasks that require running services / databases
