import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";

import { runAgent } from "./agent.ts";
import { generateReport } from "./report.ts";
import { applyScenario, checkScenario, loadScenario } from "./scenario.ts";
import { makeBashTool } from "./tools/bash.ts";
import { grepTool } from "./tools/grep.ts";
import { createMiraMcpForAgent } from "./tools/mira-mcp.ts";
import { readTool } from "./tools/read.ts";
import { writeTool } from "./tools/write.ts";
import type {
	AgentConfig,
	HarnessTool,
	Mode,
	RunMetrics,
	TranscriptEvent,
} from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_ROOT = resolve(HERE, "..", "results");

const SMOKE_TASK =
	"Create a file named `hello.txt` in the current working directory whose exact contents are the string `hello world` (no newline at the end, no extra whitespace). When done, return a final answer.";
const SMOKE_EXPECTED = "hello world";

const SMOKE_CONFIG: AgentConfig = {
	model: "claude-sonnet-4-6",
	temperature: 0,
	maxTurns: 5,
	maxTokensPerTurn: 8192,
	tokenCap: 200_000,
	wallClockCapMs: 600_000,
	bashTimeoutMs: 60_000,
};

// Per-run defaults for the first experiment. Caps from
// docs/eval/05-first-experiment.md § Configuration.
const EXPERIMENT_CONFIG: AgentConfig = {
	model: "claude-sonnet-4-6",
	temperature: 0,
	maxTurns: 30,
	maxTokensPerTurn: 8192,
	tokenCap: 200_000,
	wallClockCapMs: 600_000,
	bashTimeoutMs: 60_000,
};

function timestampStamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

async function buildTools(
	mode: Mode,
	bashTimeoutMs: number,
): Promise<{ tools: HarnessTool[]; close: () => Promise<void> }> {
	const baseline: HarnessTool[] = [
		makeBashTool(bashTimeoutMs),
		readTool,
		writeTool,
		grepTool,
	];
	if (mode === "baseline") {
		return { tools: baseline, close: async () => {} };
	}
	const handle = await createMiraMcpForAgent();
	return {
		tools: [...baseline, ...handle.tools],
		close: handle.close,
	};
}

async function runSmokeMode(
	mode: Mode,
	resultsDir: string,
): Promise<{ success: boolean; harnessOk: boolean; reason?: string }> {
	const workdir = await mkdtemp(join(tmpdir(), `mira-eval-smoke-${mode}-`));
	const transcriptPath = join(resultsDir, `smoke-${mode}.jsonl`);
	const events: TranscriptEvent[] = [];
	const emit = (event: TranscriptEvent) => events.push(event);

	const { tools, close } = await buildTools(mode, SMOKE_CONFIG.bashTimeoutMs);

	let harnessOk = true;
	let harnessError: string | undefined;
	try {
		await runAgent({
			scenario: "smoke",
			mode,
			workdir,
			task: SMOKE_TASK,
			tools,
			config: SMOKE_CONFIG,
			emit,
			successCheck: async () => {
				try {
					const got = await readFile(join(workdir, "hello.txt"), "utf8");
					return got === SMOKE_EXPECTED;
				} catch {
					return false;
				}
			},
		});
	} catch (e) {
		harnessOk = false;
		harnessError = (e as Error).message;
	} finally {
		await close();
	}

	await writeFile(
		transcriptPath,
		`${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
		"utf8",
	);

	let success = false;
	try {
		const got = await readFile(join(workdir, "hello.txt"), "utf8");
		success = got === SMOKE_EXPECTED;
	} catch {
		success = false;
	}

	await rm(workdir, { recursive: true, force: true });

	return { success, harnessOk, reason: harnessError };
}

// Stable layout: each (scenario, mode, repeat) triple gets its own subdir under
// a single per-experiment timestamp. report.ts (PR 3) globs metrics.json files
// at this depth.
function runDirName(scenario: string, mode: Mode, repeat: number): string {
	return `${scenario}-${mode}-${repeat}`;
}

export type RunScenarioOptions = {
	scenariosRoot?: string;
	resultsRoot?: string;
	// Pass an existing timestamp to group multiple runs under the same dir.
	// Defaults to a fresh timestamp per call (smoke / single-shot use).
	resultsTimestamp?: string;
	repoRoot?: string;
	installDeps?: boolean;
	config?: AgentConfig;
	client?: Anthropic;
};

export type RunScenarioResult = {
	metrics: RunMetrics;
	resultsDir: string;
	transcriptPath: string;
	metricsPath: string;
};

export async function runScenario(
	scenarioId: string,
	mode: Mode,
	repeat: number,
	opts: RunScenarioOptions = {},
): Promise<RunScenarioResult> {
	const config = opts.config ?? EXPERIMENT_CONFIG;
	const stamp = opts.resultsTimestamp ?? timestampStamp();
	const resultsRoot = opts.resultsRoot ?? RESULTS_ROOT;
	const resultsDir = join(
		resultsRoot,
		stamp,
		runDirName(scenarioId, mode, repeat),
	);
	await mkdir(resultsDir, { recursive: true });

	const transcriptPath = join(resultsDir, "transcript.jsonl");
	const metricsPath = join(resultsDir, "metrics.json");

	const scenario = await loadScenario(scenarioId, {
		scenariosRoot: opts.scenariosRoot,
	});
	const applied = await applyScenario(scenario, {
		repoRoot: opts.repoRoot,
		installDeps: opts.installDeps,
	});

	const events: TranscriptEvent[] = [];
	const emit = (event: TranscriptEvent) => events.push(event);

	const { tools, close } = await buildTools(mode, config.bashTimeoutMs);

	try {
		const result = await runAgent({
			scenario: scenarioId,
			mode,
			workdir: applied.workdir,
			task: scenario.task,
			tools,
			config,
			emit,
			successCheck: async () => {
				const r = await checkScenario(applied.workdir, scenario);
				return r.exitCode === 0;
			},
			client: opts.client,
		});

		const metrics: RunMetrics = {
			scenario: scenarioId,
			mode,
			repeat,
			model: config.model,
			success: result.success,
			stopReason: result.stopReason,
			turns: result.turns,
			tokensInput: result.tokensInput,
			tokensOutput: result.tokensOutput,
			tokensTotal: result.tokensInput + result.tokensOutput,
			toolCalls: result.toolCalls,
			toolCallsByName: result.toolCallsByName,
			filesRead: result.filesRead,
			filesModified: result.filesModified,
			wallClockMs: result.wallClockMs,
		};

		await writeFile(
			transcriptPath,
			`${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
			"utf8",
		);
		await writeFile(
			metricsPath,
			`${JSON.stringify(metrics, null, 2)}\n`,
			"utf8",
		);

		return { metrics, resultsDir, transcriptPath, metricsPath };
	} finally {
		await close();
		await applied.cleanup();
	}
}

