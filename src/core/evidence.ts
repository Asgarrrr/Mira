import { z } from "zod";

// Logical category of evidence. Independent of file format on disk:
// a run produces one logical "observation" that is materialized as both
// observation.json and observation.md; both share `kind: "observation"`.
// Storage filenames live in the FileEvidenceStore, not here.
export const evidenceKindSchema = z.enum([
	"stdout",
	"stderr",
	"combined",
	"metadata",
	"observation",
	"context",
	"other",
]);
export type EvidenceKind = z.infer<typeof evidenceKindSchema>;

export const evidenceRefSchema = z.object({
	path: z.string(),
	kind: evidenceKindSchema,
	description: z.string().optional(),
});
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

// `Evidence` describes the evidence-listing record (returned by future
// store-listing APIs). It is not persisted as JSON anywhere in V0/V0.1/
// V0.2/V0.3, so no schema is defined for it — when a future read path
// needs runtime validation, add it here following the same pattern.
export type Evidence = {
	path: string;
	kind: EvidenceKind;
	bytes: number;
	createdAt: string;
	runId?: string;
	contextId?: string;
};
