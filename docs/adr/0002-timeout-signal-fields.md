# ADR 0002: Model timeout and signal as first-class fields on CommandRun

## Status

Accepted. Supersedes the timeout decision in ADR 0001 / `docs/domain-model.md`.

## Context

ADR 0001 chose to keep `CommandRun` minimal in V0: `exitCode: number`, no `signal`, no `killedByTimeout`. The earlier note in `docs/domain-model.md` accepted that "the exit code reflects the kill (typically 124 or 137 depending on the shell)" and assumed Phase 3's summarizer would infer timeouts heuristically from exit codes and `durationMs`.

Two problems surfaced before Phase 3 started:

1. **The runtime doesn't return a numeric exit code on signal kill.** On Bun, `proc.exitCode` is `null` when the process is killed by a signal, and `proc.signalCode` carries the signal name. The previous code coerced any non-numeric value to `1`, silently collapsing a SIGKILL into a generic exit-1 failure.
2. **An evidence layer should not require downstream code to guess intent.** Inferring "this run timed out" from `exitCode === 137 && durationMs >= 300_000` is fragile (the encoded code varies by shell and platform), and it shifts ground truth out of the canonical `CommandRun` and into ad-hoc heuristics inside the summarizer.

## Decision

`CommandRun` and `CommandObservation` carry signal-level facts at the source:

- `exitCode: number | null` — `null` whenever the process was killed by a signal.
- `signal?: string` — the signal name (e.g. `"SIGKILL"`) when known, otherwise absent.
- `killedByTimeout: boolean` — `true` when Mira's own timeout enforcer issued the kill, distinguishing a Mira-initiated termination from an externally-delivered signal.

The Phase 3 summarizer reads these structured fields. It does not infer timeouts from shell-conventional exit codes.

## Consequences

- The summary line for a timed-out run is unambiguous: `\`<cmd>\` killed by timeout after <durationMs>ms (SIGKILL)`.
- `CommandObservation.exitCode` is now nullable. Any consumer (markdown renderer, future MCP exposure, ContextPack) must handle `null`.
- The observation invariant *"summaries must not claim more than the evidence supports"* is now mechanically enforced: the summary cannot say "exited with code N" when the run was signal-killed, because `exitCode` is `null` in that case.
- Process-level information (signal, timeout origin) is preserved alongside the rest of the run metadata under `.mira/runs/<run-id>/metadata.json`. Older runs written before this ADR are still readable as `CommandRun` objects so long as the new fields are tolerated as missing — V0 has no historical persistence guarantee, so this is acceptable.

## Out of scope

- Configurable timeout (still V0-deferred).
- Reporting other signal sources beyond `proc.signalCode` (e.g. SIGTERM from a parent process is captured the same way; no special branching).
- Mapping signal names to exit-code conventions for downstream tools — Mira reports the canonical signal name and lets the consumer decide.
