import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
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

	test("flags killedByTimeout and exposes the SIGKILL signal", async () => {
		const store = new FileEvidenceStore(projectRoot);
		const observer = new CommandObserver(store, 100);

		const start = Date.now();
		const { run } = await observer.observe("sleep 5", projectRoot);
		const elapsed = Date.now() - start;

		expect(run.killedByTimeout).toBe(true);
		expect(run.signal).toBe("SIGKILL");
		expect(run.exitCode).toBeNull();
		expect(elapsed).toBeLessThan(2000);
	});

	test("successful runs report killedByTimeout=false and no signal", async () => {
		const store = new FileEvidenceStore(projectRoot);
		const observer = new CommandObserver(store);

		const { run } = await observer.observe("echo ok", projectRoot);

		expect(run.exitCode).toBe(0);
		expect(run.killedByTimeout).toBe(false);
		expect(run.signal).toBeUndefined();
	});

	test("rejects on spawn error (invalid cwd) without leaking the timeout timer", async () => {
		const store = new FileEvidenceStore(projectRoot);
		// Short timeout: if the rejection still left the timer armed, this
		// test would still pass but the original 300s default would keep an
		// event-loop handle alive past the test in production. The contract
		// being documented here is "observe() rejects rather than hangs".
		const observer = new CommandObserver(store, 200);
		const badCwd = join(projectRoot, "does-not-exist");

		await expect(observer.observe("echo hi", badCwd)).rejects.toThrow();
	});

	// Regression for audit H1: when sh's descendants inherit our pipes (subshell
	// background, fork-and-wait), killing only sh leaves the descendants holding
	// stdout/stderr open — observe() blocked for the descendant's lifetime instead
	// of returning at timeoutMs. The fix spawns sh as a process-group leader and
	// group-kills on timeout. See audit/01-H1-timeout-orphans.md.
	test("kills orphan descendants on timeout via process group", async () => {
		if (process.platform === "win32") return;

		// Unique sleep duration so a precise ps check can't collide with
		// concurrent test runs or stragglers from earlier sessions.
		const sleepDuration = String(5000 + (process.pid % 1000));
		const psPattern = new RegExp(`\\bsleep ${sleepDuration}(\\s|$)`);
		const store = new FileEvidenceStore(projectRoot);
		const observer = new CommandObserver(store, 200);

		try {
			const start = Date.now();
			const { stdout } = await observer.observe(
				`(sleep ${sleepDuration} &); echo orphan`,
				projectRoot,
			);
			const elapsed = Date.now() - start;

			expect(elapsed).toBeLessThan(500);
			expect(stdout).toContain("orphan");

			const psOut = execSync("ps -ax -o pid,command", {
				encoding: "utf8",
			});
			const survivors = psOut
				.split("\n")
				.filter((line) => psPattern.test(line));
			expect(survivors).toEqual([]);
		} finally {
			// Defensive cleanup if the fix regresses — never leak a multi-thousand-second
			// sleep onto the user's machine. -9 because sleep ignores SIGTERM cleanup.
			try {
				execSync(`pkill -9 -f 'sleep ${sleepDuration}' 2>/dev/null || true`);
			} catch {}
		}
	});
});
