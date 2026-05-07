#!/usr/bin/env bun
// scripts/capture-tokens.ts
//
// Captures Anthropic count_tokens results for each tsc fixture and
// writes src/filter/filters/tsc/__fixtures__/tokens.json. Offline
// tooling — the bench reads the committed counts; this script never
// runs at test time. Plain fetch (not @anthropic-ai/sdk) so we don't
// add a dep tree for a single POST.
//
// Dual-mode (Task 04 → 05 transition): if `tscFilter` cannot be
// imported, only `raw` counts are captured; `filtered_expected` is
// set to null, and a stderr note instructs to re-run after Task 05.
//
// Usage: bun scripts/capture-tokens.ts
//   ANTHROPIC_API_KEY may be set in env or in eval/.env (auto-loaded).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const FIXTURE_DIR = join(
	import.meta.dirname,
	"..",
	"src",
	"filter",
	"filters",
	"tsc",
	"__fixtures__",
);
const FIXTURES = ["small.txt", "medium.txt", "large.txt"] as const;
const MODEL = "claude-opus-4-7";
// Variable path so TS doesn't statically resolve a file that ships in Task 05.
const TSC_INDEX_PATH = "../src/filter/filters/tsc/index.ts";

type FilterInput = {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	durationMs: number;
};
type FilterContext = { command: string; cwd: string; runId: string };
type FilteredView = { markdown: string };
type TscFilterFn = (input: FilterInput, ctx: FilterContext) => FilteredView;

const tscFilterSchema = z.custom<TscFilterFn>((v) => typeof v === "function");
const moduleSchema = z.object({ tscFilter: tscFilterSchema.optional() });
const responseSchema = z.object({ input_tokens: z.number() });

async function loadTscFilter(): Promise<TscFilterFn | null> {
	try {
		const mod: unknown = await import(TSC_INDEX_PATH);
		return moduleSchema.parse(mod).tscFilter ?? null;
	} catch {
		return null;
	}
}

function loadEvalDotenv(): void {
	if (process.env.ANTHROPIC_API_KEY) return;
	const envPath = join(import.meta.dirname, "..", "eval", ".env");
	if (!existsSync(envPath)) return;
	for (const line of readFileSync(envPath, "utf8").split("\n")) {
		const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
		const key = m?.[1];
		const val = m?.[2];
		if (key && val !== undefined && process.env[key] === undefined) {
			process.env[key] = val;
		}
	}
}

async function countTokens(text: string, apiKey: string): Promise<number> {
	const resp = await fetch(
		"https://api.anthropic.com/v1/messages/count_tokens",
		{
			method: "POST",
			headers: {
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: MODEL,
				messages: [{ role: "user", content: text }],
			}),
		},
	);
	if (!resp.ok) {
		throw new Error(`count_tokens HTTP ${resp.status}: ${await resp.text()}`);
	}
	return responseSchema.parse(await resp.json()).input_tokens;
}

loadEvalDotenv();
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
	process.stderr.write("ANTHROPIC_API_KEY missing (env or eval/.env)\n");
	process.exit(1);
}

const tscFilter = await loadTscFilter();
if (tscFilter === null) {
	process.stderr.write(
		"tscFilter not found — re-run after Task 05 to populate filtered_expected\n",
	);
}

const fixtures: Record<
	string,
	{ raw: number; filtered_expected: number | null }
> = {};
for (const name of FIXTURES) {
	const raw = readFileSync(join(FIXTURE_DIR, name), "utf8");
	const rawTokens = await countTokens(raw, apiKey);
	let filteredTokens: number | null = null;
	if (tscFilter !== null) {
		const view = tscFilter(
			{ stdout: raw, stderr: "", exitCode: 2, durationMs: 0 },
			{ command: "tsc --noEmit", cwd: ".", runId: "tokens-capture" },
		);
		filteredTokens = await countTokens(view.markdown, apiKey);
	}
	fixtures[name] = { raw: rawTokens, filtered_expected: filteredTokens };
	const tail =
		filteredTokens === null
			? " filtered_expected=null"
			: ` filtered_expected=${filteredTokens}`;
	process.stderr.write(`${name}: raw=${rawTokens}${tail}\n`);
}

const out = {
	schema: "anthropic-count_tokens-v1",
	model: MODEL,
	captured_at: new Date().toISOString(),
	fixtures,
};

const tokensPath = join(FIXTURE_DIR, "tokens.json");
writeFileSync(tokensPath, `${JSON.stringify(out, null, 2)}\n`);
process.stderr.write(`wrote ${tokensPath}\n`);
