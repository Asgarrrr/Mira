import { basename } from "node:path";

import type { CommandObservation } from "../core/command-observation.ts";
import type { CommandRun } from "../core/command-run.ts";

export function renderObservationMd(
	observation: CommandObservation,
	run: CommandRun,
): string {
	const exitCodeLabel =
		observation.exitCode === null ? "n/a" : String(observation.exitCode);

	const lines: string[] = [
		`# Run ${observation.runId}`,
		"",
		`- **Command:** \`${observation.command}\``,
		`- **Status:** ${observation.status}`,
		`- **Exit code:** ${exitCodeLabel}`,
	];

	if (observation.signal) {
		lines.push(`- **Signal:** ${observation.signal}`);
	}
	if (observation.killedByTimeout) {
		lines.push("- **Timed out:** yes");
	}

	lines.push(
		`- **Duration:** ${observation.durationMs}ms`,
		`- **Started at:** ${run.startedAt}`,
		"",
		"## Summary",
		"",
		observation.summary,
		"",
		"## Evidence",
		"",
	);

	for (const ref of observation.evidenceRefs) {
		lines.push(`- [${ref.kind}](./${basename(ref.path)})`);
	}

	lines.push("");
	return lines.join("\n");
}
