import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import type { CommandObservation } from "../../core/command-observation.ts";
import type { CommandRun } from "../../core/command-run.ts";
import { miraError } from "../errors.ts";
import { validateProjectRoot } from "../project-root.ts";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export const listRecentRunsInputShape = {
	projectRoot: z
		.string()
		.describe("Absolute path to the project root that owns the .mira/ store."),
	limit: z
		.number()
		.int()
		.optional()
		.describe(
			`Maximum number of runs to return. Default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.`,
		),
};

export type ListRecentRunsInput = {
	projectRoot: string;
	limit?: number;
};

export type RecentRunRow = {
	id: string;
	command: string;
	status: "success" | "failure";
	exitCode: number | null;
	signal?: string;
	killedByTimeout: boolean;
	durationMs: number;
	startedAt: string;
};

export type ListRecentRunsOutput = {
	runs: RecentRunRow[];
};

// Wraps the Evidence Store. Returns a slim projection of recent observations
// for browsing — not a substitute for `get_observation`. Each row mirrors
// fields already present on `CommandObservation`/`CommandRun`; ADR 0006
// forbids introducing a new field here. `startedAt` lives on `CommandRun`
// only, so each row is hydrated from both `observation.json` and
// `metadata.json` of the same run dir.
export async function runListRecentRunsTool(
	input: ListRecentRunsInput,
): Promise<ListRecentRunsOutput> {
	const projectRoot = validateProjectRoot(input.projectRoot);
	const limit = resolveLimit(input.limit);

	const runsDir = join(projectRoot, ".mira", "runs");
	if (!existsSync(runsDir)) return { runs: [] };

	// Run-ids start with `run_` followed by an ISO-8601-compact timestamp, so
	// reverse-lex sort = newest-first. Skip any dir without a complete pair of
	// `observation.json` + `metadata.json`; that mirrors `listRecentObservations`'
	// "skip incomplete dirs" behaviour and prevents the response from including
	// rows that `get_observation` would refuse to serve.
	const entries = readdirSync(runsDir).sort().reverse();
	const runs: RecentRunRow[] = [];
	for (const id of entries) {
		if (runs.length >= limit) break;
		const obsPath = join(runsDir, id, "observation.json");
		const metaPath = join(runsDir, id, "metadata.json");
		if (!existsSync(obsPath) || !existsSync(metaPath)) continue;

		let observation: CommandObservation;
		let run: CommandRun;
		try {
			observation = JSON.parse(
				readFileSync(obsPath, "utf8"),
			) as CommandObservation;
			run = JSON.parse(readFileSync(metaPath, "utf8")) as CommandRun;
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			throw miraError("INTERNAL", `failed to read run ${id}: ${message}`);
		}

		runs.push({
			id: observation.id,
			command: observation.command,
			status: observation.status,
			exitCode: observation.exitCode,
			...(observation.signal !== undefined
				? { signal: observation.signal }
				: {}),
			killedByTimeout: observation.killedByTimeout,
			durationMs: observation.durationMs,
			startedAt: run.startedAt,
		});
	}

	return { runs };
}

function resolveLimit(raw: number | undefined): number {
	if (raw === undefined) return DEFAULT_LIMIT;
	if (typeof raw !== "number" || !Number.isInteger(raw)) {
		throw miraError("INVALID_INPUT", `limit must be an integer; got ${raw}`);
	}
	if (raw < 1) {
		throw miraError("INVALID_INPUT", `limit must be >= 1; got ${raw}`);
	}
	if (raw > MAX_LIMIT) {
		throw miraError(
			"INVALID_INPUT",
			`limit must be <= ${MAX_LIMIT}; got ${raw}`,
		);
	}
	return raw;
}
