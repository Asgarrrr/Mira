# Task 04 — Capture three real `tsc` failure fixtures

## Goal

Commit three real `tsc --noEmit` output fixtures (small, medium, large) under `src/filter/filters/tsc/__fixtures__/` (co-located with the filter, per 00-decisions.md § 9c bullet 3 and § 11 file layout) so the parser, renderer, and bench have stable, reproducible inputs.

## Context recap

The pilot filter targets `tsc` (`00-decisions.md` § 9). Snapshot tests and the bench need committed fixtures so behavior is reproducible across machines, TS versions, and CI environments. Pinning fixtures is the cheapest way to defend against R4 (`tsc` format drift across versions) — when TS upgrades, fixtures are recaptured deliberately, not by surprise.

This task is **data-only**. No source code changes.

## Files touched

- `src/filter/filters/tsc/__fixtures__/small.txt` — created (~10-20 lines, 1-2 errors).
- `src/filter/filters/tsc/__fixtures__/medium.txt` — created (~80-150 lines, 5-15 errors, multiple files; **B1-shaped: cascade of `evidenceRefs` typing errors**).
- `src/filter/filters/tsc/__fixtures__/large.txt` — created (~400-600 lines, 30+ errors with cascade).
- `src/filter/filters/tsc/__fixtures__/tokens.json` — created (authoritative token counts via `anthropic.messages.count_tokens`; see 00-decisions.md § 10).
- `src/filter/filters/tsc/__fixtures__/README.md` — created (how each fixture was captured, TS version, the source code that produced it, the `tokens.json` regeneration procedure, the dual-mode behavior of `scripts/capture-tokens.ts` while `tscFilter` is unbuilt).
- `src/filter/filters/tsc/__fixtures__/sources/` — created (the small TS files used to produce the fixtures, so anyone can re-run `tsc --noEmit` and verify).
- `scripts/capture-tokens.ts` — created (one-shot script that reads each fixture + the matching expected-rendered output and writes `tokens.json`; uses `@anthropic-ai/sdk` `messages.count_tokens`). **Robust to missing `tscFilter`** (Task 05 not yet shipped at fixture-capture time): when the import fails, raw counts only are captured and `filtered_expected` is set to `null`; a stderr note instructs to re-run after Task 05.

## Interface / API change

None.

## Implementation notes

**Fixture capture procedure** (record in `src/filter/filters/tsc/__fixtures__/README.md`):

```bash
cd src/filter/filters/tsc/__fixtures__/sources
bunx -p typescript@<pinned> tsc --noEmit --pretty=false small.ts > ../small.txt 2>&1 || true
bunx -p typescript@<pinned> tsc --noEmit --pretty=false medium.ts > ../medium.txt 2>&1 || true
bunx -p typescript@<pinned> tsc --noEmit --pretty=false large.ts > ../large.txt 2>&1 || true
```

The `|| true` is critical — `tsc` exits non-zero on errors and we want to capture the output. `--pretty=false` strips ANSI/color so the parser regex (Task 05) doesn't have to fight escape codes.

**B1 fixture (medium.txt).** Captured via the eval scenario, not from a hand-rolled `medium.ts` source. Procedure: `git apply eval/scenarios/B1/base.patch` in a worktree, run `bun tsc --noEmit --pretty=false` from the repo root, redirect to `medium.txt`. The README documents this. (`sources/medium.ts` exists as a smaller stand-in only if the patch-based capture proves to be flaky to reproduce; the B1 patch is the source of truth for medium.)

**Pin the TS version.** The README must record the exact `typescript` version used (read from `package.json` of the host repo at capture time). Re-capturing on TS upgrade is a deliberate task, not a maintenance accident.

**Token capture procedure** (run once at fixture creation, re-run when the renderer or cascade-dedup changes):

```bash
# Requires ANTHROPIC_API_KEY env var
bun scripts/capture-tokens.ts
# writes src/filter/filters/tsc/__fixtures__/tokens.json
```

