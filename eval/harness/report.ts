import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Mode, RunMetrics } from "./types.ts";

export type ScenarioVerdict = "Win" | "Loss" | "Neutral";
export type GlobalVerdict = "Win" | "Loss" | "Neutral";

const WIN_TOKENS_RATIO = 0.8;
const GLOBAL_WIN_MIN_WINS = 3;

type ModeStats = {
	tokensTotalMedian: number;
	successRate: number;
	toolsAggregate: Record<string, number>;
};

type ScenarioGroup = {
	scenario: string;
	baseline?: ModeStats;
	mira?: ModeStats;
	verdict: ScenarioVerdict | "Incomplete";
};

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
	return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function aggregateMode(runs: RunMetrics[]): ModeStats {
	const tools: Record<string, number> = {};
	for (const r of runs) {
		for (const [name, count] of Object.entries(r.toolCallsByName)) {
			tools[name] = (tools[name] ?? 0) + count;
		}
	}
	return {
		tokensTotalMedian: median(runs.map((r) => r.tokensTotal)),
		successRate:
			runs.reduce((a, r) => a + (r.success ? 1 : 0), 0) / runs.length,
		toolsAggregate: tools,
	};
}

function scenarioVerdict(g: ScenarioGroup): ScenarioVerdict | "Incomplete" {
	if (!g.baseline || !g.mira) return "Incomplete";
	const b = g.baseline;
	const m = g.mira;
	const tokensRatio =
		b.tokensTotalMedian === 0 ? 1 : m.tokensTotalMedian / b.tokensTotalMedian;
	const winTokens = tokensRatio <= WIN_TOKENS_RATIO;
	const winSuccess = m.successRate >= b.successRate;
	if (winTokens && winSuccess) return "Win";
	if (
		m.tokensTotalMedian > b.tokensTotalMedian ||
		m.successRate < b.successRate
	) {
		return "Loss";
	}
	return "Neutral";
}

