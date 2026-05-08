import { describe, expect, test } from "bun:test";

import {
	parseTscOutput,
	parseTscOutputWithStats,
} from "../src/filter/filters/tsc/parser.ts";

describe("parseTscOutput — basic shapes", () => {
	test("returns [] on empty input", () => {
		expect(parseTscOutput("")).toEqual([]);
	});

	test("parses a single diagnostic", () => {
		const text = "src/foo.ts(12,3): error TS2304: Cannot find name 'Bar'.\n";
		const [d] = parseTscOutput(text);
		expect(d).toBeDefined();
		expect(d?.file).toBe("src/foo.ts");
		expect(d?.line).toBe(12);
		expect(d?.column).toBe(3);
		expect(d?.severity).toBe("error");
		expect(d?.ruleId).toBe("TS2304");
		expect(d?.message).toBe("Cannot find name 'Bar'.");
		expect(d?.continuation).toBe("");
		expect(d?.suggestion).toBeUndefined();
		expect(d?.lineStart).toBe(1);
		expect(d?.lineEnd).toBe(1);
	});

	test("attaches indented lines as continuation, not as new diagnostics", () => {
		const text = [
			"tests/foo.test.ts(40,4): error TS2769: No overload matches this call.",
			"  Overload 1 of 2, 'fn(a: A): void', gave the following error.",
			"    Type 'B' is not assignable to type 'A'.",
			"  Overload 2 of 2, 'fn(b: B): void', gave the following error.",
		].join("\n");
		const diags = parseTscOutput(text);
		expect(diags).toHaveLength(1);
		expect(diags[0]?.continuation.split("\n")).toHaveLength(3);
		expect(diags[0]?.lineStart).toBe(1);
		expect(diags[0]?.lineEnd).toBe(4);
	});

	test("parses multiple diagnostics and resets continuation between them", () => {
		const text = [
			"a.ts(1,1): error TS1: msg one",
			"  continuation of one",
			"b.ts(2,2): error TS2: msg two",
		].join("\n");
		const diags = parseTscOutput(text);
		expect(diags).toHaveLength(2);
		expect(diags[0]?.continuation).toBe("  continuation of one");
		expect(diags[1]?.continuation).toBe("");
	});

	test("severity mapping covers warning/info as well as error", () => {
		const text = ["a.ts(1,1): warning TS1: w", "b.ts(2,2): info TS2: i"].join(
			"\n",
		);
		const diags = parseTscOutput(text);
		expect(diags[0]?.severity).toBe("warning");
		expect(diags[1]?.severity).toBe("info");
	});
});

describe("parseTscOutput — Did you mean extraction", () => {
	test("extracts the suggestion and strips it from the message", () => {
		const text =
			"src/u.ts(3,38): error TS2551: Property 'firstNme' does not exist on type 'User'. Did you mean 'firstName'?\n";
		const [d] = parseTscOutput(text);
		expect(d?.suggestion).toBe("firstName");
		expect(d?.message).toBe(
			"Property 'firstNme' does not exist on type 'User'",
		);
	});

	test("leaves suggestion undefined when the message lacks the hint", () => {
		const text = "a.ts(1,1): error TS1: nothing here\n";
		const [d] = parseTscOutput(text);
		expect(d?.suggestion).toBeUndefined();
		expect(d?.message).toBe("nothing here");
	});
});

describe("parseTscOutput — line-ending handling", () => {
	test("parses CRLF input the same as LF", () => {
		const lf =
			"src/foo.ts(1,1): error TS1: msg\nsrc/bar.ts(2,2): error TS2: m2\n";
		const crlf = lf.replace(/\n/g, "\r\n");
		const a = parseTscOutput(lf);
		const b = parseTscOutput(crlf);
		expect(b).toHaveLength(2);
		expect(b[0]?.file).toBe(a[0]?.file);
		expect(b[0]?.message).toBe(a[0]?.message);
		expect(b[1]?.file).toBe(a[1]?.file);
	});

	test("does not leak \\r into rawText or message", () => {
		const crlf = "src/foo.ts(1,1): error TS1: msg\r\n";
		const [d] = parseTscOutput(crlf);
		expect(d?.message).toBe("msg");
		expect(d?.rawText.endsWith("\r")).toBe(false);
	});

	test("does not quarantine whitespace-only lines", () => {
		const text = ["a.ts(1,1): error TS1: msg", "   ", "\t"].join("\n");
		const { unparsedLines } = parseTscOutputWithStats(text);
		expect(unparsedLines).toEqual([]);
	});

	test("normalizes lone \\r so it does not appear in unparsed text", () => {
		const text = "noise without LF\rmore noise\r";
		const { unparsedLines } = parseTscOutputWithStats(text);
		for (const u of unparsedLines) {
			expect(u.text.includes("\r")).toBe(false);
		}
	});
});

describe("parseTscOutput — ANSI handling", () => {
	test("matches diagnostics wrapped in ANSI color escapes", () => {
		const ansi = "\x1b[31m";
		const reset = "\x1b[0m";
		const plain = "src/foo.ts(12,3): error TS2304: Cannot find name 'Bar'.\n";
		const colored = `${ansi}${plain.trimEnd()}${reset}\n`;
		const [a] = parseTscOutput(plain);
		const [b] = parseTscOutput(colored);
		expect(a).toEqual(b);
	});
});

