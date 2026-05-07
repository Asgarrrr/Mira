import { tscEntries } from "./filters/tsc/entries.ts";
import type { RegistryEntry } from "./types.ts";

// Single source of truth for which programs Mira filters. Each program owns
// its `entries.ts`; this file just assembles them. Adding a new filter is one
// import + one spread.
export const REGISTRY: Map<string, RegistryEntry> = new Map<
	string,
	RegistryEntry
>([...tscEntries]);

// Re-export so existing consumers (`dispatch.ts`, tests) can keep importing
// `RegistryEntry` from `./registry.ts` without churn. The canonical home is
// `./types.ts`.
export type { RegistryEntry } from "./types.ts";
