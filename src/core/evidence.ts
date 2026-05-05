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
