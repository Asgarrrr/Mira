import type { EvidenceRef } from "./evidence.ts";

export type ContextPack = {
	id: string;
	task: string;
	createdAt: string;
	summary: string;
	observationIds: string[];
	evidenceRefs: EvidenceRef[];
	suspectedFiles: string[];
	verificationCommands: string[];
	risks: string[];
	nextRecommendedAction: string;
};
