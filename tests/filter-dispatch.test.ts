import { afterEach, describe, expect, test } from "bun:test";

import { dispatchFilter, extractProgramToken } from "../src/filter/dispatch.ts";
import { REGISTRY } from "../src/filter/registry.ts";
import type {
	Filter,
	FilterContext,
	FilterInput,
} from "../src/filter/types.ts";

const INPUT: FilterInput = {
	stdout: "",
	stderr: "",
	exitCode: 0,
	durationMs: 0,
};
const CTX: FilterContext = {
	command: "noop",
	cwd: "/tmp",
	runId: "run_1",
};

const STRIPPING_CASES: Array<[string, string | null]> = [
	["tsc --noEmit", "tsc"],
	["pnpm tsc --noEmit", "tsc"],
	["pnpm exec tsc", "tsc"],
	["pnpm run typecheck", "typecheck"],
	["npm run typecheck", "typecheck"],
	["npx tsc -p .", "tsc"],
	["bunx tsc", "tsc"],
	["bun x tsc", "tsc"],
	["bun run typecheck", "typecheck"],
	["yarn tsc", "tsc"],
	["yarn run typecheck", "typecheck"],
	["pnpm exec --silent tsc", "tsc"],
	["CI=1 NODE_ENV=prod tsc", "tsc"],
	["pnpm --filter foo run typecheck", "typecheck"],
	["pnpm --filter foo tsc", "tsc"],
	["yarn workspace foo tsc", "tsc"],
	["pnpm exec 'tsc'", "tsc"],
	['pnpm exec "tsc"', "tsc"],
	["", null],
	["   ", null],
	["pnpm", null],
	["dotenv -- tsc", "dotenv"],
	["time tsc", "time"],
	["./node_modules/.bin/tsc", "./node_modules/.bin/tsc"],
];

describe("extractProgramToken", () => {
	for (const [input, expected] of STRIPPING_CASES) {
		test(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
			expect(extractProgramToken(input)).toBe(expected);
		});
	}
});

describe("dispatchFilter", () => {
	const registered: string[] = [];

	const register = (program: string, filter: Filter, version: string): void => {
		REGISTRY.set(program, { filter, version });
		registered.push(program);
	};

	afterEach(() => {
		while (registered.length > 0) {
			const program = registered.pop();
			if (program !== undefined) REGISTRY.delete(program);
		}
	});

	test("misses when no filter is registered", () => {
		expect(dispatchFilter("ls -la", INPUT, CTX)).toEqual({ kind: "miss" });
	});

	test("misses on an empty command", () => {
		expect(dispatchFilter("", INPUT, CTX)).toEqual({ kind: "miss" });
	});

	test("hits when a filter is registered for the canonical program", () => {
		const view = { findings: [], markdown: "echo-test ok" };
		const filter: Filter = () => view;
		register("echo-test", filter, "echo-test/1");

		const result = dispatchFilter("echo-test --foo", INPUT, CTX);
		expect(result).toEqual({
			kind: "hit",
			view,
			filterVersion: "echo-test/1",
		});
	});

	test("hits even when the command is wrapped", () => {
		const filter: Filter = () => ({
			findings: [],
			markdown: "wrapped",
		});
		register("echo-test", filter, "echo-test/1");

		const result = dispatchFilter("pnpm exec echo-test", INPUT, CTX);
		expect(result.kind).toBe("hit");
	});

	test("captures filter exceptions and never propagates them", () => {
		const boom = new Error("kaboom");
		const filter: Filter = () => {
			throw boom;
		};
		register("throw-test", filter, "throw-test/1");

		const result = dispatchFilter("throw-test", INPUT, CTX);
		expect(result).toEqual({
			kind: "error",
			program: "throw-test",
			cause: boom,
		});
	});

	test("treats zero findings on non-empty failing output as a miss (pretty-mode passthrough)", () => {
		const filter: Filter = () => ({
			findings: [],
			markdown: "# tsc — pass",
		});
		register("pretty-test", filter, "pretty-test/1");

		const failingInput: FilterInput = {
			stdout: "some pretty output that was not parsed",
			stderr: "",
			exitCode: 2,
			durationMs: 0,
		};
		const result = dispatchFilter("pretty-test", failingInput, CTX);
		expect(result).toEqual({ kind: "miss" });
	});

	test("zero findings on empty input + zero exit code is still a hit (legitimate pass)", () => {
		const view = { findings: [], markdown: "# tsc — pass" };
		const filter: Filter = () => view;
		register("pass-test", filter, "pass-test/1");

		const passInput: FilterInput = {
			stdout: "",
			stderr: "",
			exitCode: 0,
			durationMs: 0,
		};
		const result = dispatchFilter("pass-test", passInput, CTX);
		expect(result).toEqual({
			kind: "hit",
			view,
			filterVersion: "pass-test/1",
		});
	});
});
