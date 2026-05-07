import { describe, expect, test } from "bun:test";

import { clusterDiagnostics } from "../src/filter/filters/tsc/cluster.ts";
import { tscFilter } from "../src/filter/filters/tsc/index.ts";
import { parseTscOutput } from "../src/filter/filters/tsc/parser.ts";
import { renderTscMarkdown } from "../src/filter/filters/tsc/render.ts";

const FIXTURE_DIR = `${import.meta.dir}/../src/filter/filters/tsc/__fixtures__`;

async function readFixture(name: string): Promise<string> {
	return Bun.file(`${FIXTURE_DIR}/${name}`).text();
}

function renderFixture(text: string): string {
	const diags = parseTscOutput(text);
	const clusters = clusterDiagnostics(diags);
	return renderTscMarkdown(clusters, { durationMs: 1000 });
}

describe("renderTscMarkdown — header shape", () => {
	test("emits a pass header with no findings", () => {
		const md = renderTscMarkdown([], { durationMs: 42 });
		expect(md).toBe("# tsc — pass (42ms)\n");
	});

	test("singularizes 'error' and 'file' counts", () => {
		const text = "src/foo.ts(1,1): error TS1: only one error\n";
		const clusters = clusterDiagnostics(parseTscOutput(text));
		const md = renderTscMarkdown(clusters, { durationMs: 0 });
		expect(md.split("\n")[0]).toBe("# tsc — 1 error in 1 file (0ms)");
	});

	test("ends with exactly one trailing newline", () => {
		const text = "src/foo.ts(1,1): error TS1: x\n";
		const md = renderFixture(text);
		expect(md.endsWith("\n")).toBe(true);
		expect(md.endsWith("\n\n")).toBe(false);
	});
});

describe("renderTscMarkdown — single-finding bullet", () => {
	test("includes path:line:col, **rule**, and message", () => {
		const text = "src/foo.ts(12,3): error TS2304: Cannot find name 'Bar'.\n";
		const md = renderFixture(text);
		expect(md).toContain(
			"- **TS2304** src/foo.ts:12:3 — Cannot find name 'Bar'.",
		);
	});

	test("renders the Did you mean suggestion on its own indented line", () => {
		const text =
			"src/u.ts(3,38): error TS2551: Property 'firstNme' does not exist on type 'User'. Did you mean 'firstName'?\n";
		const md = renderFixture(text);
		expect(md).toContain("  💡 Did you mean 'firstName'?");
		expect(md).not.toContain("Did you mean 'firstName'?\n  💡");
	});

	test("indents continuation lines and truncates with … past the limit", () => {
		const long = "x".repeat(300);
		const text = ["a.ts(1,1): error TS1: head", `  ${long}`].join("\n");
		const md = renderFixture(text);
		expect(md).toContain("…");
		const longestRenderedLine = md
			.split("\n")
			.reduce((m, l) => Math.max(m, l.length), 0);
		expect(longestRenderedLine).toBeLessThan(long.length);
	});
});

