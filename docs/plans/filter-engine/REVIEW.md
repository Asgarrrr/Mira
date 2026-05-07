# Review of the filter-engine plan

## TL;DR

**Verdict: ship after addressing the compression-threshold blocker.** The plan is structurally sound — the dispatcher placement, the registry shape, the wrapper-stripping algorithm, the evidence composition all hold up to attack. But the **0.30 median compression ratio is empirically unreachable** for the renderer described, on real tsc output. I reproduced the eval's B1 bug against the actual repo and measured the ceiling at ratio ≈ 0.55, not 0.30; on smaller failures it climbs above 0.85. Picking tsc as pilot while explicitly **excluding cascade dedup from V0.4 scope** removes the only mechanism that would make this pilot hit the threshold. Two paths out: ship with a calibrated threshold (≤0.70 typical, ≤0.50 on cascade fixtures) and rename the metric, or include the smallest possible cascade-dedup pass and keep 0.30. Both are honest; the current plan is not.

Top three findings:
1. **B (blocker) — Compression threshold 0.30 is fiction for tsc + this renderer.** Measured 0.55 on the eval's own B1 fixture; typical short-error case is 0.85.
2. **J (major) — Pilot/scope mismatch.** The plan picks tsc *because* of cascade ROI (00-decisions.md:191) and then explicitly defers cascade dedup (README.md:169). The pilot's main lever is in the next slice.
3. **C (major) — Information preservation gate is too narrow.** `(file, line, ruleId)` triples is not "every diagnostic preserved" — multi-line continuations (which tsc uses for "Property X is missing", "Type Y is incompatible because Z") are dropped at the renderer per 05-tsc-parser.md:93, and the bench will not flag this as loss.

---

## Methodology

### What I read (in full)

- All 10 plan files: `docs/plans/filter-engine/{README.md, 00-decisions.md, 01-types.md, …, 08-documentation.md}`.
- Project canon: `CLAUDE.md`, `docs/thesis.md`, `docs/architecture.md`, `docs/observation-pipeline.md`, `docs/non-goals.md`.
- ADRs `0001`, `0006`, `0007` in full; skimmed `0002`–`0005`.
- Eval: `docs/eval/postmortem-001.md`, `04-scenario-corpus.md`, `02-thesis-and-metrics.md`; spot-checked `03-harness-design.md` and `eval/results/2026-05-07T10-48-32-006Z/summary.md`.
- Hook layer code: `src/cli/run.ts`, `src/cli/rewrite.ts`, `src/cli/index.ts`, `src/command/command-observer.ts`, `src/store/evidence-store.ts`, `src/core/finding.ts`, `src/core/command-observation.ts`, `hooks/README.md`, `hooks/claude/mira-rewrite.sh`.
- Existing tests: `tests/cli-run.e2e.test.ts` in full; test names from `tests/cli-rewrite.test.ts` and `tests/command-observer.test.ts`.

### What I verified independently

| Claim | Verified by | Result |
|---|---|---|
| tsc writes diagnostics to stdout, not stderr | `tsc --noEmit broken.ts` against a 4-error fixture, stream-split | confirmed: 524 B stdout, 0 B stderr |
| B1 raw output volume | `git apply eval/scenarios/B1/base.patch && bun tsc --noEmit` | 4192 B stdout, 12 errors, exit 2 |
| tsc multi-line cascade exists | TS2769 "No overload matches this call" emitted with two `Overload N of 2,…` continuations | confirmed: ~1500 B for a single multi-line diagnostic |
| `--pretty` produces a different format the plan's regex won't match | `tsc --noEmit --pretty suggestion.ts` | format is `file:line:col - error TSxxxx:` (colons + dash) — plan's `file(line,col):` regex won't match |
| Stdout buffered, not streamed | `src/command/command-observer.ts:36-50` | confirmed: `stdoutBuf += text; combinedBuf += text` |
| `findings: Finding[]` exists in schema, currently always `[]` | `src/core/command-observation.ts:24, 54` | confirmed |
| Hook always passes `--quiet` | `src/cli/rewrite.ts:125-127` | confirmed |
| No existing test invokes tsc | `grep -rn "tsc\|typescript" tests/` | confirmed (one comment match in `hooks-install.test.ts` only) |
| RTK `src/filters/` is TOML-defined | WebFetch on `github.com/rtk-ai/rtk/tree/master/src/filters` | confirmed: 70+ `.toml` files (e.g. `biome.toml`, `terraform-plan.toml`) |
| Eval harness state | `eval/results/` has 12 result dirs through 2026-05-07; `git log` shows `1fc2397` "drop synthetic-agent harness, keep client-agnostic parts" | partially bit-rotted: agent loop removed in PR #41, only scenarios + fixtures + report renderer remain |

### What I could not verify

- **TS 4.x → 5.x format stability.** Public release notes (TS 5.0) do not describe a diagnostic-format change, but I could not exhaustively verify across all 4.x→5.x→5.9 versions. Plan's claim is plausible but uncovered by my checks.
- **bench timing on a 600-line fixture.** The "≤30ms p95 on the largest fixture" budget is plausible for a single regex per line, but I did not run the parser. The plan correctly notes this is small relative to shell process launch time.
- **Future-filter IO needs.** The "sync is fine" claim is a forward-looking judgment I can only sanity-check; see G.

