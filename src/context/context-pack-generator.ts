import type { CommandObservation } from "../core/command-observation.ts";
import type { ContextPack } from "../core/context-pack.ts";
import type { EvidenceRef } from "../core/evidence.ts";

export type BuildContextPackInput = {
	id: string;
	task: string;
	createdAt: string;
	observations: CommandObservation[]; // newest first
};

export function buildContextPack(input: BuildContextPackInput): ContextPack {
	const { id, task, createdAt, observations } = input;

	const succeeded = observations.filter((o) => o.status === "success").length;
	const failed = observations.length - succeeded;

	const evidenceRefs: EvidenceRef[] = [];
	for (const obs of observations) {
		const metadataRef = obs.evidenceRefs.find((r) => r.kind === "metadata");
		if (metadataRef) evidenceRefs.push(metadataRef);
	}

	const seen = new Set<string>();
	const verificationCommands: string[] = [];
	for (const obs of observations) {
		if (obs.status !== "success") continue;
		if (seen.has(obs.command)) continue;
		seen.add(obs.command);
		verificationCommands.push(obs.command);
	}

	return {
		id,
		task,
		createdAt,
		summary: `Context pack for \`${task}\` based on ${observations.length} recent observations (${succeeded} succeeded, ${failed} failed).`,
		observationIds: observations.map((o) => o.id),
		evidenceRefs,
		suspectedFiles: [],
		verificationCommands,
		risks: [],
		nextRecommendedAction: "",
	};
}
