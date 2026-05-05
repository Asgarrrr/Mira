import { join } from "node:path";

import type { CommandRun } from "../core/command-run.ts";
import type { FileEvidenceStore } from "../store/evidence-store.ts";

export type ObserveResult = {
	run: CommandRun;
	stdout: string;
	stderr: string;
};

export class CommandObserver {
	constructor(
		private readonly store: FileEvidenceStore,
		private readonly timeoutMs: number = 300_000,
	) {}

	async observe(command: string, cwd: string): Promise<ObserveResult> {
		const { runId, runDir } = this.store.createRun();
		const startedAt = new Date().toISOString();
		const start = Date.now();

		const proc = Bun.spawn(["sh", "-c", command], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});

		let stdoutBuf = "";
		let stderrBuf = "";
		let combinedBuf = "";

		const timer = setTimeout(() => proc.kill("SIGKILL"), this.timeoutMs);

		const [, , rawExit] = await Promise.all([
			pump(proc.stdout, (chunk) => {
				stdoutBuf += chunk;
				combinedBuf += chunk;
			}),
			pump(proc.stderr, (chunk) => {
				stderrBuf += chunk;
				combinedBuf += chunk;
			}),
			proc.exited,
		]);

		clearTimeout(timer);

		const durationMs = Date.now() - start;
		const exitCode = typeof rawExit === "number" ? rawExit : 1;

		this.store.writeStdout(runId, stdoutBuf);
		this.store.writeStderr(runId, stderrBuf);
		this.store.writeCombined(runId, combinedBuf);

		const run: CommandRun = {
			id: runId,
			command,
			cwd,
			startedAt,
			durationMs,
			exitCode,
			stdoutPath: join(runDir, "stdout.log"),
			stderrPath: join(runDir, "stderr.log"),
			combinedPath: join(runDir, "combined.log"),
		};

		this.store.writeMetadata(runId, run);

		return { run, stdout: stdoutBuf, stderr: stderrBuf };
	}
}

async function pump(
	stream: ReadableStream<Uint8Array>,
	onChunk: (text: string) => void,
): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) onChunk(decoder.decode(value, { stream: true }));
		}
		const tail = decoder.decode();
		if (tail) onChunk(tail);
	} finally {
		reader.releaseLock();
	}
}
