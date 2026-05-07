import { describe, expect, test } from "bun:test";

import {
	clusterDiagnostics,
	normalizeMessage,
} from "../src/filter/filters/tsc/cluster.ts";
import type { TscDiagnostic } from "../src/filter/filters/tsc/parser.ts";

function diag(
	overrides: Partial<TscDiagnostic> & {
		ruleId: string;
		message: string;
		file?: string;
		line?: number;
		column?: number;
	},
): TscDiagnostic {
	return {
		file: "x.ts",
		line: 1,
		column: 1,
		severity: "error",
		continuation: "",
		lineStart: 1,
		lineEnd: 1,
		rawText: "",
		...overrides,
	};
}

describe("normalizeMessage", () => {
	test("replaces every quoted token with <x>", () => {
		const msg =
			"Type '{ x: number; }' is missing the following properties from type 'Point': y, z";
		expect(normalizeMessage(msg)).toBe(
			"Type <x> is missing the following properties from type <x>: y, z",
		);
	});

	test("two messages with the same shape normalize to the same string", () => {
		const a =
			"Type '{ a: string; }' is missing the following properties from type 'Other': b, c";
		const b =
			"Type '{ a: string; }' is missing the following properties from type 'Different': b, c";
		expect(normalizeMessage(a)).toBe(normalizeMessage(b));
	});

	test("messages with different shapes do not normalize equal", () => {
		expect(normalizeMessage("Cannot find name 'X'")).not.toBe(
			normalizeMessage("Cannot find module 'X'"),
		);
	});
});

describe("clusterDiagnostics", () => {
	test("groups same (ruleId, normalized-message) into one cluster", () => {
		const diags = [
			diag({
				ruleId: "TS2739",
				message: "Type '{ a: number }' is missing prop 'x'",
				file: "a.ts",
				line: 1,
			}),
			diag({
				ruleId: "TS2739",
				message: "Type '{ b: string }' is missing prop 'y'",
				file: "b.ts",
				line: 5,
			}),
		];
		const clusters = clusterDiagnostics(diags);
		expect(clusters).toHaveLength(1);
		expect(clusters[0]?.members).toHaveLength(2);
		expect(clusters[0]?.normalizedMessage).toBe("Type <x> is missing prop <x>");
	});

	test("does not cluster across different ruleIds even when normalized messages match", () => {
		const diags = [
			diag({ ruleId: "TS1", message: "Cannot find 'X'" }),
			diag({ ruleId: "TS2", message: "Cannot find 'Y'" }),
		];
		const clusters = clusterDiagnostics(diags);
		expect(clusters).toHaveLength(2);
	});

	test("sorts clusters by descending size, then ruleId, then first-member path", () => {
		const diags = [
			// Cluster A: 1 member, TS1, file z.ts
			diag({ ruleId: "TS1", message: "msg A 'x'", file: "z.ts" }),
			// Cluster B: 2 members, TS2, files a.ts and b.ts
			diag({ ruleId: "TS2", message: "msg B 'x'", file: "b.ts" }),
			diag({ ruleId: "TS2", message: "msg B 'y'", file: "a.ts" }),
		];
		const clusters = clusterDiagnostics(diags);
		expect(clusters).toHaveLength(2);
		expect(clusters[0]?.ruleId).toBe("TS2");
		expect(clusters[0]?.members).toHaveLength(2);
		expect(clusters[0]?.members[0]?.file).toBe("a.ts");
		expect(clusters[1]?.ruleId).toBe("TS1");
	});

	test("sorts cluster members by (file asc, line asc) so members[0] is deterministic", () => {
		const diags = [
			diag({ ruleId: "TS1", message: "m 'x'", file: "b.ts", line: 5 }),
			diag({ ruleId: "TS1", message: "m 'y'", file: "a.ts", line: 10 }),
			diag({ ruleId: "TS1", message: "m 'z'", file: "a.ts", line: 3 }),
		];
		const [c] = clusterDiagnostics(diags);
		expect(c?.members.map((m) => `${m.file}:${m.line}`)).toEqual([
			"a.ts:3",
			"a.ts:10",
			"b.ts:5",
		]);
	});

	test("a single-member cluster is still a cluster", () => {
		const [c] = clusterDiagnostics([diag({ ruleId: "TS1", message: "m 'x'" })]);
		expect(c?.members).toHaveLength(1);
	});

	test("returns [] for empty input", () => {
		expect(clusterDiagnostics([])).toEqual([]);
	});
});
