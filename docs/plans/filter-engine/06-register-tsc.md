# Task 06 — Register `tsc` and add e2e test

## Goal

Wire `tscFilter` into the registry so `mira run "tsc --noEmit"` (and wrapped variants like `pnpm tsc`) produce the filtered view end-to-end. One e2e test exercises the full hook pipeline against a tiny on-disk TS project.

## Context recap

After Task 03, the dispatcher is wired into `runCommand` but the registry is empty. After Task 05, `tscFilter` exists and is unit-tested. This task is the **one-line wiring** plus an integration test that catches regressions in the full pipeline (wrapper stripping → dispatch → filter → persist → print).

The integration test uses a real `tsc` invocation against a fixture project. Reasoning: snapshot tests on fixtures (Task 05) cover the parser; the e2e tests cover the **plumbing** — argument escaping, stdout capture, observation persistence, evidence pointer formatting.

## Files touched

- `src/filter/registry.ts` — edited (one line: `REGISTRY.set("tsc", tscFilter)` plus the import).
- `tests/cli-run-tsc.e2e.test.ts` — created.
- `tests/fixtures/tsc-e2e/` — created (a minimal TS project: one broken `.ts` file + a tsconfig).

## Interface / API change

None. The registry's exported shape is unchanged; only its contents differ at module load time.

## Implementation notes

**Registry update:**

```ts
// src/filter/registry.ts
import type { RegistryEntry } from "./types.ts";
import { tscFilter } from "./filters/tsc/index.ts";
import { TSC_FILTER_VERSION } from "./filters/tsc/version.ts";

export const REGISTRY: Map<string, RegistryEntry> = new Map<string, RegistryEntry>([
  ["tsc", { filter: tscFilter, version: TSC_FILTER_VERSION }],
]);
```

This is the **only** location in the codebase that references the filter implementation — keeping the dependency direction clean (`cli → run → dispatch → registry → filters/tsc/`).

The version literal lives in `filters/tsc/version.ts` and nowhere else (single source of truth — quality bar). The dispatcher reads `entry.version` and propagates it to the `DispatchResult` so `runCommand` can write `observation.filterVersion`.

**Fixture project shape** under `tests/fixtures/tsc-e2e/`:

```
tests/fixtures/tsc-e2e/
  tsconfig.json    # minimal: { "compilerOptions": { "noEmit": true, "strict": true } }
  broken.ts        # `export const x: number = "not a number";`
```

Add `tests/fixtures/**` to root `tsconfig.json` `exclude` if not already done by Task 04.

**E2E test outline:**

```ts
test("tsc filter fires end-to-end on a real failure", async () => {
  // Arrange: create a temporary cwd, copy fixture project in, ensure .mira/ is fresh
  const tmpdir = makeTmpProject(["tests/fixtures/tsc-e2e"]);

  // Act: invoke the CLI exactly as the hook does
  const result = await spawnCli(["run", "--quiet", "bunx tsc --noEmit -p ."], { cwd: tmpdir });

  // Assert: stdout shape
  expect(result.stdout).toMatch(/^# tsc — \d+ error(s)? in \d+ file(s)?/);
  expect(result.stdout).toContain("**TS"); // at least one diagnostic rendered
  expect(result.stdout).toMatch(/_evidence: \.mira\/runs\/run_[^_]+_[^/]+\/_/);

  // Assert: stderr is empty (filter hit + --quiet)
  expect(result.stderr).toBe("");

  // Assert: exit code preserved (tsc on errors exits non-zero)
  expect(result.exitCode).not.toBe(0);

  // Assert: persistence
  const runDirs = fs.readdirSync(`${tmpdir}/.mira/runs`);
  expect(runDirs.length).toBe(1);
  const runDir = `${tmpdir}/.mira/runs/${runDirs[0]}`;
  expect(fs.existsSync(`${runDir}/filtered.md`)).toBe(true);
  expect(fs.existsSync(`${runDir}/stdout.log`)).toBe(true);  // raw still present
  const obs = JSON.parse(fs.readFileSync(`${runDir}/observation.json`, "utf8"));
  expect(obs.findings.length).toBeGreaterThan(0);
  expect(obs.findings[0].severity).toBe("error");
});
```

**Wrapped invocation test (lighter weight).** Unit-test the dispatcher independently (Task 02 already covers it) — do not duplicate `pnpm tsc` / `npx tsc` in the e2e suite. Goal: e2e proves end-to-end plumbing for the simplest invocation; dispatcher unit tests prove wrapper handling.

**Avoid network and global state.** `bunx typescript` may resolve `typescript` from the host repo's `node_modules`. Confirm `typescript` is a dev dependency (`package.json`) and the test's `bunx` resolves to it without a download. If the test environment has no `typescript`, skip with a clear message rather than hanging.

**Test isolation.** Each run uses a fresh tmpdir (`mkdtemp`). After the test, clean up via the existing test harness pattern (look for `mkdtemp` usage in `tests/cli-run.e2e.test.ts`).

## Verification

```bash
bun test tests/cli-run-tsc.e2e.test.ts
bun test  # full suite — confirms no regression
bun tsc --noEmit
```

Manual smoke test from the repo root:

```bash
bun src/cli/index.ts run --quiet "bunx tsc --noEmit tests/fixtures/tsc/sources/small.ts"
```

Expected: compact markdown on stdout, `_evidence: .mira/runs/.../_` line, exit code non-zero, raw evidence in `.mira/runs/<id>/`.

## Exit criterion

- E2E test passes locally and in CI.
- Full `bun test` suite passes (no regression on existing tests).
- `bun tsc --noEmit` green.
- Manual smoke test produces the expected shape.

## Depends on

- Task 03 — wiring into `runCommand`
- Task 05 — `tscFilter` implementation

## Estimated diff size

~80 lines (~5 LOC registry, ~10 LOC fixture project, ~70 LOC e2e test).
