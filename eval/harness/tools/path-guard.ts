import { isAbsolute, relative, resolve } from "node:path";

// Resolve `relPath` against `workdir`, refusing absolute inputs and any
// resolved location that escapes the workdir. Symlinks are not resolved here;
// the harness runs in ephemeral mkdtemp dirs where symlink escape is unlikely
// and the failure mode is local (a wrong file read), not a security boundary.
export function resolveInsideWorkdir(workdir: string, relPath: string): string {
	if (typeof relPath !== "string" || relPath.length === 0) {
		throw new Error("path must be a non-empty string");
	}
	if (isAbsolute(relPath)) {
		throw new Error(`absolute paths are rejected: ${relPath}`);
	}
	const absoluteWorkdir = resolve(workdir);
	const resolved = resolve(absoluteWorkdir, relPath);
	const rel = relative(absoluteWorkdir, resolved);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`path escapes workdir: ${relPath}`);
	}
	return resolved;
}