describe("parseTscOutput — pretty-mode is unparsed (dispatcher passthrough)", () => {
	test("returns [] when only --pretty diagnostics are present", () => {
		const text = [
			"src/foo.ts:34:7 - error TS2304: Cannot find name 'Bar'.",
			"",
			"34 const x: Bar = ...",
		].join("\n");
		expect(parseTscOutput(text)).toEqual([]);
	});

	test("does not trip pretty-mode when a non-pretty diagnostic is present", () => {
		const text = [
			"src/foo.ts:34:7 - error TS2304: Cannot find name 'Bar'.",
			"src/bar.ts(1,1): error TS2: real diag",
		].join("\n");
		const diags = parseTscOutput(text);
		expect(diags).toHaveLength(1);
		expect(diags[0]?.file).toBe("src/bar.ts");
	});
});

describe("parseTscOutputWithStats — coverage accounting", () => {
	test("counts diagnostic + continuation lines as parsed", () => {
		const text = [
			"a.ts(1,1): error TS1: msg",
			"  continuation",
			"  more continuation",
		].join("\n");
		const { stats } = parseTscOutputWithStats(text);
		expect(stats.linesTotal).toBe(3);
		expect(stats.linesParsed).toBe(3);
	});

	test("counts the trailing 'Found N errors' summary as parsed", () => {
		const text = ["a.ts(1,1): error TS1: msg", "Found 1 error in 1 file."].join(
			"\n",
		);
		const { stats } = parseTscOutputWithStats(text);
		expect(stats.linesParsed).toBe(2);
		expect(stats.linesTotal).toBe(2);
	});

	test("does not count noise lines as parsed", () => {
		const text = ["a.ts(1,1): error TS1: msg", "noise!"].join("\n");
		const { stats } = parseTscOutputWithStats(text);
		expect(stats.linesTotal).toBe(2);
		expect(stats.linesParsed).toBe(1);
	});
});

describe("parseTscOutputWithStats — unparsed line tracking", () => {
	test("tracks unparsed line indices for noise lines", () => {
		const text = [
			"a.ts(1,1): error TS1: msg",
			"this is unparseable noise",
			"b.ts(2,2): error TS2: msg2",
			"another noise line",
		].join("\n");
		const { unparsedLines } = parseTscOutputWithStats(text);
		expect(unparsedLines).toEqual([
			{ line: 2, text: "this is unparseable noise" },
			{ line: 4, text: "another noise line" },
		]);
	});

	test("skips blanks, summary, continuation lines from the unparsed list", () => {
		const text = [
			"a.ts(1,1): error TS1: msg",
			"  continuation of msg",
			"",
			"Found 1 error in 1 file.",
		].join("\n");
		const { unparsedLines } = parseTscOutputWithStats(text);
		expect(unparsedLines).toEqual([]);
	});

	test("treats orphan continuation (no current diag) as unparsed", () => {
		const text = ["  orphan indented line", "a.ts(1,1): error TS1: msg"].join(
			"\n",
		);
		const { unparsedLines } = parseTscOutputWithStats(text);
		expect(unparsedLines).toEqual([
			{ line: 1, text: "  orphan indented line" },
		]);
	});

	test("fixtures small/medium/large have zero unparsed lines", async () => {
		const dir = `${import.meta.dir}/../src/filter/filters/tsc/__fixtures__`;
		for (const name of ["small.txt", "medium.txt", "large.txt"]) {
			const text = await Bun.file(`${dir}/${name}`).text();
			const { unparsedLines } = parseTscOutputWithStats(text);
			expect(unparsedLines).toEqual([]);
		}
	});
});

describe("parseTscOutput — fixture expectations (committed counts)", () => {
	test("small.txt parses to 2 diagnostics", async () => {
		const text = await Bun.file(
			`${import.meta.dir}/../src/filter/filters/tsc/__fixtures__/small.txt`,
		).text();
		expect(parseTscOutput(text)).toHaveLength(2);
	});

	test("medium.txt parses to 12 diagnostics", async () => {
		const text = await Bun.file(
			`${import.meta.dir}/../src/filter/filters/tsc/__fixtures__/medium.txt`,
		).text();
		expect(parseTscOutput(text)).toHaveLength(12);
	});

	test("large.txt parses to 32 diagnostics", async () => {
		const text = await Bun.file(
			`${import.meta.dir}/../src/filter/filters/tsc/__fixtures__/large.txt`,
		).text();
		expect(parseTscOutput(text)).toHaveLength(32);
	});

	test("each fixture has parser line coverage ≥ 0.85", async () => {
		const dir = `${import.meta.dir}/../src/filter/filters/tsc/__fixtures__`;
		for (const name of ["small.txt", "medium.txt", "large.txt"]) {
			const text = await Bun.file(`${dir}/${name}`).text();
			const { stats } = parseTscOutputWithStats(text);
			const ratio = stats.linesParsed / stats.linesTotal;
			expect(ratio).toBeGreaterThanOrEqual(0.85);
		}
	});
});
