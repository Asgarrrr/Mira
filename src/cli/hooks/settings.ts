// Pure operations on Claude Code's settings shape — no I/O, no CLI side
// effects. Kept free of `node:fs` so they can be unit-tested with plain
// in-memory objects. The CLI handler in `hooks.ts` wires these to the actual
// settings file with atomic writes.
//
// Liberal in what we accept (existing entries may carry extra fields like
// `timeout`, `statusMessage`); conservative in what we emit.

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
