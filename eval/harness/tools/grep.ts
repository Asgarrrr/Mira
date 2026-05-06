import type { HarnessTool } from "../types.ts";
import { resolveInsideWorkdir } from "./path-guard.ts";

// Minimal ripgrep wrapper. Falls back to `grep -rn` if rg is not on PATH so the
// harness still works on a stock environment. The agent should not have to
// know about the fallback.
async function hasRipgrep(): Promise<boolean> {
	const proc = Bun.spawn(["/bin/sh", "-c", "command -v rg"], {
		stdout: "ignore",
		stderr: "ignore",
	});
	return (await proc.exited) === 0;
}

export const grepTool: HarnessTool = {
	name: "grep",
	description:
		"Search for a pattern (regex) in a workdir-relative path (default: workdir root). Uses ripgrep when available, otherwise grep -rn.",
	inputSchema: {
		type: "object",
		properties: {
			pattern: {
				type: "string",
				description: "Regex pattern to search for.",
			},
			path: {
				type: "string",
				description:
					"Optional workdir-relative path. Defaults to the workdir root.",
			},
		},
		required: ["pattern"],
		additionalProperties: false,
	},
	async run(input, ctx) {
		const pattern = String(input.pattern ?? "");
		if (!pattern) {
			return { isError: true, content: "pattern must be non-empty" };
		}
		let target = ".";
		if (typeof input.path === "string" && input.path.length > 0) {
			try {
				target = resolveInsideWorkdir(ctx.workdir, input.path);
			} catch (e) {
				return { isError: true, content: (e as Error).message };
			}
		}

		const useRg = await hasRipgrep();
		const argv = useRg
			? [
					"rg",
					"--no-heading",
					"--line-number",
					"--color=never",
					pattern,
					target,
				]
			: ["grep", "-rn", pattern, target];

		const proc = Bun.spawn(argv, {
			cwd: ctx.workdir,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const exitCode = await proc.exited;
		// rg exits 1 on no matches; grep exits 1 on no matches. Both are not errors.
		const noMatch = exitCode === 1 && stderr.length === 0;
		return {
			isError: exitCode > 1,
			content: noMatch
				? "(no matches)"
				: `${stdout}${stderr ? `--stderr--\n${stderr}` : ""}`,
		};
	},
};
