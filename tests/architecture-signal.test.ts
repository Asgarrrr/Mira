import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ArchitectureSignal } from "../src/architecture/architecture-signal.ts";
import { senseArchitecture } from "../src/architecture/sense.ts";
import { buildContextPack } from "../src/context/context-pack-generator.ts";

function gitInit(cwd: string): void {
	const init = spawnSync("git", ["init", "-q", "-b", "main"], { cwd });
	if (init.status !== 0) throw new Error("git init failed");
	spawnSync("git", ["config", "user.email", "test@example.com"], { cwd });
	spawnSync("git", ["config", "user.name", "Test"], { cwd });
	spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd });
}

function gitCommitAll(cwd: string, msg: string): void {
	const add = spawnSync("git", ["add", "-A"], { cwd });
	if (add.status !== 0) throw new Error("git add failed");
	const commit = spawnSync("git", ["commit", "-q", "-m", msg], { cwd });
	if (commit.status !== 0) throw new Error("git commit failed");
}

function writeFile(cwd: string, rel: string, content: string): void {
	const full = join(cwd, rel);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, content, "utf8");
}

function pathsByKind(
	signals: ArchitectureSignal[],
	kind: ArchitectureSignal["kind"],
): string[] {
	return signals.filter((s) => s.kind === kind).map((s) => s.path);
}

describe("senseArchitecture / changed-file", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = realpathSync(mkdtempSync(join(tmpdir(), "mira-arch-")));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	test("returns [] when not a git repo", async () => {
		writeFile(cwd, "src/foo.ts", "export const x = 1;\n");
		const signals = await senseArchitecture(cwd);
		expect(signals).toEqual([]);
	});

	test("returns [] for a clean working tree", async () => {
		gitInit(cwd);
		writeFile(cwd, "src/foo.ts", "export const x = 1;\n");
		gitCommitAll(cwd, "init");
		const signals = await senseArchitecture(cwd);
		expect(signals).toEqual([]);
	});

	test("includes untracked files", async () => {
		gitInit(cwd);
		writeFile(cwd, "README.md", "# repo\n");
		gitCommitAll(cwd, "init");
		writeFile(cwd, "src/new.ts", "export const x = 1;\n");
		const signals = await senseArchitecture(cwd);
		expect(pathsByKind(signals, "changed-file")).toContain("src/new.ts");
	});

	test("includes modified files", async () => {
		gitInit(cwd);
		writeFile(cwd, "src/foo.ts", "export const x = 1;\n");
		gitCommitAll(cwd, "init");
		writeFile(cwd, "src/foo.ts", "export const x = 2;\n");
		const signals = await senseArchitecture(cwd);
		expect(pathsByKind(signals, "changed-file")).toContain("src/foo.ts");
	});

	test("excludes deleted files (existence verified before emission)", async () => {
		gitInit(cwd);
		writeFile(cwd, "src/foo.ts", "export const x = 1;\n");
		writeFile(cwd, "src/bar.ts", "export const y = 2;\n");
		gitCommitAll(cwd, "init");
		// Modify bar.ts so it appears in `git status`, then delete it from disk.
		writeFile(cwd, "src/bar.ts", "export const y = 3;\n");
		unlinkSync(join(cwd, "src/bar.ts"));

		const signals = await senseArchitecture(cwd);
		const changed = pathsByKind(signals, "changed-file");
		expect(changed).not.toContain("src/bar.ts");
	});

	test("returns repo-root-relative paths when invoked from a subdirectory", async () => {
		gitInit(cwd);
		writeFile(cwd, "src/utils/foo.ts", "export const x = 1;\n");
		gitCommitAll(cwd, "init");
		writeFile(cwd, "src/utils/foo.ts", "export const x = 2;\n");

		// Invoking `mira context` from a subdirectory must still yield correct
		// signals; git porcelain reports paths from the repo root, not from cwd.
		const subdir = join(cwd, "src", "utils");
		const signals = await senseArchitecture(subdir);
		expect(pathsByKind(signals, "changed-file")).toEqual(["src/utils/foo.ts"]);
	});

	test("handles rename status without leaking OLD path", async () => {
		// `git status --porcelain=v1 -z` emits "R  NEW\0OLD\0" for renames.
		// The parser must consume both tokens and only surface NEW. If it
		// fails to skip OLD, OLD's own slice(3) is mis-parsed as another
		// entry — and if that slice happens to match an existing file in
		// the worktree, a phantom changed-file signal leaks through.
		gitInit(cwd);
		writeFile(cwd, "xx/foo.ts", "export const x = 1;\n");
		// Decoy at the repo root: "xx/foo.ts".slice(3) === "foo.ts". If the
		// parser mis-handles the OLD token, this file would be picked up as
		// a fake changed-file because existsSync wouldn't filter it out.
		writeFile(cwd, "foo.ts", "export const root = 1;\n");
		gitCommitAll(cwd, "init");

		const mv = spawnSync("git", ["mv", "xx/foo.ts", "xx/bar.ts"], { cwd });
		if (mv.status !== 0) throw new Error("git mv failed");

		const signals = await senseArchitecture(cwd);
		const changed = pathsByKind(signals, "changed-file").sort();
		expect(changed).toEqual(["xx/bar.ts"]);
	});

	test("emits one changed-file signal per existing modified path with source 'git'", async () => {
		gitInit(cwd);
		writeFile(cwd, "src/a.ts", "export const a = 1;\n");
		writeFile(cwd, "src/b.ts", "export const b = 1;\n");
		gitCommitAll(cwd, "init");
		writeFile(cwd, "src/a.ts", "export const a = 2;\n");
		writeFile(cwd, "src/c.ts", "export const c = 3;\n");

		const signals = await senseArchitecture(cwd);
		const changed = signals.filter((s) => s.kind === "changed-file");
		const paths = changed.map((s) => s.path).sort();
		expect(paths).toEqual(["src/a.ts", "src/c.ts"]);
		for (const s of changed) expect(s.source).toBe("git");
	});
});

