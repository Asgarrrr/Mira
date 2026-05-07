import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateReport } from "./report.ts";
import type { Mode, RunMetrics } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SYNTHETIC = resolve(HERE, "__fixtures__", "synthetic-results");

type CellSpec = {
	scenario: string;
	mode: Mode;
	tokensTotal: number;
	success?: boolean;
	tools?: Record<string, number>;
};

async function writeCells(root: string, cells: CellSpec[]): Promise<void> {
	for (const c of cells) {
		for (let rep = 1; rep <= 3; rep++) {
			const tokensInput = Math.round(c.tokensTotal * 0.85);
			const tokensOutput = c.tokensTotal - tokensInput;
			const tools = c.tools ?? { read: 2, bash: 2 };
			const m: RunMetrics = {
				scenario: c.scenario,
				mode: c.mode,
				repeat: rep,
				model: "claude-sonnet-4-6",
				success: c.success ?? true,
				stopReason: "model_end",
				turns: 6,
				tokensInput,
				tokensOutput,
				tokensTotal: c.tokensTotal,
				toolCalls: Object.values(tools).reduce((a, b) => a + b, 0),
				toolCallsByName: tools,
				filesRead: 2,
				filesModified: 1,
				wallClockMs: 25_000,
			};
			const dir = join(root, `${c.scenario}-${c.mode}-${rep}`);
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, "metrics.json"), JSON.stringify(m), "utf8");
		}
	}
}

async function tmpRoot(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "mira-report-test-"));
}

describe("generateReport — per-scenario verdict", () => {
	test("Win when mira tokens drop ≥20% and success ≥ baseline", async () => {
		const root = await tmpRoot();
		try {
			await writeCells(root, [
				{ scenario: "A1", mode: "baseline", tokensTotal: 10_000 },
				{ scenario: "A1", mode: "mira", tokensTotal: 7_500 },
			]);
			const { markdown } = await generateReport(root);
			expect(markdown).toContain("| A1 | 10000 | 7500 | -25.0% |");
			expect(markdown).toMatch(/\| A1 .* Win \|/);
			expect(markdown).toContain("Global: **Neutral**"); // single-scenario corpus → not enough Wins, no Loss
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("Loss when mira tokens go up", async () => {
		const root = await tmpRoot();
		try {
			await writeCells(root, [
				{ scenario: "A1", mode: "baseline", tokensTotal: 10_000 },
				{ scenario: "A1", mode: "mira", tokensTotal: 12_000 },
			]);
			const { markdown } = await generateReport(root);
			expect(markdown).toMatch(/\| A1 .* Loss \|/);
			expect(markdown).toContain("Global: **Loss**");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("Neutral when mira tokens drop but <20%", async () => {
		const root = await tmpRoot();
		try {
			await writeCells(root, [
				{ scenario: "A1", mode: "baseline", tokensTotal: 10_000 },
				{ scenario: "A1", mode: "mira", tokensTotal: 9_000 },
			]);
			const { markdown } = await generateReport(root);
			expect(markdown).toMatch(/\| A1 .* Neutral \|/);
			expect(markdown).toContain("Global: **Neutral**");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("Loss when mira success_rate drops even if tokens drop ≥20%", async () => {
		const root = await tmpRoot();
		try {
			await writeCells(root, [
				{
					scenario: "A1",
					mode: "baseline",
					tokensTotal: 10_000,
					success: true,
				},
				{
					scenario: "A1",
					mode: "mira",
					tokensTotal: 5_000,
					success: false,
				},
			]);
			const { markdown } = await generateReport(root);
			expect(markdown).toMatch(/\| A1 .* Loss \|/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("generateReport — global verdict + B1 note", () => {
	test("Win when ≥3 scenarios are Win; B1 Loss adds a note", async () => {
		const root = await tmpRoot();
		try {
			await writeCells(root, [
				{ scenario: "A1", mode: "baseline", tokensTotal: 10_000 },
				{ scenario: "A1", mode: "mira", tokensTotal: 7_000 },
				{ scenario: "A2", mode: "baseline", tokensTotal: 10_000 },
				{ scenario: "A2", mode: "mira", tokensTotal: 7_000 },
				{ scenario: "A3", mode: "baseline", tokensTotal: 10_000 },
				{ scenario: "A3", mode: "mira", tokensTotal: 7_000 },
				{ scenario: "B1", mode: "baseline", tokensTotal: 20_000 },
				{ scenario: "B1", mode: "mira", tokensTotal: 25_000 },
			]);
			const { markdown } = await generateReport(root);
			expect(markdown).toContain("Global: **Win**");
			expect(markdown).toMatch(/\| B1 .* Loss \|/);
			expect(markdown).toContain(
				"B1 is the scenario where Mira's structural advantage",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("does not add B1 note when B1 is Win", async () => {
		const root = await tmpRoot();
		try {
			await writeCells(root, [
				{ scenario: "B1", mode: "baseline", tokensTotal: 20_000 },
				{ scenario: "B1", mode: "mira", tokensTotal: 10_000 },
			]);
			const { markdown } = await generateReport(root);
			expect(markdown).not.toContain("B1 is the scenario");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("generateReport — failure modes", () => {
	test("throws when no metrics.json found, message names the dir", async () => {
		const root = await tmpRoot();
		try {
			await expect(generateReport(root)).rejects.toThrow(root);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("throws when resultsDir does not exist", async () => {
		const missing = join(tmpdir(), `mira-report-missing-${Date.now()}`);
		await expect(generateReport(missing)).rejects.toThrow(missing);
	});
});

describe("generateReport — committed synthetic fixtures", () => {
	test("produces stable Win-verdict markdown (snapshot)", async () => {
		const { markdown } = await generateReport(SYNTHETIC);
		// Strip non-deterministic fields before snapshotting.
		const normalized = markdown
			.replace(SYNTHETIC, "<resultsDir>")
			.replace(
				/generated: \d{4}-\d{2}-\d{2}T[\d:.]+Z/,
				"generated: <iso-timestamp>",
			);
		expect(normalized).toMatchSnapshot();
	});

	test("writes summary.md to disk alongside metrics", async () => {
		await generateReport(SYNTHETIC);
		const summary = await readFile(join(SYNTHETIC, "summary.md"), "utf8");
		expect(summary).toContain("# Mira eval");
		expect(summary).toContain("Global: **Win**");
	});
});
