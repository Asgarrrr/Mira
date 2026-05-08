import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const CLI_ENTRY = join(REPO_ROOT, "src", "cli", "index.ts");
const REPO_BIN = join(REPO_ROOT, "node_modules", ".bin");
const TSC_BIN = join(REPO_BIN, "tsc");
const FIXTURE_DIR = join(REPO_ROOT, "tests", "fixtures", "tsc-e2e");

// Skip cleanly when the host has no local typescript install rather than
// hanging on an offline `bunx typescript` download.
const TSC_AVAILABLE = existsSync(TSC_BIN);

async function runMira(args: string[], cwd: string) {
	const proc = Bun.spawn(["bun", CLI_ENTRY, ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		// Inject the repo's node_modules/.bin so the spawned `tsc` resolves to
		// the dev-dep typescript without any bunx download. The fixture cwd is
		// outside the repo and has no node_modules of its own.
		env: {
			...process.env,
			PATH: `${REPO_BIN}${delimiter}${process.env.PATH ?? ""}`,
		},
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

describe.skipIf(!TSC_AVAILABLE)("mira run tsc (E2E)", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "mira-tsc-e2e-"));
		copyFileSync(
			join(FIXTURE_DIR, "tsconfig.json"),
			join(cwd, "tsconfig.json"),
		);
		copyFileSync(join(FIXTURE_DIR, "broken.ts"), join(cwd, "broken.ts"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	test("filter fires end-to-end on a real tsc failure", async () => {
		// `--pretty false` defends against future tsc default flips; the parser
		// has a pretty-mode passthrough that would otherwise turn into raw output.
		const { stdout, stderr, exitCode } = await runMira(
			["run", "--quiet", "tsc --noEmit --pretty false -p ."],
			cwd,
		);

		expect(exitCode).not.toBe(0);
		expect(stderr).toBe("");
		expect(stdout).toMatch(/^# tsc — \d+ error(?:s)? in \d+ file(?:s)?/);
		expect(stdout).toContain("**TS");
		expect(stdout).toMatch(/_evidence: \.mira\/runs\/run_[^_]+_[^/]+\/_/);

		const runsRoot = join(cwd, ".mira", "runs");
		const entries = readdirSync(runsRoot);
		expect(entries.length).toBe(1);
		const runDir = join(runsRoot, entries[0] as string);

		expect(existsSync(join(runDir, "filtered.md"))).toBe(true);
		expect(existsSync(join(runDir, "stdout.log"))).toBe(true);
		expect(existsSync(join(runDir, "stderr.log"))).toBe(true);
		expect(existsSync(join(runDir, "combined.log"))).toBe(true);

		const filtered = readFileSync(join(runDir, "filtered.md"), "utf8");
		expect(filtered).toMatch(/^# tsc —/);

		const observation = JSON.parse(
			readFileSync(join(runDir, "observation.json"), "utf8"),
		);
		expect(observation.status).toBe("failure");
		expect(observation.filterVersion).toBe("tsc/5");
		expect(Array.isArray(observation.findings)).toBe(true);
		expect(observation.findings.length).toBeGreaterThan(0);
		expect(observation.findings[0].severity).toBe("error");
		expect(observation.findings[0].title).toMatch(/^TS\d+: /);
	});
});
