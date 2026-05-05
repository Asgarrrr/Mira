# Comparables

This document describes tools related to Mira and how Mira should differ from them.

## RTK

### What RTK does well

RTK focuses on command output reduction for AI coding agents.

It provides:

- command proxying
- hook-based command rewriting
- command-specific filters
- token savings analytics
- raw output recovery
- support for many developer commands

RTK is strongest when the problem is:

> The agent receives too much noisy CLI output.

### What Mira should learn from RTK

Mira should learn from:

- command interception
- output filtering
- exit code preservation
- raw output recovery
- agent-friendly command summaries
- token-aware design

### Where Mira should differ

Mira should not optimize only for shorter output.

Mira should optimize for evidence-backed observations.

Mira should care about:

- what the command means for the current task
- which raw evidence supports the summary
- which files may be related
- what the agent should verify next
- how the observation affects the current context pack

RTK compresses outputs.

Mira should understand development events.

## Sentrux

### What Sentrux does well

Sentrux focuses on architecture health and structural feedback.

It provides:

- repository scanning
- dependency analysis
- quality signals
- rules and gates
- MCP tools
- before/after session comparison

Sentrux is strongest when the problem is:

> AI agents are degrading codebase structure faster than humans can track.

### What Mira should learn from Sentrux

Mira should learn from:

- architecture sensing
- quality gates
- structural feedback loops
- MCP integration
- before/after comparison
- human governance over agent work

### Where Mira should differ

Mira should not start with global architecture scoring.

Mira should provide task-aware architecture signals.

Instead of asking:

```txt
Is the whole codebase healthy?
```

Mira should ask:

```txt
Does this task and this change respect the relevant structure?
```

## Claude Code / Codex / Cursor / Goose

These tools are agents or agent environments.

They can:

* read files
* edit files
* execute commands
* run tests
* inspect diffs
* interact with tools

Mira should not replace them.

Mira should provide better context and evidence to them.

## Positioning

RTK:

```txt
command output -> compressed output
```

Sentrux:

```txt
codebase structure -> architecture signal
```

Mira:

```txt
development activity -> evidence graph -> task-specific context
```

## Strategic direction

Mira should eventually contain Mira-native versions of:

* command observation
* output summarization
* architecture sensing
* task-aware quality signals
* context pack generation

But each feature should serve the unified evidence model.

Do not add features only because another tool has them.
