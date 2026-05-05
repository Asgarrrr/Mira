import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { z } from "zod";

import type { EvidenceRef } from "../../core/evidence.ts";
import { miraError } from "../errors.ts";
import { validateProjectRoot } from "../project-root.ts";

export const getRawEvidenceInputShape = {
	ref: z
		.object({
			path: z.string(),
			kind: z.string(),
			description: z.string().optional(),
		})
		.describe(
			"Existing EvidenceRef. ref.path is resolved against <projectRoot>/.mira/.",
		),
	projectRoot: z
		.string()
		.describe("Absolute path to the project root that owns the .mira/ store."),
};

export type GetRawEvidenceInput = {
	ref: EvidenceRef;
	projectRoot: string;
};

export type GetRawEvidenceOutput = {
	ref: EvidenceRef;
	bytes: number;
	content: string;
};

// Wraps the Evidence Store's raw read path. The file's resolved location
// must stay inside `<projectRoot>/.mira/`; traversal, out-of-tree absolute
// paths, and symlinks that escape the evidence root are rejected BEFORE any
// read (ADR 0006: "raw evidence must remain accessible" — but never at the
// cost of leaking files outside the evidence root).
export async function runGetRawEvidenceTool(
	input: GetRawEvidenceInput,
): Promise<GetRawEvidenceOutput> {
	const projectRoot = validateProjectRoot(input.projectRoot);
	if (!input.ref || typeof input.ref !== "object") {
		throw miraError("INVALID_INPUT", "ref must be an object");
	}
	const refPath = input.ref.path;
	if (typeof refPath !== "string" || refPath.length === 0) {
		throw miraError("INVALID_INPUT", "ref.path must be a non-empty string");
	}

	const safePath = confineToMiraEvidence(projectRoot, refPath);

	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(safePath);
	} catch (e) {
		const err = e as NodeJS.ErrnoException;
		if (err.code === "ENOENT") {
			throw miraError("NOT_FOUND", `evidence not found: ${refPath}`);
		}
		throw miraError(
			"INTERNAL",
			`failed to stat ${refPath}: ${err.message ?? String(err)}`,
		);
	}
	if (!stat.isFile()) {
		throw miraError("NOT_FOUND", `evidence is not a regular file: ${refPath}`);
	}

	let content: string;
	try {
		content = readFileSync(safePath, "utf8");
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		throw miraError("INTERNAL", `failed to read ${refPath}: ${message}`);
	}

	return {
		ref: input.ref,
		bytes: stat.size,
		content,
	};
}

function confineToMiraEvidence(projectRoot: string, refPath: string): string {
	const miraRoot = resolve(projectRoot, ".mira");

	// `path.resolve(miraRoot, refPath)` covers both forms: when `refPath` is
	// relative it's joined onto `miraRoot`; when it's absolute it replaces
	// `miraRoot`. The lexical containment check below catches the absolute
	// case before any filesystem call.
	const lexCandidate = resolve(miraRoot, refPath);
	if (!isPathInside(lexCandidate, miraRoot)) {
		throw miraError(
			"PATH_OUTSIDE_EVIDENCE",
			`ref.path "${refPath}" resolves outside <projectRoot>/.mira/`,
		);
	}

	// If the file (and `.mira/`) exists, follow symlinks and re-check. This is
	// what catches a symlink under `.mira/` that points outside (e.g. to
	// /etc/hosts). The symlink check happens BEFORE the read so an attacker
	// cannot probe arbitrary files via a crafted symlink.
	if (existsSync(lexCandidate)) {
		let realCandidate: string;
		let realMiraRoot: string;
		try {
			realCandidate = realpathSync(lexCandidate);
			realMiraRoot = realpathSync(miraRoot);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			throw miraError(
				"INTERNAL",
				`failed to resolve realpath for ${refPath}: ${message}`,
			);
		}
		if (!isPathInside(realCandidate, realMiraRoot)) {
			throw miraError(
				"PATH_OUTSIDE_EVIDENCE",
				`ref.path "${refPath}" resolves outside <projectRoot>/.mira/ via a symlink`,
			);
		}
		return realCandidate;
	}

	return lexCandidate;
}

function isPathInside(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	if (rel.length === 0) return true;
	return !rel.startsWith("..") && !isAbsolute(rel);
}
