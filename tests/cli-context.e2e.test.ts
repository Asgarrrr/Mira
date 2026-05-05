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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ContextPack } from "../src/core/context-pack.ts";

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

function readPack(cwd: string): ContextPack {
	const ctxRoot = join(cwd, ".mira", "context");
	const jsonName = readdirSync(ctxRoot).find((f) => f.endsWith(".json"));
	if (!jsonName) throw new Error("no context json found");
	return JSON.parse(
		readFileSync(join(ctxRoot, jsonName), "utf8"),
	) as ContextPack;
}

describe("mira context (E2E)", () => {
	let cwd: string;

	beforeEach(() => {
		// realpath: macOS resolves /var -> /private/var, and process.cwd() in the
		// spawned CLI returns the resolved form, so the assertions need it too.
		cwd = realpathSync(mkdtempSync(join(tmpdir(), "mira-ctx-e2e-")));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	test("rejects an empty task with a usage message and exit 2", async () => {
		const { exitCode, stderr } = await runMira(["context"], cwd);
		expect(exitCode).toBe(2);
		expect(stderr).toMatch(/usage: mira context/);
	});

	test("with no prior runs, produces an empty pack and writes both files", async () => {
		const { exitCode, stderr } = await runMira(["context", "fresh start"], cwd);
		expect(exitCode).toBe(0);
		expect(stderr).toMatch(/\[mira\] ctx_/);
		expect(stderr).toContain("0 observations");

		const ctxRoot = join(cwd, ".mira", "context");
		const entries = readdirSync(ctxRoot);
		expect(entries.length).toBe(2);

		const jsonEntry = entries.find((e) => e.endsWith(".json"));
		const mdEntry = entries.find((e) => e.endsWith(".md"));
		expect(jsonEntry).toBeDefined();
		expect(mdEntry).toBeDefined();

		const pack = JSON.parse(
			readFileSync(join(ctxRoot, jsonEntry as string), "utf8"),
		) as ContextPack;
		expect(pack.task).toBe("fresh start");
		expect(pack.observationIds).toEqual([]);
		expect(pack.evidenceRefs).toEqual([]);
		expect(pack.verificationCommands).toEqual([]);
		expect(pack.suspectedFiles).toEqual([]);
		expect(pack.risks).toEqual([]);
		expect(pack.nextRecommendedAction).toBe("");
	});

	test("selects the 10 most recent of 11 runs, preserves order, references metadata", async () => {
		// 11 sequential runs so the run-id timestamp ordering is well-defined.
		for (let i = 0; i < 11; i++) {
			const { exitCode } = await runMira(["run", `echo ${i}`], cwd);
			expect(exitCode).toBe(0);
		}

		const runIds = readdirSync(join(cwd, ".mira", "runs")).sort();
		expect(runIds.length).toBe(11);
		const expectedTop10 = [...runIds].reverse().slice(0, 10);

		const { exitCode, stderr } = await runMira(["context", "investigate"], cwd);
		expect(exitCode).toBe(0);
		expect(stderr).toContain("10 observations");
		expect(stderr).toMatch(/\.mira\/context\/ctx_[^.]+\.json/);

		const ctxRoot = join(cwd, ".mira", "context");
		const ctxFiles = readdirSync(ctxRoot);
		const jsonName = ctxFiles.find((f) => f.endsWith(".json")) as string;
		const mdName = ctxFiles.find((f) => f.endsWith(".md")) as string;

		const pack = JSON.parse(
			readFileSync(join(ctxRoot, jsonName), "utf8"),
		) as ContextPack;

		expect(pack.task).toBe("investigate");
		expect(pack.id).toBe(jsonName.replace(/\.json$/, ""));
		expect(pack.observationIds).toEqual(expectedTop10);
		expect(pack.observationIds.length).toBe(10);
		expect(pack.evidenceRefs.length).toBe(10);
		for (const [i, ref] of pack.evidenceRefs.entries()) {
			expect(ref.kind).toBe("metadata");
			expect(ref.path).toBe(
				join(cwd, ".mira", "runs", expectedTop10[i] as string, "metadata.json"),
			);
			expect(existsSync(ref.path)).toBe(true);
		}

		expect(pack.summary).toContain("10 recent observations");
		expect(pack.summary).toContain("(10 succeeded, 0 failed)");

		// All 11 runs were `echo N`, all succeeded — verificationCommands are
		// the unique echo commands among the selected 10, newest first.
		expect(pack.verificationCommands.length).toBe(10);
		expect(new Set(pack.verificationCommands).size).toBe(10);
		expect(pack.verificationCommands[0]).toMatch(/^echo \d+$/);

		expect(pack.suspectedFiles).toEqual([]);
		expect(pack.risks).toEqual([]);
		expect(pack.nextRecommendedAction).toBe("");

		const md = readFileSync(join(ctxRoot, mdName), "utf8");
		expect(md).toContain(`# Context ${pack.id}`);
		expect(md).toContain("- **Task:** `investigate`");
		expect(md).toContain("## Observations");
		expect(md).toContain("## Evidence");
		expect(md).toContain("## Verification commands");
		for (const id of expectedTop10) expect(md).toContain(id);
	}, 60_000);

	test("dedupes verificationCommands and excludes failed commands", async () => {
		// Mix: one failure (exit 1), three successes (two duplicates).
		await runMira(["run", "echo a"], cwd);
		await runMira(["run", "false"], cwd); // failure
		await runMira(["run", "echo b"], cwd);
		await runMira(["run", "echo a"], cwd); // duplicate of the first

		const { exitCode } = await runMira(["context", "verify"], cwd);
		expect(exitCode).toBe(0);

		const ctxRoot = join(cwd, ".mira", "context");
		const jsonName = readdirSync(ctxRoot).find((f) =>
			f.endsWith(".json"),
		) as string;
		const pack = JSON.parse(
			readFileSync(join(ctxRoot, jsonName), "utf8"),
		) as ContextPack;

		expect(pack.observationIds.length).toBe(4);
		// Newest first: echo a (dup), echo b, false, echo a — successes only,
		// deduped by exact string.
		expect(pack.verificationCommands).toEqual(["echo a", "echo b"]);
		expect(pack.summary).toContain("(3 succeeded, 1 failed)");
	});

	test("populates suspectedFiles from working-tree state (changed-file + sibling test)", async () => {
		gitInit(cwd);
		writeFile(cwd, "src/foo.ts", "export const x = 1;\n");
		writeFile(cwd, "src/foo.test.ts", "// test\n");
		gitCommitAll(cwd, "init");
		// Touch the source file so it shows up as modified.
		writeFile(cwd, "src/foo.ts", "export const x = 2;\n");

		const { exitCode } = await runMira(["context", "investigate foo"], cwd);
		expect(exitCode).toBe(0);

		const pack = readPack(cwd);
		// kind order: changed-file → related-file → test-file → import-hint;
		// alpha within each kind; deduped across kinds. foo.test.ts shares the
		// stem with foo.ts so it lands under related-file (earliest position).
		expect(pack.suspectedFiles).toEqual(["src/foo.ts", "src/foo.test.ts"]);

		// Markdown surfaces the section when populated.
		const ctxRoot = join(cwd, ".mira", "context");
		const mdName = readdirSync(ctxRoot).find((f) =>
			f.endsWith(".md"),
		) as string;
		const md = readFileSync(join(ctxRoot, mdName), "utf8");
		expect(md).toContain("## Suspected files");
		expect(md).toContain("- `src/foo.ts`");
		expect(md).toContain("- `src/foo.test.ts`");
	});

	test("suspectedFiles is [] when the working tree is clean", async () => {
		gitInit(cwd);
		writeFile(cwd, "src/foo.ts", "export const x = 1;\n");
		gitCommitAll(cwd, "init");

		const { exitCode } = await runMira(["context", "clean tree"], cwd);
		expect(exitCode).toBe(0);

		const pack = readPack(cwd);
		expect(pack.suspectedFiles).toEqual([]);
	});

	test("respects the cap of 20 suspectedFiles when many files change", async () => {
		gitInit(cwd);
		// Seed an initial commit so subsequent files become "modified" not
		// untracked-via-empty-repo (both work, but this is more realistic).
		writeFile(cwd, "README.md", "# repo\n");
		gitCommitAll(cwd, "init");

		// Create 25 untracked files; all will be reported as changed-file.
		for (let i = 0; i < 25; i++) {
			writeFile(cwd, `src/file${String(i).padStart(2, "0")}.ts`, "x\n");
		}

		const { exitCode } = await runMira(["context", "many changes"], cwd);
		expect(exitCode).toBe(0);

		const pack = readPack(cwd);
		expect(pack.suspectedFiles.length).toBe(20);
		// Byte-wise alpha within changed-file kind ⇒ first 20 are file00..file19.
		expect(pack.suspectedFiles[0]).toBe("src/file00.ts");
		expect(pack.suspectedFiles[19]).toBe("src/file19.ts");
	});
});
