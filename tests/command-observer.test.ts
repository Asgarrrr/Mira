import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CommandObserver } from "../src/command/command-observer.ts";
import { FileEvidenceStore } from "../src/store/evidence-store.ts";

describe("CommandObserver", () => {
	let projectRoot: string;

	beforeEach(() => {
		projectRoot = mkdtempSync(join(tmpdir(), "mira-observer-"));
	});

	afterEach(() => {
		rmSync(projectRoot, { recursive: true, force: true });
	});

	test("captures stdout and exits 0 on success", async () => {
		const store = new FileEvidenceStore(projectRoot);
		const observer = new CommandObserver(store);

		const { run, stdout, stderr } = await observer.observe(
			"echo hello",
			projectRoot,
		);

		expect(run.exitCode).toBe(0);
		expect(stdout).toBe("hello\n");
		expect(stderr).toBe("");
		expect(run.command).toBe("echo hello");
		expect(run.cwd).toBe(projectRoot);
		expect(run.durationMs).toBeGreaterThanOrEqual(0);
		expect(run.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	test("persists raw evidence files on disk", async () => {
		const store = new FileEvidenceStore(projectRoot);
		const observer = new CommandObserver(store);

		const { run } = await observer.observe("echo hi", projectRoot);
		const runDir = join(projectRoot, ".mira", "runs", run.id);

		expect(existsSync(join(runDir, "stdout.log"))).toBe(true);
		expect(existsSync(join(runDir, "stderr.log"))).toBe(true);
		expect(existsSync(join(runDir, "combined.log"))).toBe(true);
		expect(existsSync(join(runDir, "metadata.json"))).toBe(true);
		expect(readFileSync(join(runDir, "stdout.log"), "utf8")).toBe("hi\n");
	});

	test("preserves non-zero exit code", async () => {
		const store = new FileEvidenceStore(projectRoot);
		const observer = new CommandObserver(store);

		const { run } = await observer.observe("exit 7", projectRoot);

		expect(run.exitCode).toBe(7);
	});

	test.each([1, 2, 7, 42])("preserves exit code %d", async (code) => {
		const store = new FileEvidenceStore(projectRoot);
		const observer = new CommandObserver(store);

		const { run } = await observer.observe(`exit ${code}`, projectRoot);

		expect(run.exitCode).toBe(code);
	});

	test("captures stderr separately from stdout", async () => {
		const store = new FileEvidenceStore(projectRoot);
		const observer = new CommandObserver(store);

		const { run, stdout, stderr } = await observer.observe(
			"echo err 1>&2",
			projectRoot,
		);

		expect(stdout).toBe("");
		expect(stderr).toBe("err\n");
		expect(run.exitCode).toBe(0);
	});

	test("combined log contains both streams", async () => {
		const store = new FileEvidenceStore(projectRoot);
		const observer = new CommandObserver(store);

		const { run } = await observer.observe(
			"echo out; echo err 1>&2",
			projectRoot,
		);
		const combined = readFileSync(
			join(projectRoot, ".mira", "runs", run.id, "combined.log"),
			"utf8",
		);

		expect(combined).toContain("out");
		expect(combined).toContain("err");
	});

	test("metadata.json round-trips through readRun", async () => {
		const store = new FileEvidenceStore(projectRoot);
		const observer = new CommandObserver(store);

		const { run } = await observer.observe("echo persisted", projectRoot);
		const fromDisk = store.readRun(run.id);

		expect(fromDisk).toEqual(run);
	});

	test("kills the process when timeout is hit", async () => {
		const store = new FileEvidenceStore(projectRoot);
		const observer = new CommandObserver(store, 100);

		const start = Date.now();
		const { run } = await observer.observe("sleep 5", projectRoot);
		const elapsed = Date.now() - start;

		expect(run.exitCode).not.toBe(0);
		expect(elapsed).toBeLessThan(2000);
	});
});
