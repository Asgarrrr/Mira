import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { HarnessTool } from "../types.ts";
import { resolveInsideWorkdir } from "./path-guard.ts";

export const writeTool: HarnessTool = {
	name: "write",
	description:
		"Overwrite a UTF-8 file with the given content. The path must be workdir-relative; parent dirs are created.",
	inputSchema: {
		type: "object",
		properties: {
			path: {
				type: "string",
				description: "Workdir-relative path to write.",
			},
			content: {
				type: "string",
				description: "Full file contents (UTF-8).",
			},
		},
		required: ["path", "content"],
		additionalProperties: false,
	},
	async run(input, ctx) {
		try {
			const abs = resolveInsideWorkdir(ctx.workdir, String(input.path ?? ""));
			await mkdir(dirname(abs), { recursive: true });
			await writeFile(abs, String(input.content ?? ""), "utf8");
			return { isError: false, content: `wrote ${input.path}` };
		} catch (e) {
			return { isError: true, content: (e as Error).message };
		}
	},
};
