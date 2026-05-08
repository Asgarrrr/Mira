import type { RegistryEntry } from "../../types.ts";
import { TSC_FILTER_VERSION, tscFilter } from "./index.ts";

export const tscEntries: ReadonlyArray<readonly [string, RegistryEntry]> = [
	["tsc", { filter: tscFilter, version: TSC_FILTER_VERSION }],
];
