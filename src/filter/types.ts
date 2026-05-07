import type { Finding } from "../core/finding.ts";

export type FilterContext = {
	command: string;
	cwd: string;
	runId: string;
};

export type FilterInput = {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	signal?: string;
	durationMs: number;
};

export type FilteredView = {
	findings: Finding[];
	markdown: string;
};

export type Filter = (input: FilterInput, ctx: FilterContext) => FilteredView;

// A registry contribution: the Filter and the version literal recorded into
// `observation.json.filterVersion` on hit. Lives in `types.ts` (not
// `registry.ts`) so per-program `entries.ts` files can reference it without
// creating an import cycle with the registry.
export type RegistryEntry = { filter: Filter; version: string };

// Tagged dispatcher result. Three explicit cases let `runCommand` branch on
// intent (write filtered.md, emit a stderr warning, or just passthrough)
// without inferring from a `null`. See docs/plans/filter-engine/02-dispatcher.md
// and 03-wire-into-run.md.
export type DispatchResult =
	| { kind: "miss" }
	| { kind: "hit"; view: FilteredView; filterVersion: string }
	| { kind: "error"; program: string; cause: unknown };
