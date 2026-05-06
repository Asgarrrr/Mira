// Scenario format + apply/check primitives for the eval harness.
// Spec: docs/eval/05-first-experiment.md § sub-task ii.

import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCENARIOS_ROOT = resolve(HERE, "..", "scenarios");

export type Scenario = {
	readonly id: string;
	readonly dir: string;
	readonly patchPath: string;
	readonly successPath: string;
	readonly taskPath: string;
	readonly task: string;
};

export type LoadScenarioOptions = {
	scenariosRoot?: string;
};

async function pathExists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

export async function loadScenario(
	id: string,
	opts: LoadScenarioOptions = {},
): Promise<Scenario> {
	if (typeof id !== "string" || id.length === 0) {
		throw new Error("loadScenario: id must be a non-empty string");
	}

	const root = opts.scenariosRoot
		? isAbsolute(opts.scenariosRoot)
			? opts.scenariosRoot
			: resolve(process.cwd(), opts.scenariosRoot)
		: DEFAULT_SCENARIOS_ROOT;

	const dir = join(root, id);
	if (!(await pathExists(dir))) {
		throw new Error(
			`loadScenario("${id}"): scenario directory not found at ${dir}`,
		);
	}

	const patchPath = join(dir, "base.patch");
	const successPath = join(dir, "success.sh");
	const taskPath = join(dir, "task.txt");

	const required: Array<readonly [string, string]> = [
		["base.patch", patchPath],
		["success.sh", successPath],
		["task.txt", taskPath],
	];
	for (const [name, p] of required) {
		if (!(await pathExists(p))) {
			throw new Error(`loadScenario("${id}"): missing ${name} at ${p}`);
		}
	}

	const task = (await readFile(taskPath, "utf8")).trim();
	if (task.length === 0) {
		throw new Error(`loadScenario("${id}"): task.txt is empty at ${taskPath}`);
	}

	return { id, dir, patchPath, successPath, taskPath, task };
}

export type ApplyScenarioOptions = {
	repoRoot?: string;
	installDeps?: boolean;
};

export type AppliedScenario = {
	readonly workdir: string;
	readonly cleanup: () => Promise<void>;
};

function runGit(
	args: string[],
	cwd?: string,
): { status: number; stdout: string; stderr: string } {
	const r = spawnSync("git", args, { encoding: "utf8", cwd });
	return {
		status: r.status ?? -1,
		stdout: r.stdout ?? "",
		stderr: r.stderr ?? "",
	};
}

function describeFailure(result: {
	status: number;
	stdout: string;
	stderr: string;
}): string {
	const msg = (result.stderr || result.stdout || "").trim();
	return msg.length > 0 ? msg : `exit ${result.status}`;
}

function discoverRepoRoot(): string {
	const r = runGit(["rev-parse", "--show-toplevel"], process.cwd());
	if (r.status !== 0) {
		throw new Error(
			`applyScenario: cannot discover repoRoot via 'git rev-parse --show-toplevel' from ${process.cwd()}: ${describeFailure(r)}`,
		);
	}
	return r.stdout.trim();
}

export async function applyScenario(
	scenario: Scenario,
	opts: ApplyScenarioOptions = {},
): Promise<AppliedScenario> {
	const repoRoot = opts.repoRoot ?? discoverRepoRoot();
	const installDeps = opts.installDeps ?? true;

	const workdir = await mkdtemp(join(tmpdir(), `mira-eval-${scenario.id}-`));

	let cleanedUp = false;
	const cleanup = async (): Promise<void> => {
		if (cleanedUp) return;
		cleanedUp = true;
		// Best-effort: prune the worktree pointer in repoRoot/.git/worktrees/.
		// If add never succeeded, this is a no-op. Errors here are swallowed —
		// the rm below is the source of truth for "directory is gone".
		runGit(["-C", repoRoot, "worktree", "remove", "--force", workdir]);
		await rm(workdir, { recursive: true, force: true });
	};

	const wtAdd = runGit([
		"-C",
		repoRoot,
		"worktree",
		"add",
		"--detach",
		workdir,
		"HEAD",
	]);
	if (wtAdd.status !== 0) {
		await cleanup();
		throw new Error(
			`applyScenario("${scenario.id}"): git worktree add failed for ${workdir}: ${describeFailure(wtAdd)}`,
		);
	}

	const check = runGit(["-C", workdir, "apply", "--check", scenario.patchPath]);
	if (check.status !== 0) {
		await cleanup();
		throw new Error(
			`applyScenario("${scenario.id}"): patch fails --check at ${scenario.patchPath}: ${describeFailure(check)}`,
		);
	}

	const apply = runGit(["-C", workdir, "apply", scenario.patchPath]);
	if (apply.status !== 0) {
		await cleanup();
		throw new Error(
			`applyScenario("${scenario.id}"): git apply failed at ${scenario.patchPath}: ${describeFailure(apply)}`,
		);
	}

	if (installDeps) {
		const inst = spawnSync("bun", ["install"], {
			cwd: workdir,
			encoding: "utf8",
		});
		if ((inst.status ?? -1) !== 0) {
			await cleanup();
			throw new Error(
				`applyScenario("${scenario.id}"): bun install failed in ${workdir}: ${describeFailure({ status: inst.status ?? -1, stdout: inst.stdout ?? "", stderr: inst.stderr ?? "" })}`,
			);
		}
	}

	return { workdir, cleanup };
}

export type CheckScenarioOptions = {
	timeoutMs?: number;
};

export type CheckScenarioResult = {
	readonly exitCode: number;
	readonly timedOut: boolean;
	readonly stdout: string;
	readonly stderr: string;
	readonly durationMs: number;
};

const DEFAULT_CHECK_TIMEOUT_MS = 120_000;

export async function checkScenario(
	workdir: string,
	scenario: Scenario,
	opts: CheckScenarioOptions = {},
): Promise<CheckScenarioResult> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
	const startedAt = Date.now();

	// `detached: true` puts the script in a new process group so we can SIGKILL
	// the whole tree on timeout via `process.kill(-pid, ...)`. Without it, a
	// success.sh that forks (`bun test`, `tsc`, etc.) would orphan its children
	// and keep stdout/stderr pipes open past `proc.kill()` — blocking the
	// readers exactly like the H1 pre-fix observer in src/command/.
	return new Promise((resolveResult) => {
		const proc = spawn("/bin/sh", [scenario.successPath], {
			cwd: workdir,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});

		let timedOut = false;
		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (d: Buffer) => {
			stdout += d.toString("utf8");
		});
		proc.stderr.on("data", (d: Buffer) => {
			stderr += d.toString("utf8");
		});

		const timer = setTimeout(() => {
			timedOut = true;
			if (proc.pid !== undefined) {
				try {
					process.kill(-proc.pid, "SIGKILL");
				} catch {
					// Process group already exited — race between timer and natural end.
				}
			}
		}, timeoutMs);

		proc.on("close", (code) => {
			clearTimeout(timer);
			const durationMs = Date.now() - startedAt;
			const exitCode = timedOut ? -1 : (code ?? -1);
			resolveResult({ exitCode, timedOut, stdout, stderr, durationMs });
		});

		proc.on("error", (err) => {
			clearTimeout(timer);
			const durationMs = Date.now() - startedAt;
			resolveResult({
				exitCode: -1,
				timedOut: false,
				stdout,
				stderr: `${stderr}\nspawn error: ${err.message}`,
				durationMs,
			});
		});
	});
}
