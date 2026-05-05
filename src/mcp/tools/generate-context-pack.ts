import { dirname } from "node:path";

import { z } from "zod";

import { senseArchitecture } from "../../architecture/sense.ts";
import { renderContextMd } from "../../cli/render-context.ts";
import { buildContextPack } from "../../context/context-pack-generator.ts";
import type { ContextPack } from "../../core/context-pack.ts";
import { FileEvidenceStore } from "../../store/evidence-store.ts";
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
	const observations = store.listRecentObservations(MAX_OBSERVATIONS);
	const architectureSignals = await senseArchitecture(projectRoot);
	const { contextId, mdPath } = store.createContext();

	const pack = buildContextPack({
		id: contextId,
		task,
		createdAt: new Date().toISOString(),
		observations,
		architectureSignals,
	});

	store.writeContextJson(contextId, pack);
	store.writeContextMarkdown(contextId, renderContextMd(pack, dirname(mdPath)));

	return { pack };
}
