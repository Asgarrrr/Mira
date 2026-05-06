import { readFile } from "node:fs/promises";

import type { HarnessTool } from "../types.ts";
import { resolveInsideWorkdir } from "./path-guard.ts";

export const readTool: HarnessTool = {
	name: "read",
	description:
		"Read a UTF-8 file. The path must be workdir-relative; absolute paths and paths escaping the workdir are rejected.",
	inputSchema: {
		type: "object",
		properties: {
			path: {
				type: "string",
				description: "Workdir-relative path to read.",
			},
		},
		required: ["path"],
		additionalProperties: false,
	},
	async run(input, ctx) {
		try {
			const abs = resolveInsideWorkdir(ctx.workdir, String(input.path ?? ""));
			const content = await readFile(abs, "utf8");
			return { isError: false, content };
		} catch (e) {
			return { isError: true, content: (e as Error).message };
		}
	},
};
