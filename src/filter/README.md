# `src/filter` — command output filters

This subsystem turns raw command output (tsc, eslint, jest, git, …) into
compact, structured markdown for AI agents. Each filter handles one program
or one umbrella sub-program (e.g. `git diff` distinct from `git status`).

The agent never needs to know Mira exists: the filter is invoked by Mira's
hook in `runCommand`, runs against the captured stdout/stderr, and emits the
markdown that replaces the raw output in the agent's tool result. Raw output
is always preserved on disk under `.mira/runs/<run-id>/` for re-rendering and
debugging.

## Layout

```
src/filter/
├── README.md              # this file
├── types.ts               # Filter, FilterContext, FilterInput, FilteredView, DispatchResult, RegistryEntry
├── dispatch.ts            # token extraction + multi-token key resolution
├── registry.ts            # single Map<key, RegistryEntry>, assembled from per-program entries
└── filters/
    └── <program>/
        ├── entries.ts     # registry contributions for this program
        ├── index.ts       # the Filter glue (assembles parser + cluster + render); also owns the version literal
        ├── parser.ts      # raw text → structured findings
        ├── cluster.ts     # (optional) collapse repeats by message shape
        ├── render.ts      # findings → markdown
        └── __fixtures__/  # captured-output test data
```

## Mental model

A filter is a triple of pure functions wired through one glue file:

1. **Parser** — `string → Finding[]`. Recognizes the program's diagnostic
   shape, strips ANSI, normalizes severity, captures source ranges into the
   raw evidence so we can re-point later.
2. **Cluster** *(optional)* — `Finding[] → Cluster[]`. Groups findings by
   `(ruleId, normalizedMessage)` so a 30× repeated TS2322 collapses into one
   bullet. Skip clustering when the output isn't repetitive (e.g.
   `git status`).
3. **Render** — `(Cluster[] | Finding[], opts) → string`. Markdown only —
   header line, optional `_top:` summary, bullets, no ANSI.

The glue (`index.ts`) chains them and exports a `Filter`. The `entries.ts`
exports the registry contributions and is the only file `registry.ts`
imports from your filter directory.

## Adding a single-program filter

You're adding a filter for a program named `foo` (one registry key, no
sub-programs).

### 1. Scaffold the directory

```
src/filter/filters/foo/
├── entries.ts
├── index.ts
├── parser.ts
├── render.ts
└── __fixtures__/
    └── sources/         # captured raw output of `foo` runs you want to support
```

### 2. Pin the filter version

The version literal lives in the glue file, exported alongside the filter:

```ts
// src/filter/filters/foo/index.ts
export const FOO_FILTER_VERSION = "foo/1";
```

This literal lives here and **nowhere else**. Bump it when the rendered
markdown changes shape. `observation.json.filterVersion` records the version
used for each run so a future Mira can re-render old evidence with a new
parser and diff against the persisted markdown.

### 3. Write the parser

```ts
// src/filter/filters/foo/parser.ts
export type FooDiagnostic = { /* … */ };
export function parseFooOutput(text: string): FooDiagnostic[] { /* … */ }
```

Strip ANSI escapes early (`/\x1b\[[0-9;]*m/g` — see `tsc/parser.ts`). If
your program has a "pretty" output mode you can't parse, detect it and
return `[]` so the dispatcher falls back to raw output (see "Pretty-mode
passthrough" below).

### 4. Write the renderer

```ts
// src/filter/filters/foo/render.ts
export function renderFooMarkdown(/* … */): string {
  // Header: `# foo — N <unit> in M <unit> (Tms)`
  // Bullets follow, prefixed `- **<rule-or-code>** path:line — message`
}
```

Conventions: italic helper lines use `_…_`; multiplicity uses `×N` (Unicode);
inter-item separator is ` · ` (Unicode middle dot). See `tsc/render.ts` for
the canonical shape.

### 5. Wire the glue

```ts
// src/filter/filters/foo/index.ts
import type { Filter, FilteredView } from "../../types.ts";
import { parseFooOutput } from "./parser.ts";
import { renderFooMarkdown } from "./render.ts";

export const FOO_FILTER_VERSION = "foo/1";

export const fooFilter: Filter = (input, ctx): FilteredView => {
  const findings = parseFooOutput(input.stdout + input.stderr);
  const markdown = renderFooMarkdown(findings, { durationMs: input.durationMs });
  return { findings, markdown };
};
```

### 6. Export the entries

```ts
// src/filter/filters/foo/entries.ts
import type { RegistryEntry } from "../../types.ts";
import { fooFilter, FOO_FILTER_VERSION } from "./index.ts";

