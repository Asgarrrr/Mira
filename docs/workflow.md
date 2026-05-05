# Workflow

## Goal

Mira should be built in small, verifiable vertical slices.

Do not build a large platform first.

V0 vertical slice:

```txt
command -> raw evidence -> CommandObservation
```

V0.1 extension:

```txt
recent observations -> ContextPack
```

## Phase 1: Evidence Store (V0)

Implement local evidence storage.

`.mira/` is created automatically on the first `mira run` — no `mira init` command in V0.

Required files per command run:

```txt
.mira/runs/<run-id>/
  metadata.json
  stdout.log
  stderr.log
  combined.log
  observation.json
  observation.md
```

`run-id` format: `run_YYYYMMDDTHHMMSSmmmZ_<random6>` (filesystem-safe, lexicographically sortable, no external id library). Full spec in `docs/architecture.md`.

Definition of done:

* raw stdout is stored
* raw stderr is stored
* metadata is stored
* evidence can be read by run id
* parallel runs in the same `cwd` produce distinct run directories
* tests cover storage

## Phase 2: Command Observation (V0)

Implement:

```txt
mira run "<command>"
```

It should:

* execute the command
* capture stdout (no real-time streaming; print after the run completes)
* capture stderr
* preserve exit code
* measure duration
* enforce a default 300-second timeout
* store evidence
* generate `CommandObservation`
* print compact output

Out of scope: interactive stdin/TTY commands, configurable timeout.

Definition of done:

* successful command test
* failed command test
* exit code preservation test
* timeout test (long-running command is killed at the default timeout)
* observation snapshot test

## Phase 3: Summarizer (V0)

Add a deterministic generic summarizer.

Rules:

* summarizer must not hide raw evidence
* summarizer must produce evidence references
* summarizer must be fixture-tested
* summarizer must not claim unsupported facts

Command-specific summarizers (test output, TypeScript errors, git diff/status) are explicitly post-V0. They will be added when a real task needs them, not preemptively.

## Phase 4: Context Pack (V0.1)

Implement:

```txt
mira context "<task>"
```

`task` is free text. The pack reads the **last 10** `CommandObservation`s for the current project. The "since last ContextPack" selection mode is post-V0.1.

It should:

* read the last 10 observations
* reference observations by id (no embedding of full observations in the pack)
* select relevant evidence refs
* generate markdown
* generate json
* suggest verification commands
* list risks
* suggest next action

`context-id` format: `ctx_YYYYMMDDTHHMMSSmmmZ_<random6>`. Pack files are stored under `.mira/context/<context-id>.{json,md}`.

Definition of done:

* context pack generated from fixture observations
* context pack references observations by id and points at raw evidence
* "last 10" selection is tested with a fixture of >10 observations
* output is snapshot-tested

## Phase 5: Architecture sensing (post-V0)

Add minimal structural awareness, as Mira's own version of the capability — not a port of Sentrux.

Initial scope:

* changed files
* suspected related files
* test file hints
* basic import hints later

Do not start with global scoring. Focus on task-aware impact.

The exact type for these signals is not committed in the V0 docs and will be defined when Phase 5 starts.

## Phase 6: Agent Integration (post-V0)

Only after the core works, expose Mira to agents.

Possible integrations:

* CLI output (already present in V0)
* Mira as an MCP server
* Claude Code commands
* Codex awareness docs

When acting as an MCP server, Mira exposes tools such as:

* `run_command`
* `get_observation`
* `get_raw_evidence`
* `generate_context_pack`
* `list_recent_runs`

## Review protocol

After every phase, run a harsh review.

Review questions:

1. Did we over-engineer?
2. Did we hide raw evidence?
3. Did we preserve exit codes?
4. Did we produce unsupported conclusions?
5. Did we duplicate RTK/Sentrux without adding Mira value?
6. Are tests realistic?
7. Are abstractions still small?

## Anti-vibecoding rule
A feature is not ready if it makes Mira less épurée.

Before adding a feature, ask:

- Does this reduce noise?
- Does this clarify evidence?
- Does this improve agent context?
- Does this preserve the simplicity of the core?
- Could this be an adapter or later layer instead?

If a feature does not improve evidence, context, or quality, do not build it yet.
