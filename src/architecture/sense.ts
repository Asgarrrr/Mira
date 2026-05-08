import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, posix } from "node:path";

import type { ArchitectureSignal } from "./architecture-signal.ts";

const TS_EXTENSIONS = [".ts", ".tsx"] as const;
const TEST_SUFFIXES = [
	".test.ts",
	".test.tsx",
	".spec.ts",
	".spec.tsx",
] as const;

export async function senseArchitecture(
	cwd: string,
): Promise<ArchitectureSignal[]> {
	// `git status --porcelain` reports paths relative to the repo root, not to
	// `cwd`. Resolve the toplevel once so existsSync checks line up when
	// `mira context` is invoked from a subdirectory; signal paths stay
	// repo-root-relative, matching the "relative to project root" contract.
	const root = resolveGitRoot(cwd);
	if (!root) return [];

	const signals: ArchitectureSignal[] = [];

	const changedRel = listChangedFiles(root).filter((rel) =>
		existsSync(join(root, rel)),
	);
	const changedSet = new Set(changedRel);

	for (const rel of changedRel) {
		signals.push({
			kind: "changed-file",
			path: rel,
			reason: "modified or untracked relative to HEAD",
			source: "git",
		});
	}

	for (const rel of changedRel) {
		for (const signal of relatedFileSignals(root, rel)) signals.push(signal);
	}

	for (const rel of changedRel) {
		for (const signal of testFileSignals(root, rel)) signals.push(signal);
	}

	const sourceFiles = listSourceFiles(root);
	for (const rel of changedRel) {
		for (const signal of importHintSignals(
			root,
			rel,
			sourceFiles,
			changedSet,
		)) {
			signals.push(signal);
		}
	}

	return signals;
}

function resolveGitRoot(cwd: string): string | null {
	const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
		cwd,
		encoding: "utf8",
	});
	if (r.status !== 0) return null;
	const out = r.stdout.trim();
	return out.length > 0 ? out : null;
}

function relatedFileSignals(cwd: string, rel: string): ArchitectureSignal[] {
	const dir = dirname(rel);
	const fileName = basename(rel);
	const stem = stemOf(fileName);
	if (!stem) return [];

	let entries: string[];
	try {
		entries = readdirSync(join(cwd, dir));
	} catch {
		return [];
	}

	const out: ArchitectureSignal[] = [];
	for (const entry of entries) {
		if (entry === fileName) continue;
		if (!isSourceFile(entry)) continue;
		if (stemOf(entry) !== stem) continue;
		const candidate = dir === "." ? entry : `${dir}/${entry}`;
		if (!existsSync(join(cwd, candidate))) continue;
		out.push({
			kind: "related-file",
			path: candidate,
			reason: `shares stem "${stem}" with ${rel}`,
			source: "filesystem",
			relatedTo: rel,
		});
	}
	return out;
}

function testFileSignals(cwd: string, rel: string): ArchitectureSignal[] {
	const dir = dirname(rel);
	const stem = stemOf(basename(rel));
	if (!stem) return [];

	const dirPrefix = dir === "." ? "" : `${dir}/`;
	// Five conventional locations for a test counterpart:
	// same-dir, co-located tests/, co-located __tests__/, repo-root tests/,
	// repo-root __tests__/. When dir === "." the co-located and repo-root
	// variants collapse — Set dedupes.
	const prefixes = new Set<string>([
		dirPrefix,
		`${dirPrefix}tests/`,
		`${dirPrefix}__tests__/`,
		"tests/",
		"__tests__/",
	]);

	const out: ArchitectureSignal[] = [];
	const emitted = new Set<string>();
	for (const prefix of prefixes) {
		for (const suffix of TEST_SUFFIXES) {
			const candidate = `${prefix}${stem}${suffix}`;
			if (candidate === rel) continue;
			if (emitted.has(candidate)) continue;
			if (!existsSync(join(cwd, candidate))) continue;
			emitted.add(candidate);
			out.push({
				kind: "test-file",
				path: candidate,
				reason: `test counterpart of ${rel}`,
				source: "filesystem",
				relatedTo: rel,
			});
		}
	}
	return out;
}

