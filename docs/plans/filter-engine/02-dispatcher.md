# Task 02 — Dispatcher with wrapper stripping

## Goal

Implement `dispatchFilter(command, input, ctx) → FilteredView | null`: strips known wrappers, looks up the registry, returns a `FilteredView` on hit, `null` on miss or on filter exception.

## Context recap

With Task 01 providing the types and registry, the dispatcher is the only piece of logic between "command string + buffered output" and "either filtered view or passthrough". It does not touch the filesystem, does not import from CLI, and is purely deterministic.

Wrapper handling matters because Claude Code emits commands like `pnpm tsc --noEmit`, `npx tsc --noEmit`, `bun tsc --noEmit`. The dispatcher must extract `tsc` as the canonical program name regardless of how it is wrapped.

The dispatcher must **catch every exception** from a registered filter — graceful degradation is a hard invariant from the decisions doc (`00-decisions.md` § 5).

## Files touched

- `src/filter/dispatch.ts` — created (wrapper stripping + dispatch).
- `tests/filter-dispatch.test.ts` — created.

## Interface / API change

```ts
// src/filter/dispatch.ts
import type { DispatchResult, FilterContext, FilterInput } from "./types.ts";
import { REGISTRY } from "./registry.ts";

// Visible for tests.
export function extractProgramToken(command: string): string | null;

// Returns a tagged result. Three cases:
//   - { kind: "miss" }: no filter registered for this command (or unrecognized shape).
//   - { kind: "hit", view, filterVersion }: filter ran successfully; caller renders.
//   - { kind: "error", program, cause }: a registered filter threw; caller emits a
//     stderr warning and falls back to passthrough. The exception is captured but
//     never propagated — the agent's tool call must never fail because of Mira.
export function dispatchFilter(
  command: string,
  input: FilterInput,
  ctx: FilterContext,
): DispatchResult;
```

`extractProgramToken` returns the canonical program name after stripping wrappers, or `null` for an empty / unrecognized shape.

## Implementation notes

**Wrapper-stripping algorithm** (`extractProgramToken`):

1. Trim leading whitespace.
2. Strip leading `KEY=value` env assignments (regex `^(?:[A-Z_][A-Z0-9_]*=\S+\s+)+`).
3. Tokenize on whitespace.
4. While the leading token matches a known wrapper:
   - Drop the token.
   - If wrapper's next token is `run`, `exec`, `dlx`, or `x`, drop that too.
   - Drop wrapper-flag pairs: `--silent`, `-s`, `--`, `--filter <value>`, `workspace <name>`.
   - Drop any leading `--<flag>=<value>` tokens (single-token form of flag-with-value).
5. After all wrappers are consumed, return the next non-flag token. Strip leading/trailing `'`/`"` quote characters (in case the agent passed `'tsc'` or `"tsc"`).

**Wrapper set** (V0.4):

```ts
const WRAPPERS = new Set([
  "pnpm", "npm", "yarn", "bun", "npx", "bunx",
]);
```

- `npx`, `bunx` are one-token forms (no sub-token).
- `bun x`, `pnpm exec`, `npm exec`, `yarn run`, `bun run`, `pnpm dlx`, `pnpm run` are two-token forms — the algorithm drops the sub-token in step 4.
- `pnpm --filter foo run typecheck` and `yarn workspace foo tsc` are filter/workspace forms — `--filter <value>` and `workspace <name>` are flag-pair-and-value tokens dropped in step 4. Without this, those shapes return `foo` (a workspace name) and miss → no compression.

**Common shapes the algorithm intentionally does NOT cover** (false-negatives, all safe — passthrough):

- `dotenv -- tsc`, `cross-env CI=1 tsc`, `time tsc` — env / wrapper tools not in `WRAPPERS`. Adding them is a future task; for V0.4 the cost is "no compression in monorepos that wrap with these", and the agent still gets correct raw output.
- `node ./node_modules/.bin/tsc` — explicit node invocation, not a package manager wrapper.
- `./node_modules/.bin/tsc` — direct binary path. Returned program token is the full path, registry lookup fails. False-negative, no harm.
- `turbo run typecheck` — turbo's underlying script is opaque to us; we cannot know it runs `tsc`.

**Dispatch logic:**