`scripts/capture-tokens.ts` does:
1. Try to import `tscFilter` from `src/filter/filters/tsc/index.ts`.
   - If it resolves (Task 05 has shipped): record both `raw` and `filtered_expected` for every fixture.
   - If it fails (Task 05 hasn't shipped yet): record `raw` only, set `filtered_expected: null`, and emit a stderr note: `tscFilter not found — re-run after Task 05 to populate filtered_expected`.
2. For each fixture (`small.txt`, `medium.txt`, `large.txt`):
   - Read raw bytes.
   - Call `anthropic.messages.count_tokens({ model: "claude-opus-4-7", messages: [{ role: "user", content: <text> }] })` for raw, and for the rendered output when `tscFilter` is available.
3. Write the result to `src/filter/filters/tsc/__fixtures__/tokens.json` with schema `"anthropic-count_tokens-v1"`, `captured_at`, model name.

The script is **not** part of the test suite — it's an offline tool. CI never invokes it. The committed `tokens.json` is the source of truth at bench time.

**Regeneration discipline.** Any PR that changes `src/filter/filters/tsc/render.ts`, `cluster.ts`, or any logic that affects rendered output MUST regenerate `tokens.json` and commit the change. The bench's regression check fails any PR that drifts `filtered_expected` by > 5% without a matching `tokens.json` update — forcing the contributor to either accept the drift (commit) or fix the renderer.

**Fixture contents — what each shape must include:**

- **small.txt** — one missing-import error. Single file, single diagnostic. Tests the happy path of the regex.
- **medium.txt** — a mix: one missing-import, one type mismatch, one "did you mean", spread across 2-3 files. Tests file grouping in the renderer.
- **large.txt** — one missing global type triggers a cascade (e.g. delete a `declare global` that everything depends on). Tests:
  - Cascade volume (the very thing the filter must compress).
  - Multi-file output ordering.
  - Long absolute paths that wrap visually.

**ANSI / color.** Capture with `--pretty=false` to keep fixtures plain text; the parser will strip ANSI defensively but the bench should not be measuring against color codes. Document this in the README so a re-capture matches.

**Repository pollution.** `src/filter/filters/tsc/__fixtures__/sources/` contains broken TS by design. To stop the project's own type checker from including them, add `src/filter/filters/*/__fixtures__/**` to `tsconfig.json`'s `exclude` (verify with `bun tsc --noEmit` from repo root after committing). The pattern uses a wildcard so V0.5+ filters inherit the exclusion automatically.

**Encoding.** UTF-8, LF line endings. `.gitattributes` if needed.

## Verification

Manual verification at fixture-capture time, then locked by Task 05:

1. Each fixture file exists and is non-empty.
2. Each fixture's first non-blank line matches the canonical `tsc` error shape (`<path>(<line>,<col>): error TSxxxx: <message>`). If `tsc` outputs a leading `error` summary instead, the README must note this so the parser handles both.
3. Running `bun tsc --noEmit` from the repo root **does not** include the fixture sources (excluded via tsconfig). If it does, the build is broken — block the task.

```bash
ls -la src/filter/filters/tsc/__fixtures__/
wc -l src/filter/filters/tsc/__fixtures__/*.txt
bun tsc --noEmit   # must stay green
```

## Exit criterion

- All three `.txt` fixtures committed and non-empty.
- `src/filter/filters/tsc/__fixtures__/tokens.json` committed with `claude-opus-4-7` raw counts. `filtered_expected` is `null` until Task 05 ships `tscFilter`; the Cluster C designer re-runs `bun scripts/capture-tokens.ts` after Task 05 to populate it.
- `scripts/capture-tokens.ts` committed and runnable; README documents how to re-run it and the dual-mode behavior described above.
- README documents the TS version, capture procedure, source TS files, and `tokens.json` regeneration discipline.
- `bun tsc --noEmit` from the repo root is green.
- `src/filter/filters/tsc/__fixtures__/sources/` is excluded via `tsconfig.json` so its broken TS does not enter the project's typecheck.

## Depends on

- (none — independent of code changes; can land in parallel with Task 02-03)

## Estimated diff size

- ~40 LOC fixture-source TS files
- ~700 lines of captured tsc output across 3 fixtures
- ~50 LOC `scripts/capture-tokens.ts`
- ~30 lines `tokens.json` (data)
- ~25 lines fixture README

Total: ~150 lines logic + ~700 lines data.
