import { basename } from "node:path";

import type { CommandObservation } from "../core/command-observation.ts";
import type { CommandRun } from "../core/command-run.ts";

export function renderObservationMd(
	observation: CommandObservation,
	run: CommandRun,
): string {
	const lines: string[] = [
		`# Run ${observation.runId}`,
		"",
		`- **Command:** \`${observation.command}\``,
		`- **Status:** ${observation.status}`,
		`- **Exit code:** ${observation.exitCode}`,
		`- **Duration:** ${observation.durationMs}ms`,
		`- **Started at:** ${run.startedAt}`,
		"",
		"## Summary",
		"",
		observation.summary,
		"",
		"## Evidence",
		"",
	];

	for (const ref of observation.evidenceRefs) {
		lines.push(`- [${ref.kind}](./${basename(ref.path)})`);
	}

	lines.push("");
	return lines.join("\n");
}
