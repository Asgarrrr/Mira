import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

import type { ContextPack } from "../src/core/context-pack.ts";
import { runGenerateContextPackTool } from "../src/mcp/tools/generate-context-pack.ts";

function gitInit(cwd: string): void {
	const init = spawnSync("git", ["init", "-q", "-b", "main"], { cwd });
	if (init.status !== 0) throw new Error("git init failed");
	spawnSync("git", ["config", "user.email", "test@example.com"], { cwd });
	spawnSync("git", ["config", "user.name", "Test"], { cwd });
	spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd });
}

function gitCommitAll(cwd: string, msg: string): void {
	if (spawnSync("git", ["add", "-A"], { cwd }).status !== 0)
		throw new Error("git add failed");
	if (spawnSync("git", ["commit", "-q", "-m", msg], { cwd }).status !== 0)
		throw new Error("git commit failed");
}

function writeFile(cwd: string, rel: string, content: string): void {
	const full = join(cwd, rel);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, content, "utf8");
}

describe("generate_context_pack tool", () => {
	let projectRoot: string;

	beforeEach(() => {
		// realpath: macOS resolves /var → /private/var; senseArchitecture's
		// `git rev-parse` returns the resolved form, so the assertions need it
		// too.
		projectRoot = realpathSync(
			mkdtempSync(join(tmpdir(), "mira-mcp-ctx-pack-")),
		);
	});

	afterEach(() => {
		rmSync(projectRoot, { recursive: true, force: true });
	});

	test("happy path: empty observation set produces an empty pack, NOT an error", async () => {
		const result = await runGenerateContextPackTool({
			task: "fresh start",
			projectRoot,
		});

		expect(result.pack.task).toBe("fresh start");
		expect(result.pack.observationIds).toEqual([]);
		expect(result.pack.evidenceRefs).toEqual([]);
		expect(result.pack.suspectedFiles).toEqual([]);
		expect(result.pack.verificationCommands).toEqual([]);
		expect(result.pack.risks).toEqual([]);
		expect(result.pack.nextRecommendedAction).toBe("");

		// Persisted both files.
		const ctxRoot = join(projectRoot, ".mira", "context");
		const entries = readdirSync(ctxRoot);
		expect(entries.length).toBe(2);
		expect(entries.find((e) => e.endsWith(".json"))).toBeDefined();
		expect(entries.find((e) => e.endsWith(".md"))).toBeDefined();
	});

	test("forwards projectRoot to senseArchitecture (no process.cwd() leak)", async () => {
		// Set process.cwd to /tmp so any accidental fallback would NOT find the
		// project's git tree. The tool must drive sensing from the explicit
		// projectRoot input instead.
		const originalCwd = process.cwd();
		process.chdir(tmpdir());
		try {
			gitInit(projectRoot);
			writeFile(projectRoot, "src/foo.ts", "export const x = 1;\n");
			writeFile(projectRoot, "src/foo.test.ts", "// test\n");
			gitCommitAll(projectRoot, "init");
			writeFile(projectRoot, "src/foo.ts", "export const x = 2;\n"); // modify

			const result = await runGenerateContextPackTool({
				task: "investigate foo",
				projectRoot,
			});

			expect(result.pack.suspectedFiles).toEqual([
				"src/foo.ts",
				"src/foo.test.ts",
			]);
		} finally {
			process.chdir(originalCwd);
		}
	});

	test("respects the kernel's cap of 20 suspectedFiles without re-paginating", async () => {
		// Seed 25 untracked .ts files. The Context Kernel projects them into
		// `suspectedFiles` capped at 20 (ADR 0005). The tool must NOT re-paginate
		// or extend that cap.
		gitInit(projectRoot);
		writeFile(projectRoot, "README.md", "# repo\n");
		gitCommitAll(projectRoot, "init");
		for (let i = 0; i < 25; i++) {
			writeFile(projectRoot, `src/file${String(i).padStart(2, "0")}.ts`, "x\n");
		}

		const result = await runGenerateContextPackTool({
			task: "many",
			projectRoot,
		});

		expect(result.pack.suspectedFiles.length).toBe(20);
		// Byte-wise alpha within the changed-file kind ⇒ first 20 are file00..file19.
		expect(result.pack.suspectedFiles[0]).toBe("src/file00.ts");
		expect(result.pack.suspectedFiles[19]).toBe("src/file19.ts");
	});

	test("persists context pack at .mira/context/<id>.{json,md}", async () => {
		const result = await runGenerateContextPackTool({
			task: "persist check",
			projectRoot,
		});

		const ctxRoot = join(projectRoot, ".mira", "context");
		const jsonPath = join(ctxRoot, `${result.pack.id}.json`);
		const mdPath = join(ctxRoot, `${result.pack.id}.md`);

		expect(existsSync(jsonPath)).toBe(true);
		expect(existsSync(mdPath)).toBe(true);

		const onDisk = JSON.parse(readFileSync(jsonPath, "utf8")) as ContextPack;
		expect(onDisk).toEqual(result.pack);
	});

	test("INVALID_INPUT when projectRoot does not exist", async () => {
		try {
			await runGenerateContextPackTool({
				task: "x",
				projectRoot: "/this/does/not/exist/anywhere",
			});
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			expect((err as McpError).data).toMatchObject({ code: "INVALID_INPUT" });
		}
	});

	test("INVALID_INPUT when projectRoot is a file", async () => {
		const filePath = join(projectRoot, "not-a-dir");
		writeFileSync(filePath, "x");
		try {
			await runGenerateContextPackTool({
				task: "x",
				projectRoot: filePath,
			});
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			expect((err as McpError).data).toMatchObject({ code: "INVALID_INPUT" });
		}
	});

	test("accepts an empty task (free text, may be empty)", async () => {
		const result = await runGenerateContextPackTool({
			task: "",
			projectRoot,
		});
		expect(result.pack.task).toBe("");
	});
});
