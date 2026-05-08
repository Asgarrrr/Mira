import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { clusterDiagnostics } from "../src/filter/filters/tsc/cluster.ts";
import {
	TSC_FILTER_VERSION,
	tscFilter,
} from "../src/filter/filters/tsc/index.ts";
import { parseTscOutput } from "../src/filter/filters/tsc/parser.ts";
import {
	formatLineRanges,
	type RenderOptions,
	renderTscMarkdown,
} from "../src/filter/filters/tsc/render.ts";
import type { FilterInput } from "../src/filter/types.ts";

const FIXTURE_DIR = `${import.meta.dir}/../src/filter/filters/tsc/__fixtures__`;
const STUB_HASH = "deadbeef";

async function readFixture(name: string): Promise<string> {
	return Bun.file(`${FIXTURE_DIR}/${name}`).text();
}

function renderOpts(overrides: Partial<RenderOptions> = {}): RenderOptions {
	return {
		durationMs: 1000,
		filterVersion: TSC_FILTER_VERSION,
		findingsHash: STUB_HASH,
		...overrides,
	};
}

function renderFixture(text: string): string {
	const diags = parseTscOutput(text);
	const clusters = clusterDiagnostics(diags);
	return renderTscMarkdown(clusters, renderOpts());
}

describe("renderTscMarkdown — header shape", () => {
	test("emits a pass header with no findings", () => {
		const md = renderTscMarkdown([], renderOpts({ durationMs: 42 }));
		expect(md.split("\n")[0]).toBe("# tsc — pass");
	});

	test("singularizes 'error' and 'file' counts", () => {
		const text = "src/foo.ts(1,1): error TS1: only one error\n";
		const clusters = clusterDiagnostics(parseTscOutput(text));
		const md = renderTscMarkdown(clusters, renderOpts({ durationMs: 0 }));
		expect(md.split("\n")[0]).toBe("# tsc — 1 error in 1 file");
	});

	test("splits header by severity when both errors and warnings exist", () => {
		const text = [
			"src/a.ts(1,1): error TS1: e",
			"src/b.ts(2,2): warning TS6133: w 'a'",
			"src/b.ts(3,3): warning TS6133: w 'b'",
		].join("\n");
		const md = renderFixture(text);
		expect(md.split("\n")[0]).toBe("# tsc — 1 error, 2 warnings in 2 files");
	});

	test("singularizes per-severity counts when each severity has one diag", () => {
		const text = [
			"src/a.ts(1,1): error TS1: e",
			"src/b.ts(2,2): warning TS6133: w",
		].join("\n");
		const md = renderFixture(text);
		expect(md.split("\n")[0]).toBe("# tsc — 1 error, 1 warning in 2 files");
	});

	test("keeps the bare 'errors' header when no warnings or infos are present", () => {
		const text = [
			"src/a.ts(1,1): error TS1: e1",
			"src/a.ts(2,2): error TS1: e2",
		].join("\n");
		const md = renderFixture(text);
		expect(md.split("\n")[0]).toBe("# tsc — 2 errors in 1 file");
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

describe("renderTscMarkdown — overload-aware continuation", () => {
	test("single overload uses the regular 240-char truncation", () => {
		const tail = "x".repeat(200);
		const text = [
			"a.ts(1,1): error TS2769: No overload matches this call.",
			`  Overload 1 of 1, '(arg: ${tail}): void', gave the following error.`,
		].join("\n");
		const md = renderFixture(text);
		expect(md).toContain("…");
		expect(md).not.toContain("(+0 other");
		expect(md).not.toContain("other overload");
	});

	test("two overloads keep first entire + '(+1 other overload)'", () => {
		const text = [
			"a.ts(1,1): error TS2769: No overload matches this call.",
			"  Overload 1 of 2, 'sigA', gave the following error.",
			"    Argument of type 'X' is not assignable to parameter of type 'Y'.",
			"      Object literal may only specify known properties.",
			"  Overload 2 of 2, 'sigB', gave the following error.",
			"    Argument of type 'X' is not assignable to parameter of type 'Z'.",
		].join("\n");
		const md = renderFixture(text);
		expect(md).toContain("Overload 1 of 2, 'sigA', gave the following error.");
		expect(md).toContain(
			"Argument of type 'X' is not assignable to parameter of type 'Y'.",
		);
		expect(md).toContain("Object literal may only specify known properties.");
		expect(md).toContain("(+1 other overload)");
		expect(md).not.toContain("(+1 other overloads)");
		expect(md).not.toContain("sigB");
	});

	test("three+ overloads: first kept, '(+N other overloads)'", () => {
		const text = [
			"a.ts(1,1): error TS2769: No overload matches this call.",
			"  Overload 1 of 3, 'sigA', gave the following error.",
			"    Argument of type 'X' is not assignable to parameter of type 'Y'.",
			"      Did you mean 'body'?",
			"  Overload 2 of 3, 'sigB', gave the following error.",
			"    Argument of type 'string' is not assignable to parameter of type 'URL'.",
			"  Overload 3 of 3, 'sigC', gave the following error.",
			"    Argument of type 'X' is missing properties from type 'Request'.",
		].join("\n");
		const md = renderFixture(text);
		expect(md).toContain("Overload 1 of 3, 'sigA', gave the following error.");
		expect(md).toContain("Did you mean 'body'?");
		expect(md).toContain("(+2 other overloads)");
		expect(md).not.toContain("sigB");
		expect(md).not.toContain("sigC");
	});

	test("first overload alone past 240 chars is still cut at 240 with …", () => {
		const sig = "x".repeat(300);
		const text = [
			"a.ts(1,1): error TS2769: No overload matches this call.",
			`  Overload 1 of 2, '${sig}', gave the following error.`,
			"  Overload 2 of 2, 'sigB', gave the following error.",
		].join("\n");
		const md = renderFixture(text);
		expect(md).toContain("…");
		expect(md).toContain("(+1 other overload)");
		const overloadLine =
			md.split("\n").find((l) => l.includes("Overload 1 of 2")) ?? "";
		expect(overloadLine.length).toBeLessThan(sig.length);
	});

	test("non-overload continuation falls back to the existing 240-char truncation", () => {
		const long = "x".repeat(300);
		const text = ["a.ts(1,1): error TS1: head", `  ${long}`].join("\n");
		const md = renderFixture(text);
		expect(md).toContain("…");
		expect(md).not.toContain("other overload");
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

	test("caps also-line locations and emits '+N more' past the limit", () => {
		// Build one cluster of 200 same-shape errors in a single file. The
		// e.g. line takes one location, so 199 candidates remain for `also:`.
		// With ALSO_LOCATIONS_LIMIT=50 the line should hold 50 triples and a
		// trailing ` · +149 more` marker.
		const lines: string[] = [];
		for (let i = 1; i <= 200; i++) {
			lines.push(
				`src/foo.ts(${i},7): error TS2739: Type '{ x: ${i}; }' is missing the following properties from type 'Vec': y, z`,
			);
		}
		const md = renderFixture(lines.join("\n"));
		const alsoLine = md.split("\n").find((l) => l.startsWith("  also:")) ?? "";
		expect(alsoLine).toContain("+149 more");
		// 50 visible triples in the also list (e.g. line carries the 200th).
		const triples = alsoLine.match(/\d+:\d+/g) ?? [];
		expect(triples.length).toBe(50);
		// Sanity: the truncation marker keeps the line bounded.
		expect(alsoLine.length).toBeLessThan(700);
	});

	test("does not append '+N more' when the cluster fits under the limit", () => {
		const lines: string[] = [];
		for (let i = 1; i <= 10; i++) {
			lines.push(
				`src/foo.ts(${i},7): error TS2739: Type '{ x: ${i}; }' is missing the following properties from type 'Vec': y, z`,
			);
		}
		const md = renderFixture(lines.join("\n"));
		expect(md).not.toContain("more");
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

describe("renderTscMarkdown — unparsed footer", () => {
	test("emits the ⚠ footer when unparsedLines is non-empty", () => {
		const text = "src/foo.ts(1,1): error TS1: x\n";
		const clusters = clusterDiagnostics(parseTscOutput(text));
		const md = renderTscMarkdown(clusters, renderOpts({ unparsedLines: [42] }));
		expect(md).toContain("⚠ 1 unparsed line — see combined.log:42");
	});

	test("pluralizes 'lines' when more than one", () => {
		const md = renderTscMarkdown(
			[],
			renderOpts({ durationMs: 5, unparsedLines: [10, 11] }),
		);
		expect(md).toContain("⚠ 2 unparsed lines — see combined.log:10-11");
	});

	test("omits the footer when unparsedLines is undefined or empty", () => {
		const text = "src/foo.ts(1,1): error TS1: x\n";
		const clusters = clusterDiagnostics(parseTscOutput(text));
		const a = renderTscMarkdown(clusters, renderOpts());
		const b = renderTscMarkdown(clusters, renderOpts({ unparsedLines: [] }));
		expect(a).not.toContain("⚠");
		expect(b).not.toContain("⚠");
	});

	test("appends footer to the pass header when zero clusters but unparsed lines present", () => {
		const md = renderTscMarkdown(
			[],
			renderOpts({
				durationMs: 7,
				unparsedLines: [3, 4, 5],
				findingsHash: "12345678",
			}),
		);
		expect(md).toBe(
			[
				"# tsc — pass",
				"",
				"⚠ 3 unparsed lines — see combined.log:3-5",
				"",
				`<!-- mira: filterVersion=${TSC_FILTER_VERSION} hash=12345678 duration=7ms -->`,
				"",
			].join("\n"),
		);
	});

	test("separates body bullets from footer with a blank line", () => {
		const text = "src/foo.ts(1,1): error TS1: x\n";
		const clusters = clusterDiagnostics(parseTscOutput(text));
		const md = renderTscMarkdown(
			clusters,
			renderOpts({ durationMs: 0, unparsedLines: [99] }),
		);
		const lines = md.split("\n");
		const footerIdx = lines.findIndex((l) => l.startsWith("⚠"));
		expect(footerIdx).toBeGreaterThan(0);
		expect(lines[footerIdx - 1]).toBe("");
	});
});

describe("formatLineRanges", () => {
	test("returns '' on empty input", () => {
		expect(formatLineRanges([])).toBe("");
	});

	test("renders a singleton as just the number", () => {
		expect(formatLineRanges([42])).toBe("42");
	});

	test("collapses a contiguous span as X-Y", () => {
		expect(formatLineRanges([42, 43, 44])).toBe("42-44");
	});

	test("mixes singletons and spans", () => {
		expect(formatLineRanges([42, 50, 51])).toBe("42, 50-51");
		expect(formatLineRanges([42, 50, 51, 78, 79, 80])).toBe("42, 50-51, 78-80");
	});

	test("sorts unsorted input defensively", () => {
		expect(formatLineRanges([80, 42, 79, 51, 78, 50])).toBe("42, 50-51, 78-80");
	});

	test("deduplicates input", () => {
		expect(formatLineRanges([5, 5, 6])).toBe("5-6");
		expect(formatLineRanges([5, 5])).toBe("5");
	});
});

describe("renderTscMarkdown — cache-stable footer", () => {
	const FOOTER_RE =
		/^<!-- mira: filterVersion=tsc\/6 hash=[0-9a-f]{8} duration=\d+ms -->$/;

	test("header no longer carries (Tms)", () => {
		const text = [
			"src/a.ts(1,1): error TS1: e1",
			"src/b.ts(2,2): error TS1: e2",
		].join("\n");
		const md = renderFixture(text);
		const headerLine = md.split("\n")[0] ?? "";
		expect(headerLine).toBe("# tsc — 2 errors in 2 files");
		expect(headerLine).not.toMatch(/\(\d+ms\)/);
	});

	test("footer appears as the last non-empty line with version, hash, duration", () => {
		const text = "src/foo.ts(1,1): error TS1: x\n";
		const md = renderFixture(text);
		expect(md.trimEnd().endsWith("-->")).toBe(true);
		const lastLine = md.trimEnd().split("\n").at(-1) ?? "";
		expect(lastLine).toMatch(FOOTER_RE);
	});

	test("hash is stable across calls with identical findings", () => {
		const stdout = [
			"src/a.ts(1,1): error TS2304: Cannot find name 'Foo'.",
			"src/b.ts(2,2): error TS2322: Type 'string' is not assignable to type 'number'.",
		].join("\n");
		const a = tscFilter(
			{ stdout, stderr: "", exitCode: 1, durationMs: 100 },
			{ command: "tsc", cwd: "/x", runId: "run_a" },
		);
		const b = tscFilter(
			{ stdout, stderr: "", exitCode: 1, durationMs: 999 },
			{ command: "tsc", cwd: "/x", runId: "run_a" },
		);
		const hashOf = (md: string) => md.match(/hash=([0-9a-f]{8})/)?.[1] ?? "";
		expect(hashOf(a.markdown)).toBe(hashOf(b.markdown));
		expect(hashOf(a.markdown)).toMatch(/^[0-9a-f]{8}$/);
	});

	test("hash differs when findings change", () => {
		const a = tscFilter(
			{
				stdout: "src/a.ts(1,1): error TS2304: Cannot find name 'Foo'.",
				stderr: "",
				exitCode: 1,
				durationMs: 100,
			},
			{ command: "tsc", cwd: "/x", runId: "run_a" },
		);
		const b = tscFilter(
			{
				stdout: "src/b.ts(2,2): error TS2322: Type 'X' is not assignable.",
				stderr: "",
				exitCode: 1,
				durationMs: 100,
			},
			{ command: "tsc", cwd: "/x", runId: "run_a" },
		);
		const hashOf = (md: string) => md.match(/hash=([0-9a-f]{8})/)?.[1] ?? "";
		expect(hashOf(a.markdown)).not.toBe(hashOf(b.markdown));
	});

	test("hash is stable across runs with identical input but different runId", () => {
		// Load-bearing: two real runs of the same tsc invocation must produce
		// byte-identical footers so the prompt cache hits. Before the fix the
		// hash was computed over `Finding[]`, which embedded `.mira/runs/<runId>`
		// paths and so changed on every run.
		const input: FilterInput = {
			stdout: "src/foo.ts(1,1): error TS1: x\n",
			stderr: "",
			exitCode: 2,
			durationMs: 100,
		};
		const viewA = tscFilter(input, {
			command: "tsc",
			cwd: "/x",
			runId: "run_AAAA_111111",
		});
		const viewB = tscFilter(input, {
			command: "tsc",
			cwd: "/x",
			runId: "run_BBBB_222222",
		});

		const extractHash = (md: string) => md.match(/hash=([0-9a-f]{8})/)?.[1];
		const hashA = extractHash(viewA.markdown);
		const hashB = extractHash(viewB.markdown);

		expect(hashA).toBeDefined();
		expect(hashA).toBe(hashB);
	});

	test("hash is the literal sha1(JSON.stringify({diags, unparsedLines})).slice(0, 8) for a known input", () => {
		// Pin the hash function contract: re-using the impl's recipe on the
		// test side means a refactor that changes the input shape forces both
		// sides to update together, while a refactor that touches only the
		// impl trips this assertion.
		const input: FilterInput = {
			stdout: "src/foo.ts(1,1): error TS1: x\n",
			stderr: "",
			exitCode: 2,
			durationMs: 0,
		};
		const view = tscFilter(input, {
			command: "tsc",
			cwd: "/x",
			runId: "run_AAAA_111111",
		});
		const hash = view.markdown.match(/hash=([0-9a-f]{8})/)?.[1];

		const expected = createHash("sha1")
			.update(
				JSON.stringify({
					diags: parseTscOutput("src/foo.ts(1,1): error TS1: x\n"),
					unparsedLines: [],
				}),
			)
			.digest("hex")
			.slice(0, 8);
		expect(hash).toBe(expected);
	});

	test("duration changes do not affect the hash", () => {
		const stdout = "src/a.ts(1,1): error TS1: e\n";
		const a = tscFilter(
			{ stdout, stderr: "", exitCode: 1, durationMs: 1 },
			{ command: "tsc", cwd: "/x", runId: "run_a" },
		);
		const b = tscFilter(
			{ stdout, stderr: "", exitCode: 1, durationMs: 99999 },
			{ command: "tsc", cwd: "/x", runId: "run_a" },
		);
		const hashOf = (md: string) => md.match(/hash=([0-9a-f]{8})/)?.[1] ?? "";
		const durationOf = (md: string) => md.match(/duration=(\d+ms)/)?.[1] ?? "";
		expect(hashOf(a.markdown)).toBe(hashOf(b.markdown));
		expect(durationOf(a.markdown)).not.toBe(durationOf(b.markdown));
	});

	test("pass case has the footer too", () => {
		const view = tscFilter(
			{ stdout: "", stderr: "", exitCode: 0, durationMs: 42 },
			{ command: "tsc", cwd: "/x", runId: "run_pass" },
		);
		const lines = view.markdown.split("\n");
		expect(lines[0]).toBe("# tsc — pass");
		const lastLine = view.markdown.trimEnd().split("\n").at(-1) ?? "";
		expect(lastLine).toMatch(FOOTER_RE);
	});

	test("footer renders after the unparsed-lines warning when both are present", () => {
		const text = "src/foo.ts(1,1): error TS1: x\n";
		const clusters = clusterDiagnostics(parseTscOutput(text));
		const md = renderTscMarkdown(clusters, renderOpts({ unparsedLines: [99] }));
		const lines = md.trimEnd().split("\n");
		const warnIdx = lines.findIndex((l) => l.startsWith("⚠"));
		const cacheIdx = lines.findIndex((l) => l.startsWith("<!-- mira:"));
		expect(warnIdx).toBeGreaterThan(0);
		expect(cacheIdx).toBeGreaterThan(warnIdx);
		// Sandwiched blank line between the two footers.
		expect(lines[cacheIdx - 1]).toBe("");
		expect(lines[warnIdx + 1]).toBe("");
	});
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
		expect(view.markdown).toBe(
			[
				"# tsc — pass",
				"",
				`<!-- mira: filterVersion=${TSC_FILTER_VERSION} hash=f784dd64 duration=42ms -->`,
				"",
			].join("\n"),
		);
	});
});