describe("renderTscMarkdown — top-codes summary line", () => {
	test("omits the line when only one unique rule is present", () => {
		const text = [
			"a.ts(1,1): error TS2322: x",
			"b.ts(2,2): error TS2322: y",
		].join("\n");
		const md = renderFixture(text);
		expect(md).not.toContain("_top:");
	});

	test("emits an italic _top: line when ≥2 unique rules are present", () => {
		const text = [
			"a.ts(1,1): error TS2322: x",
			"b.ts(2,2): error TS2304: y",
		].join("\n");
		const md = renderFixture(text);
		const lines = md.split("\n");
		// Top line sits between header and the blank line before bullets.
		expect(lines[0]).toMatch(/^# tsc —/);
		expect(lines[1]).toMatch(/^_top: /);
		expect(lines[1]?.endsWith("_")).toBe(true);
		expect(lines[2]).toBe("");
	});

	test("orders by count desc with ruleId alpha tiebreaker, uses · separator", () => {
		const text = [
			"a.ts(1,1): error TS3000: a",
			"a.ts(2,2): error TS3000: b",
			"a.ts(3,3): error TS3000: c",
			"b.ts(1,1): error TS1000: x",
			"b.ts(2,2): error TS1000: y",
			"c.ts(1,1): error TS2000: z", // count=1, ties-break with TS4000 below
			"d.ts(1,1): error TS4000: w",
		].join("\n");
		const md = renderFixture(text);
		const top = md.split("\n")[1] ?? "";
		expect(top).toBe(
			"_top: TS3000 (3×) · TS1000 (2×) · TS2000 (1×) · TS4000 (1×)_",
		);
	});

	test("caps the top line at 5 entries", () => {
		const codes = ["TS01", "TS02", "TS03", "TS04", "TS05", "TS06", "TS07"];
		const text = codes
			.map((c, i) => `f${i}.ts(1,1): error ${c}: msg ${i}`)
			.join("\n");
		const md = renderFixture(text);
		const top = md.split("\n")[1] ?? "";
		const items = top.replace(/^_top: |_$/g, "").split(" · ");
		expect(items.length).toBe(5);
		// Excluded: the last 2 in alpha order after the count-tiebreaker (TS06, TS07).
		expect(items.join(" ")).not.toContain("TS06");
		expect(items.join(" ")).not.toContain("TS07");
	});
});

describe("renderTscMarkdown — cluster bullet", () => {
	test("emits ×N + same-shape template + e.g. line + grouped also line", () => {
		const lines: string[] = [];
		for (let i = 1; i <= 4; i++) {
			lines.push(
				`src/foo.ts(${i},7): error TS2739: Type '{ x: number; }' is missing the following properties from type 'Vec': y, z`,
			);
		}
		lines.push(
			`src/bar.ts(10,1): error TS2739: Type '{ a: string; }' is missing the following properties from type 'Other': y, z`,
		);
		const md = renderFixture(lines.join("\n"));
		expect(md).toContain("- **TS2739** ×5 — same shape:");
		expect(md).toContain(
			"  e.g. src/bar.ts:10:1 — Type '{ a: string; }' is missing the following properties from type 'Other': y, z",
		);
		// biome-ignore lint/complexity/noAdjacentSpacesInRegex: matches the literal two-space markdown indent emitted by renderMultiCluster, not whitespace-collapsing.
		expect(md).toMatch(/  also: src\/foo\.ts at 1:7, 2:7, 3:7, 4:7/);
	});

	test("groups also-line locations by file with '; ' between groups", () => {
		const text = [
			"a.ts(1,1): error TS1: msg 'x'",
			"a.ts(2,2): error TS1: msg 'y'",
			"b.ts(3,3): error TS1: msg 'z'",
		].join("\n");
		const md = renderFixture(text);
		expect(md).toContain("  also: a.ts at 2:2; b.ts at 3:3");
	});
});

describe("renderTscMarkdown — preservation invariants on fixtures", () => {
	const fixtures = ["small.txt", "medium.txt", "large.txt"];

	for (const name of fixtures) {
		test(`triple coverage holds for ${name}`, async () => {
			const text = await readFixture(name);
			const diags = parseTscOutput(text);
			const md = renderFixture(text);
			for (const d of diags) {
				expect(md).toContain(`**${d.ruleId}**`);
				const inline = `${d.file}:${d.line}:${d.column}`;
				const grouped = `${d.file} at`;
				const hasTriple =
					md.includes(inline) ||
					(md.includes(grouped) && md.includes(`${d.line}:${d.column}`));
				if (!hasTriple) {
					throw new Error(
						`fixture ${name}: missing triple ${inline} (rule ${d.ruleId})`,
					);
				}
			}
		});

		test(`message-body coverage holds for non-cluster findings in ${name}`, async () => {
			const text = await readFixture(name);
			const diags = parseTscOutput(text);
			const clusters = clusterDiagnostics(diags);
			const singletonRuleMessages = new Set<string>();
			for (const c of clusters) {
				const [m] = c.members;
				if (c.members.length === 1 && m !== undefined) {
					singletonRuleMessages.add(`${m.ruleId}::${m.message}`);
				}
			}
			const md = renderFixture(text);
			for (const key of singletonRuleMessages) {
				const sep = key.indexOf("::");
				const message = key.slice(sep + 2);
				expect(md).toContain(message);
			}
		});
	}
});

describe("renderTscMarkdown — snapshots", () => {
	test("small.txt renders to a stable markdown snapshot", async () => {
		const md = renderFixture(await readFixture("small.txt"));
		expect(md).toMatchSnapshot();
	});

	test("medium.txt renders to a stable markdown snapshot", async () => {
		const md = renderFixture(await readFixture("medium.txt"));
		expect(md).toMatchSnapshot();
	});

	test("large.txt renders to a stable markdown snapshot", async () => {
		const md = renderFixture(await readFixture("large.txt"));
		expect(md).toMatchSnapshot();
	});
});

describe("tscFilter — filter-level integration", () => {
	test("returns findings count matching parsed diagnostics + markdown header + run-scoped excerpt path", async () => {
		const stdout = await readFixture("medium.txt");
		const view = tscFilter(
			{ stdout, stderr: "", exitCode: 1, durationMs: 1234 },
			{ command: "tsc --noEmit", cwd: "/x", runId: "run_test" },
		);
		expect(view.findings).toHaveLength(parseTscOutput(stdout).length);
		expect(view.markdown.startsWith("# tsc —")).toBe(true);
		for (const f of view.findings) {
			expect(f.excerpts[0]?.ref.path).toContain("run_test");
			expect(f.evidenceRefs[0]?.path).toContain("run_test");
		}
	});

	test("returns the pass shape on empty input + zero exit", () => {
		const view = tscFilter(
			{ stdout: "", stderr: "", exitCode: 0, durationMs: 42 },
			{ command: "tsc --noEmit", cwd: "/x", runId: "run_pass" },
		);
		expect(view.findings).toEqual([]);
		expect(view.markdown).toBe("# tsc — pass (42ms)\n");
	});
});
