export type CommandRun = {
	id: string;
	command: string;
	cwd: string;
	startedAt: string;
	durationMs: number;
	exitCode: number | null;
	signal?: string;
	killedByTimeout: boolean;
	stdoutPath: string;
	stderrPath: string;
	combinedPath: string;
	metadataPath: string;
};
