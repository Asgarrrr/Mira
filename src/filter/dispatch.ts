import { REGISTRY } from "./registry.ts";
import type {
	DispatchResult,
	FilterContext,
	FilterInput,
	RegistryEntry,
} from "./types.ts";

const WRAPPERS = new Set(["pnpm", "npm", "yarn", "bun", "npx", "bunx"]);
const WRAPPER_SUB_TOKENS = new Set(["run", "exec", "dlx", "x"]);
const WRAPPER_BARE_FLAGS = new Set(["--silent", "-s", "--"]);
const WRAPPER_FLAG_PAIRS = new Set(["--filter", "workspace"]);

const ENV_PREFIX = /^(?:[A-Z_][A-Z0-9_]*=\S+\s+)+/;
const SINGLE_TOKEN_FLAG_WITH_VALUE = /^--[^=\s]+=/;

// Upper bound on how many tokens form a registry key. `2` covers the umbrella
// patterns we care about today (`git diff`, `npm test`, `cargo build`); raise
// to 3 the day a `kubectl get pods` style key needs to register. Bumping is a
// constant change with no API impact — `findRegistryEntry` always falls back
// to shorter prefixes.
const MAX_KEY_TOKENS = 2;

// Strip wrapper noise from the front of a command and return the remaining
// tokens (program, sub-program, args, …). `extractTokens` slices the prefix
// used as a registry key.
function postWrapperTokens(command: string): string[] {
	const stripped = command.trimStart().replace(ENV_PREFIX, "");
	const tokens = stripped.split(/\s+/).filter((t) => t.length > 0);

	let i = 0;
	while (i < tokens.length) {
		const head = tokens[i];
		if (head === undefined || !WRAPPERS.has(head)) break;
		i++;
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

	return tokens.slice(i).map((t) => t.replace(/^['"]|['"]$/g, ""));
}

// Returns up to `MAX_KEY_TOKENS` post-wrapper tokens, used by
// `findRegistryEntry` for longest-prefix-match against the registry. For
// `git diff HEAD~1` this returns `["git", "diff"]`; for `tsc --noEmit` it
// returns `["tsc", "--noEmit"]`. Ordering preserved.
export function extractTokens(command: string): string[] {
	return postWrapperTokens(command).slice(0, MAX_KEY_TOKENS);
}

// Longest-prefix match against the registry. Tries the N-token key first,
// falls back through (N-1)…1. Returns `undefined` when no key matches.
//
// Example: for tokens = ["git", "diff"] and a registry holding "git diff" and
// "git", "git diff" wins. For tokens = ["tsc", "--noEmit"] and a registry
// holding only "tsc", the 2-token attempt misses and we fall back to "tsc".
export function findRegistryEntry(
	tokens: string[],
	registry: Map<string, RegistryEntry>,
): RegistryEntry | undefined {
	for (let n = Math.min(tokens.length, MAX_KEY_TOKENS); n >= 1; n--) {
		const key = tokens.slice(0, n).join(" ");
		const entry = registry.get(key);
		if (entry !== undefined) return entry;
	}
	return undefined;
}

export function dispatchFilter(
	command: string,
	input: FilterInput,
	ctx: FilterContext,
): DispatchResult {
	const tokens = extractTokens(command);
	if (tokens.length === 0) return { kind: "miss" };
	const entry = findRegistryEntry(tokens, REGISTRY);
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
		// Surface the program token so the user-facing notice in runCommand
		// remains specific even when we resolved a multi-token key (the first
		// token is the natural anchor for "filter for X threw").
		return { kind: "error", program: tokens[0] ?? "<unknown>", cause };
	}
}
