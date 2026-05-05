import { dirname } from "node:path";

import { senseArchitecture } from "../architecture/sense.ts";
import { buildContextPack } from "../context/context-pack-generator.ts";
import { FileEvidenceStore } from "../store/evidence-store.ts";
import { renderContextMd } from "./render-context.ts";

const MAX_OBSERVATIONS = 10;

export async function runContext(args: string[]): Promise<number> {
	const task = args.join(" ").trim();
	if (!task) {
		process.stderr.write('usage: mira context "<task>"\n');
		return 2;
	}

	const cwd = process.cwd();
	const store = new FileEvidenceStore(cwd);

	const observations = store.listRecentObservations(MAX_OBSERVATIONS);
	const architectureSignals = await senseArchitecture(cwd);
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

	process.stderr.write(
		`[mira] ${contextId} · ${observations.length} observations · .mira/context/${contextId}.json\n`,
	);

	return 0;
}