function importHintSignals(
	cwd: string,
	rel: string,
	sourceFiles: readonly string[],
	changedSet: ReadonlySet<string>,
): ArchitectureSignal[] {
	if (!isSourceFile(basename(rel))) return [];

	const out: ArchitectureSignal[] = [];
	const seen = new Set<string>();
	for (const sourceRel of sourceFiles) {
		if (sourceRel === rel) continue;
		if (changedSet.has(sourceRel)) continue;
		if (seen.has(sourceRel)) continue;
		let content: string;
		try {
			content = readFileSync(join(cwd, sourceRel), "utf8");
		} catch {
			continue;
		}
		if (!importMatchesChanged(content, sourceRel, rel)) continue;
		seen.add(sourceRel);
		out.push({
			kind: "import-hint",
			path: sourceRel,
			reason: `imports a path resolving to ${rel}`,
			source: "filesystem",
			relatedTo: rel,
		});
	}
	return out;
}

function listChangedFiles(cwd: string): string[] {
	// `-uall` expands untracked directories to individual files; without it git
	// collapses an untracked dir into a single trailing-slash entry.
	const r = spawnSync("git", ["status", "--porcelain=v1", "-z", "-uall"], {
		cwd,
		encoding: "utf8",
	});
	if (r.status !== 0) return [];
	return parsePorcelainZ(r.stdout);
}

function parsePorcelainZ(stdout: string): string[] {
	const tokens = stdout.split("\0");
	const paths: string[] = [];
	let i = 0;
	while (i < tokens.length) {
		const entry = tokens[i];
		if (!entry || entry.length < 3) {
			i++;
			continue;
		}
		const X = entry[0];
		const Y = entry[1];
		const path = entry.slice(3);
		// Renames/copies emit "<status> NEW\0OLD\0"; we want NEW, skip OLD.
		if (X === "R" || X === "C") {
			i += 2;
		} else {
			i += 1;
		}
		// Pure deletes; existence check would also filter them but be explicit.
		if (X === "D" && (Y === " " || Y === "D")) continue;
		paths.push(path);
	}
	return paths;
}

function listSourceFiles(cwd: string): string[] {
	const r = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
		cwd,
		encoding: "utf8",
	});
	if (r.status !== 0) return [];
	return r.stdout.split("\0").filter((p) => p.length > 0 && isSourceFile(p));
}

function stemOf(name: string): string {
	const dot = name.indexOf(".");
	return dot === -1 ? name : name.slice(0, dot);
}

function isSourceFile(name: string): boolean {
	return TS_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function importMatchesChanged(
	content: string,
	importerRel: string,
	changedRel: string,
): boolean {
	const re = /from\s+["']([^"']+)["']/g;
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex.exec loop
	while ((m = re.exec(content)) !== null) {
		const spec = m[1];
		if (!spec) continue;
		// Skip bare specifiers (`from "react"`) and tsconfig-paths aliases
		// (`from "@/x"`). ADR 0005: prefer false negatives over false positives.
		if (!spec.startsWith(".") && !spec.startsWith("/")) continue;
		const importerDir = posix.dirname(importerRel);
		const resolved = posix.normalize(posix.join(importerDir, spec));
		// `..`-prefixed resolutions escape the repo root and can't reference
		// a project-relative changed file.
		if (resolved.startsWith("..")) continue;
		if (resolvedMatchesChanged(resolved, changedRel)) return true;
	}
	return false;
}

function resolvedMatchesChanged(resolved: string, changedRel: string): boolean {
	if (resolved === changedRel) return true;
	for (const ext of TS_EXTENSIONS) {
		if (`${resolved}${ext}` === changedRel) return true;
		if (`${resolved}/index${ext}` === changedRel) return true;
	}
	return false;
}
