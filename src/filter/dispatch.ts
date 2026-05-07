import { REGISTRY } from "./registry.ts";
import type { DispatchResult, FilterContext, FilterInput } from "./types.ts";

const WRAPPERS = new Set(["pnpm", "npm", "yarn", "bun", "npx", "bunx"]);
const WRAPPER_SUB_TOKENS = new Set(["run", "exec", "dlx", "x"]);
const WRAPPER_BARE_FLAGS = new Set(["--silent", "-s", "--"]);
const WRAPPER_FLAG_PAIRS = new Set(["--filter", "workspace"]);

const ENV_PREFIX = /^(?:[A-Z_][A-Z0-9_]*=\S+\s+)+/;
const SINGLE_TOKEN_FLAG_WITH_VALUE = /^--[^=\s]+=/;

export function extractProgramToken(command: string): string | null {
	const stripped = command.trimStart().replace(ENV_PREFIX, "");
	const tokens = stripped.split(/\s+/).filter((t) => t.length > 0);

	let i = 0;
	while (i < tokens.length) {
		const head = tokens[i];
		if (head === undefined || !WRAPPERS.has(head)) break;
		i++;
		// Inside the wrapper iteration, repeatedly consume "wrapper noise" from
		// the front: sub-commands (`run`, `exec`, `dlx`, `x`), bare flags
		// (`--silent`, `-s`, `--`), single-token flag-with-value (`--key=val`),
		// and known flag-value pairs (`--filter foo`, `workspace foo`). Stop as
		// soon as none of these match — the next token is either another
		// wrapper (outer loop continues) or the program.
		while (i < tokens.length) {
			const next = tokens[i];
			if (next === undefined) break;
			if (
				WRAPPER_SUB_TOKENS.has(next) ||
				WRAPPER_BARE_FLAGS.has(next) ||
				SINGLE_TOKEN_FLAG_WITH_VALUE.test(next)
			) {
				i++;
				continue;
			}
			if (WRAPPER_FLAG_PAIRS.has(next) && i + 1 < tokens.length) {
				i += 2;
				continue;
			}
			break;
		}
	}

	const program = tokens[i];
	if (program === undefined) return null;
	return program.replace(/^['"]|['"]$/g, "");
}

export function dispatchFilter(
	command: string,
	input: FilterInput,
	ctx: FilterContext,
): DispatchResult {
	const program = extractProgramToken(command);
	if (program === null) return { kind: "miss" };
	const entry = REGISTRY.get(program);
	if (entry === undefined) return { kind: "miss" };
	try {
		const view = entry.filter(input, ctx);
		// Pretty-mode passthrough: if a filter saw non-empty output on a
		// non-successful run but produced zero findings, its parser hit a
		// format it does not recognize (e.g. tsc `--pretty` mode) or the run
		// was signal-killed. Treat as miss so the agent gets raw output
		// instead of a wrong "<program> — pass" header. `exitCode !== 0`
		// covers both non-zero (failed) and `null` (signal-killed).
		if (
			view.findings.length === 0 &&
			input.stdout.length + input.stderr.length > 0 &&
			input.exitCode !== 0
		) {
			return { kind: "miss" };
		}
		return { kind: "hit", view, filterVersion: entry.version };
	} catch (cause) {
		return { kind: "error", program, cause };
	}
}
