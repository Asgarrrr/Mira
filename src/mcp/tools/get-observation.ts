import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import type { CommandObservation } from "../../core/command-observation.ts";
import { miraError } from "../errors.ts";
import { validateProjectRoot } from "../project-root.ts";

export const getObservationInputShape = {
	observationId: z
		.string()
		.describe(
			"Observation id (equals run-id in V0). Format: run_<timestamp>_<random6>.",
		),
	projectRoot: z
		.string()
		.describe("Absolute path to the project root that owns the .mira/ store."),
};

export type GetObservationInput = {
	observationId: string;
	projectRoot: string;
};

export type GetObservationOutput = {
	observation: CommandObservation;
};

// Wraps the Evidence Store. Loads `.mira/runs/<observationId>/observation.json`
// under `projectRoot` and returns it verbatim. ADR 0006: ArchitectureSignal[]
// is never returned by this tool — the persisted observation does not carry
// signals (ADR 0005 invariant).
export async function runGetObservationTool(
	input: GetObservationInput,
): Promise<GetObservationOutput> {
	const projectRoot = validateProjectRoot(input.projectRoot);
	const observationId = input.observationId;
	if (typeof observationId !== "string" || observationId.length === 0) {
		throw miraError("NOT_FOUND", "observationId must be a non-empty string");
	}
	// Run dir names are produced by `generateRunId()` and only contain
	// `[A-Za-z0-9_]`. A traversal-style id (`..`, slashes, backslashes) cannot
	// match a real run dir, so we treat it as NOT_FOUND rather than letting
	// the resolution step probe the filesystem outside `.mira/runs/`.
	if (!/^[A-Za-z0-9_]+$/.test(observationId)) {
		throw miraError("NOT_FOUND", `observation not found: ${observationId}`);
	}

	const path = join(
		projectRoot,
		".mira",
		"runs",
		observationId,
		"observation.json",
	);
	if (!existsSync(path)) {
		throw miraError("NOT_FOUND", `observation not found: ${observationId}`);
	}

	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		throw miraError(
			"INTERNAL",
			`failed to read observation ${observationId}: ${message}`,
		);
	}

	let observation: CommandObservation;
	try {
		observation = JSON.parse(raw) as CommandObservation;
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		throw miraError(
			"INTERNAL",
			`malformed observation ${observationId}: ${message}`,
		);
	}

	return { observation };
}