async function runScenarioFromCli(argv: string[]): Promise<void> {
	const id = argv[0];
	const modeArg = argv[1];
	if (!id || !modeArg) {
		console.error(
			"usage: bun harness/run.ts scenario <id> <baseline|mira> [--repeat N]",
		);
		process.exit(2);
	}
	if (modeArg !== "baseline" && modeArg !== "mira") {
		console.error(
			`scenario: mode must be "baseline" or "mira", got "${modeArg}"`,
		);
		process.exit(2);
	}

	let repeat = 1;
	const repeatFlag = argv.indexOf("--repeat");
	if (repeatFlag !== -1) {
		const v = Number(argv[repeatFlag + 1]);
		if (!Number.isFinite(v) || v < 1 || !Number.isInteger(v)) {
			console.error("scenario: --repeat must be a positive integer");
			process.exit(2);
		}
		repeat = v;
	}

	const { metrics, resultsDir } = await runScenario(id, modeArg, repeat);
	console.log(`[scenario] ${id}/${modeArg}/${repeat} → ${resultsDir}`);
	console.log(
		`[scenario] success=${metrics.success} turns=${metrics.turns} tokens=${metrics.tokensTotal} stopReason=${metrics.stopReason}`,
	);
	process.exit(metrics.success ? 0 : 1);
}

async function runSmoke(): Promise<void> {
	const stamp = timestampStamp();
	const resultsDir = join(RESULTS_ROOT, stamp);
	await mkdir(resultsDir, { recursive: true });

	console.log(`[smoke] results dir: ${resultsDir}`);

	const baseline = await runSmokeMode("baseline", resultsDir);
	console.log(
		`[smoke] baseline: harnessOk=${baseline.harnessOk} fileCorrect=${baseline.success}` +
			(baseline.reason ? ` error=${baseline.reason}` : ""),
	);

	const mira = await runSmokeMode("mira", resultsDir);
	console.log(
		`[smoke] mira:     harnessOk=${mira.harnessOk} fileCorrect=${mira.success}` +
			(mira.reason ? ` error=${mira.reason}` : ""),
	);

	const allGreen =
		baseline.harnessOk && baseline.success && mira.harnessOk && mira.success;
	if (!allGreen) {
		console.error(
			"[smoke] FAILED — see transcript JSONL files in the results dir.",
		);
		process.exit(1);
	}
	console.log("[smoke] OK");
}

async function runReportFromCli(argv: string[]): Promise<void> {
	const dir = argv[0];
	if (!dir) {
		console.error("usage: bun harness/run.ts report <resultsDir>");
		process.exit(2);
	}
	const resolved = resolve(dir);
	await generateReport(resolved);
	console.log(`[report] wrote ${join(resolved, "summary.md")}`);
}

// Only dispatch CLI when invoked as a script — importing run.ts (e.g. from
// run.test.ts) must not exit the process.
if (import.meta.main) {
	const subcommand = process.argv[2];
	if (subcommand === "smoke") {
		await runSmoke();
	} else if (subcommand === "scenario") {
		await runScenarioFromCli(process.argv.slice(3));
	} else if (subcommand === "report") {
		await runReportFromCli(process.argv.slice(3));
	} else {
		console.error(
			"usage:\n  bun harness/run.ts smoke\n  bun harness/run.ts scenario <id> <baseline|mira> [--repeat N]\n  bun harness/run.ts report <resultsDir>",
		);
		process.exit(2);
	}
}
