import type { CommandRun } from "./command-run.ts";
import type { EvidenceRef } from "./evidence.ts";
import type { Finding } from "./finding.ts";

export type CommandObservation = {
	id: string;
	runId: string;
	command: string;
	status: "success" | "failure";
	exitCode: number | null;
	signal?: string;
	killedByTimeout: boolean;
	durationMs: number;
	summary: string;
	findings: Finding[];
	relatedFiles: string[];
	suggestedNextActions: string[];
	verificationHints: string[];
	evidenceRefs: EvidenceRef[];
};

export function buildObservation(run: CommandRun): CommandObservation {
	const status: CommandObservation["status"] =
		run.exitCode === 0 ? "success" : "failure";

	const evidenceRefs: EvidenceRef[] = [
		{ path: run.stdoutPath, kind: "stdout" },
		{ path: run.stderrPath, kind: "stderr" },
		{ path: run.combinedPath, kind: "combined" },
		{ path: run.metadataPath, kind: "metadata" },
	];

	return {
		id: run.id,
		runId: run.id,
		command: run.command,
		status,
		exitCode: run.exitCode,
		...(run.signal !== undefined ? { signal: run.signal } : {}),
		killedByTimeout: run.killedByTimeout,
		durationMs: run.durationMs,
		summary: buildSummary(run),
		findings: [],
		relatedFiles: [],
		suggestedNextActions: [],
		verificationHints: [],
		evidenceRefs,
	};
}

function buildSummary(run: CommandRun): string {
	const cmd = `\`${run.command}\``;
	if (run.killedByTimeout) {
		const sig = run.signal ?? "SIGKILL";
		return `${cmd} killed by timeout after ${run.durationMs}ms (${sig})`;
	}
	if (run.exitCode === null) {
		return run.signal
			? `${cmd} killed by ${run.signal} after ${run.durationMs}ms`
			: `${cmd} exited with unknown status after ${run.durationMs}ms`;
	}
	const verb = run.exitCode === 0 ? "exited" : "failed";
	return `${cmd} ${verb} with code ${run.exitCode} in ${run.durationMs}ms`;
}
