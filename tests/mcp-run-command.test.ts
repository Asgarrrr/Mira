import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

import { runRunCommandTool } from "../src/mcp/tools/run-command.ts";

describe("run_command tool", () => {
	let projectRoot: string;

	beforeEach(() => {
		projectRoot = mkdtempSync(join(tmpdir(), "mira-mcp-run-"));
	});

	afterEach(() => {
		rmSync(projectRoot, { recursive: true, force: true });
	});

	test("happy path: returns observation, persists evidence", async () => {
		const result = await runRunCommandTool({
			command: "echo hello",
			projectRoot,
		});

		expect(result.observation.status).toBe("success");
		expect(result.observation.exitCode).toBe(0);
		expect(result.observation.killedByTimeout).toBe(false);

		const runDir = join(projectRoot, ".mira", "runs", result.observation.runId);
		for (const f of [
			"stdout.log",
			"stderr.log",
			"combined.log",
			"metadata.json",
			"observation.json",
			"observation.md",
		]) {
			expect(existsSync(join(runDir, f))).toBe(true);
		}
		expect(readFileSync(join(runDir, "stdout.log"), "utf8")).toBe("hello\n");
	});

	test("non-zero exit code is reported via observation, NOT McpError", async () => {
		const result = await runRunCommandTool({
			command: "exit 7",
			projectRoot,
		});

		expect(result.observation.status).toBe("failure");
		expect(result.observation.exitCode).toBe(7);
		expect(result.observation.killedByTimeout).toBe(false);
	});

	test("INVALID_INPUT when command is empty", async () => {
		try {
			await runRunCommandTool({ command: "", projectRoot });
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			expect((err as McpError).data).toMatchObject({ code: "INVALID_INPUT" });
		}
	});

	test("INVALID_INPUT when command is whitespace-only", async () => {
		try {
			await runRunCommandTool({ command: "   ", projectRoot });
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			expect((err as McpError).data).toMatchObject({ code: "INVALID_INPUT" });
		}
	});

	test("INVALID_INPUT when projectRoot does not exist", async () => {
		try {
			await runRunCommandTool({
				command: "echo hi",
				projectRoot: join(projectRoot, "does-not-exist"),
			});
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			expect((err as McpError).data).toMatchObject({ code: "INVALID_INPUT" });
		}
	});

	test("INVALID_INPUT when projectRoot is a file, not a directory", async () => {
		const filePath = join(projectRoot, "not-a-dir");
		writeFileSync(filePath, "x");
		try {
			await runRunCommandTool({ command: "echo hi", projectRoot: filePath });
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			expect((err as McpError).data).toMatchObject({ code: "INVALID_INPUT" });
		}
	});

	test("INVALID_INPUT when projectRoot is a relative path", async () => {
		try {
			await runRunCommandTool({
				command: "echo hi",
				projectRoot: "./relative",
			});
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			expect((err as McpError).data).toMatchObject({ code: "INVALID_INPUT" });
		}
	});

	test("signal termination is reported via observation, NOT McpError", async () => {
		// Fork a subshell that kills its own pid with SIGTERM. The wrapping `sh`
		// keeps the spawned process tree's exit semantics readable — the parent
		// shell exits with signal status, exitCode is null, killedByTimeout is
		// false (Mira's timer didn't fire).
		const result = await runRunCommandTool({
			command: "sh -c 'kill -TERM $$'",
			projectRoot,
		});

		expect(result.observation.killedByTimeout).toBe(false);
		// Either exitCode is null (parent died from signal) or the wrapping shell
		// surfaced the signal as 128+15=143; both are "not zero" failure modes.
		// What matters: this is reported through the observation, not McpError.
		expect(result.observation.status).toBe("failure");
	});
});
