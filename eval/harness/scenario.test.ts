import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	applyScenario,
	checkScenario,
	loadScenario,
	type Scenario,
} from "./scenario.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const COMMITTED_FIXTURES = resolve(HERE, "__fixtures__", "scenarios");

// Dynamic fixtures (built per-test-suite) cover the negative paths without
// committing several broken-by-design scenario directories.
let dynamicFixturesRoot: string;

// A throwaway git repo used as the `repoRoot` for applyScenario tests. Built
// once in beforeAll, contains a single committed file (`src/foo.txt = "fixed\n"`)
// so the fixture's base.patch (fixed → buggy) applies cleanly.
let sourceRepoRoot: string;

async function pathExists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

function listWorktrees(repo: string): string {
	const r = spawnSync("git", ["-C", repo, "worktree", "list", "--porcelain"], {
		encoding: "utf8",
	});
	return r.stdout ?? "";
}

beforeAll(async () => {
	dynamicFixturesRoot = await mkdtemp(join(tmpdir(), "mira-scenario-test-"));

	// missing-patch: has task.txt + success.sh, no base.patch
	const mp = join(dynamicFixturesRoot, "missing-patch");
	await mkdir(mp, { recursive: true });
	await writeFile(join(mp, "task.txt"), "task\n");
	await writeFile(join(mp, "success.sh"), "#!/bin/sh\nexit 0\n");

	// missing-task: has base.patch + success.sh, no task.txt
	const mt = join(dynamicFixturesRoot, "missing-task");
	await mkdir(mt, { recursive: true });
	await writeFile(join(mt, "base.patch"), "diff --git a/x b/x\n");
	await writeFile(join(mt, "success.sh"), "#!/bin/sh\nexit 0\n");

	// missing-success: has base.patch + task.txt, no success.sh
	const ms = join(dynamicFixturesRoot, "missing-success");
	await mkdir(ms, { recursive: true });
	await writeFile(join(ms, "base.patch"), "diff --git a/x b/x\n");
	await writeFile(join(ms, "task.txt"), "task\n");

	// empty-task: all files present, but task.txt is whitespace only
	const et = join(dynamicFixturesRoot, "empty-task");
	await mkdir(et, { recursive: true });
	await writeFile(join(et, "base.patch"), "diff --git a/x b/x\n");
	await writeFile(join(et, "success.sh"), "#!/bin/sh\nexit 0\n");
	await writeFile(join(et, "task.txt"), "  \n\t\n");

	// Build the throwaway source repo with src/foo.txt = "fixed\n".
	sourceRepoRoot = await mkdtemp(join(tmpdir(), "mira-scenario-src-"));
	await mkdir(join(sourceRepoRoot, "src"), { recursive: true });
	await writeFile(join(sourceRepoRoot, "src", "foo.txt"), "fixed\n");
	const gitRun = (args: string[]) =>
		spawnSync("git", args, { cwd: sourceRepoRoot, encoding: "utf8" });
	gitRun(["init", "-q", "-b", "main"]);
	gitRun(["config", "user.email", "test@example.com"]);
	gitRun(["config", "user.name", "Test"]);
	gitRun(["add", "."]);
	gitRun(["commit", "-q", "-m", "initial"]);
});

afterAll(async () => {
	if (dynamicFixturesRoot) {
		await rm(dynamicFixturesRoot, { recursive: true, force: true });
	}
	if (sourceRepoRoot) {
		await rm(sourceRepoRoot, { recursive: true, force: true });
	}
});

describe("loadScenario", () => {
	test("happy path returns a fully populated Scenario", async () => {
		const s = await loadScenario("test-fixture", {
			scenariosRoot: COMMITTED_FIXTURES,
		});

		expect(s.id).toBe("test-fixture");
		expect(s.dir).toBe(join(COMMITTED_FIXTURES, "test-fixture"));
		expect(s.patchPath).toBe(join(s.dir, "base.patch"));
		expect(s.successPath).toBe(join(s.dir, "success.sh"));
		expect(s.taskPath).toBe(join(s.dir, "task.txt"));
		expect(s.task.length).toBeGreaterThan(0);
		// trim() removes the trailing newline written by the editor
		expect(s.task.endsWith("\n")).toBe(false);
	});

	test("missing scenario directory throws with id and resolved path", async () => {
		await expect(
			loadScenario("does-not-exist", {
				scenariosRoot: COMMITTED_FIXTURES,
			}),
		).rejects.toThrow(/does-not-exist/);
	});

	test("missing base.patch throws naming the file", async () => {
		await expect(
			loadScenario("missing-patch", {
				scenariosRoot: dynamicFixturesRoot,
			}),
		).rejects.toThrow(/base\.patch/);
	});

	test("missing task.txt throws naming the file", async () => {
		await expect(
			loadScenario("missing-task", {
				scenariosRoot: dynamicFixturesRoot,
			}),
		).rejects.toThrow(/task\.txt/);
	});

	test("missing success.sh throws naming the file", async () => {
		await expect(
			loadScenario("missing-success", {
				scenariosRoot: dynamicFixturesRoot,
			}),
		).rejects.toThrow(/success\.sh/);
	});

	test("whitespace-only task.txt throws as empty", async () => {
		await expect(
			loadScenario("empty-task", {
				scenariosRoot: dynamicFixturesRoot,
			}),
		).rejects.toThrow(/empty/);
	});

	test("empty id is rejected before any I/O", async () => {
		await expect(loadScenario("")).rejects.toThrow(/non-empty/);
	});
});

