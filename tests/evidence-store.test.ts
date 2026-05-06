import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandObservation } from "../src/core/command-observation.ts";
import type { CommandRun } from "../src/core/command-run.ts";
import type { ContextPack } from "../src/core/context-pack.ts";
import { FileEvidenceStore } from "../src/store/evidence-store.ts";

describe("FileEvidenceStore", () => {
	let projectRoot: string;

	beforeEach(() => {
		projectRoot = mkdtempSync(join(tmpdir(), "mira-test-"));
	});

	afterEach(() => {
		rmSync(projectRoot, { recursive: true, force: true });
	});

	test("createRun lazily creates .mira/runs/<run-id>/", () => {
		const store = new FileEvidenceStore(projectRoot);
		expect(existsSync(join(projectRoot, ".mira"))).toBe(false);

		const { runId, runDir, metadataPath } = store.createRun();

		expect(runDir).toBe(join(projectRoot, ".mira", "runs", runId));
		expect(metadataPath).toBe(join(runDir, "metadata.json"));
		expect(existsSync(runDir)).toBe(true);
	});

	test("two sequential createRun() calls produce distinct dirs", () => {
		const store = new FileEvidenceStore(projectRoot);
		const r1 = store.createRun();
		const r2 = store.createRun();

		expect(r1.runId).not.toBe(r2.runId);
		expect(existsSync(r1.runDir)).toBe(true);
		expect(existsSync(r2.runDir)).toBe(true);
	});

	test("parallel createRun() calls produce distinct ids and dirs on disk", async () => {
		const store = new FileEvidenceStore(projectRoot);
		const results = await Promise.all(
			Array.from({ length: 16 }, () => Promise.resolve(store.createRun())),
		);

		const ids = new Set(results.map((r) => r.runId));
		const dirs = new Set(results.map((r) => r.runDir));
		expect(ids.size).toBe(16);
		expect(dirs.size).toBe(16);
		for (const r of results) {
			expect(existsSync(r.runDir)).toBe(true);
		}
	});

	test("writeStdout / writeStderr / writeCombined round-trip via readEvidence", () => {
		const store = new FileEvidenceStore(projectRoot);
		const { runId } = store.createRun();

		store.writeStdout(runId, "stdout text\n");
		store.writeStderr(runId, "stderr text\n");
		store.writeCombined(runId, "combined text\n");

		expect(store.readEvidence(runId, "stdout")).toBe("stdout text\n");
		expect(store.readEvidence(runId, "stderr")).toBe("stderr text\n");
		expect(store.readEvidence(runId, "combined")).toBe("combined text\n");
	});

	test("writeMetadata + readRun round-trip", () => {
		const store = new FileEvidenceStore(projectRoot);
		const { runId, runDir } = store.createRun();

		const run: CommandRun = {
			id: runId,
			command: "echo hi",
			cwd: projectRoot,
			startedAt: "2026-05-05T14:30:25.123Z",
			durationMs: 12,
			exitCode: 0,
			killedByTimeout: false,
			stdoutPath: join(runDir, "stdout.log"),
			stderrPath: join(runDir, "stderr.log"),
			combinedPath: join(runDir, "combined.log"),
			metadataPath: join(runDir, "metadata.json"),
		};
		store.writeMetadata(runId, run);

		expect(store.readRun(runId)).toEqual(run);
	});

	test("evidence files are stored as utf-8 text", () => {
		const store = new FileEvidenceStore(projectRoot);
		const { runId, runDir } = store.createRun();

		store.writeStdout(runId, "café résumé\n");

		expect(readFileSync(join(runDir, "stdout.log"), "utf8")).toBe(
			"café résumé\n",
		);
	});

	test("readRun on an unknown run id throws", () => {
		const store = new FileEvidenceStore(projectRoot);
		expect(() => store.readRun("run_nope")).toThrow();
	});

	test("listRecentObservations returns [] when .mira/runs does not exist yet", () => {
		const store = new FileEvidenceStore(projectRoot);
		expect(store.listRecentObservations(10)).toEqual([]);
	});

	test("listRecentObservations returns the N newest observations, newest first", () => {
		const store = new FileEvidenceStore(projectRoot);
		const ids = [
			"run_20260505T143010000Z_a00001",
			"run_20260505T143020000Z_a00002",
			"run_20260505T143030000Z_a00003",
			"run_20260505T143040000Z_a00004",
			"run_20260505T143050000Z_a00005",
			"run_20260505T143100000Z_a00006",
			"run_20260505T143110000Z_a00007",
			"run_20260505T143120000Z_a00008",
			"run_20260505T143130000Z_a00009",
			"run_20260505T143140000Z_a00010",
			"run_20260505T143150000Z_a00011",
		];

		// Write 11 observation dirs in lexicographic order. We can't rely on
		// FileEvidenceStore.createRun() (it generates ids), so we materialise the
		// fixture by hand.
		const runsRoot = join(projectRoot, ".mira", "runs");
		for (const id of ids) {
			const dir = join(runsRoot, id);
			mkdirSync(dir, { recursive: true });
			const observation: CommandObservation = {
				id,
				runId: id,
				command: `echo ${id}`,
				status: "success",
				exitCode: 0,
				killedByTimeout: false,
				durationMs: 1,
				summary: `\`echo ${id}\` exited with code 0 in 1ms`,
				findings: [],
				relatedFiles: [],
				suggestedNextActions: [],
				verificationHints: [],
				evidenceRefs: [
					{ path: join(dir, "stdout.log"), kind: "stdout" },
					{ path: join(dir, "stderr.log"), kind: "stderr" },
					{ path: join(dir, "combined.log"), kind: "combined" },
					{ path: join(dir, "metadata.json"), kind: "metadata" },
				],
			};
			writeFileSync(
				join(dir, "observation.json"),
				`${JSON.stringify(observation, null, 2)}\n`,
				"utf8",
			);
		}

		const recent = store.listRecentObservations(10);
		expect(recent.length).toBe(10);
		expect(recent.map((o) => o.id)).toEqual([...ids].reverse().slice(0, 10));
	});

	test("listRecentObservations skips run dirs without observation.json", () => {
		const store = new FileEvidenceStore(projectRoot);
		const { runId, runDir } = store.createRun(); // no observation.json written
		const observation: CommandObservation = {
			id: "run_zzzzzzzzzzzzzzzzzz_zzzzzz",
			runId: "run_zzzzzzzzzzzzzzzzzz_zzzzzz",
			command: "echo z",
			status: "success",
			exitCode: 0,
			killedByTimeout: false,
			durationMs: 1,
			summary: "`echo z` exited with code 0 in 1ms",
			findings: [],
			relatedFiles: [],
			suggestedNextActions: [],
			verificationHints: [],
			evidenceRefs: [],
		};
		// Manually create a second run dir with an observation.json
		const runsRoot = join(projectRoot, ".mira", "runs");
		const dir = join(runsRoot, observation.id);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "observation.json"),
			`${JSON.stringify(observation, null, 2)}\n`,
			"utf8",
		);

		expect(existsSync(runDir)).toBe(true);
		const recent = store.listRecentObservations(10);
		expect(recent.map((o) => o.id)).toEqual([observation.id]);
		expect(recent.map((o) => o.id)).not.toContain(runId);
	});

	test("listRecentObservations skips run dirs whose observation.json is malformed JSON", () => {
		// Regression for audit H2: one corrupt observation.json (interrupted
		// write, OOM mid-flush, disk full) used to throw out of the loop and
		// poison the entire projection — list_recent_runs and
		// generate_context_pack returned INTERNAL even when other healthy runs
		// existed. The fix treats a parse error the same as a missing file.
		const store = new FileEvidenceStore(projectRoot);
		const runsRoot = join(projectRoot, ".mira", "runs");
		const ids = [
			"run_20260505T143010000Z_a00001",
			"run_20260505T143020000Z_a00002",
			"run_20260505T143030000Z_a00003",
		];

		for (const id of ids) {
			const dir = join(runsRoot, id);
			mkdirSync(dir, { recursive: true });
			const observation: CommandObservation = {
				id,
				runId: id,
				command: `echo ${id}`,
				status: "success",
				exitCode: 0,
				killedByTimeout: false,
				durationMs: 1,
				summary: `\`echo ${id}\` exited with code 0 in 1ms`,
				findings: [],
				relatedFiles: [],
				suggestedNextActions: [],
				verificationHints: [],
				evidenceRefs: [],
			};
			writeFileSync(
				join(dir, "observation.json"),
				`${JSON.stringify(observation, null, 2)}\n`,
				"utf8",
			);
		}

		const corruptId = ids[1] as string;
		writeFileSync(
			join(runsRoot, corruptId, "observation.json"),
			"{this is not json,,,",
			"utf8",
		);

		const recent = store.listRecentObservations(10);
		const recentIds = recent.map((o) => o.id);
		const expectedIds = [...ids].reverse().filter((id) => id !== corruptId);

		expect(recent.length).toBe(2);
		expect(recentIds).not.toContain(corruptId);
		expect(recentIds).toEqual(expectedIds);
	});

	test("listRecentObservations skips run dirs whose observation.json is JSON-valid but wrong-shape", () => {
		// Regression for audit M1: an observation.json that parses (well-formed
		// JSON) but doesn't match `commandObservationSchema` — e.g., an older
		// Mira version's schema or a partial write that landed between two
		// valid braces — used to flow through `as CommandObservation` and
		// surface as a CommandObservation with none of the expected fields.
		// The fix treats a shape mismatch the same way H2 treats a parse-throw:
		// skip the row, don't poison the projection.
		const store = new FileEvidenceStore(projectRoot);
		const runsRoot = join(projectRoot, ".mira", "runs");
		const ids = [
			"run_20260505T143010000Z_a00001",
			"run_20260505T143020000Z_a00002",
			"run_20260505T143030000Z_a00003",
		];

		for (const id of ids) {
			const dir = join(runsRoot, id);
			mkdirSync(dir, { recursive: true });
			const observation: CommandObservation = {
				id,
				runId: id,
				command: `echo ${id}`,
				status: "success",
				exitCode: 0,
				killedByTimeout: false,
				durationMs: 1,
				summary: `\`echo ${id}\` exited with code 0 in 1ms`,
				findings: [],
				relatedFiles: [],
				suggestedNextActions: [],
				verificationHints: [],
				evidenceRefs: [],
			};
			writeFileSync(
				join(dir, "observation.json"),
				`${JSON.stringify(observation, null, 2)}\n`,
				"utf8",
			);
		}

		const wrongShapeId = ids[1] as string;
		writeFileSync(
			join(runsRoot, wrongShapeId, "observation.json"),
			JSON.stringify({ totally: "wrong" }),
			"utf8",
		);

		const recent = store.listRecentObservations(10);
		const recentIds = recent.map((o) => o.id);
		const expectedIds = [...ids].reverse().filter((id) => id !== wrongShapeId);

		expect(recent.length).toBe(2);
		expect(recentIds).not.toContain(wrongShapeId);
		expect(recentIds).toEqual(expectedIds);
	});

	test("listRecentObservations keeps scanning past corrupt dirs to fill the limit", () => {
		// Regression: a corrupt run dir at the top of the sort must not shrink the
		// result below `limit` when more valid observations exist behind it.
		const store = new FileEvidenceStore(projectRoot);
		const runsRoot = join(projectRoot, ".mira", "runs");

		// Newest entry, lexicographically: corrupt (no observation.json).
		mkdirSync(join(runsRoot, "run_20260505T999999999Z_corrupt"), {
			recursive: true,
		});

		const validIds = Array.from(
			{ length: 11 },
			(_, i) =>
				`run_20260505T1430${String(i).padStart(2, "0")}000Z_v${String(i).padStart(5, "0")}`,
		);
		for (const id of validIds) {
			const dir = join(runsRoot, id);
			mkdirSync(dir, { recursive: true });
			const observation: CommandObservation = {
				id,
				runId: id,
				command: `echo ${id}`,
				status: "success",
				exitCode: 0,
				killedByTimeout: false,
				durationMs: 1,
				summary: `\`echo ${id}\` exited with code 0 in 1ms`,
				findings: [],
				relatedFiles: [],
				suggestedNextActions: [],
				verificationHints: [],
				evidenceRefs: [{ path: join(dir, "metadata.json"), kind: "metadata" }],
			};
			writeFileSync(
				join(dir, "observation.json"),
				`${JSON.stringify(observation, null, 2)}\n`,
				"utf8",
			);
		}

		const recent = store.listRecentObservations(10);
		expect(recent.length).toBe(10);
		expect(recent.map((o) => o.id)).toEqual(
			[...validIds].reverse().slice(0, 10),
		);
		expect(recent.map((o) => o.id)).not.toContain(
			"run_20260505T999999999Z_corrupt",
		);
	});

	test("createContext lazily creates .mira/context/ and writes pack files", () => {
		const store = new FileEvidenceStore(projectRoot);
		expect(existsSync(join(projectRoot, ".mira", "context"))).toBe(false);

		const { contextId, jsonPath, mdPath } = store.createContext();
		expect(existsSync(join(projectRoot, ".mira", "context"))).toBe(true);
		expect(jsonPath).toBe(
			join(projectRoot, ".mira", "context", `${contextId}.json`),
		);
		expect(mdPath).toBe(
			join(projectRoot, ".mira", "context", `${contextId}.md`),
		);

		const pack: ContextPack = {
			id: contextId,
			task: "t",
			createdAt: "2026-01-01T00:00:00.000Z",
			summary: "s",
			observationIds: [],
			evidenceRefs: [],
			suspectedFiles: [],
			verificationCommands: [],
			risks: [],
			nextRecommendedAction: "",
		};
		store.writeContextJson(contextId, pack);
		store.writeContextMarkdown(contextId, "# md\n");

		expect(JSON.parse(readFileSync(jsonPath, "utf8"))).toEqual(pack);
		expect(readFileSync(mdPath, "utf8")).toBe("# md\n");
	});
});
