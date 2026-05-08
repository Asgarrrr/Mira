import { describe, expect, test } from "bun:test";

import { REGISTRY } from "../src/filter/registry.ts";
import type {
	DispatchResult,
	Filter,
	FilterContext,
	FilteredView,
	FilterInput,
} from "../src/filter/types.ts";

describe("filter/registry", () => {
	test("registers tsc with its version", () => {
		const entry = REGISTRY.get("tsc");
		expect(entry).toBeDefined();
		expect(entry?.version).toBe("tsc/3");
		expect(typeof entry?.filter).toBe("function");
	});
});

describe("filter/types", () => {
	test("a fixture Filter type-checks under the exported types", () => {
		const fixture: Filter = (_input, _ctx) => ({
			findings: [],
			markdown: "ok",
		});

		const input: FilterInput = {
			stdout: "",
			stderr: "",
			exitCode: 0,
			durationMs: 1,
		};
		const ctx: FilterContext = {
			command: "noop",
			cwd: "/tmp",
			runId: "run_1",
		};

		const view: FilteredView = fixture(input, ctx);
		expect(view).toEqual({ findings: [], markdown: "ok" });
	});

	test("DispatchResult discriminates miss / hit / error", () => {
		const miss: DispatchResult = { kind: "miss" };
		const hit: DispatchResult = {
			kind: "hit",
			view: { findings: [], markdown: "" },
			filterVersion: "test/1",
		};
		const error: DispatchResult = {
			kind: "error",
			program: "tsc",
			cause: new Error("boom"),
		};

		expect(miss.kind).toBe("miss");
		expect(hit.kind).toBe("hit");
		expect(error.kind).toBe("error");
	});

	test("the module exports the documented public surface", async () => {
		const types = await import("../src/filter/types.ts");
		const registry = await import("../src/filter/registry.ts");

		// Types are erased at runtime — confirm the modules load and the
		// runtime registry surface is present. Type-level exports are
		// verified at compile time by this file's other tests.
		expect(types).toBeDefined();
		expect(registry.REGISTRY).toBeInstanceOf(Map);
	});
});
