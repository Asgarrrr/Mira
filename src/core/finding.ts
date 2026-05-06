import { z } from "zod";

import { evidenceRefSchema } from "./evidence.ts";

export const evidenceExcerptSchema = z.object({
	ref: evidenceRefSchema,
	lineStart: z.number().optional(),
	lineEnd: z.number().optional(),
	text: z.string(),
});
export type EvidenceExcerpt = z.infer<typeof evidenceExcerptSchema>;

export const findingSchema = z.object({
	id: z.string(),
	severity: z.enum(["info", "warning", "error"]),
	title: z.string(),
	description: z.string(),
	excerpts: z.array(evidenceExcerptSchema),
	evidenceRefs: z.array(evidenceRefSchema),
	relatedFiles: z.array(z.string()).optional(),
});
export type Finding = z.infer<typeof findingSchema>;
