import { describe, expect, test } from "bun:test";

import { renderContextMd } from "../src/cli/render-context.ts";
import { buildContextPack } from "../src/context/context-pack-generator.ts";
import type { CommandObservation } from "../src/core/command-observation.ts";

const PROJECT = "/tmp/project";
const CONTEXT_DIR = `${PROJECT}/.mira/context`;

function obs(overrides: {
	id: string;
	command: string;
	status?: "success" | "failure";
	exitCode?: number | null;
}): CommandObservation {
	const id = overrides.id;
	const status = overrides.status ?? "success";
	const exitCode = overrides.exitCode ?? (status === "success" ? 0 : 1);
	const runDir = `${PROJECT}/.mira/runs/${id}`;
	return {
		id,
		runId: id,
		command: overrides.command,
		status,
		exitCode,
		killedByTimeout: false,
		durationMs: 100,
		summary: `\`${overrides.command}\` ${status === "success" ? "exited" : "failed"} with code ${exitCode} in 100ms`,
		findings: [],
		relatedFiles: [],
		suggestedNextActions: [],
		verificationHints: [],
		evidenceRefs: [
			{ path: `${runDir}/stdout.log`, kind: "stdout" },
			{ path: `${runDir}/stderr.log`, kind: "stderr" },
			{ path: `${runDir}/combined.log`, kind: "combined" },
			{ path: `${runDir}/metadata.json`, kind: "metadata" },
		],
	};
}

const FIXTURE_OBSERVATIONS: CommandObservation[] = [
	obs({ id: "run_20260505T143030000Z_aaaaaa", command: "bun test" }),
	obs({
		id: "run_20260505T143025000Z_bbbbbb",
		command: "bun build",
		status: "failure",
		exitCode: 1,
	}),
	obs({ id: "run_20260505T143020000Z_cccccc", command: "bun lint" }),
	obs({ id: "run_20260505T143015000Z_dddddd", command: "bun test" }),
	obs({
		id: "run_20260505T143010000Z_eeeeee",
		command: "bun typecheck",
		status: "failure",
		exitCode: 2,
	}),
];

describe("buildContextPack", () => {
	test("produces the canonical Tier 1 fields and leaves Tier 2 fields empty", () => {
		const pack = buildContextPack({
			id: "ctx_20260505T143031000Z_zzzzzz",
			task: "investigate failing build",
			createdAt: "2026-05-05T14:30:31.000Z",
			observations: FIXTURE_OBSERVATIONS,
		});

		expect(pack).toEqual({
			id: "ctx_20260505T143031000Z_zzzzzz",
			task: "investigate failing build",
			createdAt: "2026-05-05T14:30:31.000Z",
			summary:
				"Context pack for `investigate failing build` based on 5 recent observations (3 succeeded, 2 failed).",
			observationIds: [
				"run_20260505T143030000Z_aaaaaa",
				"run_20260505T143025000Z_bbbbbb",
				"run_20260505T143020000Z_cccccc",
				"run_20260505T143015000Z_dddddd",
				"run_20260505T143010000Z_eeeeee",
			],
			evidenceRefs: [
				{
					path: `${PROJECT}/.mira/runs/run_20260505T143030000Z_aaaaaa/metadata.json`,
					kind: "metadata",
				},
				{
					path: `${PROJECT}/.mira/runs/run_20260505T143025000Z_bbbbbb/metadata.json`,
					kind: "metadata",
				},
				{
					path: `${PROJECT}/.mira/runs/run_20260505T143020000Z_cccccc/metadata.json`,
					kind: "metadata",
				},
				{
					path: `${PROJECT}/.mira/runs/run_20260505T143015000Z_dddddd/metadata.json`,
					kind: "metadata",
				},
				{
					path: `${PROJECT}/.mira/runs/run_20260505T143010000Z_eeeeee/metadata.json`,
					kind: "metadata",
				},
			],
			suspectedFiles: [],
			verificationCommands: ["bun test", "bun lint"],
			risks: [],
			nextRecommendedAction: "",
		});
	});

	test("verificationCommands keeps only successful, unique commands in newest-first order", () => {
		const pack = buildContextPack({
			id: "ctx_x",
			task: "t",
			createdAt: "2026-01-01T00:00:00.000Z",
			observations: [
				obs({ id: "run_05", command: "bun test" }),
				obs({
					id: "run_04",
					command: "bun build",
					status: "failure",
					exitCode: 1,
				}),
				obs({ id: "run_03", command: "bun test" }),
				obs({ id: "run_02", command: "bun lint" }),
				obs({
					id: "run_01",
					command: "bun typecheck",
					status: "failure",
					exitCode: 2,
				}),
			],
		});

		expect(pack.verificationCommands).toEqual(["bun test", "bun lint"]);
	});

	test("handles zero observations: counts at zero, all derived arrays empty", () => {
		const pack = buildContextPack({
			id: "ctx_empty",
			task: "fresh start",
			createdAt: "2026-01-01T00:00:00.000Z",
			observations: [],
		});

		expect(pack.summary).toBe(
			"Context pack for `fresh start` based on 0 recent observations (0 succeeded, 0 failed).",
		);
		expect(pack.observationIds).toEqual([]);
		expect(pack.evidenceRefs).toEqual([]);
		expect(pack.verificationCommands).toEqual([]);
		expect(pack.suspectedFiles).toEqual([]);
		expect(pack.risks).toEqual([]);
		expect(pack.nextRecommendedAction).toBe("");
	});

	test("never embeds full observations — only ids and metadata refs", () => {
		const pack = buildContextPack({
			id: "ctx_x",
			task: "t",
			createdAt: "2026-01-01T00:00:00.000Z",
			observations: FIXTURE_OBSERVATIONS,
		});

		const serialised = JSON.stringify(pack);
		expect(serialised).not.toContain("findings");
		expect(serialised).not.toContain("suggestedNextActions");
		expect(serialised).not.toContain("stdout.log");
		expect(serialised).not.toContain("stderr.log");
		expect(serialised).not.toContain("combined.log");
		expect(serialised).not.toContain("observation.json");
	});
});

