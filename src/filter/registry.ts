import { tscEntries } from "./filters/tsc/entries.ts";
import type { Filter } from "./types.ts";

// Each entry pairs a filter with a version string (e.g. `"tsc/1"`). The
// version is recorded into `observation.json.filterVersion` on hit so V0.5+
// can re-render an old run with a new filter version and diff against the
// persisted markdown (Axis 3, docs/observation-pipeline.md).
export type RegistryEntry = { filter: Filter; version: string };

// Single source of truth for which programs Mira filters. Each program owns
// its `entries.ts`; this file just assembles them. Adding a new filter is one
// import + one spread.
export const REGISTRY: Map<string, RegistryEntry> = new Map<
	string,
	RegistryEntry
>([...tscEntries]);
