// `mira hooks` subcommand — install/uninstall/status the Mira PreToolUse(Bash)
// hook in Claude Code's settings.json.
//
// Pure operations on the settings shape are exported separately (no I/O) so
// they can be unit-tested. The CLI entry `runHooks` wires them to the actual
// settings file (`~/.claude/settings.json` for user scope or
// `<cwd>/.claude/settings.json` for project scope) with an atomic write and
// optional diff/dry-run output.
//
// Liberal in what we accept (existing entries may carry extra fields like
// `timeout`, `statusMessage`); conservative in what we emit.

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

export function getDefaultClaudeHookScript(): string {
	return resolve(REPO_ROOT, "hooks", "claude", "mira-rewrite.sh");
}

export type SettingsScope = "user" | "project";

export function resolveSettingsPath(scope: SettingsScope): string {
	if (scope === "project") {
		return resolve(process.cwd(), ".claude", "settings.json");
	}
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

// Exact-match: previously this used `String.includes` which false-positives
// when one configured path is a prefix of another (e.g.
// `/foo/mira-rewrite.sh.bak` contains `/foo/mira-rewrite.sh`). Now exact only.
export function isClaudeHookInstalled(
	settings: ClaudeSettings,
	scriptPath: string,
): boolean {
	const pre = getPreToolUse(settings);
	if (!pre) return false;
	for (const entry of pre) {
		if (!Array.isArray(entry?.hooks)) continue;
		for (const h of entry.hooks) {
			if (h?.type === "command" && h.command === scriptPath) return true;
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
			return h.command !== scriptPath;
		});
		if (entry.hooks.length !== before) changed = true;
		if (entry.hooks.length === 0) {
			pre.splice(i, 1);
		}
	}

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
					isMira: h.command.endsWith("mira-rewrite.sh"),
				});
			}
		}
	}
	return rows;
}

export type DiffRow =
	| { kind: "added"; row: HookStatusRow }
	| { kind: "removed"; row: HookStatusRow };

export function diffHooks(
	before: ClaudeSettings,
	after: ClaudeSettings,
): DiffRow[] {
	const beforeRows = listHooks(before);
	const afterRows = listHooks(after);
	const key = (r: HookStatusRow) => `${r.event}/${r.matcher}/${r.command}`;
	const beforeKeys = new Set(beforeRows.map(key));
	const afterKeys = new Set(afterRows.map(key));
	const out: DiffRow[] = [];
	for (const r of afterRows) {
		if (!beforeKeys.has(key(r))) out.push({ kind: "added", row: r });
	}
	for (const r of beforeRows) {
		if (!afterKeys.has(key(r))) out.push({ kind: "removed", row: r });
	}
	return out;
}

// ── I/O helpers ────────────────────────────────────────────────────

