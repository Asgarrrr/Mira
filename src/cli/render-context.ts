import { relative } from "node:path";

import type { ContextPack } from "../core/context-pack.ts";

export function renderContextMd(pack: ContextPack, contextDir: string): string {
	const lines: string[] = [
		`# Context ${pack.id}`,
		"",
		`- **Task:** \`${pack.task}\``,
		`- **Created at:** ${pack.createdAt}`,
		`- **Observations:** ${pack.observationIds.length}`,
		"",
		"## Summary",
		"",
		pack.summary,
		"",
		"## Observations",
		"",
	];

	if (pack.observationIds.length === 0) {
		lines.push("_No recent observations._");
	} else {
		for (const id of pack.observationIds) lines.push(`- ${id}`);
	}

	lines.push("", "## Evidence", "");
	if (pack.evidenceRefs.length === 0) {
		lines.push("_No evidence._");
	} else {
		for (const ref of pack.evidenceRefs) {
			lines.push(`- [${ref.kind}](${relative(contextDir, ref.path)})`);
		}
	}

	if (pack.verificationCommands.length > 0) {
		lines.push("", "## Verification commands", "");
		for (const cmd of pack.verificationCommands) lines.push(`- \`${cmd}\``);
	}

	lines.push("");
	return lines.join("\n");
}
