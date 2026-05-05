import { join } from "node:path";

import { CommandObserver } from "../command/command-observer.ts";
import { buildObservation } from "../core/command-observation.ts";
import { FileEvidenceStore } from "../store/evidence-store.ts";
import { renderObservationMd } from "./render-observation.ts";

export async function runCommand(args: string[]): Promise<number> {
	const command = args.join(" ").trim();
	if (!command) {
		process.stderr.write('usage: mira run "<command>"\n');
		return 2;
	}

	const cwd = process.cwd();
	const store = new FileEvidenceStore(cwd);
	const observer = new CommandObserver(store);

	const { run, stdout, stderr } = await observer.observe(command, cwd);

	const metadataPath = join(store.runDir(run.id), "metadata.json");
	const observation = buildObservation(run, metadataPath);
	store.writeObservationJson(run.id, observation);
	store.writeObservationMarkdown(run.id, renderObservationMd(observation, run));

	if (stdout) process.stdout.write(stdout);
	if (stderr) process.stderr.write(stderr);

	process.stderr.write(
		`[mira] ${run.id} · ${observation.status} · exit ${run.exitCode} · ${run.durationMs}ms · .mira/runs/${run.id}/\n`,
	);

	return run.exitCode;
}