describe("applyScenario", () => {
	test("workdir contains the patched (buggy) file", async () => {
		const scenario = await loadScenario("test-fixture", {
			scenariosRoot: COMMITTED_FIXTURES,
		});
		const applied = await applyScenario(scenario, {
			repoRoot: sourceRepoRoot,
			installDeps: false,
		});
		try {
			const got = await readFile(
				join(applied.workdir, "src", "foo.txt"),
				"utf8",
			);
			expect(got).toBe("buggy\n");
		} finally {
			await applied.cleanup();
		}
	});

	test("cleanup() removes workdir and prunes the worktree pointer", async () => {
		const scenario = await loadScenario("test-fixture", {
			scenariosRoot: COMMITTED_FIXTURES,
		});
		const applied = await applyScenario(scenario, {
			repoRoot: sourceRepoRoot,
			installDeps: false,
		});

		expect(listWorktrees(sourceRepoRoot)).toContain(applied.workdir);
		expect(await pathExists(applied.workdir)).toBe(true);

		await applied.cleanup();

		expect(listWorktrees(sourceRepoRoot)).not.toContain(applied.workdir);
		expect(await pathExists(applied.workdir)).toBe(false);
	});

	test("malformed patch throws and leaves no worktree behind", async () => {
		const bogusRoot = await mkdtemp(join(tmpdir(), "mira-bogus-"));
		try {
			const dir = join(bogusRoot, "bogus");
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, "base.patch"), "this is not a valid patch\n");
			await writeFile(join(dir, "task.txt"), "task\n");
			await writeFile(join(dir, "success.sh"), "#!/bin/sh\nexit 0\n");

			const scenario = await loadScenario("bogus", {
				scenariosRoot: bogusRoot,
			});

			const before = listWorktrees(sourceRepoRoot);

			await expect(
				applyScenario(scenario, {
					repoRoot: sourceRepoRoot,
					installDeps: false,
				}),
			).rejects.toThrow(/base\.patch/);

			// No new worktree should have been registered, even though one was
			// briefly created during `git worktree add` (cleanup() runs before
			// the throw propagates).
			expect(listWorktrees(sourceRepoRoot)).toBe(before);
		} finally {
			await rm(bogusRoot, { recursive: true, force: true });
		}
	});

	test("installDeps: false skips bun install (no node_modules)", async () => {
		const scenario = await loadScenario("test-fixture", {
			scenariosRoot: COMMITTED_FIXTURES,
		});
		const applied = await applyScenario(scenario, {
			repoRoot: sourceRepoRoot,
			installDeps: false,
		});
		try {
			expect(await pathExists(join(applied.workdir, "node_modules"))).toBe(
				false,
			);
		} finally {
			await applied.cleanup();
		}
	});

	test("cleanup() is idempotent (calling twice does not throw)", async () => {
		const scenario = await loadScenario("test-fixture", {
			scenariosRoot: COMMITTED_FIXTURES,
		});
		const applied = await applyScenario(scenario, {
			repoRoot: sourceRepoRoot,
			installDeps: false,
		});

		await applied.cleanup();
		await applied.cleanup(); // must not throw
		expect(await pathExists(applied.workdir)).toBe(false);
	});

	test("after-suite invariant: source repo has no scenario worktrees left", async () => {
		// Smoke check that, after every prior applyScenario test, no orphan
		// worktree pointers remain in sourceRepoRoot/.git/worktrees/. This
		// catches a `cleanup()` regression where the worktree pointer survives
		// even though the workdir is rm'd. We match the scenario-workdir prefix
		// (`mira-eval-`), not all of tmpdir — the source repo itself lives
		// under tmpdir and is the primary worktree, which is expected to show.
		const list = listWorktrees(sourceRepoRoot);
		expect(list).not.toContain("mira-eval-");
	});
});

