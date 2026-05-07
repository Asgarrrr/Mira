import { spawn } from "node:child_process";
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

		// `detached: true` makes the child the leader of a new POSIX process
		// group (setsid), so we can group-kill its descendants on timeout via
		// `process.kill(-pid, ...)`. Bun.spawn does not expose this today, so
		// we reach for `node:child_process` here. See ADR 0001 (300s timeout
		// invariant) and audit/01-H1-timeout-orphans.md for the failure mode
		// this guards against (sh fork-and-wait, double-fork orphans).
		const proc = spawn("sh", ["-c", command], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});

		let stdoutBuf = "";
		let stderrBuf = "";
		let combinedBuf = "";
		let killedByTimeout = false;

		proc.stdout?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			stdoutBuf += text;
			combinedBuf += text;
		});
		proc.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			stderrBuf += text;
			combinedBuf += text;
		});

		const closed = new Promise<{
			code: number | null;
			signal: NodeJS.Signals | null;
		}>((resolve, reject) => {
			proc.once("close", (code, signal) => resolve({ code, signal }));
			proc.once("error", reject);
		});

		const timer = setTimeout(() => {
			const procAlive = proc.exitCode === null && proc.signalCode === null;
			if (procAlive) killedByTimeout = true;
			if (proc.pid !== undefined) {
				// Three-tier best-effort kill: group-kill (negative pid covers
				// descendants), then leader-kill, then give up. Each tier may
				// throw ESRCH if the target is already gone — which is fine,
				// since the timeout has already fired and the race is over.
				try {
					process.kill(-proc.pid, "SIGKILL");
				} catch {
					try {
						proc.kill("SIGKILL");
					} catch {
						// Process gone before we could kill it; nothing to do.
					}
				}
			}
			// Belt-and-suspenders: drop our end of the pipes so `close` fires
			// even if a descendant somehow survives the group-kill.
			proc.stdout?.destroy();
			proc.stderr?.destroy();
		}, this.timeoutMs);

		const { code, signal } = await closed;
		clearTimeout(timer);

		const durationMs = Date.now() - start;
		const exitCode = code;
		const signalName = signal ?? undefined;

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
			...(signalName !== undefined ? { signal: signalName } : {}),
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
