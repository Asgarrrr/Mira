import { tscEntries } from "./filters/tsc/entries.ts";
import type { RegistryEntry } from "./types.ts";

// Single source of truth for which programs Mira filters. Each program owns
// its `entries.ts`; this file just assembles them.
export const REGISTRY: Map<string, RegistryEntry> = new Map<
	string,
	RegistryEntry
>([...tscEntries]);
