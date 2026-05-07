import { describe, expect, test } from "bun:test";

import {
	type ClaudeSettings,
	installClaudeHook,
	isClaudeHookInstalled,
	listHooks,
	uninstallClaudeHook,
} from "../src/cli/hooks.ts";

const SCRIPT = "/abs/path/hooks/claude/mira-rewrite.sh";

// Test helper: index into an array and assert the element exists. Mira's
// tsconfig sets `noUncheckedIndexedAccess`, so `arr[i]` returns `T | undefined`
// even after a length check; this gives us a typed access without sprinkling
// `!` non-null assertions through the assertions.
function at<T>(arr: readonly T[], i: number): T {
	const v = arr[i];
	if (v === undefined) throw new Error(`expected index ${i} to be defined`);
	return v;
}

describe("installClaudeHook", () => {
	test("adds PreToolUse(Bash) entry to empty settings", () => {
		const before: ClaudeSettings = {};
		const { settings: after, changed } = installClaudeHook(before, SCRIPT);

		expect(changed).toBe(true);
		const hooks = (after.hooks as Record<string, unknown>).PreToolUse as Array<{
			matcher: string;
			hooks: Array<{ type: string; command: string }>;
		}>;
		expect(hooks).toHaveLength(1);
		const entry = at(hooks, 0);
		expect(entry.matcher).toBe("Bash");
		expect(entry.hooks).toHaveLength(1);
		expect(at(entry.hooks, 0)).toEqual({ type: "command", command: SCRIPT });
	});

	test("preserves an existing rtk hook by appending to the same Bash entry", () => {
		const before: ClaudeSettings = {
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: [{ type: "command", command: "rtk hook claude" }],
					},
				],
			},
		};
		const { settings: after, changed } = installClaudeHook(before, SCRIPT);

		expect(changed).toBe(true);
		const entries = (after.hooks as Record<string, unknown>)
			.PreToolUse as Array<{
			matcher: string;
			hooks: Array<{ type: string; command: string }>;
		}>;
		expect(entries).toHaveLength(1);
		const entry = at(entries, 0);
		expect(entry.hooks).toHaveLength(2);
		expect(at(entry.hooks, 0).command).toBe("rtk hook claude");
		expect(at(entry.hooks, 1).command).toBe(SCRIPT);
	});

	test("is idempotent — second install is a no-op", () => {
		const before: ClaudeSettings = {};
		const { settings: once } = installClaudeHook(before, SCRIPT);
		const { settings: twice, changed } = installClaudeHook(once, SCRIPT);

		expect(changed).toBe(false);
		expect(twice).toEqual(once);
	});

	test("creates a Bash entry alongside non-Bash entries", () => {
		const before: ClaudeSettings = {
			hooks: {
				PreToolUse: [
					{
						matcher: "Write|Edit",
						hooks: [{ type: "command", command: "format-on-edit.sh" }],
					},
				],
			},
		};
		const { settings: after, changed } = installClaudeHook(before, SCRIPT);

		expect(changed).toBe(true);
		const entries = (after.hooks as Record<string, unknown>)
			.PreToolUse as Array<{ matcher: string }>;
		expect(entries).toHaveLength(2);
		expect(entries.find((e) => e.matcher === "Bash")).toBeDefined();
		expect(entries.find((e) => e.matcher === "Write|Edit")).toBeDefined();
	});

	test("preserves unrelated top-level keys", () => {
		const before: ClaudeSettings = {
			$schema: "https://json.schemastore.org/claude-code-settings.json",
			permissions: { allow: ["Bash(git *)"] },
			theme: "dark",
		};
		const { settings: after } = installClaudeHook(before, SCRIPT);

		expect(after.$schema).toBe(
			"https://json.schemastore.org/claude-code-settings.json",
		);
		expect(after.permissions).toEqual({ allow: ["Bash(git *)"] });
		expect(after.theme).toBe("dark");
	});

	test("does not mutate the input settings", () => {
		const before: ClaudeSettings = { hooks: { PreToolUse: [] } };
		const beforeSnapshot = structuredClone(before);
		installClaudeHook(before, SCRIPT);
		expect(before).toEqual(beforeSnapshot);
	});
});

