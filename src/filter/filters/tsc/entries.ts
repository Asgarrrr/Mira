import type { RegistryEntry } from "../../types.ts";
import { tscFilter, TSC_FILTER_VERSION } from "./index.ts";

export const tscEntries: ReadonlyArray<readonly [string, RegistryEntry]> = [
	["tsc", { filter: tscFilter, version: TSC_FILTER_VERSION }],
];
