// Test-only entry point that mirrors `src/cli/index.ts run` but registers a
// fixture filter into the in-process REGISTRY before delegating. Used by
// `tests/cli-run-filter.e2e.test.ts` to exercise the filter wiring without
// shipping a production filter. The mode is selected via the
// `MIRA_FILTER_FIXTURE_MODE` env var.
import { runCommand } from "../../src/cli/run.ts";
import { REGISTRY } from "../../src/filter/registry.ts";
import type { Filter } from "../../src/filter/types.ts";

const mode = process.env.MIRA_FILTER_FIXTURE_MODE;

if (mode === "hit") {
	const filter: Filter = () => ({
		findings: [
			{
				id: "fix-1",
				severity: "error",
				title: "fixture finding",
				description: "fixture finding from echo bootstrap",
				excerpts: [],
				evidenceRefs: [],
			},
		],
		markdown: "## test\nbody",
	});
	REGISTRY.set("echo", { filter, version: "echo/1" });
}

if (mode === "throw") {
	const filter: Filter = () => {
		throw new Error("fixture filter exploded");
	};
	REGISTRY.set("echo", { filter, version: "echo/1" });
}

const code = await runCommand(process.argv.slice(2));
process.exit(code);
