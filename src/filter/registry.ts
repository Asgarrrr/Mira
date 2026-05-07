import { TSC_FILTER_VERSION, tscFilter } from "./filters/tsc/index.ts";
import type { Filter } from "./types.ts";

// Each entry pairs a filter with a version string (e.g. `"tsc/1"`). The
// version is recorded into `observation.json.filterVersion` on hit so V0.5+
// can re-render an old run with a new filter version and diff against the
// persisted markdown (Axis 3, docs/observation-pipeline.md).
export type RegistryEntry = { filter: Filter; version: string };

export const REGISTRY: Map<string, RegistryEntry> = new Map<
	string,
	RegistryEntry
>([["tsc", { filter: tscFilter, version: TSC_FILTER_VERSION }]]);
