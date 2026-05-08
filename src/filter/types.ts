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

// Lives here (not in `registry.ts`) so `entries.ts` files can import it
// without an import cycle.
export type RegistryEntry = { filter: Filter; version: string };

export type DispatchResult =
	| { kind: "miss" }
	| { kind: "hit"; view: FilteredView; filterVersion: string }
	| { kind: "error"; program: string; cause: unknown };
