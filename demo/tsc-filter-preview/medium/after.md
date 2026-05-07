# tsc — 12 errors in 7 files (1240ms)

- **TS2739** ×8 — same shape: Type X is missing the following properties from type Y: path, kind
  e.g. src/core/command-observation.ts:42:8 — Type '{ path: string; kind: string; }[]' is missing the following properties from type '{ path: string; kind: "stdout" | "stderr" | "combined" | "metadata" | "observation" | "context" | "other"; description?: string | undefined; }': path, kind
  also: tests/context-pack.test.ts at 32:3; tests/evidence-store.test.ts at 176:5, 211:4, 259:5, 316:5, 373:5; tests/mcp-list-recent-runs.test.ts at 33:3
- **TS2339** src/context/context-pack-generator.ts:34:40 — Property 'find' does not exist on type '{ path: string; kind: "stdout" | "stderr" | "combined" | "metadata" | "observation" | "context" | "other"; description?: string | undefined; }'.
- **TS2488** src/render/render-observation.ts:41:20 — Type '{ path: string; kind: "stdout" | "stderr" | "combined" | "metadata" | "observation" | "context" | "other"; description?: string | undefined; }' must have a '[Symbol.iterator]()' method that returns an iterator.
- **TS2769** tests/command-observation.test.ts:40:4 — No overload matches this call.
  Overload 1 of 2, '(expected: { id: string; runId: string; command: string; status: "success" | "failure"; exitCode: number | null; killedByTimeout: boolean; durationMs: number; summary: string; findings: { id: string; ... 5 more …
- **TS7006** src/context/context-pack-generator.ts:34:46 — Parameter 'r' implicitly has an 'any' type.

_evidence: .mira/runs/run_<id>/_
