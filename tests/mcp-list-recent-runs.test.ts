import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

import type { CommandObservation } from "../src/core/command-observation.ts";
import type { CommandRun } from "../src/core/command-run.ts";
import { runListRecentRunsTool } from "../src/mcp/tools/list-recent-runs.ts";

function seedRun(
	projectRoot: string,
	id: string,
	opts: Partial<CommandObservation & CommandRun> = {},
): void {
	const runDir = join(projectRoot, ".mira", "runs", id);
	mkdirSync(runDir, { recursive: true });

	const observation: CommandObservation = {
		id,
		runId: id,
		command: opts.command ?? `echo ${id}`,
		status: opts.status ?? "success",
		exitCode: opts.exitCode === undefined ? 0 : opts.exitCode,
		killedByTimeout: opts.killedByTimeout ?? false,
		durationMs: opts.durationMs ?? 12,
		...(opts.signal !== undefined ? { signal: opts.signal } : {}),
		summary: `\`${opts.command ?? `echo ${id}`}\` exited`,
		findings: [],
		relatedFiles: [],
		suggestedNextActions: [],
		verificationHints: [],
		evidenceRefs: [],
	};
	writeFileSync(
		join(runDir, "observation.json"),
		`${JSON.stringify(observation, null, 2)}\n`,
		"utf8",
	);

	const run: CommandRun = {
		id,
		command: opts.command ?? `echo ${id}`,
		cwd: projectRoot,
		startedAt: opts.startedAt ?? "2026-05-05T14:30:00.000Z",
		durationMs: opts.durationMs ?? 12,
		exitCode: opts.exitCode === undefined ? 0 : opts.exitCode,
		...(opts.signal !== undefined ? { signal: opts.signal } : {}),
		killedByTimeout: opts.killedByTimeout ?? false,
		stdoutPath: join(runDir, "stdout.log"),
		stderrPath: join(runDir, "stderr.log"),
		combinedPath: join(runDir, "combined.log"),
		metadataPath: join(runDir, "metadata.json"),
	};
	writeFileSync(
		join(runDir, "metadata.json"),
		`${JSON.stringify(run, null, 2)}\n`,
		"utf8",
	);
}

describe("list_recent_runs tool", () => {
	let projectRoot: string;

	beforeEach(() => {
		projectRoot = mkdtempSync(join(tmpdir(), "mira-mcp-list-"));
	});

	afterEach(() => {
		rmSync(projectRoot, { recursive: true, force: true });
	});

	test("happy path: returns slim rows newest-first, default limit 10", async () => {
		// 12 runs; default limit drops the oldest two.
		const ids = Array.from(
			{ length: 12 },
			(_, i) =>
				`run_20260505T1430${String(i).padStart(2, "0")}000Z_v${String(i).padStart(5, "0")}`,
		);
		for (const id of ids) {
			seedRun(projectRoot, id, {
				startedAt: `2026-05-05T14:30:${id.slice(13, 15)}.000Z`,
			});
		}

		const result = await runListRecentRunsTool({ projectRoot });
		expect(result.runs.length).toBe(10);
		expect(result.runs.map((r) => r.id)).toEqual(
			[...ids].reverse().slice(0, 10),
		);
		// Slim row shape only.
		const row = result.runs[0];
		expect(Object.keys(row ?? {}).sort()).toEqual([
			"command",
			"durationMs",
			"exitCode",
			"id",
			"killedByTimeout",
			"startedAt",
			"status",
		]);
	});

	test("respects an explicit limit", async () => {
		const ids = Array.from(
			{ length: 5 },
			(_, i) =>
				`run_20260505T1430${String(i).padStart(2, "0")}000Z_v${String(i).padStart(5, "0")}`,
		);
		for (const id of ids) seedRun(projectRoot, id);

		const result = await runListRecentRunsTool({ projectRoot, limit: 3 });
		expect(result.runs.length).toBe(3);
		expect(result.runs.map((r) => r.id)).toEqual(
			[...ids].reverse().slice(0, 3),
		);
	});

	test("returns [] when no runs exist (not an error)", async () => {
		const result = await runListRecentRunsTool({ projectRoot });
		expect(result.runs).toEqual([]);
	});

	test("includes signal field when present, omits it otherwise", async () => {
		seedRun(projectRoot, "run_20260505T143000000Z_a00001", {
			status: "success",
			exitCode: 0,
		});
		seedRun(projectRoot, "run_20260505T143010000Z_a00002", {
			status: "failure",
			exitCode: null,
			signal: "SIGKILL",
			killedByTimeout: true,
		});

		const result = await runListRecentRunsTool({ projectRoot });
		const newest = result.runs[0];
		const oldest = result.runs[1];
		expect(newest?.signal).toBe("SIGKILL");
		expect(newest?.killedByTimeout).toBe(true);
		expect(newest?.exitCode).toBe(null);
		expect("signal" in (oldest ?? {})).toBe(false);
	});

	test("skips run dirs without observation.json or metadata.json", async () => {
		// Complete run.
		seedRun(projectRoot, "run_20260505T143010000Z_complete");
		// Partial: dir exists but neither file does.
		mkdirSync(join(projectRoot, ".mira", "runs", "run_partial"), {
			recursive: true,
		});

		const result = await runListRecentRunsTool({ projectRoot });
		expect(result.runs.map((r) => r.id)).toEqual([
			"run_20260505T143010000Z_complete",
		]);
	});

	test("INVALID_INPUT for limit = 0", async () => {
		try {
			await runListRecentRunsTool({ projectRoot, limit: 0 });
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			expect((err as McpError).data).toMatchObject({ code: "INVALID_INPUT" });
		}
	});

	test("INVALID_INPUT for limit = 51 (max is 50)", async () => {
		try {
			await runListRecentRunsTool({ projectRoot, limit: 51 });
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			expect((err as McpError).data).toMatchObject({ code: "INVALID_INPUT" });
		}
	});

	test("INVALID_INPUT for non-integer limit", async () => {
		try {
			await runListRecentRunsTool({ projectRoot, limit: 3.5 });
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			expect((err as McpError).data).toMatchObject({ code: "INVALID_INPUT" });
		}
	});

	test("INVALID_INPUT when projectRoot does not exist", async () => {
		try {
			await runListRecentRunsTool({
				projectRoot: "/this/does/not/exist/anywhere",
			});
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			expect((err as McpError).data).toMatchObject({ code: "INVALID_INPUT" });
		}
	});

	test("INTERNAL on malformed metadata.json", async () => {
		const id = "run_20260505T143030000Z_bad";
		seedRun(projectRoot, id);
		writeFileSync(
			join(projectRoot, ".mira", "runs", id, "metadata.json"),
			"{not json",
			"utf8",
		);
		try {
			await runListRecentRunsTool({ projectRoot });
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			expect((err as McpError).data).toMatchObject({ code: "INTERNAL" });
		}
	});
});