---

## Findings, by attack vector

### A. Pilot pick — **WEAK**

The plan's table (00-decisions.md:186) gives tsc top marks on every axis. The math doesn't survive contact with real fixtures.

**Byte-volume sanity check** (run by me, this session):

| Command | Failure shape | Raw bytes | Errors | Bytes/error |
|---|---|---:|---:|---:|
| tsc --noEmit | `broken.ts` (4 type errors, 1 multi-line) | 524 | 4 | ~131 |
| tsc --noEmit | B1 reproduction (eval bug applied) | 4192 | 12 | ~349 |
| tsc --noEmit | small cascade (12 Point errors) | 1443 | 12 | ~120 |
| bun test | 2 trivial assertion failures (with source snippet) | 803 | 2 | ~402 |

bun test at 2 trivial failures = 803 B; at 30 failures it would be ~12 KB. Source snippets are big and mostly redundant — easy to compress. The plan rejects bun test on "format instability across versions" (00-decisions.md:196), but bun test's format has been stable since bun 1.0; the more honest reason would be "we don't want to write three parsers". The rejection of vitest on the same grounds is stronger (vitest reformats output across major versions), but it gets bundled with bun test.

**Eval B1 alignment is real but not as strong as the plan implies.** The B1 scenario (04-scenario-corpus.md:91) is constructed precisely to exhibit cascade behavior — "a single root cause producing many surface symptoms". My reproduction yields 12 errors, not the 14 the corpus claims, and most are *unique* errors not cascade-cluster siblings (TS2339 + TS2739 + TS2488 + TS2769 + TS7006). The eval's "agent reads first 3 errors, recognizes the type-shape problem" works regardless of whether Mira shows raw or filtered — the filter's contribution to B1 is secondary.

**Format stability claim** (00-decisions.md:188 "very stable"): no public release notes document a tsc output break in 4.x→5.x. Couldn't confirm exhaustively. Plausible.

**Verdict:** the rejection of vitest and bun test is rationalized; the rejection of eslint (trivial-parser-low-win) is sound. tsc is *a* defensible pilot, not the obvious one — and it inherits a hidden cost (B/J below).

### B. Compression threshold (0.30) — **FAIL (BLOCKER)**

The plan presents 0.30 (00-decisions.md:217, README.md:81) without empirical grounding. Let me derive it.

**Per-line transformation by the renderer** (05-tsc-parser.md:78-94):

```
Raw:      cascade-real.ts(2,7): error TS2739: Type '{ x: number; }' is missing…
Rendered:                      - **TS2739** L2:7 — Type '{ x: number; }' is missing…
```

Savings per line: filename hoisted to section header (~30 chars per line, deduped across N lines from same file). Prefix `error ` removed. Net per-line savings ≈ 25-50 chars on a 120-300 char line — i.e., per-line ratio ≈ 0.80–0.90.

**Math against my B1 reproduction:**
- Raw: 4192 B, 12 errors, 7 distinct files
- Rendered (estimated): title (~50 B) + 7 file sections (~25 B each) + 12 bullets at ~80–250 B = ~2300–2700 B
- Plus the multi-line TS2769 continuation (~1500 B in raw) collapses to first sentence in renderer → save ~1300 B
- **Estimated ratio ≈ 0.55–0.65** on the eval's own B1 fixture.

For my "12 single-line Point errors" fixture (1443 B raw):
- Rendered ≈ 50 + 25 + 12 × 100 = 1275 B
- **Ratio ≈ 0.88.** Above the threshold by 3×.

For the 4-error broken.ts (524 B raw, 1 multi-line):
- Rendered ≈ 50 + 25 + 4 × 90 = 435 B (after dropping the one TS2345 continuation)
- **Ratio ≈ 0.83.**

Where would 0.30 come from? Three places, none in V0.4 scope:
1. **Cascade dedup** — 50 errors → 1 root, 49 silenced. Plan: out-of-scope (README.md:169).
2. **Drop messages entirely** — keep only `(file, line, ruleId)` triples. Violates the plan's own information-preservation invariant for the message body.
3. **Aggressive truncation of message text** — would erode information preservation further.

**The threshold is biased to the failure direction:** if the plan ships and the bench fails, V0.4 doesn't ship — but the dispatcher, registry, types, fixtures, and bench infrastructure all still work. The plan's F1 ("tsc pilot does not hit 0.3") acknowledges this failure mode and lists "tighten the renderer" or "pivot to bun test". "Tighten the renderer" with the constraints listed cannot achieve 0.30; "pivot to bun test" is a 3-day rebuild on Tasks 04–06.

**Recommendation (numbered for the verdict block):**
- **B-1.** Reset the threshold to a value supportable by the renderer described: ≤0.70 median typical, ≤0.50 on the cascade fixture. Or
- **B-2.** Include a minimal cascade-dedup pass (cluster identical `(ruleId, identifier)` pairs into a single bullet with a count). One small function, ~30 LOC. Keeps 0.30 honest.
- **B-3.** Reframe the metric. "Tokens saved per failure run on real fixtures" with absolute numbers (e.g. "~1200 B saved / failure on the B1 fixture") would not depend on a ratio that fights the renderer.

