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
		const { runId, runDir, metadataPath } = this.store.createRun();
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
		let killedByTimeout = false;
		let completed = false;

		const timer = setTimeout(() => {
			if (completed) return;
			killedByTimeout = true;
			proc.kill("SIGKILL");
		}, this.timeoutMs);

		const exitedSentinel = proc.exited.then(() => {
			completed = true;
		});

		await Promise.all([
			pump(proc.stdout, (chunk) => {
				stdoutBuf += chunk;
				combinedBuf += chunk;
			}),
			pump(proc.stderr, (chunk) => {
				stderrBuf += chunk;
				combinedBuf += chunk;
			}),
			exitedSentinel,
		]);

		clearTimeout(timer);

		const durationMs = Date.now() - start;
		const exitCode = proc.exitCode;
		const signal = proc.signalCode ?? undefined;

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
			...(signal !== undefined ? { signal } : {}),
			killedByTimeout,
			stdoutPath: join(runDir, "stdout.log"),
			stderrPath: join(runDir, "stderr.log"),
			combinedPath: join(runDir, "combined.log"),
			metadataPath,
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
