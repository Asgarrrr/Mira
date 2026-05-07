import { z } from "zod";

import type { CommandRun } from "./command-run.ts";
import { evidenceRefSchema } from "./evidence.ts";
import { findingSchema } from "./finding.ts";

// Runtime shape check for persisted observation.json. The schema mirrors the
// fields that `buildObservation` produces, so today's writes round-trip
// unchanged. M1: read paths parse against this schema before returning to
// agents — a JSON-valid-but-wrong-shape blob is rejected instead of silently
// surfacing as a `CommandObservation` (audit/05). Sub-schemas for
// `EvidenceRef` and `Finding` live with their own types in `evidence.ts` and
// `finding.ts`.
export const commandObservationSchema = z.object({
	id: z.string(),
	runId: z.string(),
	command: z.string(),
	status: z.enum(["success", "failure"]),
	exitCode: z.number().nullable(),
	signal: z.string().optional(),
	killedByTimeout: z.boolean(),
	durationMs: z.number(),
	summary: z.string(),
	findings: z.array(findingSchema),
	relatedFiles: z.array(z.string()),
	suggestedNextActions: z.array(z.string()),
	verificationHints: z.array(z.string()),
	evidenceRefs: z.array(evidenceRefSchema),
	// Set when a registered filter rendered the agent-facing markdown for this
	// run; the value is the filter's `<program>/<schema-version>` tag (e.g.
	// `"tsc/1"`). Unset on filter miss or on pre-V0.4 evidence — the field is
	// optional so existing observations round-trip unchanged.
	filterVersion: z.string().optional(),
});

export type CommandObservation = z.infer<typeof commandObservationSchema>;

export function buildObservation(run: CommandRun): CommandObservation {
	const status: CommandObservation["status"] =
		run.exitCode === 0 ? "success" : "failure";

	const evidenceRefs: CommandObservation["evidenceRefs"] = [
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
