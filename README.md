# Mira 

Mira is a suite of orchestration tools designed to improve the quality of work produced by development agents, while reducing their cost of use.

Its core premise is simple: an agent doesn’t fail only because it generates poorly, but also because it misunderstands its context.

## Why

Development agents are powerful, but remain unreliable in real-world codebases.

They struggle to explore repositories effectively, miss existing abstractions, and often overload their context with irrelevant information. As a result, their outputs become inconsistent, expensive, and difficult to trust.

Mira focuses on this invisible layer: how context is discovered, structured, filtered, and delivered to the agent.

## What Mira is

Mira is not an autonomous agent.

It is a middleware layer — a set of tools that helps existing agents operate more effectively within a software project.

## Idea

Mira aims to make agents more relevant, more efficient, and more reliable in how they reason about, explore, and interact with a codebase.

This includes:
- understanding repository structure more deeply
- filtering tool outputs more intelligently
- selecting what actually deserves to enter the active context
- maintaining a durable understanding of the project over time

## Intuition

An agent should not rediscover a project from scratch at every task.

It should not blindly inject everything it reads, executes, or produces into its context.

Mira explores a different approach: improving the conditions in which agents operate before they even begin to reason.

## Prototype

This repository currently exposes a small Bun CLI around reusable Mira tools.

```sh
bun index.ts scan
bun index.ts context "add a repository scanner"
bun index.ts explain "add a repository scanner"
bun test 2>&1 | bun index.ts digest "bun test"
bun index.ts tools
```

The first tools are:
- `repo.scan`: builds a compact map of the repository
- `file.rank`: ranks files against a task using local signals
- `context.pack`: creates a context pack for an agent
- `selection.explain`: explains why files were selected
- `signal.digest`: turns noisy command output into compact signals

The CLI is only an adapter. The reusable tool modules live under `src/tools`, so the same core can later be exposed through MCP, an HTTP API, or another agent integration.

Mira does not put raw command output into context by default. Command output should first pass through a signal digest so agents receive facts, affected files, warnings, and a short summary instead of terminal noise.

## Architecture

Mira v1 stays a single Bun/TypeScript package with explicit boundaries:

- `src/core` owns the stable vocabulary: tool contracts, project scans, ranking types, context packs, and the tool registry.
- `src/tools` owns reusable capabilities. Tools do not import the CLI and can be called directly from another adapter.
- `src/signals` digests noisy command and tool outputs into compact facts, files, warnings, and summaries.
- `src/indexers` reads the outside world: filesystem, Git, and package manifests. It does not format CLI output.
- `src/cli` is an adapter. It parses arguments, asks the registry for a tool, runs it, and delegates human output to CLI formatters.

The project rule is simple: adapters stay at the edge, product intelligence lives in `core`, `tools`, and `signals`, indexers only read, and durable store/API/MCP surfaces come later.
