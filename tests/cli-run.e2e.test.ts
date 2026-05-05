import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = resolve(HERE, "..", "src", "cli", "index.ts");

async function runMira(args: string[], cwd: string) {
	const proc = Bun.spawn(["bun", CLI_ENTRY, ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

function readSingleRunDir(cwd: string): string {
	const runsRoot = join(cwd, ".mira", "runs");
	const entries = readdirSync(runsRoot);
	expect(entries.length).toBe(1);
	return join(runsRoot, entries[0] as string);
}

describe("mira run (E2E)", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "mira-e2e-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	test("forwards stdout, persists evidence, exits 0 on success", async () => {
		const { stdout, stderr, exitCode } = await runMira(
			["run", "echo hello"],
			cwd,
		);

		expect(exitCode).toBe(0);
		expect(stdout).toBe("hello\n");
		expect(stderr).toMatch(/\[mira\] run_/);
		expect(stderr).toContain("success");
		expect(stderr).toContain("exit 0");

		const runDir = readSingleRunDir(cwd);
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

		const md = readFileSync(join(runDir, "observation.md"), "utf8");
		expect(md).toContain("- **Status:** success");
		expect(md).toContain("- **Exit code:** 0");

		const observation = JSON.parse(
			readFileSync(join(runDir, "observation.json"), "utf8"),
		);
		expect(observation.status).toBe("success");
		expect(observation.exitCode).toBe(0);
		expect(observation.killedByTimeout).toBe(false);
	});

	test("preserves the exit code of a failing command", async () => {
		const { exitCode, stderr } = await runMira(["run", "exit 3"], cwd);

		expect(exitCode).toBe(3);
		expect(stderr).toContain("failure");
		expect(stderr).toContain("exit 3");

		const runDir = readSingleRunDir(cwd);
		const observation = JSON.parse(
			readFileSync(join(runDir, "observation.json"), "utf8"),
		);
		expect(observation.status).toBe("failure");
		expect(observation.exitCode).toBe(3);
	});

	test("rejects an empty command with a usage message and exit 2", async () => {
		const { exitCode, stderr } = await runMira(["run"], cwd);

		expect(exitCode).toBe(2);
		expect(stderr).toMatch(/usage: mira run/);
	});

	test("two concurrent mira run invocations produce two distinct run dirs", async () => {
		const [a, b] = await Promise.all([
			runMira(["run", "echo a"], cwd),
			runMira(["run", "echo b"], cwd),
		]);

		expect(a.exitCode).toBe(0);
		expect(b.exitCode).toBe(0);

		const runsRoot = join(cwd, ".mira", "runs");
		const entries = readdirSync(runsRoot);
		expect(entries.length).toBe(2);
		expect(new Set(entries).size).toBe(2);
	});
});
