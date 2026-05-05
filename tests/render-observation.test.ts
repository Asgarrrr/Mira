import { describe, expect, test } from "bun:test";

import { renderObservationMd } from "../src/cli/render-observation.ts";
import { buildObservation } from "../src/core/command-observation.ts";
import type { CommandRun } from "../src/core/command-run.ts";

const RUN_DIR = "/tmp/project/.mira/runs/run_20260505T143025123Z_a4f2k9";

const FIXTURE_RUN: CommandRun = {
	id: "run_20260505T143025123Z_a4f2k9",
	command: "bun test",
	cwd: "/tmp/project",
	startedAt: "2026-05-05T14:30:25.123Z",
	durationMs: 1234,
	exitCode: 0,
	killedByTimeout: false,
	stdoutPath: `${RUN_DIR}/stdout.log`,
	stderrPath: `${RUN_DIR}/stderr.log`,
	combinedPath: `${RUN_DIR}/combined.log`,
	metadataPath: `${RUN_DIR}/metadata.json`,
};

describe("renderObservationMd", () => {
	test("renders a successful run", () => {
		const md = renderObservationMd(buildObservation(FIXTURE_RUN), FIXTURE_RUN);

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

	test("renders a failed run with a non-zero exit code", () => {
		const run: CommandRun = {
			...FIXTURE_RUN,
			command: "bun test",
			exitCode: 7,
			durationMs: 42,
		};
		const md = renderObservationMd(buildObservation(run), run);

		expect(md).toBe(
			[
				"# Run run_20260505T143025123Z_a4f2k9",
				"",
				"- **Command:** `bun test`",
				"- **Status:** failure",
				"- **Exit code:** 7",
				"- **Duration:** 42ms",
				"- **Started at:** 2026-05-05T14:30:25.123Z",
				"",
				"## Summary",
				"",
				"`bun test` failed with code 7 in 42ms",
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

	test("renders a timed-out run with signal and timeout markers", () => {
		const run: CommandRun = {
			...FIXTURE_RUN,
			command: "sleep 999",
			exitCode: null,
			signal: "SIGKILL",
			killedByTimeout: true,
			durationMs: 300012,
		};
		const md = renderObservationMd(buildObservation(run), run);

		expect(md).toBe(
			[
				"# Run run_20260505T143025123Z_a4f2k9",
				"",
				"- **Command:** `sleep 999`",
				"- **Status:** failure",
				"- **Exit code:** n/a",
				"- **Signal:** SIGKILL",
				"- **Timed out:** yes",
				"- **Duration:** 300012ms",
				"- **Started at:** 2026-05-05T14:30:25.123Z",
				"",
				"## Summary",
				"",
				"`sleep 999` killed by timeout after 300012ms (SIGKILL)",
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

	test("renders an externally-signalled run (no timeout)", () => {
		const run: CommandRun = {
			...FIXTURE_RUN,
			command: "node server.js",
			exitCode: null,
			signal: "SIGTERM",
			killedByTimeout: false,
			durationMs: 1500,
		};
		const md = renderObservationMd(buildObservation(run), run);

		expect(md).toContain("- **Status:** failure");
		expect(md).toContain("- **Exit code:** n/a");
		expect(md).toContain("- **Signal:** SIGTERM");
		expect(md).not.toContain("Timed out:");
		expect(md).toContain("`node server.js` killed by SIGTERM after 1500ms");
	});
});
