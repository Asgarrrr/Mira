import type { EvidenceRef } from "./evidence.ts";

export type EvidenceExcerpt = {
	ref: EvidenceRef;
	lineStart?: number;
	lineEnd?: number;
	text: string;
};

export type Finding = {
	id: string;
	severity: "info" | "warning" | "error";
	title: string;
	description: string;
	excerpts: EvidenceExcerpt[];
	evidenceRefs: EvidenceRef[];
	relatedFiles?: string[];
};
