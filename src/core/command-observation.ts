import type { CommandRun } from "./command-run.ts";
import type { EvidenceRef } from "./evidence.ts";
import type { Finding } from "./finding.ts";

export type CommandObservation = {
	id: string;
	runId: string;
	command: string;
	status: "success" | "failure";
	exitCode: number;
	durationMs: number;
	summary: string;
	findings: Finding[];
	relatedFiles: string[];
	suggestedNextActions: string[];
	verificationHints: string[];
	evidenceRefs: EvidenceRef[];
};

export function buildObservation(
	run: CommandRun,
	metadataPath: string,
): CommandObservation {
	const status: CommandObservation["status"] =
		run.exitCode === 0 ? "success" : "failure";
	const verb = status === "success" ? "exited" : "failed";
	const summary = `\`${run.command}\` ${verb} with code ${run.exitCode} in ${run.durationMs}ms`;

	const evidenceRefs: EvidenceRef[] = [
		{ path: run.stdoutPath, kind: "stdout" },
		{ path: run.stderrPath, kind: "stderr" },
		{ path: run.combinedPath, kind: "combined" },
		{ path: metadataPath, kind: "metadata" },
	];

	return {
		id: run.id,
		runId: run.id,
		command: run.command,
		status,
		exitCode: run.exitCode,
		durationMs: run.durationMs,
		summary,
		findings: [],
		relatedFiles: [],
		suggestedNextActions: [],
		verificationHints: [],
		evidenceRefs,
	};
}
