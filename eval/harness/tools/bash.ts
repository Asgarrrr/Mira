import type { HarnessTool } from "../types.ts";

// Best-effort sandbox: reject any whitespace-separated token that contains
// `/` unless it begins with `./`/`../` or its absolute portion is on the small
// allowlist. This blocks `cat /etc/passwd`, `cd /`, `x=/etc/passwd`,
// `>/tmp/...`, `</etc/passwd` and similar shapes, while letting `git status`,
// `bun test`, `cat ./tests/foo.ts`, `2>/dev/null` through. It is not a
// security boundary — the agent runs locally and the workdir is mkdtemp'd —
// it is a guard against the agent reaching outside the scenario's tree by
// accident or under prompt drift.
const ABSOLUTE_PATH_ALLOWLIST = new Set(["/dev/null", "/dev/stdin"]);

function rejectAbsolutePathTokens(command: string): string | null {
	const tokens = command.split(/\s+/).filter(Boolean);
	for (const token of tokens) {
		// strip surrounding quotes for matching
		const stripped = token.replace(/^['"]|['"]$/g, "");
		if (!stripped.includes("/")) continue;
		if (stripped.startsWith("./") || stripped.startsWith("../")) continue;
		// Inspect the absolute portion (from first `/` to end). Allows shapes
		// like `2>/dev/null` whose path portion is on the allowlist.
		const pathPortion = stripped.slice(stripped.indexOf("/"));
		if (ABSOLUTE_PATH_ALLOWLIST.has(pathPortion)) continue;
		return stripped;
	}
	return null;
}

export function makeBashTool(timeoutMs: number): HarnessTool {
	return {
		name: "bash",
		description: `Run a shell command. cwd is the workdir. Tokens containing "/" are rejected unless they begin with "./" or "../", or their absolute portion is exactly /dev/null or /dev/stdin (so 2>/dev/null is fine). Use relative paths with explicit ./ prefix. Hard timeout: ${timeoutMs}ms. Returns "exitCode=<n>\\n--stdout--\\n...\\n--stderr--\\n..." text.`,
		inputSchema: {
			type: "object",
			properties: {
				command: {
					type: "string",
					description: "Shell command to execute via /bin/sh -c.",
				},
			},
			required: ["command"],
			additionalProperties: false,
		},
		async run(input, ctx) {
			const command = String(input.command ?? "");
			if (!command.trim()) {
				return { isError: true, content: "command must be non-empty" };
			}
			const offender = rejectAbsolutePathTokens(command);
			if (offender !== null) {
				return {
					isError: true,
					content: `absolute path token rejected: ${offender}`,
				};
			}

			const proc = Bun.spawn(["/bin/sh", "-c", command], {
				cwd: ctx.workdir,
				stdout: "pipe",
				stderr: "pipe",
			});

			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				proc.kill();
			}, timeoutMs);

			const [stdout, stderr] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			const exitCode = await proc.exited;
			clearTimeout(timer);

			const header = timedOut
				? `exitCode=${exitCode} (TIMEOUT after ${timeoutMs}ms)`
				: `exitCode=${exitCode}`;
			return {
				isError: timedOut,
				content: `${header}\n--stdout--\n${stdout}--stderr--\n${stderr}`,
			};
		},
	};
}
