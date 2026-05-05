import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { CommandRun } from "../core/command-run.ts";
import { generateRunId } from "../core/ids.ts";

type RunEvidenceKind = "stdout" | "stderr" | "combined" | "metadata";

const FILENAMES: Record<RunEvidenceKind, string> = {
	stdout: "stdout.log",
	stderr: "stderr.log",
	combined: "combined.log",
	metadata: "metadata.json",
};

export class FileEvidenceStore {
	private readonly runsDir: string;

	constructor(projectRoot: string) {
		this.runsDir = join(projectRoot, ".mira", "runs");
	}

	createRun(): { runId: string; runDir: string } {
		mkdirSync(this.runsDir, { recursive: true });
		const runId = generateRunId();
		const runDir = join(this.runsDir, runId);
		mkdirSync(runDir);
		return { runId, runDir };
	}

	writeStdout(runId: string, text: string): void {
		this.writeRunFile(runId, "stdout", text);
	}

	writeStderr(runId: string, text: string): void {
		this.writeRunFile(runId, "stderr", text);
	}

	writeCombined(runId: string, text: string): void {
		this.writeRunFile(runId, "combined", text);
	}

	writeMetadata(runId: string, run: CommandRun): void {
		this.writeRunFile(runId, "metadata", `${JSON.stringify(run, null, 2)}\n`);
	}

	readRun(runId: string): CommandRun {
		return JSON.parse(this.readEvidence(runId, "metadata")) as CommandRun;
	}

	readEvidence(runId: string, kind: RunEvidenceKind): string {
		return readFileSync(join(this.runsDir, runId, FILENAMES[kind]), "utf8");
	}

	private writeRunFile(
		runId: string,
		kind: RunEvidenceKind,
		text: string,
	): void {
		writeFileSync(join(this.runsDir, runId, FILENAMES[kind]), text, "utf8");
	}
}
