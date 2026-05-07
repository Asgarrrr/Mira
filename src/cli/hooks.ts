// `mira hooks` subcommand — installs/uninstalls/lists Mira's PreToolUse(Bash)
// hook in Claude Code's user-scope settings.json.
//
// The pure operations on the settings shape are exported separately so they
// can be tested without touching the filesystem; the CLI entry `runHooks`
// wires them to `~/.claude/settings.json` and provides the user-facing output.
//
// Schema reference (subset):
//   settings.hooks.PreToolUse: Array<{ matcher?; hooks: Array<{ type: "command"; command; ... }> }>
//
// Liberal in what we accept (existing entries may carry `timeout`,
// `statusMessage`, etc.); conservative in what we emit (only `type` + `command`).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

export function getDefaultClaudeHookScript(): string {
	return resolve(REPO_ROOT, "hooks", "claude", "mira-rewrite.sh");
}

export function getDefaultClaudeSettingsPath(): string {
	return resolve(homedir(), ".claude", "settings.json");
}

// ── Pure operations on settings ────────────────────────────────────

export type ClaudeSettings = Record<string, unknown>;

type CommandHook = {
	type: "command";
	command: string;
	[key: string]: unknown;
};

type HookEntry = {
	matcher?: string;
	hooks: CommandHook[];
	[key: string]: unknown;
};

function getPreToolUse(settings: ClaudeSettings): HookEntry[] | undefined {
	const hooks = settings.hooks as Record<string, unknown> | undefined;
	const pre = hooks?.PreToolUse;
	return Array.isArray(pre) ? (pre as HookEntry[]) : undefined;
}

function ensurePreToolUse(settings: ClaudeSettings): HookEntry[] {
	const root = settings as { hooks?: Record<string, unknown> };
	root.hooks ??= {};
	const hooks = root.hooks as Record<string, unknown>;
	if (!Array.isArray(hooks.PreToolUse)) {
		hooks.PreToolUse = [];
	}
	return hooks.PreToolUse as HookEntry[];
}

export function isClaudeHookInstalled(
	settings: ClaudeSettings,
	scriptPath: string,
): boolean {
	const pre = getPreToolUse(settings);
	if (!pre) return false;
	for (const entry of pre) {
		if (!Array.isArray(entry?.hooks)) continue;
		for (const h of entry.hooks) {
			if (h?.type === "command" && typeof h.command === "string") {
				if (h.command === scriptPath || h.command.includes(scriptPath)) {
					return true;
				}
			}
		}
	}
	return false;
}

export function installClaudeHook(
	settings: ClaudeSettings,
	scriptPath: string,
): { settings: ClaudeSettings; changed: boolean } {
	const next = structuredClone(settings);
	if (isClaudeHookInstalled(next, scriptPath)) {
		return { settings: next, changed: false };
	}

	const pre = ensurePreToolUse(next);
	const newHook: CommandHook = { type: "command", command: scriptPath };

	const bashEntry = pre.find((e) => e?.matcher === "Bash");
	if (bashEntry) {
		if (!Array.isArray(bashEntry.hooks)) bashEntry.hooks = [];
		bashEntry.hooks.push(newHook);
	} else {
		pre.push({ matcher: "Bash", hooks: [newHook] });
	}

	return { settings: next, changed: true };
}

export function uninstallClaudeHook(
	settings: ClaudeSettings,
	scriptPath: string,
): { settings: ClaudeSettings; changed: boolean } {
	const next = structuredClone(settings);
	const pre = getPreToolUse(next);
	if (!pre) return { settings: next, changed: false };

	let changed = false;

	for (let i = pre.length - 1; i >= 0; i--) {
		const entry = pre[i];
		if (!Array.isArray(entry?.hooks)) continue;
		const before = entry.hooks.length;
		entry.hooks = entry.hooks.filter((h) => {
			if (h?.type !== "command" || typeof h.command !== "string") return true;
			return h.command !== scriptPath && !h.command.includes(scriptPath);
		});
		if (entry.hooks.length !== before) changed = true;
		// Drop the entry entirely if we emptied its hooks list.
		if (entry.hooks.length === 0) {
			pre.splice(i, 1);
		}
	}

	// Drop the PreToolUse array if we emptied it; same for hooks{}.
	const root = next as { hooks?: Record<string, unknown> };
	if (root.hooks && Array.isArray(root.hooks.PreToolUse)) {
		const arr = root.hooks.PreToolUse as HookEntry[];
		if (arr.length === 0) {
			delete root.hooks.PreToolUse;
		}
		if (Object.keys(root.hooks).length === 0) {
			delete root.hooks;
		}
	}

	return { settings: next, changed };
}

export type HookStatusRow = {
	event: string;
	matcher: string;
	command: string;
	isMira: boolean;
};

