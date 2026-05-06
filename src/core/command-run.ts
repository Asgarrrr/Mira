import { z } from "zod";

export const commandRunSchema = z.object({
	id: z.string(),
	command: z.string(),
	cwd: z.string(),
	startedAt: z.string(),
	durationMs: z.number(),
	exitCode: z.number().nullable(),
	signal: z.string().optional(),
	killedByTimeout: z.boolean(),
	stdoutPath: z.string(),
	stderrPath: z.string(),
	combinedPath: z.string(),
	metadataPath: z.string(),
});
export type CommandRun = z.infer<typeof commandRunSchema>;
