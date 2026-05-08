// Registry contributions for the tsc filter. The central `registry.ts`
// imports + spreads each program's entries; new programs add a single import
// line, no central editing of inline `Map.set` calls.

import type { RegistryEntry } from "../../types.ts";
import { tscFilter, TSC_FILTER_VERSION } from "./index.ts";

export const tscEntries: ReadonlyArray<readonly [string, RegistryEntry]> = [
	["tsc", { filter: tscFilter, version: TSC_FILTER_VERSION }],
];