export function listHooks(settings: ClaudeSettings): HookStatusRow[] {
	const rows: HookStatusRow[] = [];
	const hooks = settings.hooks as Record<string, unknown> | undefined;
	if (!hooks) return rows;

	for (const [event, value] of Object.entries(hooks)) {
		if (!Array.isArray(value)) continue;
		for (const entry of value as HookEntry[]) {
			const matcher = typeof entry?.matcher === "string" ? entry.matcher : "*";
			if (!Array.isArray(entry?.hooks)) continue;
			for (const h of entry.hooks) {
				if (h?.type !== "command" || typeof h.command !== "string") continue;
				rows.push({
					event,
					matcher,
					command: h.command,
					isMira: h.command.includes("mira-rewrite.sh"),
				});
			}
		}
	}
	return rows;
}

// ── CLI handler ────────────────────────────────────────────────────

const USAGE = `usage: mira hooks <command>

Commands:
  install --agent claude   Install the PreToolUse(Bash) hook in ~/.claude/settings.json
  uninstall --agent claude Remove Mira's hook entry; preserve unrelated hooks
  status                   List all hooks currently installed in ~/.claude/settings.json
`;

function parseAgent(args: string[]): "claude" | null {
	const idx = args.indexOf("--agent");
	if (idx === -1 || idx === args.length - 1) return null;
	const value = args[idx + 1];
	return value === "claude" ? "claude" : null;
}

function readSettings(path: string): ClaudeSettings {
	if (!existsSync(path)) return {};
	try {
		const raw = readFileSync(path, "utf8");
		return JSON.parse(raw) as ClaudeSettings;
	} catch (e) {
		throw new Error(
			`mira hooks: cannot parse ${path}: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

function writeSettings(path: string, settings: ClaudeSettings): void {
	writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

export async function runHooks(args: string[]): Promise<number> {
	const sub = args[0];
	if (!sub) {
		process.stderr.write(USAGE);
		return 2;
	}

	if (sub === "install") {
		const agent = parseAgent(args.slice(1));
		if (agent !== "claude") {
			process.stderr.write("mira hooks install: expected --agent claude\n");
			return 2;
		}
		const settingsPath = getDefaultClaudeSettingsPath();
		const scriptPath = getDefaultClaudeHookScript();
		if (!existsSync(scriptPath)) {
			process.stderr.write(
				`mira hooks install: hook script not found at ${scriptPath}\n`,
			);
			return 1;
		}
		const before = readSettings(settingsPath);
		const { settings: after, changed } = installClaudeHook(before, scriptPath);
		if (!changed) {
			process.stdout.write(`mira hooks: already installed at ${scriptPath}\n`);
			return 0;
		}
		writeSettings(settingsPath, after);
		const coexisting = listHooks(after).filter(
			(r) => r.event === "PreToolUse" && r.matcher === "Bash" && !r.isMira,
		);
		process.stdout.write(`mira hooks: installed → ${settingsPath}\n`);
		process.stdout.write(`           script   = ${scriptPath}\n`);
		if (coexisting.length > 0) {
			process.stdout.write(
				`           coexists with ${coexisting.length} other PreToolUse(Bash) hook(s):\n`,
			);
			for (const row of coexisting) {
				process.stdout.write(`             - ${row.command}\n`);
			}
		}
		process.stdout.write(
			"           Reload via /hooks (or restart Claude Code) for the change to take effect.\n",
		);
		return 0;
	}

	if (sub === "uninstall") {
		const agent = parseAgent(args.slice(1));
		if (agent !== "claude") {
			process.stderr.write("mira hooks uninstall: expected --agent claude\n");
			return 2;
		}
		const settingsPath = getDefaultClaudeSettingsPath();
		const scriptPath = getDefaultClaudeHookScript();
		const before = readSettings(settingsPath);
		const { settings: after, changed } = uninstallClaudeHook(
			before,
			scriptPath,
		);
		if (!changed) {
			process.stdout.write(`mira hooks: not installed (nothing to remove)\n`);
			return 0;
		}
		writeSettings(settingsPath, after);
		process.stdout.write(
			`mira hooks: removed Mira entry from ${settingsPath}\n`,
		);
		return 0;
	}

	if (sub === "status") {
		const settingsPath = getDefaultClaudeSettingsPath();
		const settings = readSettings(settingsPath);
		const rows = listHooks(settings);
		if (rows.length === 0) {
			process.stdout.write(
				`mira hooks: no hooks configured in ${settingsPath}\n`,
			);
			return 0;
		}
		process.stdout.write(`mira hooks status (${settingsPath}):\n`);
		for (const row of rows) {
			const tag = row.isMira ? "[mira]" : "      ";
			process.stdout.write(
				`  ${tag} ${row.event}/${row.matcher} → ${row.command}\n`,
			);
		}
		return 0;
	}

	process.stderr.write(`mira hooks: unknown subcommand "${sub}"\n${USAGE}`);
	return 2;
}
