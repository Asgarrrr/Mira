import { describe, expect, test } from "bun:test";
import { renderObservationMd } from "../src/cli/render-observation.ts";
import { buildObservation } from "../src/core/command-observation.ts";
import type { CommandRun } from "../src/core/command-run.ts";

const FIXTURE_RUN: CommandRun = {
	id: "run_20260505T143025123Z_a4f2k9",
	command: "bun test",
	cwd: "/tmp/project",
	startedAt: "2026-05-05T14:30:25.123Z",
	durationMs: 1234,
	exitCode: 0,
	stdoutPath:
		"/tmp/project/.mira/runs/run_20260505T143025123Z_a4f2k9/stdout.log",
	stderrPath:
		"/tmp/project/.mira/runs/run_20260505T143025123Z_a4f2k9/stderr.log",
	combinedPath:
		"/tmp/project/.mira/runs/run_20260505T143025123Z_a4f2k9/combined.log",
};

const FIXTURE_METADATA_PATH =
	"/tmp/project/.mira/runs/run_20260505T143025123Z_a4f2k9/metadata.json";

describe("buildObservation", () => {
	test("derives a success observation from a zero exit code", () => {
		const observation = buildObservation(FIXTURE_RUN, FIXTURE_METADATA_PATH);

		expect(observation).toEqual({
			id: FIXTURE_RUN.id,
			runId: FIXTURE_RUN.id,
			command: "bun test",
			status: "success",
			exitCode: 0,
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
				{ path: FIXTURE_METADATA_PATH, kind: "metadata" },
			],
		});
	});

	test("derives a failure observation from a non-zero exit code", () => {
		const observation = buildObservation(
			{ ...FIXTURE_RUN, exitCode: 7, durationMs: 42 },
			FIXTURE_METADATA_PATH,
		);

		expect(observation.status).toBe("failure");
		expect(observation.summary).toBe("`bun test` failed with code 7 in 42ms");
	});

	test("findings/relatedFiles/etc. are empty in V0", () => {
		const observation = buildObservation(FIXTURE_RUN, FIXTURE_METADATA_PATH);

		expect(observation.findings).toEqual([]);
		expect(observation.relatedFiles).toEqual([]);
		expect(observation.suggestedNextActions).toEqual([]);
		expect(observation.verificationHints).toEqual([]);
	});
});

describe("renderObservationMd", () => {
	test("renders a deterministic markdown document", () => {
		const observation = buildObservation(FIXTURE_RUN, FIXTURE_METADATA_PATH);
		const md = renderObservationMd(observation, FIXTURE_RUN);

		expect(md).toBe(
			[
				"# Run run_20260505T143025123Z_a4f2k9",
				"",
				"- **Command:** `bun test`",
				"- **Status:** success",
				"- **Exit code:** 0",
				"- **Duration:** 1234ms",
				"- **Started at:** 2026-05-05T14:30:25.123Z",
				"",
				"## Summary",
				"",
				"`bun test` exited with code 0 in 1234ms",
				"",
				"## Evidence",
				"",
				"- [stdout](./stdout.log)",
				"- [stderr](./stderr.log)",
				"- [combined](./combined.log)",
				"- [metadata](./metadata.json)",
				"",
			].join("\n"),
		);
	});
});
