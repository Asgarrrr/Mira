# Observation pipeline — beyond RTK

This document maps what sits between *"a command finishes running"* and *"the agent reads an observation"*. It is research + roadmap, not a binding decision; concrete commitments will land as ADRs.

The question this document answers: **what is powerfully useful to an AI coding agent that command-output filtering (RTK-style) does not capture, and how should Mira's pipeline be shaped to deliver it?**

## Where we are today (V0 → V0.3)

```
mira run "<cmd>"
  ↓
command-observer kernel       captures raw stdout/stderr/exit/signal/duration
  ↓
EvidenceStore                 writes raw bytes to .mira/runs/<id>/
  ↓
observation builder           produces CommandObservation (markdown + JSON)
  ↓
stdout: passthrough + footer  agent sees the original output verbatim
```

V0.1 adds `ContextPack` as a Tier-2 view (last 10 observations bundled). V0.2 adds `senseArchitecture` → `suspectedFiles[]`. V0.3 exposes the kernels through 5 MCP tools.

What's missing: between *raw bytes captured* and *agent reads*, Mira does no transformation. The agent gets the same bytes as a naked shell. Token efficiency = 0% improvement vs no Mira.

## What RTK actually does

`rtk-ai/rtk` is a 42K-star Rust binary. Source layout (verified):

| Module | Role |
|---|---|
| `src/discover/` | command rewrite registry — maps incoming `cmd` to `rtk cmd` |
| `src/filters/` | TOML registry, ~100 commands (biome, gradle, gcc, helm, jq, jest…) |
| `src/parser/` | basic text formatting; *not* per-tool AST parsers |
| `src/learn/` | adaptive learning over filter behaviour, embryonic |
| `src/analytics/` | usage stats, savings telemetry |
| `src/hooks/` | per-client hook scripts (claude, cursor, codex, …) |

Integration model (Claude Code): `PreToolUse(Bash)` hook reads `tool_input.command`, calls `rtk rewrite "<cmd>"`, the binary returns either a rewritten command (auto-allow) or an exit code signalling passthrough/deny/ask. The hook emits JSON that Claude Code consumes to substitute the command before execution.

What each filter does (per `.toml` rule):

- `match_command` — regex anchored on the command shape
- `strip_ansi`, `strip_lines_matching`, `keep_lines_matching`, `max_lines`
- `truncate_message`, `on_empty`
- Stateless, line-level, deterministic, <10 ms overhead

