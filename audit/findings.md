# Mira audit — findings (2026-05-06)

**Scope:** entire `src/`, `tests/`, `eval/harness/` (incl. my own work in PR #15), and ADR alignment.
**Method:** ADR→test coverage map, kernel-by-kernel surface review, empirical probes (`audit/probes/`), MCP/Anthropic SDK doc cross-check.
**Tone:** I've been hard on the code, including mine. Where a subagent claimed something, I re-ran the probe or re-read the source before listing it. Findings I could not personally reproduce are marked `(unverified)`.

---

## TL;DR

Mira's surface-level invariants are well covered (40/53 ADR claims have direct tests, ~75%). Path safety on the MCP boundary is solid: every traversal vector tried — `..`, absolute, symlink to file, symlink to dir, dir-symlink at top — was correctly rejected (ADR 0006). Parallel `mira run` against the same project root is collision-free up to ≥50 conc/ms thanks to a 6-char random suffix.

But two **HIGH** bugs in the kernels and two **MEDIUM** in the code I personally shipped:

| # | Severity | Location | One-liner |
|---|---|---|---|
| H1 | HIGH | `src/command/command-observer.ts:23-55` | ~~Timeout doesn't unblock the observer if the command leaks descendants holding stdout/stderr — confirmed `10 014 ms` return on a `1000 ms` timeout.~~ **Fixed** in PR #16 (`fix/h1-timeout-process-group`): timeout now kills the whole process group. |
| H2 | HIGH | `src/store/evidence-store.ts:107` + 2 MCP tools | ~~One corrupt `observation.json` poisons `list_recent_runs` AND `generate_context_pack` with `INTERNAL`.~~ **Fixed** in PR #17 (`fix/h2-tolerate-corrupt-observation-json`): the recent-runs projection tolerates corrupt observations and skips them. |
| M1 | MEDIUM | `src/mcp/tools/get-observation.ts:74` & `list-recent-runs.ts:80` | ~~Persisted observations are returned without shape validation. `{"totally":"wrong"}` round-trips silently.~~ **Fixed** in PR #20 (`fix/m1-shape-validation`): observation shape is validated on read. |
| M2 | MEDIUM | `eval/harness/tools/bash.ts` | ~~My sandbox has ≥4 trivial bypasses — including a confirmed file *write* outside the workdir.~~ **Fixed** in PR #24 (`fix/m2-bash-sandbox`): guard now rejects `/`-bearing tokens (B1–B5 closed), eval-side test added at `eval/harness/tools/bash-sandbox-tests.ts`. |
| M3 | MEDIUM | `eval/harness/agent.ts:127-134` | ~~Loop ignores `stop_reason === "max_tokens"`. A truncated `tool_use` block would be executed with undefined fields.~~ **Fixed** in PR #18 (`fix/m3-stop-reason-max-tokens`): the loop refuses to execute a tool_use truncated by max_tokens. |
| L1 | LOW | `eval/harness/agent.ts:106` | ~~`max_tokens: 4096` hardcoded. Sonnet 4.6 ceiling is much higher; risks silent truncation in real eval scenarios.~~ **Fixed** in PR #19 (`fix/l1-max-tokens-per-turn`): `maxTokensPerTurn` is now configurable on `AgentConfig`. |
| L2 | LOW | `src/mcp/tools/get-raw-evidence.ts` | ~~Long `ref.path` returns `INTERNAL` on `ENAMETOOLONG`. Should be `INVALID_INPUT` per ADR 0006 reservation of `INTERNAL` for genuine bugs.~~ **Fixed** in PR #26 (`fix/l2-error-mapping`): both `statSync`/`readFileSync` catches now map `ENAMETOOLONG` → `INVALID_INPUT` and `EACCES` → `NOT_FOUND`; `INTERNAL` default preserved. Regression test in `tests/mcp-get-raw-evidence.test.ts`. |
| L3 | LOW | same | ~~`readFileSync(path, "utf8")` mojibakes non-UTF-8 bytes (`U+FFFD`). Tool description says "verbatim, never re-encoded" — technically false.~~ **Fixed** in PR #27 (`fix/l3-encoding-contract`, description-only): tool description in `src/mcp/server.ts`, ADR 0006 § `get_raw_evidence`, and `docs/architecture.md` § MCP Boundary now state explicitly that `content` is decoded UTF-8 with `U+FFFD` substitution and that V0 evidence kinds are text-only. Runtime unchanged; an `encoding: "utf8" \| "base64"` field is deferred to a future ADR. |

Two soft-coverage gaps from the ADR map worth surfacing:
- **No structural test** enforces ADR 0006's `mcp -> kernels -> core types` direction. A reverse-import would not fail CI.
- **No structural test** enforces ADR 0005's "no new npm deps in `src/architecture/`" or "all sensing logic stays in `src/architecture/`".

Solid is solid: see § "What was probed and held up" at the bottom.

---

## HIGH — confirmed kernel bugs

### H1. Timeout fires the kill but the observer still hangs on dangling pipes

**Status:** Fixed in PR #16 (`fix/h1-timeout-process-group`) — timeout now kills the whole process group via `child_process.spawn(..., { detached: true })` + `process.kill(-pid, 'SIGKILL')`.

**File:** `src/command/command-observer.ts:23-55`
**Reproducer:** `bun audit/probes/probe-3-timeout.ts`

`Bun.spawn(["sh","-c", cmd]).kill("SIGKILL")` only kills the immediate child (the `sh` parent). When the command spawned descendants that inherited `stdout`/`stderr` pipes — either by `(cmd &)` orphaning, by `cmd & wait`, or by an `sh` that didn't exec into a single child — the descendants keep the pipes open. The two `pump()` loops at `command-observer.ts:46-53` block in `await reader.read()` waiting for an EOF that never arrives until the descendant terminates on its own.

Measured today on this machine:

| Command | `timeoutMs` | Wall-clock to return | `killedByTimeout` | Note |
|---|---|---|---|---|
| `sleep 10` | 1000 | **1004 ms** | `true` | Happy case (sh exec'd into sleep). |
| `trap '' TERM; sleep 10` | 1000 | **10 014 ms** | `true` | sh forked-then-waited; SIGKILL'd sh dies but sleep keeps the pipes. |
| `(sleep 30 &) ; echo orphan` | 800 | **30 008 ms** | `false` | sh exits cleanly, orphan re-parented to launchd, observer waits for orphan to die. Process leaks to system. |
| `sleep 30 & wait` | 800 | **30 011 ms** | `true` | Background child holds pipes after timer fires. |

**Why it matters:** the entire V0 thesis ("default 300 s timeout") is enforced on the shell, not on the observation. A user running `mira run "npm run dev"` (which spawns watchers) hangs the agent indefinitely. ADR 0001 invariant "exit codes preserved through timeout" is technically respected (`exitCode=null`, `signal=SIGKILL`, `killedByTimeout=true`), but the wall-clock contract is silently broken.

**Fix paths (small diffs):**

1. Spawn the child as the leader of a new process group (`Bun.spawn` does not expose this directly — `child_process.spawn(..., { detached: true })` does, then `process.kill(-pid, 'SIGKILL')`). Kills the whole tree.
2. After the timer fires, also `await reader.cancel()` on both pumps. Closes our end of the pipe so `pump()` returns even if descendants still hold the write end.
3. Add a hard outer wall-clock timeout (`Promise.race` with a 2× `timeoutMs` rescue) — defense in depth, returns `INTERNAL` on the rare path where 1+2 fail.

Pick (1) for correctness and (2) as belt-and-suspenders.

### H2. One bad `observation.json` blocks browse + pack generation

**Status:** Fixed in PR #17 (`fix/h2-tolerate-corrupt-observation-json`) — the recent-runs projection wraps the `JSON.parse` in `try/catch` and skips unreadable rows.

**File:** `src/store/evidence-store.ts:93-111`
**Reproducer:** `bun audit/probes/probe-4-corrupt-state.ts`

```ts
// evidence-store.ts:107
observations.push(
  JSON.parse(readFileSync(path, "utf8")) as CommandObservation,
);
```

The "skip incomplete dirs" comment at line 95 acknowledges crash resilience as a goal. It is enforced for the **missing-file** case (`existsSync` short-circuit) but not for the **malformed-JSON** case. A single failed write (disk full, OOM, kill -9 mid-write) propagates `JSON.parse` throw out of the loop and out of `listRecentObservations`. Both `list_recent_runs` and `generate_context_pack` then report `INTERNAL` with no rows — the entire history is opaque until the bad file is found and removed.

Probe output, with 3 healthy runs and the middle one's `observation.json` replaced by `"{this is not json,,,"`:

```
get_observation(corrupt): isError=true code=INTERNAL          ← acceptable, single-target
list_recent_runs():       isError=true code=INTERNAL          ← whole list dropped
generate_context_pack():  isError=true code=INTERNAL          ← pack cannot be generated at all
```

**Fix (small):** wrap the `JSON.parse` in `try/catch`, skip the row, log nothing (we don't have a logger in V0). Optionally include a sentinel in the projection (`{ id, unreadable: true }`) so consumers see something is wrong. ADR 0001's "raw evidence not silently discarded" is preserved — the raw `observation.json` is still on disk, and `get_observation(id)` still surfaces the parse error per-row.

---

## MEDIUM — quality gaps and my own bugs

### M1. Persisted observations are returned with no shape validation

**Status:** Fixed in PR #20 (`fix/m1-shape-validation`) — observations are validated with zod on read; shape-incorrect rows surface as a controlled error instead of round-tripping silently.

**Files:** `src/mcp/tools/get-observation.ts:74`, `src/mcp/tools/list-recent-runs.ts:80`
**Reproducer:** `bun audit/probes/probe-4-corrupt-state.ts` ("wrong shape" line)

```ts
return JSON.parse(readFileSync(path, "utf8")) as CommandObservation;
```

If `observation.json` is well-formed JSON of the *wrong* shape (e.g. older Mira version, or a partial write that happened to land between two valid braces), the boundary returns it verbatim and `isError` is undefined. Probe output:

```
get_observation(wrong shape): isError=undefined structured={"observation":{"totally":"wrong"}}
list_recent_runs(corrupt metadata): code=INTERNAL runs=undefined
```

ADR 0006's "no re-encoding" is honored for shape-correct data; the contract for shape-incorrect data is undefined. Adding a `zod` parse on read would close this — and `zod` is already a transitive dep of `@modelcontextprotocol/sdk`, so no new top-level dep.

### M2. My eval `bash` tool sandbox has ≥4 working bypasses

**Status:** Fixed in PR #24 (`fix/m2-bash-sandbox`) — guard rejects any `/`-bearing token (B1–B5 closed); offline coverage in `eval/harness/tools/bash-sandbox-tests.ts`.

**File:** `eval/harness/tools/bash.ts:14-26`
**Reproducer:** `bun audit/probes/probe-7-bash-sandbox.ts` and `probe-7b-bash-more.ts`

I shipped a sandbox that splits on `\s+` and rejects tokens starting with `/` (allowlist `/dev/null`, `/dev/stdin`). The header comment honestly says "not a security boundary". Confirmed leaks today:

| # | Bypass | Why |
|---|---|---|
| B1 | `x=/etc/passwd; cat $x` | Token `x=/etc/passwd` starts with `x`. |
| B2 | `FILE=/tmp/canary; cat $FILE` | Same shape. |
| B3 | `cat \/etc/passwd` | Token starts with `\`; sh resolves to `/etc/passwd`. |
| B4 | `read x </etc/passwd; echo $x` | Token `read` is normal. |
| **B5** | **`echo pwned >/tmp/probe-pwned`** | **Confirmed file write outside workdir.** Token `>/tmp/...` starts with `>`. |

The probe agent also claimed other vectors I did **not** independently confirm in this audit run (`<` redirection alone, `${IFS}` evasion, here-strings) — they may or may not all repro. The principle stands: token-level prefix matching is trivially bypassed.

**Why it's MEDIUM, not HIGH:** the harness runs locally on the user's machine, not as a service, and the workdir is mkdtemp'd. The threat model is "agent under prompt drift writes outside its scenario tree", not "remote attacker". Still, the next eval scenarios (A1/A2/A3 in `docs/eval/04-scenario-corpus.md`) will run agents that *should* be confined to a single worktree — a leak distorts results.

**Fix paths:** the cheap one is to also reject tokens that *contain* `/` outside known relative shapes, plus tokens shaped `KEY=/...`, plus reject `>`/`<` followed by `/`. The right one is `nsjail` / a chroot / a docker scratch image. ADR-style decision deferred — this lives in `eval/`, not `src/`.

### M3. My agent loop ignores `stop_reason === "max_tokens"`

**Status:** Fixed in PR #18 (`fix/m3-stop-reason-max-tokens`) — the loop refuses to execute a `tool_use` block truncated by `max_tokens`; offline test in `eval/harness/agent.test.ts`.

**File:** `eval/harness/agent.ts:127-134`
**Cross-check:** Anthropic [Handling stop reasons](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons)

The loop at `agent.ts:131` only branches on "no `tool_use` blocks → done". The Anthropic docs explicitly warn:

> If Claude's response is cut off due to hitting the `max_tokens` limit and the truncated response contains an incomplete tool use block, you'll need to retry the request with a higher `max_tokens` value.

My loop would happily execute the truncated tool call with whatever fields managed to serialize before the cut. Tool wrappers don't validate input depth (and shouldn't have to), so the failure mode is "pass undefined to `Bun.spawn` / `readFile` / `client.callTool`" — surface error at best, garbage forwarded at worst.

**Fix:** before extracting `toolUses`, check `if (response.stop_reason === "max_tokens" && lastBlock?.type === "tool_use") { stopReason = "token_cap"; break; }`. Two lines.

---

## LOW — rough edges

### L1. `max_tokens: 4096` hardcoded for Sonnet 4.6

**Status:** Fixed in PR #19 (`fix/l1-max-tokens-per-turn`) — `maxTokensPerTurn` is now configurable on `AgentConfig`.

**File:** `eval/harness/agent.ts:106`

Sonnet 4.6 supports far more (per current docs). 4096 is fine for the smoke (the model wrote `hello.txt` in 3 turns) but in real eval scenarios the model may legitimately need a longer single response (compound tool plans, multi-file edits in one turn). Silent truncation will skew the eval's token-reduction thesis. Parametrize via `AgentConfig`, default to `8192–16384`.

### L2. `ENAMETOOLONG` returns `INTERNAL`

**Status:** Fixed in PR #26 (`fix/l2-error-mapping`) — `ENAMETOOLONG` → `INVALID_INPUT`, `EACCES` → `NOT_FOUND`; `INTERNAL` default preserved for genuine bugs.

**File:** `src/mcp/tools/get-raw-evidence.ts` (caller of `statSync`)

A 10 KB `ref.path` triggers `ENAMETOOLONG` from the OS which the boundary maps to `INTERNAL`. ADR 0006 reserves `INTERNAL` for "genuine bugs" and lists `INVALID_INPUT` for malformed inputs. Map `ENAMETOOLONG` (and probably `EACCES`) to `INVALID_INPUT` / `NOT_FOUND` respectively.

### L3. `get_raw_evidence` is lossy on non-UTF-8 bytes

**Status:** Fixed in PR #27 (`fix/l3-encoding-contract`, description-only) — Option A: narrow the contract instead of changing the runtime.

**File:** `src/mcp/tools/get-raw-evidence.ts`

~~`readFileSync(path, "utf8")` replaces invalid sequences with `U+FFFD`. The tool description says "Returned verbatim — never truncated, summarized, or re-encoded". V0 evidence is shell stdout/stderr which is overwhelmingly UTF-8, so this is theoretical today; flag for any future binary evidence kind. Fix would be base64 with a `encoding: "utf8" | "base64"` field, but that's a contract change — defer.~~ **Fixed** in PR #27 (`fix/l3-encoding-contract`, Option A). The tool description in `src/mcp/server.ts`, ADR 0006 § `get_raw_evidence`, and `docs/architecture.md` § MCP Boundary now state explicitly that `content` is decoded UTF-8 with `U+FFFD` substitution and that V0 evidence kinds are text-only. The `encoding: "utf8" | "base64"` field (Option B) remains a deferred follow-up if a binary evidence kind is ever introduced — that would extend ADR 0006's contract and is out of V0 scope.

---

## Coverage gaps surfaced (no test, no structural enforcement)

From the ADR-by-ADR map produced by the coverage subagent:

- **ADR 0006 — dependency direction `mcp -> kernels -> core types`**: ~~not enforced~~. **RESOLVED** in PR #23 (`fix/struct-dep-direction-rules`, `.sentrux/rules.toml`). The two real ADR violations on `main` (mcp→cli markdown reuse, cli→mcp bin entry) were fixed in PR #21 (render extraction) and intentionally carved out (bin shim is composition root) respectively; see `docs/eval/01-sentrux-rules.md` § Resolution.
- **ADR 0005 — "all sensing logic under `src/architecture/`"**: structurally approximated by the rules (architecture is import-isolated to core), but symbol-level "sensing logic" cannot be detected by sentrux's import-only model. Documented as a known gap.
- **ADR 0005 — "zero new deps for sensing"**: same. A `npm install some-graph-lib` only used by `src/architecture/` would not break CI.
- **ADR 0001 — "core domain model stays small"**: subjective; not testable as written.
- **ADR 0001 — exit-code preservation tested only on exit 0 + a few non-zero cases**, never the full mutation matrix (signal **and** exitCode set, killed-by-timeout but exitCode populated, etc.). The probes confirmed observed behavior matches docs in the cases they hit; no proof for the cases they didn't.

~~Pragmatically: **a Sentrux rule file or an `eslint-plugin-import/no-restricted-paths` rule** closes the structural gaps cheaply.~~ Sentrux rules shipped (`.sentrux/rules.toml`, 13 rules, validated by `sentrux check .` v0.5.7+).

---

## What was probed and held up (null findings — also valuable)

These are *not* claims that the surfaces are bug-free; they are claims that the specific vectors I tried, today, against this commit, behaved per spec.

- **Path safety on `get_raw_evidence`**: every traversal vector tried was correctly rejected: `../etc/passwd`, `foo/../../etc/passwd`, `/etc/passwd`, symlinks to files (`runs/leak/symlink -> /etc/hosts`), symlinked dirs (`runs/escape -> /etc` then `runs/escape/hosts`), top-level dir symlinks (`.mira/leak -> /etc`). The `realpath` step at `get-raw-evidence.ts:104-129` does its job. (ADR 0006 invariant honored.)
- **Parallel `mira run`** at 50 concurrent invocations against the same project root: 50 distinct ids, no duplicate dirs, no partial writes, every observation matched the launched command. Birthday collision odds at this scale are ~10⁻⁶ per millisecond bucket; an `EEXIST`-retry around `mkdirSync(runDir)` would be cheap belt-and-suspenders, not currently necessary.
- **`generate_context_pack` against an empty `.mira/`**: returns a valid pack with `observationIds=[]`, `suspectedFiles=[]`. ADR 0004 Tier 2 honored.
- **`senseArchitecture` outside a git repo, and even with `PATH=""`**: returns `[]` cleanly via `spawnSync` non-zero status — no throw, no stderr leak. ADR 0005 happy path.
- **Traversal `observationId`** (`../../../etc/passwd`): rejected by the `^[A-Za-z0-9_]+$` whitelist with `NOT_FOUND`.
- **Cross-package `@modelcontextprotocol/sdk` copies**: both `node_modules/.../sdk@1.29.0` are byte-identical (verified via `diff -r dist/`). The `as any` cast in my `mira-mcp.ts:52` is a TS-identity artifact, not a runtime hazard. **Fragile**: pin both `@modelcontextprotocol/sdk` to an exact version (drop the `^`) so a future minor bump in one and not the other doesn't silently mismatch.

---

## What this audit did NOT cover

- **No fuzzing** of the Anthropic API responses themselves — I did not simulate an SDK that returns malformed `usage` objects, missing `content` arrays, etc.
- **No load tests** — only one parallel-50 run; nothing about long-running scenarios with many GB of evidence.
- **No cross-platform** — all probes ran on macOS Darwin 25.3.0 with `/bin/sh` = bash. Linux/dash and Windows behave differently for spawn semantics; H1 fix needs to respect that.
- **No prompt-caching audit** — currently disabled in the harness, but if turned on, `agent.ts:113-114` undercounts cost (cache_creation × 1.25 + cache_read × 0.1 are missing). Latent bug — file ticket before enabling caching.
- **No security review** of the MCP stdio transport itself — assuming the `@modelcontextprotocol/sdk` framing is correct (separate audit, separate PR).

---

## Recommended fix order

If this report becomes a backlog, my priorities:

1. **H1** (timeout / orphans). Mira's whole "command observer" identity rests on this contract. ~30 LOC.
2. **H2** (corrupt-file poison). One `try/catch` in `evidence-store.ts:107`. Trivial, high impact.
3. **M3** (stop_reason = max_tokens). 5 LOC in `agent.ts`. Required before sub-task iv runs real models.
4. **L1** (max_tokens parametrize). Ride along with M3.
5. **M1** (zod-on-read for observations). Ride along with H2's corrupt-file fix — same blast radius.
6. **Sentrux rules** for ADR 0005/0006 dep direction. Was already designed in `docs/eval/01-sentrux-rules.md`; resurrect.
7. **M2** (bash sandbox). Cheap fixes (token-contains-`/`, `>/`, `KEY=/...`) before sub-task iv. Real fix (nsjail / docker) when scenarios get serious.
8. **L2, L3** (error-code mapping, encoding contract). Cosmetic; defer until they bite. — **Both fixed.** L2: PR #26. L3: PR #27. Audit series 20260506 closed (9/9 issues addressed).

---

## What I personally got wrong (in PR #15)

For honesty:

- **Bash sandbox is a fig leaf.** I shipped it knowing the rejection regex was best-effort; I underestimated how trivially the agent (or a prompt-injection vector) could bypass it. The header comment ("not a security boundary") is true but doesn't excuse the gap — it should at minimum block file writes outside the workdir.
- **Stop-reason handling is wrong.** I copy-paste'd the loop pattern from familiarity, not from re-reading the docs. Two-line fix would have prevented a real failure mode.
- **`max_tokens: 4096` is conservative theatre.** I picked it because it sounded "safe" — actually it's the smallest defensible value. Should be parametrized.
- **The `as any` cast is fragile.** I wrote a comment saying "package-identity artefact, not a runtime issue", which is true *because both versions are pinned to the same major and currently identical*. The comment doesn't say "this assumption is fragile" — and it is.

None of these are reasons to revert PR #15; they're reasons to harden it before sub-task iv runs anything that matters.
