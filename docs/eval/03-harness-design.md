# 03 — Harness design

## Goal

A minimal, deterministic-where-possible runner that takes a (scenario, mode) pair and produces a metrics record. Local, scriptable, no hosted service.

## Folder layout

```
eval/
  package.json                isolated; carries @anthropic-ai/sdk
  scenarios/
    A1-parse-porcelain-rename/
      base.patch              reverse patch turning the fixed code into the buggy state
      task.txt                one-paragraph task description for the agent
      success.sh              exit 0 = pass, non-zero = fail
      README.md               human notes: bug summary, ground-truth fix, hypothesis
    A2-cap-suspected-files/   ...
    A3-build-summary-verb/    ...
  harness/
    agent.ts                  agent loop (Anthropic SDK)
    tools/
      bash.ts                 shell exec tool
      read.ts                 file read tool
      write.ts                file write tool
      grep.ts                 ripgrep wrapper
      mira-mcp.ts             in-process Mira MCP client (uses createMiraMcpServer)
    run.ts                    CLI entry: pick scenario, mode, repeats → execute
    metrics.ts                collect/aggregate per-run metrics
    report.ts                 produce summary.md from results
  results/
    <run-timestamp>/
      <scenario>-<mode>-<repeat>/
        transcript.jsonl      one event per line: model turn, tool call, tool result
        metrics.json
      summary.md
```

## Agent loop (`harness/agent.ts`)

Minimal wrapper around the Anthropic Messages API with tool use:

```ts
type RunResult = {
  success: boolean;
  metrics: Metrics;
  transcript: TranscriptEvent[];
};

async function runAgent(
  scenario: Scenario,
  mode: "baseline" | "mira",
  workdir: string,
  config: AgentConfig,
): Promise<RunResult>
```

Loop:
1. Initialize Anthropic client with the chosen model (default: Sonnet 4.6)
2. Build the tool list:
   - **Baseline**: `bash`, `read`, `write`, `grep`
   - **Mira-augmented**: same + the five MCP tools, exposed as Anthropic tools but routed to a local `createMiraMcpServer()` via `InMemoryTransport` (same pattern as `tests/mcp-integration.test.ts`)
3. Send the system prompt + the scenario's `task.txt` as the user message
4. While the response contains `tool_use` blocks: execute each tool, collect results, send them back, increment `turns`
5. Stop when:
   - the model returns no `tool_use` (terminal answer), or
   - `turns >= config.maxTurns` (default 30), or
   - `tokens_total >= config.tokenCap` (default 200_000), or
   - `wall_clock_ms >= config.wallClockCap` (default 600_000)
6. Run `success.sh` in `workdir`; capture its exit code as `success`
7. Return `RunResult`

### Determinism knobs

- `temperature: 0`
- Same scenario base state per repeat (re-applied from `base.patch` on a fresh worktree of the current repo)
- Pinned model version string
- Same system prompt
- `maxTokensPerTurn` per-call output cap (smoke default `8192`; raise per-scenario in sub-task iv if a longer single response is legitimately needed; don't go above `16_384` — at temp=0 the tail of long responses is rarely productive and the per-scenario budget is finite)

Determinism is not full — model output still varies. That's why N=3 repeats.

### System prompt

Minimal, deliberately:

```
You are a coding agent. Solve the task described by the user. Use the provided tools.
When done, return a final answer (no tool call). Do not ask follow-up questions; act on best understanding.
```

No mention of Mira specifically. The Mira tools (in mira mode) are simply additional tools; the agent decides whether and when to use them. This is the test.

## Tool wrappers

### Baseline tools

Minimal. Each takes a workdir-relative path; absolute paths are rejected.

- `bash(command, timeoutMs?)` — exec, captures stdout/stderr/exitCode
- `read(path)` — utf-8 read, returns content
- `write(path, content)` — overwrite
- `grep(pattern, path?)` — ripgrep wrapper

### Mira tools

Forwarded to an in-process MCP server. The harness wraps each of the five tools (`run_command`, `get_observation`, `get_raw_evidence`, `generate_context_pack`, `list_recent_runs`) with the matching Anthropic tool schema. `projectRoot` is passed automatically by the harness — the agent doesn't have to know about it.

This forwarding pattern means the eval *also* validates that the MCP boundary is consumable as designed.

Implementation hint: `createMiraMcpServer()` is exported from `src/mcp/server.ts`. Pair it with `InMemoryTransport.createLinkedPair()` from `@modelcontextprotocol/sdk/inMemory.js`. See `tests/mcp-integration.test.ts` for the full pattern.

## Mode setup (per repeat)

For each (scenario, mode, repeat):
1. Create a fresh ephemeral workdir (`mkdtemp`)
2. `git worktree add <workdir> HEAD` (or `git clone --depth 1` if worktrees are awkward)
3. Apply `scenario/base.patch` to introduce the bug (the patch turns the *fixed* tree into the *buggy* tree)
4. Sanity check: run the failing test once, expect it to fail
5. Run agent loop
6. Run `success.sh`
7. Tear down workdir (`git worktree remove`)

## Instrumentation

- Every model invocation logs `usage` to `transcript.jsonl`
- Every tool call logs `(tool, args_size, result_size, duration_ms)` and a truncated args/result preview (head 200 chars)
- A post-run pass converts the transcript into `metrics.json`

## Dependency scope

- New runtime dep: `@anthropic-ai/sdk` — added to **`eval/package.json`**, not to root `package.json`
- The eval folder has its own minimal `package.json` so the `src/` runtime stays clean
- `src/` is never imported by the eval; the eval consumes Mira via:
  - **Default (in-process):** direct `createMiraMcpServer()` import (lightweight, fast, what `tests/mcp-integration.test.ts` already does)
  - **Optional (subprocess):** `bun src/cli/index.ts mcp` over stdio — heavier but more realistic; second experiment

Mira's `src/` continues to depend on nothing the eval needs. The eval depends on Mira's published surface.

## Cost guard-rails

- Hard token cap per run (default 200K total)
- Hard wall-clock cap per run (default 10 min)
- The harness reports running cost estimate after each scenario; aborts if a single scenario exceeds 2× its budget

## Out of scope (first iteration)

- Streaming the model's output (results captured at end of each turn)
- Caching API responses (each repeat is a fresh call — that's the point)
- Multiple model providers (Anthropic SDK only)
- A web UI on top of `summary.md`
- Production-style observability (Datadog, Sentry, etc.)
