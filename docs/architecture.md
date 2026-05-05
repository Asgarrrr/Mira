# Architecture
- Épurée by default: small API surface, compact outputs, clear files, minimal concepts.
- Details should be recoverable through evidence references, not dumped into every response.
## Overview

Mira V0 is organized around two kernels:

```txt
Evidence Kernel
Command Kernel
```

V0.1 adds:

```txt
Context Kernel
```

A future Architecture Kernel is sketched at the end of this document but is not built in V0 or V0.1.

Each kernel produces or consumes evidence.

The core rule is:

> Every agent-facing conclusion must be backed by traceable raw evidence.

## High-level flow

V0 vertical slice:

```txt
User / Agent
    |
    v
mira run "<command>"
    |
    v
CommandObserver
    |
    v
Raw stdout/stderr + metadata
    |
    v
EvidenceStore
    |
    v
CommandObservation
    |
    v
Agent-facing output
```

V0.1 extension:

```txt
mira context "<task>"
    |
    v
read last 10 CommandObservations
    |
    v
ContextPack (references observations by id)
    |
    v
Agent-facing output
```

## Evidence Kernel

The Evidence Kernel stores raw and derived evidence.

It is the most important part of Mira.

Responsibilities:

* store command metadata
* store raw stdout
* store raw stderr
* store generated observations
* store context packs
* expose evidence by id
* keep files human-readable

Initial storage layout:

```txt
.mira/                     created automatically on first `mira run`
  runs/                    V0
    <run-id>/
      metadata.json
      stdout.log
      stderr.log
      combined.log
      observation.json
      observation.md
  context/                 V0.1
    <context-id>.json
    <context-id>.md
```

`.mira/` should be added to project-level `.gitignore`. There is no `mira init` command in V0; the directory is created lazily.

### ID formats

- `run-id`: `run_YYYYMMDDTHHMMSSmmmZ_<random6>` — ISO-8601 compact UTC timestamp with millisecond precision, plus 6 random alphanumeric characters.
- `context-id`: `ctx_YYYYMMDDTHHMMSSmmmZ_<random6>` — same shape with the `ctx_` prefix.

Examples:

```txt
run_20260505T143025123Z_a4f2k9
ctx_20260505T143027001Z_z1m8q3
```

The format is filesystem-safe (ASCII alphanumeric and underscores only) and lexicographically sortable. The random suffix lets parallel `mira run` executions in the same directory share an `.mira/` without a global lock. No external id library is used.

## Command Kernel

The Command Kernel observes command execution.

Responsibilities:

* execute commands
* capture stdout and stderr
* preserve exit codes
* measure duration
* generate command observations
* route outputs through the summarizer

Initial command:

```txt
mira run "<command>"
```

V0 behaviour:

* default timeout: **300 seconds** (configurable timeout is post-V0)
* no real-time streaming — stdout/stderr are captured fully, then the observation is printed once the run completes
* interactive stdin/TTY commands are out of scope
* parallel `mira run` executions in the same `cwd` are supported; uniqueness comes from the `run-id` random suffix, not a global lock

The Command Kernel should not depend on a specific summarizer or external proxy.

## Context Kernel (V0.1)

The Context Kernel generates task-specific context packs.

Responsibilities:

* read the **last 10** `CommandObservation`s for the current project
* reference observations by id — never embed full observation objects
* produce agent-readable markdown
* produce machine-readable json
* list verification commands
* list risks and next actions

A context pack should never invent facts. It can include heuristics, but they must be labeled as heuristics.

The "since last ContextPack" selection mode is explicitly out of scope for V0.1.

## Dependency direction

Preferred dependency direction:

```txt
cli -> kernels -> core types
adapters -> core types
summarizers -> core types
store -> core types
```

Core types should not depend on CLI, adapters, or storage implementation.

## Initial source structure

V0:

```txt
src/
  core/
    evidence.ts
    command-observation.ts
  store/
    evidence-store.ts
  command/
    command-observer.ts
  summarizers/
    generic-summarizer.ts
  cli/
    index.ts
    run.ts
tests/
  fixtures/
  command-observation.test.ts
  evidence-store.test.ts
```

V0.1 adds:

```txt
src/
  core/
    context-pack.ts
  context/
    context-pack-generator.ts
  cli/
    context.ts
tests/
  context-pack.test.ts
```

Interface/implementation splits, multiple observers, and command-specific summarizers are deferred until they are justified by an actual need.

## Design constraints

* Local-first.
* Human-readable evidence files.
* No database in V0 unless clearly justified.
* No LLM calls in V0.
* No broad plugin system in V0.
* No UI in V0.
* No command-specific explosion in V0.
* No real-time output streaming in V0.
* No interactive stdin/TTY support in V0.
* Default 300-second timeout per `mira run`.
* `.mira/` is created lazily on first run; no `mira init`.

## Quality bar

A feature is not complete unless:

* raw evidence is stored
* generated output references the evidence
* failure mode is tested
* success mode is tested
* exit code behavior is preserved
* behavior is deterministic

## Post-V0 layers

These layers are not part of V0 or V0.1 but are sketched here so the kernel boundaries stay clean as Mira grows.

### Adapter layer (post-V0)

`ToolAdapter` becomes the typed integration boundary for external tools (RTK, Sentrux, git, test runners). Adapters convert external output into Mira-native evidence and observations. Their typed output must include the structured observation **and** the evidence references it points at — adapters cannot return arbitrary ungrounded results.

Adapters are not built in V0; they appear when the first real external integration ships, not preemptively.

MCP is not an adapter. It is the protocol Mira will use to expose its evidence model to coding agents (see `docs/workflow.md` Phase 6).

### Architecture Kernel (post-V0)

Will produce task-aware structural signals tied to evidence — changed files, related files, test hints, eventually import graphs and module ownership.

Mira will build its own version of architecture sensing inside the evidence model. It is deliberately not started in V0 or V0.1; see `docs/non-goals.md` and `docs/workflow.md` Phase 5.
