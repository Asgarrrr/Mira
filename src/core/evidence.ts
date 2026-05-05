// Logical category of evidence. Independent of file format on disk:
// a run produces one logical "observation" that is materialized as both
// observation.json and observation.md; both share `kind: "observation"`.
// Storage filenames live in the FileEvidenceStore, not here.
export type EvidenceKind =
	| "stdout"
	| "stderr"
	| "combined"
	| "metadata"
	| "observation"
	| "context"
	| "other";

export type Evidence = {
	path: string;
	kind: EvidenceKind;
	bytes: number;
	createdAt: string;
	runId?: string;
	contextId?: string;
};

export type EvidenceRef = {
	path: string;
	kind: EvidenceKind;
	description?: string;
};
