import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type Anthropic from "@anthropic-ai/sdk";
import type { Message } from "@anthropic-ai/sdk/resources/messages.mjs";

import { runScenario } from "./run.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const COMMITTED_FIXTURES = resolve(HERE, "__fixtures__", "scenarios");

let sourceRepoRoot: string;
let resultsRoot: string;

async function pathExists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

function listWorktrees(repo: string): string {
	const r = spawnSync("git", ["-C", repo, "worktree", "list", "--porcelain"], {
		encoding: "utf8",
	});
	return r.stdout ?? "";
}

beforeAll(async () => {
	// Mirrors scenario.test.ts: a throwaway repo with src/foo.txt = "fixed\n"
	// so the test-fixture's base.patch (fixed → buggy) applies cleanly.
	sourceRepoRoot = await mkdtemp(join(tmpdir(), "mira-run-test-src-"));
	await mkdir(join(sourceRepoRoot, "src"), { recursive: true });
	await writeFile(join(sourceRepoRoot, "src", "foo.txt"), "fixed\n");
	const gitRun = (args: string[]) =>
		spawnSync("git", args, { cwd: sourceRepoRoot, encoding: "utf8" });
	gitRun(["init", "-q", "-b", "main"]);
	gitRun(["config", "user.email", "test@example.com"]);
	gitRun(["config", "user.name", "Test"]);
	gitRun(["add", "."]);
	gitRun(["commit", "-q", "-m", "initial"]);

	resultsRoot = await mkdtemp(join(tmpdir(), "mira-run-test-results-"));
});

afterAll(async () => {
	if (sourceRepoRoot)
		await rm(sourceRepoRoot, { recursive: true, force: true });
	if (resultsRoot) await rm(resultsRoot, { recursive: true, force: true });
});

// Mock client that ends the agent loop on the first turn (no tool_use).
function makeEndImmediatelyClient(): Anthropic {
	const message: Message = {
		id: "msg_end",
		type: "message",
		role: "assistant",
		model: "claude-test-model",
		content: [{ type: "text", text: "done" }],
		stop_reason: "end_turn",
		stop_sequence: null,
		usage: { input_tokens: 7, output_tokens: 3 },
	} as unknown as Message;
	return {
		messages: { create: async () => message },
	} as unknown as Anthropic;
}

describe("runScenario", () => {
	test("writes metrics.json + transcript.jsonl, prunes worktree, success reflects success.sh", async () => {
		const result = await runScenario("test-fixture", "baseline", 1, {
			scenariosRoot: COMMITTED_FIXTURES,
			resultsRoot,
			repoRoot: sourceRepoRoot,
			installDeps: false,
			client: makeEndImmediatelyClient(),
		});

		expect(result.metrics.scenario).toBe("test-fixture");
		expect(result.metrics.mode).toBe("baseline");
		expect(result.metrics.repeat).toBe(1);
		// success.sh in the fixture exits 0 unconditionally — runScenario must
		// reflect that, regardless of what the agent did.
		expect(result.metrics.success).toBe(true);
		expect(result.metrics.stopReason).toBe("model_end");
		expect(result.metrics.turns).toBe(1);
		expect(result.metrics.tokensInput).toBe(7);
		expect(result.metrics.tokensOutput).toBe(3);
		expect(result.metrics.tokensTotal).toBe(10);
		expect(result.metrics.toolCalls).toBe(0);
		expect(result.metrics.filesRead).toBe(0);
		expect(result.metrics.filesModified).toBe(0);

		expect(result.resultsDir.endsWith("test-fixture-baseline-1")).toBe(true);

		const onDisk = JSON.parse(await readFile(result.metricsPath, "utf8"));
		expect(onDisk).toEqual(result.metrics);

		const transcript = await readFile(result.transcriptPath, "utf8");
		const lines = transcript.split("\n").filter((l) => l.length > 0);
		expect(lines.length).toBeGreaterThan(0);
		// The footer is always emitted last.
		const footer = JSON.parse(lines[lines.length - 1] as string);
		expect(footer.type).toBe("footer");
		expect(footer.filesRead).toBe(0);
		expect(footer.filesModified).toBe(0);

		// Worktree must be pruned and removed even on success.
		expect(listWorktrees(sourceRepoRoot)).not.toContain("mira-eval-");
	});

	test("groups multiple runs under one resultsTimestamp", async () => {
		const stamp = "fixed-stamp";
		const r1 = await runScenario("test-fixture", "baseline", 1, {
			scenariosRoot: COMMITTED_FIXTURES,
			resultsRoot,
			resultsTimestamp: stamp,
			repoRoot: sourceRepoRoot,
			installDeps: false,
			client: makeEndImmediatelyClient(),
		});
		const r2 = await runScenario("test-fixture", "baseline", 2, {
			scenariosRoot: COMMITTED_FIXTURES,
			resultsRoot,
			resultsTimestamp: stamp,
			repoRoot: sourceRepoRoot,
			installDeps: false,
			client: makeEndImmediatelyClient(),
		});

		expect(r1.resultsDir.includes(`${stamp}/test-fixture-baseline-1`)).toBe(
			true,
		);
		expect(r2.resultsDir.includes(`${stamp}/test-fixture-baseline-2`)).toBe(
			true,
		);
		// Same parent (the timestamped experiment dir) is what report.ts needs.
		expect(dirname(r1.resultsDir)).toBe(dirname(r2.resultsDir));
		expect(await pathExists(r1.metricsPath)).toBe(true);
		expect(await pathExists(r2.metricsPath)).toBe(true);
	});
});
