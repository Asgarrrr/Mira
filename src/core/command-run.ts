export type CommandRun = {
	id: string;
	command: string;
	cwd: string;
	startedAt: string;
	durationMs: number;
	exitCode: number;
	stdoutPath: string;
	stderrPath: string;
	combinedPath: string;
};