function readSettings(path: string): ClaudeSettings {
	if (!existsSync(path)) return {};
	try {
		const raw = readFileSync(path, "utf8");
		const trimmed = raw.trim();
		if (trimmed.length === 0) return {};
		return JSON.parse(raw) as ClaudeSettings;
	} catch (e) {
		throw new Error(
			`mira hooks: cannot parse ${path}: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

// Atomic write: write to a temp file in the same directory, then rename.
// Same-filesystem rename is atomic on POSIX, so a partial write or crash
// leaves the original file untouched.
function atomicWriteSettings(path: string, settings: ClaudeSettings): void {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true });
	const tmp = resolve(dir, `.mira-hooks-${process.pid}-${Date.now()}.json.tmp`);
	try {
		writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
		renameSync(tmp, path);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			// best-effort cleanup
		}
		throw err;
	}
}

// ── CLI handler ────────────────────────────────────────────────────

const USAGE = `usage: mira hooks <command> [flags]

Commands:
  install    Add Mira's PreToolUse(Bash) hook
  uninstall  Remove Mira's PreToolUse(Bash) hook (preserves other hooks)
  status     List hooks currently configured

Flags:
  --agent claude        Required for install/uninstall (only Claude is supported)
  --scope user|project  Settings file to act on (default: user)
  --dry-run             Print what would change; do not write
  --verbose             Print the full diff and resolved paths
`;

type ParsedArgs = {
	agent: "claude" | null;
	scope: SettingsScope;
	dryRun: boolean;
	verbose: boolean;
};

function parseArgs(args: string[]): ParsedArgs {
	let agent: "claude" | null = null;
	let scope: SettingsScope = "user";
	let dryRun = false;
	let verbose = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--agent") {
			const v = args[++i];
			agent = v === "claude" ? "claude" : null;
		} else if (a === "--scope") {
			const v = args[++i];
			if (v === "user" || v === "project") scope = v;
		} else if (a === "--dry-run") {
			dryRun = true;
		} else if (a === "--verbose") {
			verbose = true;
		}
	}
	return { agent, scope, dryRun, verbose };
}

function describeRow(row: HookStatusRow): string {
	const tag = row.isMira ? "[mira]" : "      ";
	return `  ${tag} ${row.event}/${row.matcher} → ${row.command}`;
}

function printDiff(diff: DiffRow[]): void {
	for (const d of diff) {
		const sign = d.kind === "added" ? "+" : "-";
		const tag = d.row.isMira ? "[mira]" : "      ";
		process.stdout.write(
			`  ${sign} ${tag} ${d.row.event}/${d.row.matcher} → ${d.row.command}\n`,
		);
	}
}

export async function runHooks(args: string[]): Promise<number> {
	const sub = args[0];
	if (!sub) {
		process.stderr.write(USAGE);
		return 2;
	}

	const parsed = parseArgs(args.slice(1));
	const settingsPath = resolveSettingsPath(parsed.scope);
	const scriptPath = getDefaultClaudeHookScript();

	if (sub === "install") {
		if (parsed.agent !== "claude") {
			process.stderr.write("mira hooks install: expected --agent claude\n");
			return 2;
		}
		if (!existsSync(scriptPath)) {
			process.stderr.write(
				`mira hooks install: hook script not found at ${scriptPath}\n`,
			);
			return 1;
		}
		const before = readSettings(settingsPath);
		const { settings: after, changed } = installClaudeHook(before, scriptPath);

		if (!changed) {
			process.stdout.write(
				`mira hooks: already installed at ${settingsPath} → ${scriptPath}\n`,
			);
			return 0;
		}

		const diff = diffHooks(before, after);
		if (parsed.dryRun) {
			process.stdout.write(
				`mira hooks: --dry-run (no write) — ${settingsPath}\n`,
			);
			printDiff(diff);
			return 0;
		}

		atomicWriteSettings(settingsPath, after);
		process.stdout.write(`mira hooks: installed → ${settingsPath}\n`);
		if (parsed.verbose) {
			process.stdout.write(`mira hooks: script   = ${scriptPath}\n`);
			printDiff(diff);
		}

		const coexisting = listHooks(after).filter(
			(r) => r.event === "PreToolUse" && r.matcher === "Bash" && !r.isMira,
		);
		if (coexisting.length > 0) {
			process.stdout.write(
				`mira hooks: coexists with ${coexisting.length} other PreToolUse(Bash) hook(s)\n`,
			);
			if (parsed.verbose) {
				for (const row of coexisting) {
					process.stdout.write(`  - ${row.command}\n`);
				}
			}
		}
		process.stdout.write(
			"mira hooks: reload via /hooks (or restart Claude Code) for the change to take effect.\n",
		);
		return 0;
	}

	if (sub === "uninstall") {
		if (parsed.agent !== "claude") {
			process.stderr.write("mira hooks uninstall: expected --agent claude\n");
			return 2;
		}
		const before = readSettings(settingsPath);
		const { settings: after, changed } = uninstallClaudeHook(
			before,
			scriptPath,
		);
		if (!changed) {
			process.stdout.write(
				`mira hooks: not installed at ${settingsPath} (nothing to remove)\n`,
			);
			return 0;
		}

		const diff = diffHooks(before, after);
		if (parsed.dryRun) {
			process.stdout.write(
				`mira hooks: --dry-run (no write) — ${settingsPath}\n`,
			);
			printDiff(diff);
			return 0;
		}

		atomicWriteSettings(settingsPath, after);
		process.stdout.write(
			`mira hooks: removed Mira entry from ${settingsPath}\n`,
		);
		if (parsed.verbose) printDiff(diff);
		return 0;
	}

	if (sub === "status") {
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
			process.stdout.write(`${describeRow(row)}\n`);
		}
		return 0;
	}

	process.stderr.write(`mira hooks: unknown subcommand "${sub}"\n${USAGE}`);
	return 2;
}
