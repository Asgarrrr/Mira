import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

import { miraError } from "./errors.ts";

// Every tool in src/mcp/tools/ takes an explicit absolute `projectRoot` and
// must validate it the same way. Centralised here so the boundary never
// reads `process.cwd()` and so the failure messages stay consistent across
// tools (ADR 0006: "Every tool that touches the project tree takes an
// explicit absolute `projectRoot`").
export function validateProjectRoot(projectRoot: unknown): string {
	if (typeof projectRoot !== "string" || projectRoot.length === 0) {
		throw miraError("INVALID_INPUT", "projectRoot must be a non-empty string");
	}
	if (!isAbsolute(projectRoot)) {
		throw miraError(
			"INVALID_INPUT",
			`projectRoot must be an absolute path; got "${projectRoot}"`,
		);
	}
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(projectRoot);
	} catch {
		throw miraError(
			"INVALID_INPUT",
			`projectRoot does not exist: ${projectRoot}`,
		);
	}
	if (!stat.isDirectory()) {
		throw miraError(
			"INVALID_INPUT",
			`projectRoot is not a directory: ${projectRoot}`,
		);
	}
	return projectRoot;
}
