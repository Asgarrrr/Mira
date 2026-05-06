import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runAgent } from "./agent.ts";
import { makeBashTool } from "./tools/bash.ts";
import { grepTool } from "./tools/grep.ts";
import { createMiraMcpForAgent } from "./tools/mira-mcp.ts";
import { readTool } from "./tools/read.ts";
import { writeTool } from "./tools/write.ts";
import type {
	AgentConfig,
	HarnessTool,
	Mode,
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

const subcommand = process.argv[2];
if (subcommand === "smoke") {
	await runSmoke();
} else {
	console.error("usage: bun harness/run.ts smoke");
	process.exit(2);
}
