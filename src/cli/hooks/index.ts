// `mira hooks` subcommand — install/uninstall/status the Mira PreToolUse(Bash)
// hook in Claude Code's settings.json.
//
// Pure operations on the settings shape live in `./settings.ts`; settings
// file I/O lives in `./io.ts`. This file owns flag parsing and the dispatch
// into per-subcommand runners.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteSettings, readSettings } from "./io.ts";
import {
	type ClaudeSettings,
	type DiffRow,
	diffHooks,
	type HookStatusRow,
	installClaudeHook,
	listHooks,
	uninstallClaudeHook,
} from "./settings.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");

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

function printPostInstallNotices(
	after: ClaudeSettings,
	parsed: ParsedArgs,
	scriptPath: string,
): void {
	if (parsed.verbose) {
		process.stdout.write(`mira hooks: script   = ${scriptPath}\n`);
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
}

function runInstall(
	parsed: ParsedArgs,
	settingsPath: string,
	scriptPath: string,
): number {
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
	if (parsed.verbose) printDiff(diff);
	printPostInstallNotices(after, parsed, scriptPath);
	return 0;
}

function runUninstall(
	parsed: ParsedArgs,
	settingsPath: string,
	scriptPath: string,
): number {
	if (parsed.agent !== "claude") {
		process.stderr.write("mira hooks uninstall: expected --agent claude\n");
		return 2;
	}
	const before = readSettings(settingsPath);
	const { settings: after, changed } = uninstallClaudeHook(before, scriptPath);
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
	process.stdout.write(`mira hooks: removed Mira entry from ${settingsPath}\n`);
	if (parsed.verbose) printDiff(diff);
	return 0;
}

function runStatus(settingsPath: string): number {
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

export async function runHooks(args: string[]): Promise<number> {
	const sub = args[0];
	if (!sub) {
		process.stderr.write(USAGE);
		return 2;
	}
	const parsed = parseArgs(args.slice(1));
	const settingsPath = resolveSettingsPath(parsed.scope);
	const scriptPath = getDefaultClaudeHookScript();

	if (sub === "install") return runInstall(parsed, settingsPath, scriptPath);
	if (sub === "uninstall")
		return runUninstall(parsed, settingsPath, scriptPath);
	if (sub === "status") return runStatus(settingsPath);

	process.stderr.write(`mira hooks: unknown subcommand "${sub}"\n${USAGE}`);
	return 2;
}
