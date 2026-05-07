# tsc filter — fixtures

Three real `tsc --noEmit` outputs used by the parser/cluster/render unit
tests (Task 05) and by the bench (Task 07). Co-located with the filter
per [`docs/plans/filter-engine/00-decisions.md`](../../../../../docs/plans/filter-engine/00-decisions.md)
§ 9c bullet 3 and § 11.

## TypeScript version pinned

Captured against `typescript@5.9.3` (the version installed under the
repo's `node_modules/`; `package.json` declares `"typescript": "^5"`).
On a TS upgrade, re-capture is a deliberate task — the fixture lock-step
defends against R4 (tsc format drift across versions). Re-recording must
land in the same PR as the version bump.

## Capture flags

All captures use `--pretty=false` (anti-ANSI; we want plain text the
parser regex can match without fighting escape codes) and `--noEmit`
(we only want diagnostics). `tsc 5.9.3` rejects `--pretty=false` as a
single token; the syntax is two args (`--pretty false`).

We invoke `./node_modules/.bin/tsc` directly. `bun tsc` adds a trailing
`error: "tsc" exited with code 2` line; `bunx -p typescript@<v> tsc`
adds a `Saved lockfile` line. The direct binary path is the cleanest.

## Fixture inventory

| File         | Errors | Source                                             | Tests                                               |
|--------------|-------:|----------------------------------------------------|-----------------------------------------------------|
| `small.txt`  |      2 | `sources/small.ts`                                 | happy-path regex — single-file, two distinct errors |
| `medium.txt` |     12 | `eval/scenarios/B1/base.patch` applied to repo HEAD | B1 cascade — multi-file, multi-rule, continuation lines |
| `large.txt`  |     32 | `sources/large.ts`                                 | cascade volume — same-shape errors clustering target |

`medium.txt` does NOT have a `sources/medium.ts`; the B1 patch against
the repo at the time of capture IS the source of truth. To regenerate
medium, see the procedure below.

## Capture procedure

```bash
# From the repo root (cwd matters — paths are reported relative to cwd):

# small.txt and large.txt (synthetic sources):
./node_modules/.bin/tsc --noEmit --pretty false \
  src/filter/filters/tsc/__fixtures__/sources/small.ts \
  > src/filter/filters/tsc/__fixtures__/small.txt 2>&1 || true
./node_modules/.bin/tsc --noEmit --pretty false \
  src/filter/filters/tsc/__fixtures__/sources/large.ts \
  > src/filter/filters/tsc/__fixtures__/large.txt 2>&1 || true

# medium.txt (B1 scenario — apply the patch, capture, revert):
git apply eval/scenarios/B1/base.patch
./node_modules/.bin/tsc --noEmit --pretty false \
  > src/filter/filters/tsc/__fixtures__/medium.txt 2>&1 || true
git apply -R eval/scenarios/B1/base.patch
```

The `|| true` is critical — `tsc` exits 2 on errors; we want to capture
the output regardless. Verify the working tree is clean afterwards
(`git status`) — a leftover B1 patch would break the rest of the suite.

## Output shape notes (for the parser, Task 05)

- `--pretty=false` output has no leading "Found N errors" summary in TS
  5.9.3. Each diagnostic is a single line with a possible block of
  indented continuation lines (`tests/command-observation.test.ts(40,4)`
  in `medium.txt` is the example: TS2769 followed by four `  Overload …`
  lines).
- All paths are relative to the cwd at capture time. `small.txt` and
  `large.txt` paths begin with `src/filter/filters/tsc/__fixtures__/sources/`;
  `medium.txt` paths begin with `src/` or `tests/`. Don't normalize.
- `large.txt` is 32 lines of identical-shape `TS2739` errors. After
  cluster-dedup (00-decisions.md § 9b), the renderer should emit one
  bullet with `×32` and 32 locations. This is the headline cascade
  case the bench measures.

## Repository pollution

`sources/` contains deliberately broken TS. The repo's `tsconfig.json`
excludes `src/filter/filters/*/__fixtures__/**` so the project's own
typecheck (`bun tsc --noEmit`) does not pick them up. Verify on every
fixture-touching PR that the repo-root typecheck stays green.

## Encoding

UTF-8, LF line endings. No `.gitattributes` override needed — the
project default already enforces LF.

## `tokens.json` regeneration discipline

`tokens.json` is committed alongside the fixtures and contains
authoritative token counts via Anthropic's
`messages.count_tokens({ model: "claude-opus-4-7" })` endpoint. Schema:

```json
{
  "schema": "anthropic-count_tokens-v1",
  "model": "claude-opus-4-7",
  "captured_at": "<ISO timestamp>",
  "fixtures": {
    "small.txt":  { "raw": <n>, "filtered_expected": <n> | null },
    "medium.txt": { "raw": <n>, "filtered_expected": <n> | null },
    "large.txt":  { "raw": <n>, "filtered_expected": <n> | null }
  }
}
```

Regenerate via `bun scripts/capture-tokens.ts` (requires
`ANTHROPIC_API_KEY` in env). The script is offline-only — the bench
itself does not call the API; it reads these committed counts.

**Dual-mode capture (Task 04 → Task 05 transition).** When Task 04
shipped, `tscFilter` did not yet exist (it lands in Task 05). The
capture script is therefore robust to a missing `tscFilter`:

- If the `tscFilter` import resolves, both `raw` and `filtered_expected`
  are written.
- If it fails, only `raw` is captured; `filtered_expected` is set to
  `null`, and the script emits a stderr note instructing to re-run after
  Task 05 ships.

The Cluster C designer (Task 05 owner) re-runs `bun scripts/capture-tokens.ts`
after `tscFilter` lands and commits the populated `tokens.json` in the
same PR. Future regenerations follow the standard rule: any PR that
changes `src/filter/filters/tsc/render.ts`, `cluster.ts`, or any logic
affecting rendered output MUST regenerate `tokens.json`.