**Claimed effect**: 60–90 % token reduction on common dev commands ([README](https://github.com/rtk-ai/rtk)). The compression is purely textual — no semantic understanding, no memory across calls.

## What RTK does NOT touch

Examined against `src/learn/`, `src/parser/`, `src/discover/` and the filters TOML corpus. None of the following are present in any meaningful form:

| Capability | Status in RTK |
|---|---|
| Typed structured diagnostics (SARIF, LSP-style findings) | absent — text in, text out |
| Cross-command memory or persistence | absent by design (stateless) |
| Diff between consecutive runs of the same command | absent |
| Cascade detection / root-cause clustering | absent |
| Code intelligence (find-references, type hierarchy, blast radius) | absent — out of scope |
| Streaming progressive output (long-running builds) | absent — run-to-completion only |
| Pre-fetch of likely-next-reads | absent |
| Causality across git history | absent |

These gaps are not bugs in RTK — RTK is a stateless filter, by intent. They are the *adjacent space* that an evidence-model project (Mira) can occupy without overlap.

## Four strategic axes that go beyond RTK

Each axis has: what RTK does (or doesn't), what an agent gains, the technique, the cost.

### Axis 1 — Typed `Finding[]`, not regex strip

**What changes.** Replace line-level filtering with per-tool parsers that emit structured diagnostics. Modeled on [SARIF](https://learn.microsoft.com/en-us/cpp/build/reference/sarif-output?view=msvc-170), the industry standard supported natively by clang, msvc, rustc, semgrep, codeql, and others.

```ts
type Finding = {
  severity: "error" | "warning" | "info";
  ruleId: string;            // "TS2304" | "biome/style/useConst" | "vitest/expect-eq"
  file: string;              // resolved absolute path
  range: { start: Loc; end: Loc };
  message: string;
  related?: Finding[];       // cascade siblings, same root
};
```

**Agent benefit.** Instead of parsing 3 KB of `tsc` stdout to find a file:line, the agent receives `{ errors: 3, root_in: "src/foo.ts:42", cascade: 2 }`. Semantically queryable: *"only errors"*, *"group by file"*, *"first failing test"*. Token reduction comparable to RTK; token *quality* much higher.

**Foundation in Mira.** `src/core/finding.ts` already declares a Finding type with zod. The schema is there; what's missing is the parser registry that converts tool output to `Finding[]`.

**Cost.** One parser per supported tool. Start with the project's own toolchain: `tsc`, `biome`, `bun test`. Each parser is ~50–150 LOC and deterministic.

### Axis 2 — Code intelligence via LSP

**The big lever, and the one RTK cannot reach.** For *navigation* and *understanding* operations (find references, blast radius, change impact, type hierarchy), measured benchmarks show LSP delivers 5–34× the token efficiency of grep/read on the same task ([Agent Client Protocol article](https://blog.promptlayer.com/agent-client-protocol-the-lsp-for-ai-coding-agents/)).

[`agent-lsp`](https://github.com/blackwell-systems/agent-lsp) reports the following on HashiCorp Consul (319 K LOC):
- via grep: **17.7 MB**, **5 534 tool calls** for a blast-radius analysis
- via LSP: **841 KB**, **119 tool calls**
- → **21× token reduction**, **46× tool-call reduction**

**What it requires.** A managed Language Server pool: `typescript-language-server`, `rust-analyzer`, `gopls`, `pyright`, etc. Mira would route MCP queries to the right server, cache its responses, and surface results as typed findings — same `Finding[]` shape as Axis 1.

**Foundation in Mira.** V0.2 ships `senseArchitecture` (filesystem-only heuristics). LSP integration is the natural step up: from filename heuristics to symbol-level semantics. The MCP boundary already supports adding tools; new ones like `find_references`, `goto_definition`, `change_impact` slot in.

**Cost.** Hard. Process management, protocol speak, cancellation, init/teardown, multi-language. Estimate: 3–4 weeks for one server done well; another 1–2 per additional language. Not V0.4. Probably V0.6+.

### Axis 3 — Cross-run memory (the differentiator)

**What only persistent storage enables.** Mira already writes every observation to `.mira/runs/<id>/`. This is the asset RTK does not have and cannot, by design. Three concrete patterns:

- **Diff-on-rerun.** Agent runs `bun test` → fail. Edits. Reruns. Mira recognises *"same command, prior observation found"* and emits the *delta*: `"1 test now passes, 0 new failures, 0 changes elsewhere"`. The agent sees ~100 bytes instead of the full re-run output. Implementation: hash-anchored comparison of finding sets across observations.
- **Cascade clustering.** `tsc` reports 50 errors but they all chain back to one missing import. Mira clusters by similarity (rule id + identifier reference) and surfaces *"1 root cause + 49 cascading"*. The agent fixes the root, reruns, and 50 errors disappear.
- **Causality / git crossing.** *"When did this test start failing?"* Mira walks `list_recent_runs` history and correlates with `git log`: *"started failing in run 47, 3 commits ago, after touching src/foo.ts"*.

**Foundation in Mira.** All three patterns sit on top of the existing `EvidenceStore` + `CommandObservation` types. No new persistence layer needed.

**Cost.** Diff-on-rerun is small (~200 LOC + tests). Cascade clustering needs heuristics and tuning per tool. Causality / git crossing is a separate kernel.

### Axis 4 — Speculative pre-fetch

**The agent's next read is often predictable.** When `git status` shows *modified: src/foo.ts*, the agent will likely read `src/foo.ts` next. When `bun test` reports a failure in `tests/x.test.ts:42`, the agent reads that file. Mira already computes `suspectedFiles[]` (V0.2). The extension: at observation time, **pre-fetch and cache** content for those files.

```ts
type Observation = {
  // …existing fields…
  speculative: {
    files: Array<{ path: string; size: number; mtime: string; contentRef: EvidenceRef }>;
  };
};
```

The agent calls a new MCP tool `get_speculative_evidence(observationId)` and gets file contents already-on-disk in `.mira/runs/<id>/speculative/`, no syscall round-trip.

**Foundation in Mira.** V0.2's heuristics + V0's evidence store. The new piece is the cache write at observation creation, and the new MCP tool.

**Cost.** Small (~150 LOC). Risk: cache size growth. Mitigation: cap at N files × M bytes per observation, garbage-collect old `.mira/runs/` proactively.

## Recommended slice for V0.4

Not all four axes ship in V0.4. The slice that maximizes leverage / effort:

| Slice | Axis | Leverage | Effort | V0.4? |
|---|---|---|---|---|
| **A. Typed `Finding` pipeline** with 3 parsers (`tsc`, `biome`, `bun test`) | 1 | High | Medium | **yes** |
| **B. Diff-on-rerun** | 3 | High (infra in place) | Low | **yes** |
| **C. Cascade dedup** in `Finding[]` | 1 + 3 | High | Medium | **yes** |
| **D. TOML registry fallback** for commands without dedicated parsers (RTK-shape) | (RTK parity) | Medium | Medium | **yes** |
| E. Speculative pre-fetch on `suspectedFiles[]` | 4 | Medium | Low | V0.5 |
| F. LSP integration (start with `typescript-language-server`) | 2 | Very high | Very high | V0.6+ |
| G. Causality / git crossing | 3 | Medium | Medium | V0.7 |

V0.4 = A + B + C + D. It establishes the shape (typed findings, cross-run delta, cascade dedup) and provides a fallback layer (D) for unparsed commands so the upgrade path stays incremental.

LSP (F) is the single biggest unlock the analysis surfaced. It is intentionally deferred — too large for V0.4 and pre-empts an ADR of its own. Listing it explicitly in the roadmap so the V0.4 design does not paint it into a corner.

## Pipeline shape (V0.4 target)

```
mira run "<cmd>"
  ↓
command-observer kernel       captures raw stdout/stderr (unchanged)
  ↓
EvidenceStore                 writes raw + observation.json (unchanged)
  ↓
[NEW] parser dispatch         picks per-tool parser; falls back to TOML filter
  ↓
[NEW] Finding[] aggregator    cascade-dedup, severity-rank
  ↓
[NEW] cross-run differ        compares with prior observation of same command
  ↓
observation builder           CommandObservation now carries findings + delta
  ↓
stdout: compact (default)     findings rendered as compact text + pointers
get_raw_evidence(ref): raw    raw bytes still one MCP call away
```

Two principles preserved from V0:
- **Raw is never lost.** Every transformation is a *derivation* over the raw bytes that remain on disk.
- **Compact and traceable.** The agent sees `Finding[]`; the bytes are one hop away when it needs them.

## Open questions before V0.4 ADR

- **Schema versioning.** SARIF has `version: "2.1.0"`. Should Mira's `Finding` schema follow SARIF directly, adopt a subset, or define its own? Tradeoff: SARIF compatibility means external tools (CodeQL, Semgrep) drop in; subset is cleaner.
- **Parser registry layout.** Built-ins compiled in (Rust-style) vs. data-driven (TOML + small interpreter). Built-ins are simpler today but harder for users to override. Mirror RTK's TOML for the *fallback* layer (Slice D) and use compiled parsers for first-class tools (Slice A).
- **Cascade rules.** Per-tool or per-rule-id? Probably per-tool with a default (cluster by `ruleId` + first identifier mentioned in `message`). Tunable in user TOML.
- **Performance budget.** RTK target <10 ms. Mira does more (Finding parsing + cross-run diff). Target: <30 ms p95 on a 200-line `tsc` output. Benchmark in tests.
- **MCP surface.** Does `get_observation` return `findings[]` inline, or a count + ref? Probably both: count inline, full array on a new `get_findings` tool.
- **Streaming (Axis bonus).** Long-running commands (dev servers, full builds) currently hold the harness for the entire duration. Streaming is out of V0.4 but the parser design should not preclude it.

## What this document deliberately is NOT

- Not an ADR. ADR 0007 will encode the V0.4 commitments after this is reviewed.
- Not a feature shopping list. The four axes are *categories* of value; V0.4 ships only A+B+C+D.
- Not a re-implementation of RTK. The TOML fallback (slice D) borrows the *form*, not the registry. Mira will not maintain 100+ filter TOMLs; community-contributed ones via the same TOML schema are a future option, not a V0 promise.
- Not a competitor positioning document. RTK and Mira occupy adjacent spaces; an installation can use both, with RTK rewriting commands and Mira observing the rewritten outcome — although Mira's V0.4 makes the RTK layer optional.

## References

- [SARIF format spec (Microsoft Learn)](https://learn.microsoft.com/en-us/cpp/build/reference/sarif-output?view=msvc-170) — structured diagnostics standard
- [agent-lsp on GitHub](https://github.com/blackwell-systems/agent-lsp) — LSP token-reduction benchmarks (5–34×, 21× on Consul)
- [Agent Client Protocol: The LSP for AI Coding Agents (PromptLayer)](https://blog.promptlayer.com/agent-client-protocol-the-lsp-for-ai-coding-agents/) — bidirectional JSON-RPC for agent ↔ tools
- [LSP for AI coding tools (Amir Teymoori)](https://amirteymoori.com/lsp-language-server-protocol-ai-coding-tools/) — explanation of why LSP-style structure beats grep
- [LSP integrations transform coding agents (Maik Kingma)](https://tech-talk.the-experts.nl/give-your-ai-coding-agent-eyes-how-lsp-integration-transform-coding-agents-4ccae8444929) — real-world deployment notes
- [oh-my-pi (can1357)](https://github.com/can1357/oh-my-pi) — agent integrating LSP, browser, subagents — reference architecture
- [rtk-ai/rtk](https://github.com/rtk-ai/rtk) — the project this document positions Mira against
