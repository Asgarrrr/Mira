import { afterEach, describe, expect, test } from "bun:test";

import {
	dispatchFilter,
	extractTokens,
	findRegistryEntry,
} from "../src/filter/dispatch.ts";
import { REGISTRY } from "../src/filter/registry.ts";
import type {
	Filter,
	FilterContext,
	FilterInput,
	RegistryEntry,
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

// First-token outcomes of `extractTokens` after wrapper-stripping. Kept as
// a table because the wrapper grammar (npm/yarn/pnpm/bun/bunx/npx, env
// prefixes, --filter pairs, --silent flags, quoted args) is the fragile
// part of the dispatcher.
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
	["bun --bun tsc", "tsc"],
	["", null],
	["   ", null],
	["pnpm", null],
	["dotenv -- tsc", "dotenv"],
	["time tsc", "time"],
	["./node_modules/.bin/tsc", "./node_modules/.bin/tsc"],
];

describe("extractTokens — wrapper stripping", () => {
	for (const [input, expected] of STRIPPING_CASES) {
		test(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
			expect(extractTokens(input)[0] ?? null).toBe(expected);
		});
	}

	test("returns up to MAX_KEY_TOKENS post-wrapper tokens", () => {
		// MAX_KEY_TOKENS is 2 today — verify the cap behavior at the boundary.
		expect(extractTokens("git diff HEAD~1 -- src/")).toEqual(["git", "diff"]);
	});

	test("strips wrappers before slicing", () => {
		expect(extractTokens("pnpm exec git status")).toEqual(["git", "status"]);
		expect(extractTokens("bunx tsc --noEmit")).toEqual(["tsc", "--noEmit"]);
	});

	test("returns [] on empty / whitespace-only / wrapper-only input", () => {
		expect(extractTokens("")).toEqual([]);
		expect(extractTokens("   ")).toEqual([]);
		expect(extractTokens("pnpm")).toEqual([]);
	});

	test("strips quotes from each returned token", () => {
		expect(extractTokens("pnpm exec 'tsc' '--noEmit'")).toEqual([
			"tsc",
			"--noEmit",
		]);
	});
});

describe("findRegistryEntry", () => {
	const mkFilter = (markdown: string): RegistryEntry => ({
		filter: () => ({ findings: [], markdown }),
		version: "test/1",
	});

	test("returns the entry for a single-token key (canonical lookup)", () => {
		const reg = new Map<string, RegistryEntry>([["tsc", mkFilter("tsc")]]);
		expect(findRegistryEntry(["tsc"], reg)?.version).toBe("test/1");
	});

	test("longest-prefix match prefers the 2-token key when present", () => {
		const reg = new Map<string, RegistryEntry>([
			["git", mkFilter("git")],
			["git diff", mkFilter("git diff")],
		]);
		const entry = findRegistryEntry(["git", "diff"], reg);
		expect(
			entry?.filter(
				{ stdout: "", stderr: "", exitCode: 0, durationMs: 0 },
				{
					command: "",
					cwd: "",
					runId: "",
				},
			).markdown,
		).toBe("git diff");
	});

	test("falls back to a shorter prefix when the longer key is absent", () => {
		const reg = new Map<string, RegistryEntry>([["git", mkFilter("git")]]);
		const entry = findRegistryEntry(["git", "log"], reg);
		expect(
			entry?.filter(
				{ stdout: "", stderr: "", exitCode: 0, durationMs: 0 },
				{
					command: "",
					cwd: "",
					runId: "",
				},
			).markdown,
		).toBe("git");
	});

	test("returns undefined when nothing matches at any prefix", () => {
		const reg = new Map<string, RegistryEntry>([["tsc", mkFilter("tsc")]]);
		expect(findRegistryEntry(["unknown"], reg)).toBeUndefined();
		expect(findRegistryEntry(["unknown", "sub"], reg)).toBeUndefined();
	});

	test("returns undefined on an empty token list", () => {
		const reg = new Map<string, RegistryEntry>([["tsc", mkFilter("tsc")]]);
		expect(findRegistryEntry([], reg)).toBeUndefined();
	});
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

	test("treats zero findings on signal-killed (exitCode=null) output as a miss", () => {
		const filter: Filter = () => ({
			findings: [],
			markdown: "# tsc — pass",
		});
		register("kill-test", filter, "kill-test/1");

		const killedInput: FilterInput = {
			stdout: "partial output before SIGTERM",
			stderr: "",
			exitCode: null,
			signal: "SIGTERM",
			durationMs: 0,
		};
		const result = dispatchFilter("kill-test", killedInput, CTX);
		expect(result).toEqual({ kind: "miss" });
	});

	test("resolves a multi-token key end-to-end (e.g. 'git diff')", () => {
		const view = { findings: [], markdown: "# git diff — 0 changes" };
		const filter: Filter = () => view;
		register("git diff", filter, "git-diff/1");

		const result = dispatchFilter("git diff HEAD~1 -- src/", INPUT, CTX);
		expect(result).toEqual({
			kind: "hit",
			view,
			filterVersion: "git-diff/1",
		});
	});

	test("falls back from a 2-token miss to a 1-token hit", () => {
		const view = { findings: [], markdown: "# git — generic" };
		const filter: Filter = () => view;
		register("git", filter, "git/1");

		// "git log" is not registered; the dispatcher tries "git log" first
		// (miss), then falls back to "git" (hit).
		const result = dispatchFilter("git log --oneline", INPUT, CTX);
		expect(result.kind).toBe("hit");
		if (result.kind === "hit") {
			expect(result.filterVersion).toBe("git/1");
		}
	});

	test("pretty-mode tsc output + non-zero exit → kind: 'miss' (passthrough)", () => {
		// Regression guard: with quarantine-don't-drop the tsc filter now emits
		// info-severity findings for unparsed lines. The glue must short-circuit
		// (return an empty view) on a failed pretty-mode run so the dispatcher's
		// own pretty-mode rule still kicks in.
		const prettyOutput = [
			"src/foo.ts:34:7 - error TS2304: Cannot find name 'Bar'.",
			"",
			"34 const x: Bar = ...",
		].join("\n");
		const result = dispatchFilter(
			"tsc --noEmit",
			{ stdout: prettyOutput, stderr: "", exitCode: 2, durationMs: 5 },
			{ command: "tsc", cwd: "/x", runId: "rPretty" },
		);
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
