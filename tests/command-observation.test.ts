import { describe, expect, test } from "bun:test";
import { buildObservation } from "../src/core/command-observation.ts";
import type { CommandRun } from "../src/core/command-run.ts";

const FIXTURE_RUN: CommandRun = {
	id: "run_20260505T143025123Z_a4f2k9",
	command: "bun test",
	cwd: "/tmp/project",
	startedAt: "2026-05-05T14:30:25.123Z",
	durationMs: 1234,
	exitCode: 0,
	killedByTimeout: false,
	stdoutPath:
		"/tmp/project/.mira/runs/run_20260505T143025123Z_a4f2k9/stdout.log",
	stderrPath:
		"/tmp/project/.mira/runs/run_20260505T143025123Z_a4f2k9/stderr.log",
	combinedPath:
		"/tmp/project/.mira/runs/run_20260505T143025123Z_a4f2k9/combined.log",
	metadataPath:
		"/tmp/project/.mira/runs/run_20260505T143025123Z_a4f2k9/metadata.json",
};

describe("buildObservation", () => {
	test("derives a success observation from a zero exit code", () => {
		const observation = buildObservation(FIXTURE_RUN);

		expect(observation).toEqual({
			id: FIXTURE_RUN.id,
			runId: FIXTURE_RUN.id,
			command: "bun test",
			status: "success",
			exitCode: 0,
			killedByTimeout: false,
			durationMs: 1234,
			summary: "`bun test` exited with code 0 in 1234ms",
			findings: [],
			relatedFiles: [],
			suggestedNextActions: [],
			verificationHints: [],
			evidenceRefs: [
				{ path: FIXTURE_RUN.stdoutPath, kind: "stdout" },
				{ path: FIXTURE_RUN.stderrPath, kind: "stderr" },
				{ path: FIXTURE_RUN.combinedPath, kind: "combined" },
				{ path: FIXTURE_RUN.metadataPath, kind: "metadata" },
			],
		});
	});

	test("derives a failure observation from a non-zero exit code", () => {
		const observation = buildObservation({
			...FIXTURE_RUN,
			exitCode: 7,
			durationMs: 42,
		});

		expect(observation.status).toBe("failure");
		expect(observation.summary).toBe("`bun test` failed with code 7 in 42ms");
	});

	test("findings/relatedFiles/etc. are empty in V0", () => {
		const observation = buildObservation(FIXTURE_RUN);

		expect(observation.findings).toEqual([]);
		expect(observation.relatedFiles).toEqual([]);
		expect(observation.suggestedNextActions).toEqual([]);
		expect(observation.verificationHints).toEqual([]);
	});

	test("propagates timeout and signal into the observation", () => {
		const observation = buildObservation({
			...FIXTURE_RUN,
			command: "sleep 999",
			exitCode: null,
			signal: "SIGKILL",
			killedByTimeout: true,
			durationMs: 300012,
		});

		expect(observation.status).toBe("failure");
		expect(observation.exitCode).toBeNull();
		expect(observation.signal).toBe("SIGKILL");
		expect(observation.killedByTimeout).toBe(true);
		expect(observation.summary).toBe(
			"`sleep 999` killed by timeout after 300012ms (SIGKILL)",
		);
	});

	test("describes a signal-killed run that did not time out", () => {
		const observation = buildObservation({
			...FIXTURE_RUN,
			command: "node server.js",
			exitCode: null,
			signal: "SIGTERM",
			killedByTimeout: false,
			durationMs: 1500,
		});

		expect(observation.status).toBe("failure");
		expect(observation.summary).toBe(
			"`node server.js` killed by SIGTERM after 1500ms",
		);
	});
});