function topTools(tools: Record<string, number>, n: number): string {
	const entries = Object.entries(tools).sort(
		(a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
	);
	if (entries.length === 0) return "—";
	return entries
		.slice(0, n)
		.map(([name, count]) => `${name}(${count})`)
		.join(", ");
}

function deltaPct(baseline: number, mira: number): string {
	if (baseline === 0) return "n/a";
	const pct = ((mira - baseline) / baseline) * 100;
	const sign = pct > 0 ? "+" : "";
	return `${sign}${pct.toFixed(1)}%`;
}

function fmtRate(rate: number): string {
	return `${(rate * 100).toFixed(0)}%`;
}

function globalVerdict(groups: ScenarioGroup[]): GlobalVerdict {
	const wins = groups.filter((g) => g.verdict === "Win").length;
	const losses = groups.filter((g) => g.verdict === "Loss").length;
	if (wins >= GLOBAL_WIN_MIN_WINS) return "Win";
	if (losses >= 1) return "Loss";
	return "Neutral";
}

async function loadAllMetrics(resultsDir: string): Promise<RunMetrics[]> {
	let entries: string[];
	try {
		entries = await readdir(resultsDir);
	} catch (e) {
		throw new Error(
			`report: cannot read resultsDir "${resultsDir}": ${(e as Error).message}`,
		);
	}
	const out: RunMetrics[] = [];
	for (const name of entries.sort()) {
		const path = join(resultsDir, name, "metrics.json");
		try {
			const raw = await readFile(path, "utf8");
			out.push(JSON.parse(raw) as RunMetrics);
		} catch {
			// Subdir without metrics.json (e.g. smoke jsonl, summary.md alongside).
		}
	}
	if (out.length === 0) {
		throw new Error(`report: no metrics.json found under "${resultsDir}"`);
	}
	return out;
}

function groupByScenario(metrics: RunMetrics[]): ScenarioGroup[] {
	const buckets = new Map<
		string,
		{ baseline: RunMetrics[]; mira: RunMetrics[] }
	>();
	for (const m of metrics) {
		const bucket = buckets.get(m.scenario) ?? { baseline: [], mira: [] };
		bucket[m.mode as Mode].push(m);
		buckets.set(m.scenario, bucket);
	}
	const groups: ScenarioGroup[] = [];
	for (const [scenario, b] of [...buckets.entries()].sort((a, z) =>
		a[0].localeCompare(z[0]),
	)) {
		const g: ScenarioGroup = {
			scenario,
			baseline: b.baseline.length ? aggregateMode(b.baseline) : undefined,
			mira: b.mira.length ? aggregateMode(b.mira) : undefined,
			verdict: "Incomplete",
		};
		g.verdict = scenarioVerdict(g);
		groups.push(g);
	}
	return groups;
}

function renderTable(groups: ScenarioGroup[]): string {
	const header =
		"| scenario | baseline median | mira median | Δ% | baseline success | mira success | mira tools (top 3) | verdict |\n" +
		"|---|---:|---:|---:|---:|---:|---|---|";
	const rows = groups.map((g) => {
		if (!g.baseline || !g.mira) {
			return `| ${g.scenario} | — | — | — | — | — | — | ${g.verdict} |`;
		}
		return `| ${g.scenario} | ${g.baseline.tokensTotalMedian} | ${g.mira.tokensTotalMedian} | ${deltaPct(
			g.baseline.tokensTotalMedian,
			g.mira.tokensTotalMedian,
		)} | ${fmtRate(g.baseline.successRate)} | ${fmtRate(g.mira.successRate)} | ${topTools(
			g.mira.toolsAggregate,
			3,
		)} | ${g.verdict} |`;
	});
	return [header, ...rows].join("\n");
}

const HONESTY_BULLETS = [
	"N=3 per cell — one bad run shifts the median, so close calls should not be over-read.",
	"Synthetic scenarios know the answer; over-suggestive task wording can leak it.",
	"Mira's opt-in advantage only materializes when the agent chooses to skip raw fetches; if Sonnet always fetches everything, Wins won't surface on a single-shot task.",
	"A1–A3 run on Mira's own small codebase, where context selection has little room to differentiate. B1 has more headroom (large typecheck output).",
	"SDK-level token accounting may diverge from production tools (cache reads, etc.). The harness itself is the instrument; if it is wrong, every result is wrong.",
];

function renderHonesty(): string {
	return ["## Honesty axis", "", ...HONESTY_BULLETS.map((b) => `- ${b}`)].join(
		"\n",
	);
}

function renderVerdict(
	groups: ScenarioGroup[],
	verdict: GlobalVerdict,
): string {
	const wins = groups.filter((g) => g.verdict === "Win").length;
	const losses = groups.filter((g) => g.verdict === "Loss").length;
	const neutrals = groups.filter((g) => g.verdict === "Neutral").length;
	const lines = [
		"## Verdict",
		"",
		`Global: **${verdict}** (Win=${wins}, Loss=${losses}, Neutral=${neutrals}, scenarios=${groups.length})`,
	];
	const b1 = groups.find((g) => g.scenario === "B1");
	if (b1?.verdict === "Loss") {
		lines.push(
			"",
			"> Note: B1 is the scenario where Mira's structural advantage is expected to be most visible. A B1 Loss alone is enough to question the hypothesis even if A1–A3 land Neutral.",
		);
	}
	return lines.join("\n");
}

export async function generateReport(
	resultsDir: string,
): Promise<{ markdown: string }> {
	const metrics = await loadAllMetrics(resultsDir);
	const groups = groupByScenario(metrics);
	const verdict = globalVerdict(groups);

	const markdown = [
		"# Mira eval — first experiment summary",
		"",
		renderTable(groups),
		"",
		renderVerdict(groups, verdict),
		"",
		renderHonesty(),
		"",
		"---",
		`_resultsDir: \`${resultsDir}\` · generated: ${new Date().toISOString()}_`,
		"",
	].join("\n");

	await writeFile(join(resultsDir, "summary.md"), markdown, "utf8");
	return { markdown };
}
