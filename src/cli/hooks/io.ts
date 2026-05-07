// Settings file I/O — read with permissive parsing (missing/empty files
// return `{}`) and atomic write via temp+rename so a partial write or crash
// can never corrupt the on-disk settings.

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { ClaudeSettings } from "./settings.ts";

export function readSettings(path: string): ClaudeSettings {
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
export function atomicWriteSettings(
	path: string,
	settings: ClaudeSettings,
): void {
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
