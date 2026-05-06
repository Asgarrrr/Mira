import type { HarnessTool } from "../types.ts";

// Best-effort sandbox: reject any whitespace-separated token that starts with
// `/` unless it is on the small allowlist. This blocks `cat /etc/passwd` and
// `cd /` while letting `git status`, `bun test`, `rg foo` through. It is not
// a security boundary — the agent runs locally and the workdir is mkdtemp'd —
// it is a guard against the agent reaching outside the scenario's tree by
// accident or under prompt drift.
const ABSOLUTE_PATH_ALLOWLIST = new Set(["/dev/null", "/dev/stdin"]);

function rejectAbsolutePathTokens(command: string): string | null {
	const tokens = command.split(/\s+/).filter(Boolean);
	for (const token of tokens) {
		// strip surrounding quotes for matching
		const stripped = token.replace(/^['"]|['"]$/g, "");
		if (stripped.startsWith("/") && !ABSOLUTE_PATH_ALLOWLIST.has(stripped)) {
			return stripped;
		}
	}
	return null;
}

export function makeBashTool(timeoutMs: number): HarnessTool {
	return {
		name: "bash",
		description: `Run a shell command. cwd is the workdir. Absolute paths in the command are rejected (allowlist: /dev/null, /dev/stdin). Hard timeout: ${timeoutMs}ms. Returns "exitCode=<n>\\n--stdout--\\n...\\n--stderr--\\n..." text.`,
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
