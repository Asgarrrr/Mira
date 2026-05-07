# ADR 0007: Hook is the data layer, MCP is the insight layer

## Status

Accepted

## Context

ADR 0006 locked the V0.3 MCP surface at five tools: `run_command`, `get_observation`, `get_raw_evidence`, `generate_context_pack`, `list_recent_runs`. The first eval (`docs/eval/postmortem-001.md`, PR #39) ran four scenarios in two modes and produced **Loss 4/4** for the Mira-augmented agent versus baseline (+14.5% to +111.3% tokens). Post-mortem caveat aside (the harness tested a synthetic agent, not Claude Code), three observations from the transcripts hold under any client:

1. **`run_command` + `get_raw_evidence` is a 2-tool ceremony for what `bash` does in 1.** On debug-style tasks, the agent always needs the raw output to make progress, so the deferral never saves anything — it is mathematical overhead.
2. **`generate_context_pack` arrived empty in 12/12 mira cells** because the worktree's `.mira/` was fresh. The default day-0 experience is "Mira has nothing for you".
3. **The `mira-rewrite.sh` hook silently captured the same evidence in baseline mode** without asking the agent for any tool call. The hook paid no token tax; the MCP did.

The V0.3 thesis was "deferred fetches reduce tokens". On debugging workloads, deferred fetches are a guaranteed loss because the agent always re-fetches. The thesis is wrong on that workload, and that workload covers most real coding-agent activity.

A re-test against headless Claude Code was scoped (closed PR #40) and dropped: it does not change the structural argument above. The MCP, as currently shaped, is misdesigned.

## Decision

Mira is split along two layers with distinct economics:

- **Hook = data layer** (RTK lineage). Always-on, invisible to the agent, captures raw evidence into `.mira/`. **Zero token tax.** This is the surface that already works in production today and that real users adopt without thinking about it.
- **MCP = insight layer** (Sentrux lineage). Opt-in, agent-invoked when a structural question arises. Each tool answers a **dense question with a dense answer** (a paragraph, not a 50k-token dump). The tool tax in the system prompt is justified by answer quality, not by deferral.

### What dies (deprecated by this ADR)

- `run_command` — the hook does this better, with no MCP round-trip.
- `get_observation` — companion to a dead tool.
- `get_raw_evidence` — companion to a dead tool.

These tools remain shipped in V0.3 to avoid a churn release; they are deprecated and slated for removal in the next breaking change. New work should not depend on them.

### What survives

- `list_recent_runs` — the legitimate multi-session query ("what have I already tried on this bug?"). Reads from the hook's evidence store. Stays.
- `generate_context_pack` — pivots from "give me what I know" (mostly empty on day 0) toward "give me the structural picture relevant to this task" (Sentrux-flavored: cycles, coupling, dead code around the suspected files). Concrete shape TBD when the first Sentrux-style tool lands.

### What's added (when usage demands it, not speculatively)

Sentrux-flavored MCP tools, one at a time, each justified by an observed need:

- `find_cycles(paths?)` — import / reference cycles.
- `coupling_around(file)` — files that move together; modification-magnets.
- `dead_code_in(area?)` — symbols unreferenced for N commits.
- `test_gaps(file)` — source files without mirroring tests.
- `architectural_diff(branch, base)` — what structural shapes a PR introduces.

These are **not committed in this ADR**. Each one needs its own design pass, justified by a concrete moment of "I wished Mira told me X". This list is illustrative, not a roadmap.

## Consequences

- The hook (`mira run` + evidence store) is the durable, user-facing surface. Its stability matters more than the MCP's.
- The current MCP V0.3 implementation ships as-is for now; deprecations are documented, not yet executed.
- `CLAUDE.md` § V0.3 scope is updated to reference this ADR rather than describing the five tools as the durable surface.
- V1 is **not** "more tools on the V0.3 shape". V1 is "first Sentrux-style insight tool, when a real need surfaces".
- The eval scaffolding (`eval/scenarios/`, `eval/harness/scenario.ts`, `eval/harness/report.ts`) stays available so a future Sentrux tool can be measured against an honest workload (multi-session, pre-seeded `.mira/`, Claude Code as the client) — but no work goes into the eval until that need exists.

## What this ADR does not do

- It does not declare Mira's overall direction wrong. The hook works. The evidence model works. The data layer is solid.
- It does not commit to building any specific Sentrux tool.
- It does not delete the deprecated tools yet — that requires a separate change once nothing depends on them.
- It does not re-open PR #40 (Claude Code experiment); that decision stands.

## Reference

- `docs/eval/postmortem-001.md` — the data forcing this decision.
- `docs/adr/0006-mcp-server-v0-3-scope.md` — the previous scope this ADR partially supersedes.
- `docs/adr/0001-core-abstractions.md` — the unified evidence model both layers share.