export const fooEntries: ReadonlyArray<readonly [string, RegistryEntry]> = [
  ["foo", { filter: fooFilter, version: FOO_FILTER_VERSION }],
];
```

### 7. Wire into the registry

```ts
// src/filter/registry.ts
import { fooEntries } from "./filters/foo/entries.ts";
// …
export const REGISTRY = new Map<string, RegistryEntry>([
  ...tscEntries,
  ...fooEntries,
]);
```

One import + one spread. That's the whole central edit.

### 8. Add tests

Mirror the parser/cluster/render split:

```
tests/
├── filter-foo-parser.test.ts   # unit tests on parseFooOutput
├── filter-foo-render.test.ts   # unit tests + markdown snapshots
└── cli-run-foo.e2e.test.ts     # full pipeline via `bun src/cli/index.ts run`
```

The e2e test is what catches integration regressions (wrapper stripping,
persistence, evidence pointer formatting). See
`tests/cli-run-tsc.e2e.test.ts` for the pattern: a tmpdir + `Bun.spawn` + a
captured-output fixture project.

## Adding an umbrella filter with sub-programs

Some programs (`git`, `npm`, `cargo`, `pnpm`) host sub-programs whose output
shapes differ enough to need their own parser and renderer. Mira handles
this with **multi-token registry keys** — `git diff` is a separate entry
from `git status`, the dispatcher uses longest-prefix matching to resolve.

### Layout

```
src/filter/filters/git/
├── entries.ts            # exports gitEntries with one tuple per sub-program
├── shared/               # primitives shared across git/* (e.g. parse-porcelain.ts)
└── diff/
    ├── index.ts          # glue + GIT_DIFF_VERSION
    ├── parser.ts
    ├── render.ts
    └── __fixtures__/
└── status/
    ├── index.ts
    └── …
```

Each sub-program directory is a normal single-program filter (steps 1–6
above). The umbrella's `entries.ts` lists them all:

```ts
// src/filter/filters/git/entries.ts
import type { RegistryEntry } from "../../types.ts";
import { gitDiffFilter, GIT_DIFF_VERSION } from "./diff/index.ts";
import { gitStatusFilter, GIT_STATUS_VERSION } from "./status/index.ts";

export const gitEntries: ReadonlyArray<readonly [string, RegistryEntry]> = [
  ["git diff", { filter: gitDiffFilter, version: GIT_DIFF_VERSION }],
  ["git status", { filter: gitStatusFilter, version: GIT_STATUS_VERSION }],
];
```

### Resolution order

The dispatcher tries the longest-token prefix first, falling back through
shorter prefixes. For `git diff HEAD~1 -- src/`:

- 2-token attempt: `"git diff"` → match → use the diff filter.
- (No fallback needed.)

For `git log --oneline` *if you only registered `"git diff"`*:

- 2-token attempt: `"git log"` → miss.
- 1-token attempt: `"git"` → miss (not registered) → passthrough (raw
  output reaches the agent).

The cap is `MAX_KEY_TOKENS = 2` in `dispatch.ts`. Bump to 3 the day a
`kubectl get pods` style key needs to register — it's a one-line constant
change.

### Reusing parsers across sub-programs

Put shared primitives under `<program>/shared/`. For git, this is mostly
porcelain parsers (`git status --porcelain=v1 -z` shape, `git diff` hunk
headers). Import from sibling sub-program directories:

```ts
// src/filter/filters/git/diff/parser.ts
import { stripAnsi } from "../../../lib/ansi.ts"; // if `src/filter/lib/` exists
import { parseHunkHeader } from "../shared/hunk.ts";
```

`src/filter/lib/` is reserved for **cross-filter universal** primitives
(ANSI strip, message truncation, top-codes summary). It's lazy: don't
create the directory until two filters genuinely need to share something.

## Conventions

- **Filter version is a literal in the glue `index.ts`** — the only place,
  exported alongside the filter. Bump on output-format changes. Tests assert
  it via `tests/filter-types.test.ts`.
- **Pretty-mode passthrough**: when the parser sees only ANSI-styled
  human-pretty output it can't parse, return zero findings. The dispatcher
  detects `0 findings + non-empty output + non-zero exit` and switches to
  passthrough (`{ kind: "miss" }` → raw stdout/stderr reaches the agent).
- **One registry entry per (program, sub-program) pair** — no internal
  dispatch inside a filter. Each entry is its own glue.
- **Co-locate fixtures** under `__fixtures__/`. Real captured output is
  always preferred over hand-crafted samples — capture with
  `scripts/capture-tokens.ts` or by hand from a real run.
- **File ≤250 LOC, function ≤40 LOC** (Mira global rule). When the parser
  loop crosses 40, extract a helper that names the sub-step (don't split
  for the heuristic alone if the result is harder to read).
- **No external dependencies**: parsers should be stdlib + project types
  only. We will not pull in a tree-sitter grammar or a TS compiler API just
  to parse `tsc` output.

## Reference

- `docs/adr/0008-filter-architecture.md` — the *why* behind these
  conventions (entries pattern, longest-prefix dispatch, no-internal-dispatch
  rule, lazy `lib/`).
- `docs/plans/filter-engine/` — V0.4 implementation plan and decision log.
- `docs/architecture.md` — Filter subsystem in the broader Mira architecture.
- `src/filter/filters/tsc/` — the canonical reference implementation.
