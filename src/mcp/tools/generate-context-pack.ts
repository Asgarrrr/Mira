import { dirname } from "node:path";

import { z } from "zod";

import { senseArchitecture } from "../../architecture/sense.ts";
import { buildContextPack } from "../../context/context-pack-generator.ts";
import type { ContextPack } from "../../core/context-pack.ts";
import { renderContextMd } from "../../render/render-context.ts";
import { FileEvidenceStore } from "../../store/evidence-store.ts";
import { miraError } from "../errors.ts";
import { validateProjectRoot } from "../project-root.ts";

const MAX_OBSERVATIONS = 10;

export const generateContextPackInputShape = {
	task: z.string().describe("Free-text task description; may be empty."),
	projectRoot: z
		.string()
		.describe(
			"Absolute path to the project root. Forwarded to senseArchitecture; never inferred from process.cwd().",
		),
};

export type GenerateContextPackInput = {
	task: string;
	projectRoot: string;
};

export type GenerateContextPackOutput = {
	pack: ContextPack;
};

// Wraps the Context Kernel. Equivalent to `mira context "<task>"` invoked in
// `projectRoot`. Last-10 selection (V0.1, ADR 0004) and architecture sensing
// (V0.2, ADR 0005) are inherited from the kernel — the cap of 20 paths in
// `suspectedFiles` is enforced by `buildContextPack` and never re-paginated
// here. An empty observation set is a valid empty pack, not an error.
export async function runGenerateContextPackTool(
	input: GenerateContextPackInput,
): Promise<GenerateContextPackOutput> {
	const projectRoot = validateProjectRoot(input.projectRoot);
	const task = typeof input.task === "string" ? input.task : "";

	const store = new FileEvidenceStore(projectRoot);
	let observations: Awaited<
		ReturnType<FileEvidenceStore["listRecentObservations"]>
	>;
	try {
		observations = store.listRecentObservations(MAX_OBSERVATIONS);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		throw miraError(
			"INTERNAL",
			`failed to read recent observations: ${message}`,
		);
	}

	let architectureSignals: Awaited<ReturnType<typeof senseArchitecture>>;
	try {
		architectureSignals = await senseArchitecture(projectRoot);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		throw miraError("INTERNAL", `architecture sensing failed: ${message}`);
	}

	let contextId: string;
	let mdPath: string;
	try {
		({ contextId, mdPath } = store.createContext());
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		throw miraError("INTERNAL", `failed to create context dir: ${message}`);
	}

	const pack = buildContextPack({
		id: contextId,
		task,
		createdAt: new Date().toISOString(),
		observations,
		architectureSignals,
	});

	try {
		store.writeContextJson(contextId, pack);
		store.writeContextMarkdown(
			contextId,
			renderContextMd(pack, dirname(mdPath)),
		);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		throw miraError(
			"INTERNAL",
			`failed to persist context pack ${contextId}: ${message}`,
		);
	}

	return { pack };
}