describe("senseArchitecture / related-file", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = realpathSync(mkdtempSync(join(tmpdir(), "mira-arch-")));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	test("matches same-dir same-stem TS siblings (foo.ts ↔ foo.types.ts ↔ foo.helpers.ts)", async () => {
		gitInit(cwd);
		writeFile(cwd, "src/foo.ts", "export const x = 1;\n");
		writeFile(cwd, "src/foo.types.ts", "export type X = number;\n");
		writeFile(cwd, "src/foo.helpers.ts", "export const h = 1;\n");
		writeFile(cwd, "src/bar.ts", "export const y = 1;\n");
		gitCommitAll(cwd, "init");
		writeFile(cwd, "src/foo.ts", "export const x = 2;\n");

		const signals = await senseArchitecture(cwd);
		const related = pathsByKind(signals, "related-file").sort();
		expect(related).toEqual(["src/foo.helpers.ts", "src/foo.types.ts"]);

		for (const s of signals.filter((sig) => sig.kind === "related-file")) {
			expect(s.relatedTo).toBe("src/foo.ts");
			expect(s.source).toBe("filesystem");
		}
	});

	test("does not match files in other directories", async () => {
		gitInit(cwd);
		writeFile(cwd, "src/foo.ts", "x\n");
		writeFile(cwd, "other/foo.types.ts", "x\n");
		gitCommitAll(cwd, "init");
		writeFile(cwd, "src/foo.ts", "y\n");

		const signals = await senseArchitecture(cwd);
		expect(pathsByKind(signals, "related-file")).toEqual([]);
	});
});

describe("senseArchitecture / test-file", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = realpathSync(mkdtempSync(join(tmpdir(), "mira-arch-")));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	test("matches *.test.ts/.tsx and *.spec.ts/.tsx in the same dir", async () => {
		gitInit(cwd);
		writeFile(cwd, "src/foo.ts", "x\n");
		writeFile(cwd, "src/foo.test.ts", "x\n");
		writeFile(cwd, "src/foo.spec.ts", "x\n");
		writeFile(cwd, "src/foo.test.tsx", "x\n");
		writeFile(cwd, "src/foo.spec.tsx", "x\n");
		gitCommitAll(cwd, "init");
		writeFile(cwd, "src/foo.ts", "y\n");

		const signals = await senseArchitecture(cwd);
		const tests = pathsByKind(signals, "test-file").sort();
		expect(tests).toEqual([
			"src/foo.spec.ts",
			"src/foo.spec.tsx",
			"src/foo.test.ts",
			"src/foo.test.tsx",
		]);
	});

	test("matches counterparts under a sibling tests/ directory", async () => {
		gitInit(cwd);
		writeFile(cwd, "src/foo.ts", "x\n");
		writeFile(cwd, "src/tests/foo.test.ts", "x\n");
		gitCommitAll(cwd, "init");
		writeFile(cwd, "src/foo.ts", "y\n");

		const signals = await senseArchitecture(cwd);
		expect(pathsByKind(signals, "test-file")).toContain(
			"src/tests/foo.test.ts",
		);
	});

	test("emits no test-file when none exists", async () => {
		gitInit(cwd);
		writeFile(cwd, "src/foo.ts", "x\n");
		gitCommitAll(cwd, "init");
		writeFile(cwd, "src/foo.ts", "y\n");

		const signals = await senseArchitecture(cwd);
		expect(pathsByKind(signals, "test-file")).toEqual([]);
	});

	test("matches counterpart at repo-root tests/", async () => {
		gitInit(cwd);
		writeFile(cwd, "src/foo.ts", "x\n");
		writeFile(cwd, "tests/foo.test.ts", "x\n");
		gitCommitAll(cwd, "init");
		writeFile(cwd, "src/foo.ts", "y\n");

		const signals = await senseArchitecture(cwd);
		expect(pathsByKind(signals, "test-file")).toContain("tests/foo.test.ts");
	});

	test("matches counterpart in co-located __tests__/", async () => {
		gitInit(cwd);
		writeFile(cwd, "src/foo.ts", "x\n");
		writeFile(cwd, "src/__tests__/foo.test.ts", "x\n");
		gitCommitAll(cwd, "init");
		writeFile(cwd, "src/foo.ts", "y\n");

		const signals = await senseArchitecture(cwd);
		expect(pathsByKind(signals, "test-file")).toContain(
			"src/__tests__/foo.test.ts",
		);
	});

	test("matches counterpart at repo-root __tests__/", async () => {
		gitInit(cwd);
		writeFile(cwd, "src/foo.ts", "x\n");
		writeFile(cwd, "__tests__/foo.test.ts", "x\n");
		gitCommitAll(cwd, "init");
		writeFile(cwd, "src/foo.ts", "y\n");

		const signals = await senseArchitecture(cwd);
		expect(pathsByKind(signals, "test-file")).toContain(
			"__tests__/foo.test.ts",
		);
	});
});