```ts
export function dispatchFilter(
  command: string,
  input: FilterInput,
  ctx: FilterContext,
): DispatchResult {
  const program = extractProgramToken(command);
  if (program === null) return { kind: "miss" };
  const entry = REGISTRY.get(program);
  if (entry === undefined) return { kind: "miss" };
  try {
    const view = entry.filter(input, ctx);
    // Pretty-mode passthrough: parser detected a format it does not handle and
    // returned zero findings on a non-empty input. Treat as miss so the agent
    // gets raw output (not a wrong "tsc — pass" header). See 05-tsc-parser.md.
    if (view.findings.length === 0 && (input.stdout.length + input.stderr.length) > 0 && (input.exitCode ?? 0) !== 0) {
      return { kind: "miss" };
    }
    return { kind: "hit", view, filterVersion: entry.version };
  } catch (cause) {
    return { kind: "error", program, cause };
  }
}
```

**Error handling lives ONLY here.** Quality bar #5: no try/catch outside `dispatch.ts`. Filters propagate exceptions; the dispatcher is the single auditable boundary. The `runCommand` integration (Task 03) inspects `kind` and decides whether to write `filtered.md`, emit a stderr warning, or just passthrough.

**Pretty-mode pass-through.** When the tsc parser hits pretty-mode input, it returns zero findings (05-tsc-parser.md). The dispatcher treats "zero findings + non-empty input + non-zero exit code" as miss — the agent gets raw output, never a wrong "pass" header on a failing build.

**Keep `extractProgramToken` pure.** No filesystem checks. A user-named local script `./tsc` is not the wrapped `tsc` — that's fine; passthrough is the safe answer.

## Verification

Test name: `tests/filter-dispatch.test.ts`.

Coverage:

1. **Wrapper-stripping table-driven test.** Inputs and expected program tokens:

   | Input | Expected | Notes |
   |---|---|---|
   | `tsc --noEmit` | `tsc` | bare |
   | `pnpm tsc --noEmit` | `tsc` | one-token wrapper |
   | `pnpm exec tsc` | `tsc` | two-token (exec) |
   | `pnpm run typecheck` | `typecheck` | sub-token consumed; `typecheck` is the script name (won't match `tsc` registry) |
   | `npm run typecheck` | `typecheck` | |
   | `npx tsc -p .` | `tsc` | one-token (`npx`) |
   | `bunx tsc` | `tsc` | one-token (`bunx`) |
   | `bun x tsc` | `tsc` | two-token (`bun x`) |
   | `bun run typecheck` | `typecheck` | |
   | `yarn tsc` | `tsc` | |
   | `yarn run typecheck` | `typecheck` | |
   | `pnpm exec --silent tsc` | `tsc` | flag drop |
   | `CI=1 NODE_ENV=prod tsc` | `tsc` | env strip |
   | `pnpm --filter foo run typecheck` | `typecheck` | --filter value pair dropped, then `run` sub-token, then returns `typecheck` |
   | `pnpm --filter foo tsc` | `tsc` | --filter value pair dropped |
   | `yarn workspace foo tsc` | `tsc` | workspace value pair dropped |
   | `pnpm exec 'tsc'` | `tsc` | quote strip |
   | `pnpm exec "tsc"` | `tsc` | quote strip |
   | `` (empty) | `null` | |
   | `   ` (whitespace) | `null` | |
   | `pnpm` (just wrapper) | `null` | wrapper consumed, nothing left |
   | `dotenv -- tsc` | `dotenv` | NOT a covered wrapper — false-negative documented |
   | `time tsc` | `time` | NOT a covered wrapper — false-negative documented |
   | `./node_modules/.bin/tsc` | `./node_modules/.bin/tsc` | direct path; registry lookup fails — false-negative documented |

2. **Dispatch miss.** `dispatchFilter("ls", input, ctx)` returns `{ kind: "miss" }`.

3. **Dispatch hit.** Register a fixture filter under `"echo-test"` for the test (with version `"echo-test/1"`), then call `dispatchFilter("echo-test", input, ctx)` and assert `{ kind: "hit", view, filterVersion: "echo-test/1" }`. Clean up after the test.

4. **Filter exception is caught.** Register a filter that throws. Call dispatch. Expect `{ kind: "error", program: "throw-test", cause: <Error> }`, no exception propagated.

5. **Pretty-mode passthrough.** Register a filter that returns `{ findings: [], markdown: "# tsc — pass" }` on non-empty input + exitCode 2. Assert dispatch returns `{ kind: "miss" }`, NOT a hit with a wrong "pass" header.

```bash
bun test tests/filter-dispatch.test.ts
```

## Exit criterion

- All table-driven cases pass.
- Throwing filter test asserts the exception does not escape `dispatchFilter`.
- `bun tsc --noEmit` green.
- No new dependencies in `package.json`.

## Depends on

- Task 01 — types + registry

## Estimated diff size

~180 lines (~90 LOC dispatch — the flag-pair drop and quote-strip add ~20 LOC over the simple wrapper loop, ~90 LOC tests for the expanded table).