describe("renderContextMd", () => {
	test("renders a populated context pack", () => {
		const pack = buildContextPack({
			id: "ctx_20260505T143031000Z_zzzzzz",
			task: "investigate failing build",
			createdAt: "2026-05-05T14:30:31.000Z",
			observations: FIXTURE_OBSERVATIONS,
		});

		const md = renderContextMd(pack, CONTEXT_DIR);

		expect(md).toBe(
			[
				"# Context ctx_20260505T143031000Z_zzzzzz",
				"",
				"- **Task:** `investigate failing build`",
				"- **Created at:** 2026-05-05T14:30:31.000Z",
				"- **Observations:** 5",
				"",
				"## Summary",
				"",
				"Context pack for `investigate failing build` based on 5 recent observations (3 succeeded, 2 failed).",
				"",
				"## Observations",
				"",
				"- run_20260505T143030000Z_aaaaaa",
				"- run_20260505T143025000Z_bbbbbb",
				"- run_20260505T143020000Z_cccccc",
				"- run_20260505T143015000Z_dddddd",
				"- run_20260505T143010000Z_eeeeee",
				"",
				"## Evidence",
				"",
				"- [metadata](../runs/run_20260505T143030000Z_aaaaaa/metadata.json)",
				"- [metadata](../runs/run_20260505T143025000Z_bbbbbb/metadata.json)",
				"- [metadata](../runs/run_20260505T143020000Z_cccccc/metadata.json)",
				"- [metadata](../runs/run_20260505T143015000Z_dddddd/metadata.json)",
				"- [metadata](../runs/run_20260505T143010000Z_eeeeee/metadata.json)",
				"",
				"## Verification commands",
				"",
				"- `bun test`",
				"- `bun lint`",
				"",
			].join("\n"),
		);
	});

	test("renders an empty context pack with placeholder sections", () => {
		const pack = buildContextPack({
			id: "ctx_empty",
			task: "fresh start",
			createdAt: "2026-01-01T00:00:00.000Z",
			observations: [],
		});

		const md = renderContextMd(pack, CONTEXT_DIR);

		expect(md).toBe(
			[
				"# Context ctx_empty",
				"",
				"- **Task:** `fresh start`",
				"- **Created at:** 2026-01-01T00:00:00.000Z",
				"- **Observations:** 0",
				"",
				"## Summary",
				"",
				"Context pack for `fresh start` based on 0 recent observations (0 succeeded, 0 failed).",
				"",
				"## Observations",
				"",
				"_No recent observations._",
				"",
				"## Evidence",
				"",
				"_No evidence._",
				"",
			].join("\n"),
		);
	});
});