describe("senseArchitecture / import-hint", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = realpathSync(mkdtempSync(join(tmpdir(), "mira-arch-")));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	test('matches `from "./foo"` and `from "./foo.ts"` references', async () => {
		gitInit(cwd);
		writeFile(cwd, "src/foo.ts", "export const x = 1;\n");
		writeFile(cwd, "src/a.ts", 'import { x } from "./foo";\n');
		writeFile(cwd, "src/b.ts", 'import { x } from "./foo.ts";\n');
		writeFile(cwd, "src/c.ts", 'import { unrelated } from "./bar";\n');
		gitCommitAll(cwd, "init");
		writeFile(cwd, "src/foo.ts", "export const x = 2;\n");

		const signals = await senseArchitecture(cwd);
		const hints = pathsByKind(signals, "import-hint").sort();
		expect(hints).toEqual(["src/a.ts", "src/b.ts"]);

		for (const s of signals.filter((sig) => sig.kind === "import-hint")) {
			expect(s.relatedTo).toBe("src/foo.ts");
			expect(s.source).toBe("filesystem");
		}
	});

	test("does not match a partial basename (foobar !== foo)", async () => {
		gitInit(cwd);
		writeFile(cwd, "src/foo.ts", "x\n");
		writeFile(cwd, "src/foobar.ts", "x\n");
		writeFile(cwd, "src/a.ts", 'import { x } from "./foobar";\n');
		gitCommitAll(cwd, "init");
		writeFile(cwd, "src/foo.ts", "y\n");

		const signals = await senseArchitecture(cwd);
		expect(pathsByKind(signals, "import-hint")).toEqual([]);
	});

	test("does not include the changed file itself among import-hints", async () => {
		gitInit(cwd);
		writeFile(cwd, "src/foo.ts", 'import { x } from "./foo";\n'); // self-loop
		writeFile(cwd, "src/a.ts", 'import { x } from "./foo";\n');
		gitCommitAll(cwd, "init");
		writeFile(cwd, "src/foo.ts", 'import { x } from "./foo";\nconst y = 2;\n');

		const signals = await senseArchitecture(cwd);
		expect(pathsByKind(signals, "import-hint")).toEqual(["src/a.ts"]);
	});

	test("does not match basename collision across directories", async () => {
		gitInit(cwd);
		writeFile(cwd, "src/utils/foo.ts", "export const x = 1;\n");
		writeFile(cwd, "src/auth/foo.ts", "export const y = 1;\n");
		// imports its OWN local foo, not the utils one — basename matches but path doesn't.
		writeFile(cwd, "src/auth/a.ts", 'import { y } from "./foo";\n');
		gitCommitAll(cwd, "init");
		writeFile(cwd, "src/utils/foo.ts", "export const x = 2;\n");

		const signals = await senseArchitecture(cwd);
		expect(pathsByKind(signals, "import-hint")).toEqual([]);
	});

	test("does not match bare specifier with same basename", async () => {
		gitInit(cwd);
		writeFile(cwd, "src/react.ts", "export const x = 1;\n");
		writeFile(cwd, "src/a.ts", 'import { x } from "react";\n');
		gitCommitAll(cwd, "init");
		writeFile(cwd, "src/react.ts", "export const x = 2;\n");

		const signals = await senseArchitecture(cwd);
		expect(pathsByKind(signals, "import-hint")).toEqual([]);
	});

	test("matches directory imports resolving to index.ts", async () => {
		gitInit(cwd);
		writeFile(cwd, "src/utils/index.ts", "export const x = 1;\n");
		writeFile(cwd, "src/a.ts", 'import { x } from "./utils";\n');
		gitCommitAll(cwd, "init");
		writeFile(cwd, "src/utils/index.ts", "export const x = 2;\n");

		const signals = await senseArchitecture(cwd);
		expect(pathsByKind(signals, "import-hint")).toEqual(["src/a.ts"]);
	});

	test("does not match tsconfig-paths aliases", async () => {
		gitInit(cwd);
		writeFile(cwd, "src/foo.ts", "export const x = 1;\n");
		writeFile(cwd, "src/a.ts", 'import { x } from "@/foo";\n');
		gitCommitAll(cwd, "init");
		writeFile(cwd, "src/foo.ts", "export const x = 2;\n");

		const signals = await senseArchitecture(cwd);
		// Documents the deliberate false-negative: ADR 0005 prefers no signal
		// over a fabricated one when path resolution is ambiguous.
		expect(pathsByKind(signals, "import-hint")).toEqual([]);
	});
});

