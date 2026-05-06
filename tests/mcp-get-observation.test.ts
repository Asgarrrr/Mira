import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

import type { CommandObservation } from "../src/core/command-observation.ts";
import { runGetObservationTool } from "../src/mcp/tools/get-observation.ts";

function writeObservation(projectRoot: string, id: string, body: string): void {
	const dir = join(projectRoot, ".mira", "runs", id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "observation.json"), body, "utf8");
}

const FIXTURE_OBSERVATION: CommandObservation = {
	id: "run_20260505T143010000Z_abcdef",
	runId: "run_20260505T143010000Z_abcdef",
	command: "echo hi",
	status: "success",
	exitCode: 0,
	killedByTimeout: false,
	durationMs: 12,
	summary: "`echo hi` exited with code 0 in 12ms",
	findings: [],
	relatedFiles: [],
	suggestedNextActions: [],
	verificationHints: [],
	evidenceRefs: [],
};

describe("get_observation tool", () => {
	let projectRoot: string;

	beforeEach(() => {
		projectRoot = mkdtempSync(join(tmpdir(), "mira-mcp-get-obs-"));
	});

	afterEach(() => {
		rmSync(projectRoot, { recursive: true, force: true });
	});

	test("happy path: returns persisted observation verbatim", async () => {
		writeObservation(
			projectRoot,
			FIXTURE_OBSERVATION.id,
			`${JSON.stringify(FIXTURE_OBSERVATION, null, 2)}\n`,
		);

		const result = await runGetObservationTool({
			observationId: FIXTURE_OBSERVATION.id,
			projectRoot,
		});

		expect(result.observation).toEqual(FIXTURE_OBSERVATION);
	});

	test("does not synthesize ArchitectureSignal[] in the output", async () => {
		writeObservation(
			projectRoot,
			FIXTURE_OBSERVATION.id,
			`${JSON.stringify(FIXTURE_OBSERVATION, null, 2)}\n`,
		);

		const result = await runGetObservationTool({
			observationId: FIXTURE_OBSERVATION.id,
			projectRoot,
		});

		// ADR 0005 invariant: ArchitectureSignal[] is never embedded in the
		// observation. The boundary must not invent it.
		expect("architectureSignals" in result.observation).toBe(false);
		expect(result.observation).not.toHaveProperty("signals");
	});

	test("NOT_FOUND when the run dir does not exist", async () => {
		try {
			await runGetObservationTool({
				observationId: "run_nope",
				projectRoot,
			});
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			expect((err as McpError).data).toMatchObject({ code: "NOT_FOUND" });
		}
	});

	test("NOT_FOUND when observation.json is missing inside an existing run dir", async () => {
		mkdirSync(join(projectRoot, ".mira", "runs", "run_partial"), {
			recursive: true,
		});

		try {
			await runGetObservationTool({
				observationId: "run_partial",
				projectRoot,
			});
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			expect((err as McpError).data).toMatchObject({ code: "NOT_FOUND" });
		}
	});

	test("NOT_FOUND for traversal-style observationIds (refused before filesystem probe)", async () => {
		// `..` cannot match a real run dir name (run-id format is alphanumeric +
		// underscore only) — this must come back as NOT_FOUND, not as a probe
		// of the filesystem outside `.mira/runs/`.
		for (const bad of ["../etc", "..", "a/b", "a\\b", ".hidden"]) {
			try {
				await runGetObservationTool({
					observationId: bad,
					projectRoot,
				});
				throw new Error(`expected throw for ${bad}`);
			} catch (err) {
				expect(err).toBeInstanceOf(McpError);
				expect((err as McpError).data).toMatchObject({ code: "NOT_FOUND" });
			}
		}
	});

	test("INTERNAL when observation.json is malformed JSON", async () => {
		writeObservation(projectRoot, "run_bad_json", "{not json");

		try {
			await runGetObservationTool({
				observationId: "run_bad_json",
				projectRoot,
			});
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			expect((err as McpError).data).toMatchObject({ code: "INTERNAL" });
		}
	});

	test("INTERNAL when observation.json is JSON-valid but wrong-shape", async () => {
		// Regression for audit M1: a JSON-valid blob with the wrong shape
		// (e.g., an older Mira version's schema, or a partial write that
		// landed between two valid braces) used to flow through
		// `as CommandObservation` and reach the agent as a silent success
		// payload of `{"observation":{"totally":"wrong"}}`. The fix rejects
		// it on read with INTERNAL, mirroring the malformed-JSON case above —
		// shape correctness is now part of the contract.
		writeObservation(
			projectRoot,
			"run_wrong_shape",
			JSON.stringify({ totally: "wrong" }),
		);

		try {
			await runGetObservationTool({
				observationId: "run_wrong_shape",
				projectRoot,
			});
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			expect((err as McpError).data).toMatchObject({ code: "INTERNAL" });
		}
	});

	test("INVALID_INPUT when projectRoot is not a directory", async () => {
		try {
			await runGetObservationTool({
				observationId: FIXTURE_OBSERVATION.id,
				projectRoot: "/this/does/not/exist/anywhere",
			});
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			expect((err as McpError).data).toMatchObject({ code: "INVALID_INPUT" });
		}
	});
});