I cannot recommend shipping with 0.30 unchanged. The ship gate is misaligned with what the plan can produce.

### C. Information preservation — **FAIL (MAJOR)**

The plan's invariant (00-decisions.md:213): "every `(file, line, ruleId)` triple appears verbatim in the markdown". This is the right *correctness* gate but the wrong *preservation* gate.

**What a user-facing tsc message contains beyond the triple:**

```
src/x.ts(7,5): error TS2345: Argument of type '{ name: string; }' is not assignable to parameter of type '{ name: string; age: number; }'.
  Property 'age' is missing in type '{ name: string; }' but required in type '{ name: string; age: number; }'.
```

The continuation is *not* decorative. It tells the agent *which property* is missing — without it, the agent must compute the difference between the two types itself, character by character. Plan § Task 05 (05-tsc-parser.md:93) explicitly drops this:

> Multi-line messages: include the first line in the bullet; the rest of the message is dropped at this stage.

**My empirical observation:** on the B1 fixture, the TS2769 "No overload matches this call" diagnostic is ~1500 bytes of structured cascade with two `Overload N of 2…` branches. Each branch carries the actual mismatch information. Dropping it keeps `(file, line, ruleId)` but removes *the entire diagnostic content*.

**Why the gate doesn't catch this:** the bench (07-bench.md) only asserts the triple appears; it cannot tell that 70% of the message body was dropped at render time. F2 in the plan ("preservation snapshot fails repeatedly") fires *only* if the parser drops a finding, not if the renderer drops body text.

**Other preservation gaps:**
- The `Found N errors in M files` summary line: plan drops it (05-tsc-parser.md:54), regenerates from `diags.length`. Fine — but if the parser misses some errors that don't match the regex, the regenerated count diverges silently. There is no consistency check.
- `--pretty` mode "related-information" annotations (`'X' is declared here.` cross-references): only emitted in pretty mode. Mira's piped stdout makes tsc default to non-pretty, so this is not currently lost — but if a user explicitly passes `--pretty`, the regex (file:line:col format) doesn't match and the entire output falls through.

**Recommendation:**
- **C-1.** Tighten the renderer to keep continuation lines (or summarize them deterministically) when they don't make the bullet too long.
- **C-2.** Add a coverage metric to the bench: `bytes_in_findings / bytes_total_input`. If parser ate < X% of input bytes, flag.
- **C-3.** Document `--pretty` as unsupported (not just untested) and add a parser-no-match path that falls through to passthrough explicitly when fewer than N% of lines parse.

### D. Stderr suppression on filter hit — **PASS (with one caveat)**

Empirical check: tsc --noEmit on a 4-error case writes 524 B to stdout, 0 B to stderr. Even in pretty mode, diagnostics stay on stdout. So under normal operation, the suppression is invisible.

**Edge cases I considered:**
- `Cannot find module 'X'` resolution warnings — surfaced as TS2307 errors on stdout, not stderr. Confirmed.
- `tsconfig.json watch mode unavailable` style warnings — could not reproduce on my version (TS 5.9.3); these existed in older tsc versions and historically went to stderr.
- Project-reference resolution diagnostics — go to stdout in modern tsc.
- `tsc: command not found` from the shell — this is shell stderr, not tsc stderr. The dispatcher would never see "tsc" as the program token because the shell would have failed before observation. Non-issue.

