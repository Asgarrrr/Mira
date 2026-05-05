import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

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

	const candidates: string[] = [];
	for (const suffix of TEST_SUFFIXES) {
		const inSameDir = `${stem}${suffix}`;
		candidates.push(dir === "." ? inSameDir : `${dir}/${inSameDir}`);
		const inSiblingTests = `tests/${stem}${suffix}`;
		candidates.push(dir === "." ? inSiblingTests : `${dir}/${inSiblingTests}`);
	}

	const out: ArchitectureSignal[] = [];
	for (const candidate of candidates) {
		if (candidate === rel) continue;
		if (!existsSync(join(cwd, candidate))) continue;
		out.push({
			kind: "test-file",
			path: candidate,
			reason: `test counterpart of ${rel}`,
			source: "filesystem",
			relatedTo: rel,
		});
	}
	return out;
}

function importHintSignals(
	cwd: string,
	rel: string,
	sourceFiles: readonly string[],
	changedSet: ReadonlySet<string>,
): ArchitectureSignal[] {
	const fileName = basename(rel);
	if (!isSourceFile(fileName)) return [];
	const noExt = stripTsExtension(fileName);

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
		if (!hasImportTo(content, fileName, noExt)) continue;
		seen.add(sourceRel);
		out.push({
			kind: "import-hint",
			path: sourceRel,
			reason: `imports a path ending with "${noExt}"`,
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

function stripTsExtension(name: string): string {
	for (const ext of TS_EXTENSIONS) {
		if (name.endsWith(ext)) return name.slice(0, -ext.length);
	}
	return name;
}

function isSourceFile(name: string): boolean {
	return TS_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function hasImportTo(
	content: string,
	fullBasename: string,
	noExtBasename: string,
): boolean {
	const re = /from\s+["']([^"']+)["']/g;
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex.exec loop
	while ((m = re.exec(content)) !== null) {
		const spec = m[1];
		if (!spec) continue;
		const tail = basename(spec);
		if (tail === fullBasename || tail === noExtBasename) return true;
	}
	return false;
}