describe("uninstallClaudeHook", () => {
	test("removes Mira entry and preserves rtk", () => {
		const before: ClaudeSettings = {
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: [
							{ type: "command", command: "rtk hook claude" },
							{ type: "command", command: SCRIPT },
						],
					},
				],
			},
		};
		const { settings: after, changed } = uninstallClaudeHook(before, SCRIPT);

		expect(changed).toBe(true);
		const entries = (after.hooks as Record<string, unknown>)
			.PreToolUse as Array<{
			hooks: Array<{ command: string }>;
		}>;
		const entry = at(entries, 0);
		expect(entry.hooks).toHaveLength(1);
		expect(at(entry.hooks, 0).command).toBe("rtk hook claude");
	});

	test("returns changed: false when Mira hook is absent", () => {
		const before: ClaudeSettings = {
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: [{ type: "command", command: "rtk hook claude" }],
					},
				],
			},
		};
		const { changed } = uninstallClaudeHook(before, SCRIPT);
		expect(changed).toBe(false);
	});

	test("drops empty Bash entry after removing the only Mira hook", () => {
		const before: ClaudeSettings = {
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: [{ type: "command", command: SCRIPT }],
					},
				],
			},
		};
		const { settings: after, changed } = uninstallClaudeHook(before, SCRIPT);

		expect(changed).toBe(true);
		// Bash entry was the only one, so PreToolUse and hooks{} get cleaned up.
		expect(after.hooks).toBeUndefined();
	});

	test("preserves other-event hooks when cleaning PreToolUse", () => {
		const before: ClaudeSettings = {
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: [{ type: "command", command: SCRIPT }],
					},
				],
				PostToolUse: [
					{
						matcher: "Write|Edit",
						hooks: [{ type: "command", command: "format-on-edit.sh" }],
					},
				],
			},
		};
		const { settings: after, changed } = uninstallClaudeHook(before, SCRIPT);

		expect(changed).toBe(true);
		const post = (after.hooks as Record<string, unknown>).PostToolUse;
		expect(post).toBeDefined();
		expect((after.hooks as Record<string, unknown>).PreToolUse).toBeUndefined();
	});

	test("does not mutate the input settings", () => {
		const before: ClaudeSettings = {
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: [{ type: "command", command: SCRIPT }],
					},
				],
			},
		};
		const beforeSnapshot = structuredClone(before);
		uninstallClaudeHook(before, SCRIPT);
		expect(before).toEqual(beforeSnapshot);
	});
});

describe("isClaudeHookInstalled", () => {
	test("matches an exact command path", () => {
		const settings: ClaudeSettings = {
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: [{ type: "command", command: SCRIPT }],
					},
				],
			},
		};
		expect(isClaudeHookInstalled(settings, SCRIPT)).toBe(true);
	});

	test("matches a substring (path embedded in larger command)", () => {
		const settings: ClaudeSettings = {
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: [{ type: "command", command: `bash ${SCRIPT}` }],
					},
				],
			},
		};
		expect(isClaudeHookInstalled(settings, SCRIPT)).toBe(true);
	});

	test("returns false when settings lacks PreToolUse", () => {
		expect(isClaudeHookInstalled({}, SCRIPT)).toBe(false);
		expect(isClaudeHookInstalled({ hooks: {} }, SCRIPT)).toBe(false);
	});
});

describe("listHooks", () => {
	test("flags Mira hooks via the isMira field", () => {
		const settings: ClaudeSettings = {
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: [
							{ type: "command", command: "rtk hook claude" },
							{ type: "command", command: SCRIPT },
						],
					},
				],
			},
		};
		const rows = listHooks(settings);
		expect(rows).toHaveLength(2);
		const first = rows[0];
		const second = rows[1];
		if (!first || !second) throw new Error("rows narrowing");
		expect(first.command).toBe("rtk hook claude");
		expect(first.isMira).toBe(false);
		expect(second.command).toBe(SCRIPT);
		expect(second.isMira).toBe(true);
	});

	test("walks every event, not just PreToolUse", () => {
		const settings: ClaudeSettings = {
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: [{ type: "command", command: SCRIPT }],
					},
				],
				PostToolUse: [
					{
						matcher: "Write|Edit",
						hooks: [{ type: "command", command: "format.sh" }],
					},
				],
			},
		};
		const rows = listHooks(settings);
		const events = new Set(rows.map((r) => r.event));
		expect(events.has("PreToolUse")).toBe(true);
		expect(events.has("PostToolUse")).toBe(true);
	});

	test("returns [] for settings without hooks", () => {
		expect(listHooks({})).toEqual([]);
	});

	test("uses '*' as the matcher when none is set", () => {
		const settings: ClaudeSettings = {
			hooks: {
				PreToolUse: [{ hooks: [{ type: "command", command: "x" }] }],
			},
		};
		const rows = listHooks(settings);
		const first = rows[0];
		if (!first) throw new Error("rows narrowing");
		expect(first.matcher).toBe("*");
	});
});