**Caveat (matches the plan's F6):** if a future tsc version writes a non-TS-shaped warning to stderr, the parser won't pick it up, and the suppression deletes it from the agent's view. The plan accepts this. Acceptable in V0.4 because:
- Raw `stderr.log` is one read away under the run dir.
- The evidence pointer line tells the agent where to look.

**Recommendation: PASS, but** the test in Task 03 (cli-run-filter.e2e.test.ts) should include one case where stderr is non-empty during a filter hit and assert that:
1. The filtered markdown still renders.
2. The stderr content is *findable* via the run dir.

That test would catch a regression where a future hook accidentally `rm`'d stderr.log alongside its suppression.

### E. Wrapper-stripping algorithm — **WEAK**

Plan covers (00-decisions.md:54-62, 02-dispatcher.md:42-78):
- `pnpm`, `npm`, `yarn`, `bun`, `npx`
- Two-token sub-forms: `pnpm exec`, `pnpm run`, `pnpm dlx`, `bun x`, `npm exec`, `yarn run`, `bun run`
- Leading flags `--silent`, `-s`, `--`
- Leading `KEY=value` env

I traced the algorithm against 14 wrapper shapes the plan does not cover. Categorized:

**False negatives → no harm (passthrough):**
- `dotenv -- tsc --noEmit` → returns "dotenv" → miss → raw output. **Common in monorepos.**
- `cross-env CI=1 tsc` → returns "cross-env" → miss → raw output. Very common in test scripts.
- `time tsc --noEmit` → returns "time" → miss.
- `node --max-old-space-size=8192 ./node_modules/.bin/tsc` → returns "node" → miss.
- `./node_modules/.bin/tsc --noEmit` → returns the full path → miss. Common in CI scripts.
- `nice -n 19 tsc` → returns "nice" → miss.
- `turbo run typecheck` → "turbo" not in WRAPPERS → returns "turbo" → miss.
- `yarn workspace foo tsc` → after stripping `yarn`, peek finds "workspace" (not in {run, exec, dlx, x}) so loop stops; returns "workspace". Miss. **Common in yarn monorepos.**
- `pnpm --filter foo run typecheck` → after stripping `pnpm`, peek finds `--filter` (not a sub-token); algorithm step 5 says "return next non-flag token" but `--filter foo` is a flag-with-value pair the algorithm has no knowledge of → likely returns "foo" or "--filter". Miss. **Very common in pnpm monorepos.**
- `pnpm --filter foo tsc` → same. Miss.

**False positives I can construct:** none. After stripping, the literal-match against the registry guarantees no spurious hit.

**Genuinely ambiguous (plan does not specify behavior):**
- `pnpm dlx -p typescript@5 tsc` — after `pnpm dlx`, the next tokens are `-p typescript@5 tsc`. Algorithm step 4 sub-bullet only lists `--silent, -s, --` for skip; `-p` is not in the list. Step 5 says "next non-flag token". If `-p` is treated as a flag, what about its value `typescript@5`? Behavior is undefined. Likely returns `typescript@5` or `tsc` depending on implementation choice.
- `bunx --bun tsc` — `bunx` is not in WRAPPERS (only `bun x` two-token form is). **`bunx` is the standard bun shortcut**; not catching it is a real gap. Returns "bunx" → miss → no harm but also no benefit.

**Quoted-arg handling:** plan tokenizes on whitespace (02-dispatcher.md:46). For `pnpm exec --silent "tsc"` (literal quotes preserved through the shell), the token would be `"tsc"` not `tsc`. Registry lookup fails. **Real false negative.** Mitigation cost: trim leading/trailing quote chars off candidate token; ~5 LOC.

**Verdict:** the false-negative profile is acceptable (the plan correctly bounds risk to passthrough). But two common wrappers (`pnpm --filter X`, `yarn workspace X`, `bunx`) are likely to be missed in real monorepos — the same monorepos most likely to use Mira. Add them in a follow-up; not a blocker.

**Recommendation:**
- **E-1.** Add `bunx` to WRAPPERS as a one-token form.
- **E-2.** Add `--filter <value>` and `workspace <name>` skip rules so `pnpm --filter foo run typecheck` and `yarn workspace foo tsc` resolve. ~10 LOC.
- **E-3.** Strip leading/trailing single and double quotes off the candidate token before registry lookup.
- **E-4.** Extend the table-driven test (02-dispatcher.md:90) to include 5+ false-negative cases as documented "no-op" entries — so a future change that accidentally matches them is caught.

### F. Findings mutation in runCommand — **PASS**

Plan (03-wire-into-run.md:48-50) mutates the result of `buildObservation`:

```ts
const observation = buildObservation(run);
if (view !== null) observation.findings = view.findings;
store.writeObservationJson(run.id, observation);
```

I verified `commandObservationSchema` is parsed *only at read time* (`evidence-store.ts:120` in `listRecentObservations`), not at write time. `writeObservationJson` (evidence-store.ts:72) just `JSON.stringify`s the object — no `.parse`, no `Object.freeze`. Mutation works.

Cleaner alternative: thread `findings` into `buildObservation` as an optional param. But that couples `core/command-observation.ts` to the filter pipeline conceptually, which the plan correctly avoids. Mutate-then-persist is a bounded, contained tactic. The mutation lives in one file (`run.ts`), happens immediately after construction, and is observed by no other code before persistence.

**One nit (minor):** the plan does not assert the schema parses after mutation. If a future filter returns a `Finding` with extra fields, zod's default behavior is to strip them on parse. Add `commandObservationSchema.parse(observation)` before write — costs nothing, catches a class of regression.

### G. "Filter is sync" decision — **PASS, but tighter than it looks**

Plan (01-types.md:56-62, 00-decisions.md:32-42): `Filter: (input, ctx) → FilteredView`. Sync.

**Future filters that would want IO:**
- A test runner filter that reads source at the failure location to enrich the excerpt: ~feasible sync via `readFileSync`. **Sync works.**
- A `tsconfig.json` resolver to remap relative paths to absolute: sync via `readFileSync`. **Sync works.**
- An LSP ping for symbol info: requires a long-running process pool; not sync-friendly. **Sync would break.**
- A rate-limited remote API call: not sync-friendly. **Sync would break.**

The first two cover most realistic V0.5–V0.6 filter wishes. The migration cost (claim from plan: "change the signature in one place") — the dispatcher is wrapped in try/catch and called synchronously from `runCommand` (`await observer.observe` … `dispatchFilter` … `process.stdout.write`). Migration to async means:
- `dispatchFilter` becomes `async`, returns `Promise<FilteredView | null>`.
- `runCommand` already in an async context (`async function runCommand`, line 6 of run.ts) — adds `await`.
- All filter implementations change their signature.
- Tests change their assertion shape.

Total migration: ~30 LOC + every filter file. Not free, not catastrophic.

**Verdict: the plan's call is correct for V0.4.** The sync constraint forces filter authors to use sync IO if they need any IO at all, which keeps the contract simple. When the first filter that needs async IO arrives, the migration is a bounded refactor.

### H. `--quiet` / footer matrix — **PASS, with one missing case**

Plan's table (00-decisions.md:150-156) has 4 rows: {direct CLI, hook} × {filter hit, filter miss}. tty axis is not covered explicitly.

**Is the tty axis material?**
- `process.stdout.isTTY` is referenced *nowhere* in the current Mira code — I grepped src/ and confirmed. The footer is unconditional on TTY (line 32-41 of run.ts: `if (!quiet) process.stderr.write(…)`).
- The filter output (`view.markdown`) is plain text. No TTY-specific rendering.
- Whether agents see TTY: no — the hook redirects through `bun .../index.ts run --quiet …`, so child stdout is a pipe.

**Verdict: tty axis is non-material in V0.4.** No need to add it to the table. Document this with a one-line note that says so explicitly, so a future contributor doesn't reintroduce the question.

**Missing case:** what if a future caller (not the hook) doesn't pass `--quiet`?
- Direct CLI (no hook): footer renders to stderr, filter renders to stdout. Both visible, no conflict.
- A hypothetical future hook that forgets `--quiet`: the agent sees the filtered markdown on stdout AND the `[mira] …` footer on stderr. Most agents merge stderr into the tool result anyway → mild noise. **Defensible.**

### I. Bench as ship gate — **WEAK**

Plan claim (00-decisions.md:223): "the eval can't run cleanly until the harness fixes from postmortem-001 land". I checked: the harness state is *more nuanced* than the plan implies.

- `eval/results/2026-05-07T10-48-32-006Z/` exists (created today, 2026-05-07). Has 12 result dirs (4 scenarios × 3 repeats × 2 modes - some). The result-renderer + scenarios + report logic still work.
- `git log` commit `1fc2397` "drop synthetic-agent harness, keep client-agnostic parts" (PR #41) tells me the *agent loop* was removed — i.e., there is no longer a runnable end-to-end agent-driven eval. The fixtures, scenarios, and report renderer remain; the orchestration that drives Claude does not.
- Postmortem-001 explicitly notes (line 5 caveat) that the loss verdict was about the *synthetic* agent, not Claude Code.

**So the claim "harness can't run cleanly" is true in the sense that no agent-driven harness exists.** It's misleading in the sense that a Claude-Code-driven harness has not been built and would itself be a several-day project. The bench is the right V0.4 gate because the alternative is *not built*, not because the alternative is *broken*.

**The bench-vs-eval gap matters concretely:**
- Bench measures: bytes(filtered) / bytes(raw) on a static fixture.
- Eval would measure: tokens spent by an agent solving B1 with vs without the filter.
- These can diverge significantly. Example: filter cuts B1 raw output from 4192 B to 2300 B (saving ~500 tokens), but the agent also reads `.mira/runs/<id>/combined.log` once (adds ~1000 tokens). Net: filter *increases* tokens.

The plan accepts this divergence (R5 in README.md:104, with a 30%-divergence revision trigger in 00-decisions.md:226). That's reasonable in principle. In practice, with no agent-eval scheduled to land near V0.4, the trigger may not fire for months. The bench could pass and Mira could regress agents silently.

**Recommendation:**
- **I-1.** Promote the eval-harness rebuild to "next after V0.4 ships" in the V0.4 PR description. The plan's docs (08) currently has it as out-of-scope without a follow-up commitment. Ship V0.4, then rebuild a Claude-Code-driven harness, then re-test against V0.4.
- **I-2.** Add a "regression?" answer mechanism. If the bench passes but a follow-up eval shows agents perform worse with the filter on, **what is the response?** ADR 0008 should answer this. Right now, no one decides — the bench is the gate, the eval is "consumed later". A planned authority to revoke V0.4 is necessary; otherwise the silent regression has no remediation path.

### J. Cascading failure mode — **FAIL (MAJOR)**

The original observation-pipeline.md:139-151 commits V0.4 to A+B+C+D. The plan ships only A. The plan acknowledges this narrowing in 08-documentation.md and adds a doc paragraph that V0.4 = Slice A.

**What "épurée" justifies:**
- Slice D (TOML registry fallback) — not shipping is correct. Mira is not RTK; building a TOML schema for V0.4 is premature.
- Slice B (diff-on-rerun) — independently valuable, can be shipped V0.5 without coupling.

**What "épurée" does NOT justify:**
- Slice C (cascade dedup). The plan picks tsc as pilot **because of cascade clustering ROI**: 00-decisions.md:191 explicitly says "Cascade clustering ROI: very high (one missing import → 50 errors)". Then it ships *without* cascade clustering and sets a compression target (0.30) that is only achievable *with* cascade clustering. That's not narrowing the slice — that's keeping the dishes that need salt and removing the salt.

**Counterfactual:** if Slice C were in V0.4, what compression would tsc see?
- The B1 fixture I reproduced has 8 errors of TS2739/TS2741 type all rooted in "evidenceRefs missing array". Cluster them into one finding ("8 sites, all missing array on evidenceRefs") with a `count: 8` and a list of locations. Compression on the cluster: ~80% (8 lines → 2). Total bench compression on B1: ~0.30, the actual target.
- Without Slice C: ~0.55 as measured.

**Recommendation:**
- **J-1.** Either include a minimal cascade-dedup pass (cluster by `(ruleId, normalized-error-message)` — ~30 LOC, deterministic) or *acknowledge in the ADR* that the threshold is unachievable without it and recalibrate.
- **J-2.** If you keep Slice C out, switch the pilot to bun test where source-snippet truncation provides honest compression without cascade dedup. The plan's rejection of bun test on format-instability grounds is weaker than the plan implies (bun test format has been stable across 1.x).

### K. Risks the plan didn't list — **MIXED**

For each, my assessment:

1. **Race conditions in `filtered.md` write.** Each run gets a unique `<run-id>` directory; parallel `mira run` writes go to disjoint paths. **Non-issue.** The existing `evidence-store.ts:153 writeRunFile` does a synchronous `writeFileSync` — no atomic temp-and-rename, but each run owns its directory exclusively.

2. **`bench/filter/tsc.ts` calls `tscFilter` directly without `dispatchFilter`** (07-bench.md:67-73). **Real gap.** The bench measures parser+renderer but not wrapper-stripping or registry lookup. So a regression in `extractProgramToken` would not show up in the bench. The plan accepts this implicitly — wrapper-stripping has its own unit tests (Task 02). But: if the bench is the V0.4 ship gate, the gate doesn't exercise the dispatch path. Suggest adding one bench row that calls `dispatchFilter("pnpm tsc", …)` end-to-end. ~5 LOC.

3. **Snapshot vs bench byte-count disagreements.** Both consume the same fixture. As long as both use the same parser+renderer, they agree by construction. The risk is a bench that re-implements parsing — the plan's bench imports `tscFilter` directly (07-bench.md:42), so this is fine. **Non-issue.**

4. **Agent doesn't know the filter ran.** The markdown header (`# tsc — 3 errors in 2 files`) plus the `_evidence: …` line are the only signals. Is this enough? **Borderline.** A Claude Code agent reading the tool result will see the markdown and treat it as the command output. The agent has no signal that this is *Mira's view* of the output, not the raw tsc output. If the agent later runs `cat .mira/runs/<id>/combined.log` and sees a different format, it might be confused. **Recommendation:** consider a small change to the header: `# tsc — 3 errors in 2 files (mira-filtered)` or a footer comment `<!-- mira: filtered, raw at .mira/runs/<id>/ -->`. Costs 30 chars; informs the agent. Plan currently has only the evidence pointer, which is implicit. Minor.

5. **Information loss on filter exception → silent passthrough.** Plan (02-dispatcher.md:73-77): `try { return filter(...) } catch { return null }`. Then dispatch returns null → passthrough → agent sees raw output. **The agent has no signal that Mira tried and failed.** This is the worst of both worlds: the agent can't trust that "raw output means no filter exists", because sometimes raw output means "filter crashed". Suggest writing `filter-error.log` to the run dir on exception (plan mentions this as future, 02-dispatcher.md:79) and emit a one-line warning to stderr when the filter would have applied: `[mira] filter for tsc raised; passthrough used; see .mira/runs/<id>/filter-error.log`. **Minor for V0.4** (since the only filter, tsc, has small chance of throwing on real input), but worth a follow-up ticket.

6. **Mutation of `observation` after build, before write.** Already covered (F). The schema validates only on read, so the mutation is invisible to the writer. Add a `commandObservationSchema.parse` before write; cost zero, catches typos.

7. **`bench:filter:tsc` script only.** No `bench` script that runs all benches. As V0.5+ adds filters, bench discovery should be automatic or scripted. Plan defers; acceptable for V0.4 but flag in 08-documentation.md.

### L. The plan's own claims, verified

| Claim | Plan reference | Status | Evidence |
|---|---|---|---|
| 1. Stdout buffered, not streamed | 00-decisions.md:11, 17 | ✅ verified | `src/command/command-observer.ts:36-50` accumulates `stdoutBuf += text` |
| 2. `CommandObservation.findings: Finding[]` exists, currently `[]` | 01-types.md:11, 00-decisions.md:48 | ✅ verified | `src/core/command-observation.ts:24` (schema), `:54` (`findings: []` in builder) |
| 3. Hook always passes `--quiet` | 00-decisions.md:140, README.md:96 | ✅ verified | `src/cli/rewrite.ts:125-127`: `${cmd} run --quiet ${escapeForShell(command)}` |
| 4. No existing test invokes tsc | README.md:93, 03-wire-into-run.md:101 | ✅ verified | `grep -rn "tsc\|typescript" tests/` — only one comment-only match in `hooks-install.test.ts:18` |
| 5. RTK uses regex per-command in TOML files | 00-decisions.md:67 | ✅ verified | `github.com/rtk-ai/rtk/tree/master/src/filters` returns 70+ `.toml` files with `match_command`, `strip_lines_matching` keys |
| 6. CommandObserver returns stdout/stderr as strings | 00-decisions.md:11 | ✅ verified | `src/command/command-observer.ts:106` returns `{ run, stdout: stdoutBuf, stderr: stderrBuf }` |
| 7. tsc multi-line cascade exists | 05-tsc-parser.md:93, README.md:99 | ✅ verified | TS2769 emitted on B1 reproduction with two `Overload N of 2…` continuations totaling ~1500 B |
| 8. `tsc --pretty=false` is the format the regex matches | 05-tsc-parser.md:48 | ✅ verified | non-pretty: `file(line,col): error TSxxxx:` (regex matches); pretty: `file:line:col - error TSxxxx:` (regex doesn't match) |
| 9. The `eval/` harness is too heavy / not yet ready | 00-decisions.md:223 | ⚠️ partial | true that a Claude-Code-driven agent loop does not exist (PR #41 dropped the synthetic loop); fixtures + report renderer + scenarios still work |
| 10. tsc compresses to ≤30% of raw bytes on real fixtures | 00-decisions.md:201, 217 | ❌ FAIL | measured ~0.55 on B1, ~0.85 on smaller failures, with the renderer described |

---

## Findings the plan missed

Numbered, severity-tagged.

1. **[BLOCKER] The 0.30 compression threshold is empirically unreachable** with the renderer described, on real tsc output. See B above. Recalibrate or include cascade dedup.

2. **[MAJOR] The pilot's main compression lever (cascade dedup) is in V0.5+.** See J. Either include it or reconsider tsc as the pilot.

3. **[MAJOR] Information preservation only checks `(file, line, ruleId)`, not message body or continuations.** See C. Multi-line tsc messages carry the most actionable content; the renderer drops them by design and the bench cannot detect the loss.

4. **[MAJOR] No agent regression detection.** Plan accepts a 30%-divergence trigger between byte-count and token-count, but there is no scheduled eval to fire it. ADR 0008 should commit a follow-up. See I.

5. **[MAJOR] `--pretty` mode breaks the regex.** Plan's defense is "Mira pipes stdout, so tsc defaults to non-pretty" — true, but if a user explicitly passes `--pretty` (common in human-facing scripts), the parser silently produces zero findings and the dispatcher returns a `FilteredView` with empty `findings[]` and "pass" markdown. The agent sees `# tsc — pass` on a failing build. **Add: parser detects `--pretty`-shaped lines and falls through to passthrough** (treat as miss), so the agent at least gets raw output instead of a wrong "pass".

6. **[MAJOR] Filter exception → silent passthrough is indistinguishable from "no filter exists".** See K.5. Add a one-line stderr warning when the filter is registered but threw, so the agent / user knows.

7. **[MAJOR] tsc actually exits with code 2 on errors, not 1.** Plan's tests (e.g. 06-register-tsc.md:67 `expect(result.exitCode).not.toBe(0)`) accommodate this loosely, but **the bench (07-bench.md) feeds `exitCode: 1` to the filter** (line 68). The filter's pass/fail-header logic uses `findings.length === 0`, not `exitCode`, so it works in practice — but the bench's input doesn't match real tsc behavior. Make the bench use `exitCode: 2`.

8. **[MAJOR] Renderer adds a header line that is information loss when wrong.** `# tsc — 3 errors in 2 files (1240ms)` — but if the parser missed any error (e.g. one matched `--pretty` shape and was skipped), the count is wrong, and the markdown silently asserts a wrong fact to the agent. Add a parser-line-coverage check (lines parsed / lines total); if < 90%, include `<!-- mira: parser coverage X% -->` in the markdown.

9. **[MINOR] `bench/filter/tsc.ts` bypasses `dispatchFilter`.** See K.2. The ship gate doesn't exercise wrapper-stripping. Add one row that goes through dispatch.

10. **[MINOR] `bunx`, `pnpm --filter`, `yarn workspace`, quoted-args.** See E recommendations.

11. **[MINOR] `commandObservationSchema.parse(observation)` is not called on write.** See F. The mutation works but is unverified.

12. **[MINOR] `FilterContext.command` ambiguity.** Plan (01-types.md:57): the filter sees the *original* command, not the stripped one. Reasoning: "a filter may want to emit the original command verbatim in its markdown title". But the renderer in 05-tsc-parser.md:80 emits `# tsc — 3 errors`, hardcoding "tsc" — not the original command. So the verbatim-title rationale doesn't bind; either the renderer should use `ctx.command` (which would emit "# pnpm tsc — 3 errors" — accurate but slightly noisier), or `FilterContext.command` should be the canonicalized program name. Pick one. Today's contract is unenforced.

13. **[MINOR] No test for the `--quiet` semantics-on-filter-hit case as documented in the matrix.** Task 03 covers test 1 (with `--quiet`) and 3 (without `--quiet`); there are 4 rows in the matrix (00-decisions.md:150). Add the missing two combinations.

14. **[MINOR] `tests/fixtures/tsc/sources/` exclusion from root tsconfig.** Plan (04-fixtures.md:51) says to exclude. The fixtures contain deliberately broken TS. If the exclusion isn't done in the same PR as fixture capture, `bun tsc --noEmit` from the repo root breaks. Make this an explicit pre-merge gate.

15. **[MINOR] `bun pm cache` and offline behavior.** Task 06 (06-register-tsc.md:84) says the e2e test depends on `bunx typescript` resolving. If CI runs with no network or with a cold bun cache, the test downloads typescript. Pin the dev-dep, document the dependency.

---

## Verified claims (table)

(See § L above. Reproduced for the verdict's sake — all 10 claim audits, with status.)

| # | Claim | Status | Evidence |
|---|---|---|---|
| 1 | Stdout buffered, not streamed | ✅ | `src/command/command-observer.ts:36-50` |
| 2 | `findings: Finding[]` exists, always `[]` | ✅ | `src/core/command-observation.ts:24, 54` |
| 3 | Hook always passes `--quiet` | ✅ | `src/cli/rewrite.ts:125-127` |
| 4 | No test invokes tsc | ✅ | `grep -rn "tsc" tests/` clean |
| 5 | RTK uses TOML regex per command | ✅ | `github.com/rtk-ai/rtk/tree/master/src/filters` (70+ `.toml`) |
| 6 | Observer returns strings | ✅ | `command-observer.ts:106` |
| 7 | tsc emits multi-line continuations | ✅ | TS2769 reproduction, ~1500 B per cascade |
| 8 | Non-pretty regex shape | ✅ | empirically `file(line,col):` vs pretty `file:line:col -` |
| 9 | Eval harness can't run | ⚠️ | true for the agent-driven path; partial for fixtures+report |
| 10 | tsc compresses to ≤0.30 of raw | ❌ | measured 0.55 on B1, 0.85 typical |

---

## Final reflection (mandatory section)

Pause. Reread the plan from scratch.

The plan is **architecturally clean**. Decisions 1–8 are right: post-buffer placement, sync filter contract, identity fallback, evidence composition, exit-code preservation. The wrapper-stripping algorithm is over-confident in its coverage but undercaught in its risks (false negatives are passthrough — safe by construction). The phasing is right (empty registry first, pilot second, bench third). I tried hard to break the architecture and couldn't — the things I broke are at the *configuration* layer (threshold value, scope of preservation, what's in V0.4 vs V0.5).

What did I almost miss?

**On second read, the relationship between Decision 9 (pilot=tsc) and Out-of-scope (cascade dedup) is the pivotal flaw.** The plan's own table in 00-decisions.md:191 says tsc's "Cascade clustering ROI" is "very high". That's the *justification* for picking tsc. Then the plan doesn't ship cascade clustering. The pilot's selling point is in the next slice. Reading once, I treated this as "pick the pilot for compression headroom; ship the simple compression first; do cascade dedup later". On second read: no, the renderer-only compression *does not produce the headroom*. The headroom is in the dedup. Without the dedup, the compression target is wrong by ~2x. This is the #1 finding. I caught it on first read but the depth — that the *justification* of the pilot is incompatible with the *scope* of the pilot — only crystallized on rereading.

**What I almost over-credited.** The plan's risk table (R1-R6) is genuinely well-thought. R3 (tsc format drift) is mitigated by fixture capture; R4 (filter throws) is mitigated by try/catch; R5 (bytes ≠ tokens) is mitigated by a divergence trigger. I almost gave a Pass on B because the plan acknowledges F1 ("does not hit 0.3") and offers two paths (tighten or pivot). On second read: the "tighten the renderer" path *cannot reach 0.30* given the constraints elsewhere in the plan (information preservation, no cascade dedup, no clever fallback). The plan acknowledges the failure scenario but the response is unimplementable. That's not a real mitigation.

**Where I almost under-credited.** D (stderr suppression) initially read as risky — empirically tsc writes to stdout, so the suppression is invisible. The F6 acceptance is correct.

**Verdict change?** No — same as TL;DR. **Ship after addressing B (recalibrate threshold or include minimal cascade dedup), C (preservation gate covers message body), and J (resolve pilot/scope mismatch).** The other 12 items are minor.

---

## Verdict

- [ ] Ship as-is
- [x] Ship after addressing:
  1. **B (BLOCKER)** — recalibrate the 0.30 threshold to match the renderer (≤0.70 typical, ≤0.50 cascade) **OR** include minimal cascade dedup (~30 LOC) to make 0.30 achievable. Don't ship a gate the renderer can't pass.
  2. **C (MAJOR)** — extend the information-preservation check to include message-body coverage (e.g. `bytes_in_findings / bytes_total ≥ 0.7`). The triple gate isn't enough.
  3. **J (MAJOR)** — resolve the tsc-pilot ↔ no-cascade-dedup contradiction explicitly in ADR 0008. Either ship cascade dedup as part of V0.4, recalibrate the threshold to acknowledge cascade dedup is the lever and is V0.5+, or pivot the pilot to bun test (where source-snippet truncation gives honest compression without cascade dedup).
  4. **Findings 5, 6, 7, 8 (MAJOR)** — `--pretty` fall-through, filter-exception signal, exit-code 2 in bench, parser-coverage flag. These are small, in-scope, and fix real silent failure modes.
  5. **Findings 9–15 (MINOR)** — bench-via-dispatchFilter, more wrapper coverage, schema parse on write, `FilterContext.command` semantics, missing matrix tests, fixture-exclusion gate, dev-dep pinning. Worth a single follow-up PR.
- [ ] Do not ship