describe("buildContextPack — suspectedFiles projection (ADR 0005)", () => {
	test("orders changed-file → related-file → test-file → import-hint, alpha within each kind", () => {
		const signals: ArchitectureSignal[] = [
			{
				kind: "import-hint",
				path: "src/i.ts",
				reason: "r",
				source: "filesystem",
			},
			{
				kind: "related-file",
				path: "src/r2.ts",
				reason: "r",
				source: "filesystem",
			},
			{
				kind: "changed-file",
				path: "src/b.ts",
				reason: "r",
				source: "git",
			},
			{
				kind: "changed-file",
				path: "src/a.ts",
				reason: "r",
				source: "git",
			},
			{
				kind: "test-file",
				path: "src/a.test.ts",
				reason: "r",
				source: "filesystem",
			},
			{
				kind: "related-file",
				path: "src/r1.ts",
				reason: "r",
				source: "filesystem",
			},
		];

		const pack = buildContextPack({
			id: "ctx_x",
			task: "t",
			createdAt: "2026-01-01T00:00:00.000Z",
			observations: [],
			architectureSignals: signals,
		});

		expect(pack.suspectedFiles).toEqual([
			"src/a.ts", // changed-file (alpha)
			"src/b.ts",
			"src/r1.ts", // related-file (alpha)
			"src/r2.ts",
			"src/a.test.ts", // test-file
			"src/i.ts", // import-hint
		]);
	});

	test("dedupes a path that appears under multiple kinds (first occurrence wins)", () => {
		const signals: ArchitectureSignal[] = [
			{
				kind: "test-file",
				path: "src/foo.test.ts",
				reason: "r",
				source: "filesystem",
			},
			{
				kind: "related-file",
				path: "src/foo.test.ts",
				reason: "r",
				source: "filesystem",
			},
			{
				kind: "changed-file",
				path: "src/foo.ts",
				reason: "r",
				source: "git",
			},
		];

		const pack = buildContextPack({
			id: "ctx_x",
			task: "t",
			createdAt: "2026-01-01T00:00:00.000Z",
			observations: [],
			architectureSignals: signals,
		});

		// foo.test.ts appears in both related-file and test-file: kept under
		// related-file (earliest position), dropped from test-file.
		expect(pack.suspectedFiles).toEqual(["src/foo.ts", "src/foo.test.ts"]);
	});

	test("caps suspectedFiles at 20", () => {
		const signals: ArchitectureSignal[] = Array.from(
			{ length: 30 },
			(_, i) => ({
				kind: "changed-file" as const,
				path: `src/file${String(i).padStart(2, "0")}.ts`,
				reason: "r",
				source: "git" as const,
			}),
		);

		const pack = buildContextPack({
			id: "ctx_x",
			task: "t",
			createdAt: "2026-01-01T00:00:00.000Z",
			observations: [],
			architectureSignals: signals,
		});

		expect(pack.suspectedFiles.length).toBe(20);
		// Alphabetic byte-wise sort ⇒ file00..file19
		expect(pack.suspectedFiles[0]).toBe("src/file00.ts");
		expect(pack.suspectedFiles[19]).toBe("src/file19.ts");
	});

	test("returns [] when no signals are passed", () => {
		const pack = buildContextPack({
			id: "ctx_x",
			task: "t",
			createdAt: "2026-01-01T00:00:00.000Z",
			observations: [],
		});
		expect(pack.suspectedFiles).toEqual([]);
	});
});