// Construct a Scenario object directly without touching disk for `loadScenario`.
// Useful when tests want to point at a specific success script under
// `__fixtures__/scripts/` without inventing a parallel scenarios directory.
function synthesizeScenario(
	input: Partial<Scenario> & { id: string },
): Scenario {
	const dir = input.dir ?? "/dev/null";
	return {
		id: input.id,
		dir,
		patchPath: input.patchPath ?? join(dir, "base.patch"),
		successPath: input.successPath ?? join(dir, "success.sh"),
		taskPath: input.taskPath ?? join(dir, "task.txt"),
		task: input.task ?? "synthesized scenario",
	};
}

const SCRIPTS_DIR = resolve(HERE, "__fixtures__", "scripts");

// First-experiment scenarios (`docs/eval/04-scenario-corpus.md`). The integration
// test exercises only the metadata + patch-apply layer — it does not run
// `success.sh`. That keeps the test cheap (no bun install, no full test
// suite per scenario) while still catching the most common regressions:
// a malformed `base.patch`, a missing required file, or a layout drift.
const REAL_SCENARIO_IDS = ["A1", "A2", "A3", "B1"] as const;

function discoverMiraRoot(): string {
	const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
		cwd: HERE,
		encoding: "utf8",
	});
	if ((r.status ?? -1) !== 0) {
		throw new Error("could not resolve mira repo root from eval/harness/");
	}
	return r.stdout.trim();
}

describe("real scenarios (A1, A2, A3, B1)", () => {
	let miraRoot: string;

	beforeAll(() => {
		miraRoot = discoverMiraRoot();
	});

	for (const id of REAL_SCENARIO_IDS) {
		test(`${id}: loadScenario + applyScenario succeed and clean up`, async () => {
			const scenario = await loadScenario(id);
			expect(scenario.id).toBe(id);
			expect(scenario.task.length).toBeGreaterThan(0);

			const applied = await applyScenario(scenario, {
				repoRoot: miraRoot,
				installDeps: false,
			});
			try {
				expect(await pathExists(applied.workdir)).toBe(true);
				expect(listWorktrees(miraRoot)).toContain(applied.workdir);
			} finally {
				await applied.cleanup();
			}
			expect(listWorktrees(miraRoot)).not.toContain(applied.workdir);
			expect(await pathExists(applied.workdir)).toBe(false);
		});
	}
});

describe("checkScenario", () => {
	let cwd: string;

	beforeAll(async () => {
		cwd = await mkdtemp(join(tmpdir(), "mira-check-test-"));
	});

	afterAll(async () => {
		if (cwd) await rm(cwd, { recursive: true, force: true });
	});

	test("canonical success.sh exits 0", async () => {
		const scenario = await loadScenario("test-fixture", {
			scenariosRoot: COMMITTED_FIXTURES,
		});
		const result = await checkScenario(cwd, scenario);
		expect(result.exitCode).toBe(0);
		expect(result.timedOut).toBe(false);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});

	test("non-zero exit propagates", async () => {
		const scenario = synthesizeScenario({
			id: "fail",
			dir: SCRIPTS_DIR,
			successPath: join(SCRIPTS_DIR, "success-fail.sh"),
		});
		const result = await checkScenario(cwd, scenario);
		expect(result.exitCode).toBe(1);
		expect(result.timedOut).toBe(false);
	});

	test("timeout kills slow script and reports timedOut: true, exitCode: -1", async () => {
		const scenario = synthesizeScenario({
			id: "slow",
			dir: SCRIPTS_DIR,
			successPath: join(SCRIPTS_DIR, "success-slow.sh"),
		});
		const result = await checkScenario(cwd, scenario, { timeoutMs: 200 });
		expect(result.timedOut).toBe(true);
		expect(result.exitCode).toBe(-1);
		expect(result.durationMs).toBeGreaterThanOrEqual(200);
		// Sanity: the actual sleep is 5s; the timeout must fire well before that.
		expect(result.durationMs).toBeLessThan(2_000);
	});

	test("cwd is the workdir (verified via pwd in stdout)", async () => {
		const scenario = synthesizeScenario({
			id: "pwd",
			dir: SCRIPTS_DIR,
			successPath: join(SCRIPTS_DIR, "success-pwd.sh"),
		});
		const result = await checkScenario(cwd, scenario);
		expect(result.exitCode).toBe(0);
		// Match by mkdtemp basename — robust to /var vs /private/var symlink
		// canonicalization on macOS.
		expect(result.stdout).toContain(basename(cwd));
	});
});
