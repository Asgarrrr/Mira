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
const BOOTSTRAP = resolve(HERE, "fixtures", "filter-cli-bootstrap.ts");

type Mode = "none" | "hit" | "throw";

async function runBootstrap(args: string[], cwd: string, mode: Mode) {
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (mode !== "none") env.MIRA_FILTER_FIXTURE_MODE = mode;
	else delete env.MIRA_FILTER_FIXTURE_MODE;
	const proc = Bun.spawn(["bun", BOOTSTRAP, ...args], {
		cwd,
		env,
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

describe("mira run + filter dispatcher (E2E)", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "mira-filter-e2e-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	test("no filter registered → unchanged behavior, no filtered.md", async () => {
		const { stdout, stderr, exitCode } = await runBootstrap(
			["echo hello", "--quiet"],
			cwd,
			"none",
		);

		expect(exitCode).toBe(0);
		expect(stdout).toBe("hello\n");
		expect(stderr).toBe("");

		const runDir = readSingleRunDir(cwd);
		expect(existsSync(join(runDir, "filtered.md"))).toBe(false);

		const observation = JSON.parse(
			readFileSync(join(runDir, "observation.json"), "utf8"),
		);
		expect(observation.findings).toEqual([]);
		expect(observation.filterVersion).toBeUndefined();
	});

	test("filter hit + --quiet → markdown + pointer on stdout, empty stderr, findings persisted", async () => {
		const { stdout, stderr, exitCode } = await runBootstrap(
			["echo hello", "--quiet"],
			cwd,
			"hit",
		);

		expect(exitCode).toBe(0);
		expect(stderr).toBe("");

		const runDir = readSingleRunDir(cwd);
		const runId = runDir.split("/").pop();
		expect(runId).toMatch(/^run_/);
		expect(stdout).toBe(`## test\nbody\n_evidence: .mira/runs/${runId}/_\n`);

		expect(existsSync(join(runDir, "filtered.md"))).toBe(true);
		expect(readFileSync(join(runDir, "filtered.md"), "utf8")).toBe(
			"## test\nbody",
		);

		const observation = JSON.parse(
			readFileSync(join(runDir, "observation.json"), "utf8"),
		);
		expect(observation.findings).toHaveLength(1);
		expect(observation.findings[0].id).toBe("fix-1");
		expect(observation.filterVersion).toBe("echo/1");
	});

	test("filter hit without --quiet → markdown + pointer on stdout, footer on stderr", async () => {
		const { stdout, stderr, exitCode } = await runBootstrap(
			["echo hello"],
			cwd,
			"hit",
		);

		expect(exitCode).toBe(0);

		const runDir = readSingleRunDir(cwd);
		const runId = runDir.split("/").pop();
		expect(stdout).toBe(`## test\nbody\n_evidence: .mira/runs/${runId}/_\n`);
		expect(stderr).toMatch(/\[mira\] run_/);
		expect(stderr).toContain("success");
	});

	test("filter throws → stderr warning + raw passthrough, no filtered.md, no findings", async () => {
		const { stdout, stderr, exitCode } = await runBootstrap(
			["echo hello", "--quiet"],
			cwd,
			"throw",
		);

		expect(exitCode).toBe(0);
		expect(stdout).toBe("hello\n");
		expect(stderr).toBe('[mira] filter threw for "echo"; passthrough used\n');

		const runDir = readSingleRunDir(cwd);
		expect(existsSync(join(runDir, "filtered.md"))).toBe(false);

		const observation = JSON.parse(
			readFileSync(join(runDir, "observation.json"), "utf8"),
		);
		expect(observation.findings).toEqual([]);
		expect(observation.filterVersion).toBeUndefined();
	});
});
