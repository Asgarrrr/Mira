import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandRun } from "../src/core/command-run.ts";
import { FileEvidenceStore } from "../src/store/evidence-store.ts";

describe("FileEvidenceStore", () => {
	let projectRoot: string;

	beforeEach(() => {
		projectRoot = mkdtempSync(join(tmpdir(), "mira-test-"));
	});

	afterEach(() => {
		rmSync(projectRoot, { recursive: true, force: true });
	});

	test("createRun lazily creates .mira/runs/<run-id>/", () => {
		const store = new FileEvidenceStore(projectRoot);
		expect(existsSync(join(projectRoot, ".mira"))).toBe(false);

		const { runId, runDir } = store.createRun();

		expect(runDir).toBe(join(projectRoot, ".mira", "runs", runId));
		expect(existsSync(runDir)).toBe(true);
	});

	test("two sequential createRun() calls produce distinct dirs", () => {
		const store = new FileEvidenceStore(projectRoot);
		const r1 = store.createRun();
		const r2 = store.createRun();

		expect(r1.runId).not.toBe(r2.runId);
		expect(existsSync(r1.runDir)).toBe(true);
		expect(existsSync(r2.runDir)).toBe(true);
	});

	test("parallel createRun() calls produce distinct ids", async () => {
		const store = new FileEvidenceStore(projectRoot);
		const results = await Promise.all(
			Array.from({ length: 16 }, () => Promise.resolve(store.createRun())),
		);
		const ids = new Set(results.map((r) => r.runId));
		expect(ids.size).toBe(16);
	});

	test("writeStdout / writeStderr / writeCombined round-trip via readEvidence", () => {
		const store = new FileEvidenceStore(projectRoot);
		const { runId } = store.createRun();

		store.writeStdout(runId, "stdout text\n");
		store.writeStderr(runId, "stderr text\n");
		store.writeCombined(runId, "combined text\n");

		expect(store.readEvidence(runId, "stdout")).toBe("stdout text\n");
		expect(store.readEvidence(runId, "stderr")).toBe("stderr text\n");
		expect(store.readEvidence(runId, "combined")).toBe("combined text\n");
	});

	test("writeMetadata + readRun round-trip", () => {
		const store = new FileEvidenceStore(projectRoot);
		const { runId, runDir } = store.createRun();

		const run: CommandRun = {
			id: runId,
			command: "echo hi",
			cwd: projectRoot,
			startedAt: "2026-05-05T14:30:25.123Z",
			durationMs: 12,
			exitCode: 0,
			stdoutPath: join(runDir, "stdout.log"),
			stderrPath: join(runDir, "stderr.log"),
			combinedPath: join(runDir, "combined.log"),
		};
		store.writeMetadata(runId, run);

		expect(store.readRun(runId)).toEqual(run);
	});

	test("evidence files are stored as utf-8 text", () => {
		const store = new FileEvidenceStore(projectRoot);
		const { runId, runDir } = store.createRun();

		store.writeStdout(runId, "café résumé\n");

		expect(readFileSync(join(runDir, "stdout.log"), "utf8")).toBe(
			"café résumé\n",
		);
	});

	test("readRun on an unknown run id throws", () => {
		const store = new FileEvidenceStore(projectRoot);
		expect(() => store.readRun("run_nope")).toThrow();
	});
});
