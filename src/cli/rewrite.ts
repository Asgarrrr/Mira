// `mira rewrite` — Claude Code PreToolUse(Bash) rewriter.
//
// The hook script (hooks/claude/mira-rewrite.sh) is a thin shell delegate;
// it pipes Claude Code's hook payload through this file. Putting the logic
// in TS means we can unit-test the skip patterns and shell escaping instead
// of relying on bash glob heuristics.
//
// Hook protocol version: 1. Bumped when the input or output JSON shape
// changes; readers can guard on `process.env.MIRA_HOOK_VERSION_REQUIRE`.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HOOK_PROTOCOL_VERSION = 1;

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = resolve(HERE, "index.ts");

type RewriteInput = {
	tool_name?: string;
	tool_input?: { command?: unknown };
};

type RewriteOutput = {
	hookSpecificOutput: {
		hookEventName: "PreToolUse";
		permissionDecision: "allow";
		permissionDecisionReason: string;
		updatedInput: { command: string };
	};
};

// Programs whose entire run is interactive / TTY-driven. The V0 command-
// observer cannot drive these, so we let them through unchanged.
const INTERACTIVE_PROGRAMS = new Set([
	"vim",
	"nvim",
	"vi",
	"nano",
	"emacs",
	"pico",
	"less",
	"more",
	"top",
	"htop",
	"man",
	"info",
]);

export type SkipDecision = { skip: false } | { skip: true; reason: string };

export function shouldSkip(command: string): SkipDecision {
	const cmd = command.trim();
	if (cmd.length === 0) return { skip: true, reason: "empty command" };

	// Idempotence: already wrapped via `mira run` or via `bun .../src/cli/index.ts run`.
	if (/^mira\s+run(\s|$)/.test(cmd)) {
		return { skip: true, reason: "already wrapped (mira run)" };
	}
	// Match `src/cli/index.ts run` anywhere — the path is specific enough that
	// we don't need a leading word boundary (and a `/path/src/cli/index.ts run`
	// shape is exactly what we want to catch).
	if (/src\/cli\/index\.ts\s+run(?:\s|$)/.test(cmd)) {
		return { skip: true, reason: "already wrapped (cli/index.ts run)" };
	}

	// First-token check for interactive programs. Word-anchored (split on
	// whitespace, take token 0); avoids `bunvim` / `nanopb` false positives.
	const firstToken = cmd.split(/\s+/, 1)[0] ?? "";
	if (INTERACTIVE_PROGRAMS.has(firstToken)) {
		return { skip: true, reason: `interactive program: ${firstToken}` };
	}

	// `watch <cmd>` — long-running.
	if (firstToken === "watch") {
		return { skip: true, reason: "watch command" };
	}

	// `tail -f` (with or without other leading flags).
	if (/^tail\b[^|;&]*\s-f(\s|$)/.test(cmd)) {
		return { skip: true, reason: "tail -f (streaming)" };
	}

	// `--watch` flag anywhere (word-anchored, allows `--watch=true`).
	if (/(?:^|\s)--watch(?:$|\s|=)/.test(cmd)) {
		return { skip: true, reason: "--watch flag" };
	}

	// Backgrounded job: trailing ` &` (alone), ` &;`, ` &|`, but NOT `&&`.
	// We match a single `&` that is not part of `&&` and is followed by
	// end-of-string, semicolon, or pipe.
	if (/(?<!&)\s&(?!&)\s*(?:$|[;|])/.test(cmd)) {
		return { skip: true, reason: "backgrounded job (&)" };
	}

	// Heredoc (`<<` or `<<-` followed by an identifier). Common heredoc
	// shapes that V0's observer can't drive.
	if (/\s<<-?\s*['"]?\w+/.test(cmd)) {
		return { skip: true, reason: "heredoc" };
	}

	return { skip: false };
}

// POSIX single-quote escape. Wraps the input in `'...'` and replaces any
// embedded single quote with `'\''` (close quote, escaped quote, reopen).
// Equivalent to jq's `@sh` filter.
export function escapeForShell(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

export function getDefaultMiraCmd(): string {
	const fromEnv = process.env.MIRA_CMD;
	if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
	return `bun ${CLI_ENTRY}`;
}

export function buildRewrittenCommand(
	command: string,
	miraCmd?: string,
): string {
	const cmd = miraCmd ?? getDefaultMiraCmd();
	return `${cmd} run ${escapeForShell(command)}`;
}

export function buildHookOutput(rewritten: string): RewriteOutput {
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "allow",
			permissionDecisionReason: "Mira: capture observation under .mira/runs/",
			updatedInput: { command: rewritten },
		},
	};
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf8");
}

const USAGE = `usage: mira rewrite [--client claude]

Reads a Claude Code PreToolUse hook payload on stdin and emits a hook
response on stdout. Designed to be invoked by the hook script in
hooks/claude/mira-rewrite.sh; not intended for direct use.
`;

export async function runRewrite(args: string[]): Promise<number> {
	// `--client claude` is currently the only supported value; the flag exists
	// for forward compatibility (other agents will land later).
	const clientIdx = args.indexOf("--client");
	if (clientIdx !== -1) {
		if (clientIdx === args.length - 1) {
			process.stderr.write(`mira rewrite: --client requires a value\n${USAGE}`);
			return 2;
		}
		const client = args[clientIdx + 1];
		if (client !== "claude") {
			process.stderr.write(
				`mira rewrite: unknown client "${client}" (only "claude" is supported)\n`,
			);
			return 2;
		}
	}

	const raw = await readStdin();
	if (raw.trim().length === 0) return 0;

	let parsed: RewriteInput;
	try {
		parsed = JSON.parse(raw) as RewriteInput;
	} catch {
		// Malformed JSON — passthrough silently. Crashing here would propagate
		// up to Claude Code as a hook failure and disrupt the user's tool call.
		return 0;
	}

	const command = parsed?.tool_input?.command;
	if (typeof command !== "string" || command.length === 0) return 0;

	const decision = shouldSkip(command);
	if (decision.skip) return 0;

	const rewritten = buildRewrittenCommand(command);
	const output = buildHookOutput(rewritten);
	process.stdout.write(`${JSON.stringify(output)}\n`);
	return 0;
}
