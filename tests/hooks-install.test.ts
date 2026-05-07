import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	type ClaudeSettings,
	diffHooks,
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

describe("isClaudeHookInstalled — exact match (P0 #2 fix)", () => {
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

	test("does NOT match a different path that contains scriptPath as a substring", () => {
		// Regression for the original includes() check that false-positived on
		// e.g. /foo/mira-rewrite.sh.bak vs /foo/mira-rewrite.sh.
		const settings: ClaudeSettings = {
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: [{ type: "command", command: `${SCRIPT}.bak` }],
					},
				],
			},
		};
		expect(isClaudeHookInstalled(settings, SCRIPT)).toBe(false);
	});

	test("does NOT match a wrapper command embedding the script path", () => {
		// Old behavior matched `bash ${SCRIPT}` via includes(). New exact-match
		// rejects it: a wrapper has different identity.
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
		expect(isClaudeHookInstalled(settings, SCRIPT)).toBe(false);
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

describe("diffHooks", () => {
	test("flags an addition with kind: added", () => {
		const before: ClaudeSettings = {};
		const { settings: after } = installClaudeHook(before, SCRIPT);
		const d = diffHooks(before, after);
		expect(d).toHaveLength(1);
		const first = at(d, 0);
		expect(first.kind).toBe("added");
		expect(first.row.command).toBe(SCRIPT);
	});

	test("flags a removal with kind: removed", () => {
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
		const { settings: after } = uninstallClaudeHook(before, SCRIPT);
		const d = diffHooks(before, after);
		expect(d).toHaveLength(1);
		const first = at(d, 0);
		expect(first.kind).toBe("removed");
		expect(first.row.command).toBe(SCRIPT);
	});

	test("returns [] when no changes", () => {
		const settings: ClaudeSettings = {
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: [{ type: "command", command: "rtk hook claude" }],
					},
				],
			},
		};
		expect(diffHooks(settings, settings)).toEqual([]);
	});
});

// Integration tests for the runHooks CLI handler — exercises atomic write,
// JSON parsing, and the --scope/--dry-run/--verbose flags against a real
// (but isolated) filesystem.
describe("runHooks (integration)", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeProjectDir(initial?: ClaudeSettings): {
		dir: string;
		settingsPath: string;
	} {
		const dir = mkdtempSync(join(tmpdir(), "mira-hooks-itest-"));
		tempDirs.push(dir);
		const settingsPath = join(dir, ".claude", "settings.json");
		if (initial) {
			require("node:fs").mkdirSync(join(dir, ".claude"), { recursive: true });
			require("node:fs").writeFileSync(
				settingsPath,
				JSON.stringify(initial, null, 2),
			);
		}
		return { dir, settingsPath };
	}

	async function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
		const prior = process.cwd();
		process.chdir(dir);
		try {
			return await fn();
		} finally {
			process.chdir(prior);
		}
	}

	test("install --scope project --dry-run does not write the file", async () => {
		const { dir, settingsPath } = makeProjectDir();
		const { runHooks } = await import("../src/cli/hooks.ts");
		await withCwd(dir, () =>
			runHooks([
				"install",
				"--agent",
				"claude",
				"--scope",
				"project",
				"--dry-run",
			]),
		);
		expect(existsSync(settingsPath)).toBe(false);
	});

	test("install --scope project writes settings.json atomically", async () => {
		const { dir, settingsPath } = makeProjectDir();
		const { runHooks } = await import("../src/cli/hooks.ts");
		const code = await withCwd(dir, () =>
			runHooks(["install", "--agent", "claude", "--scope", "project"]),
		);
		expect(code).toBe(0);
		expect(existsSync(settingsPath)).toBe(true);
		const written = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<
			string,
			unknown
		>;
		const pre = (written.hooks as Record<string, unknown>).PreToolUse as Array<{
			matcher: string;
			hooks: Array<{ command: string }>;
		}>;
		const entry = at(pre, 0);
		expect(entry.matcher).toBe("Bash");
		expect(at(entry.hooks, 0).command.endsWith("mira-rewrite.sh")).toBe(true);
	});

	test("install is idempotent — second invocation is a no-op", async () => {
		const { dir, settingsPath } = makeProjectDir();
		const { runHooks } = await import("../src/cli/hooks.ts");
		await withCwd(dir, () =>
			runHooks(["install", "--agent", "claude", "--scope", "project"]),
		);
		const firstWrite = readFileSync(settingsPath, "utf8");
		await withCwd(dir, () =>
			runHooks(["install", "--agent", "claude", "--scope", "project"]),
		);
		const secondWrite = readFileSync(settingsPath, "utf8");
		expect(secondWrite).toBe(firstWrite);
	});

	test("uninstall --scope project removes the entry and preserves siblings", async () => {
		const { dir, settingsPath } = makeProjectDir({
			permissions: { allow: ["Bash(git *)"] },
			hooks: {
				PostToolUse: [
					{
						matcher: "Write|Edit",
						hooks: [{ type: "command", command: "format.sh" }],
					},
				],
			},
		});
		const { runHooks } = await import("../src/cli/hooks.ts");
		await withCwd(dir, () =>
			runHooks(["install", "--agent", "claude", "--scope", "project"]),
		);
		await withCwd(dir, () =>
			runHooks(["uninstall", "--agent", "claude", "--scope", "project"]),
		);
		const after = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<
			string,
			unknown
		>;
		// PreToolUse should be gone; PostToolUse and permissions preserved.
		const hooks = after.hooks as Record<string, unknown>;
		expect(hooks.PreToolUse).toBeUndefined();
		expect(hooks.PostToolUse).toBeDefined();
		expect(after.permissions).toEqual({ allow: ["Bash(git *)"] });
	});

	test("install --agent without value rejects", async () => {
		const { dir } = makeProjectDir();
		const { runHooks } = await import("../src/cli/hooks.ts");
		const code = await withCwd(dir, () =>
			runHooks(["install", "--scope", "project"]),
		);
		expect(code).toBe(2);
	});

	test("does not leave a tmp file behind on a successful write", async () => {
		const { dir, settingsPath } = makeProjectDir();
		const { runHooks } = await import("../src/cli/hooks.ts");
		await withCwd(dir, () =>
			runHooks(["install", "--agent", "claude", "--scope", "project"]),
		);
		const dotClaude = join(dir, ".claude");
		const fs = require("node:fs");
		const entries = fs.readdirSync(dotClaude) as string[];
		// Only settings.json should remain; no .mira-hooks-*.json.tmp leftovers.
		expect(entries.filter((e) => e.includes(".tmp"))).toEqual([]);
		expect(existsSync(settingsPath)).toBe(true);
	});
});
