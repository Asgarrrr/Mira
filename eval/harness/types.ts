// Shared types for the eval harness. Kept narrow on purpose — the harness is
// internal scaffolding for the eval; it is not a public surface.

export type Mode = "baseline" | "mira";

// One row per (scenario, mode, repeat) execution. Persisted as metrics.json
// alongside the transcript; consumed by report.ts.
export type RunMetrics = {
	scenario: string;
	mode: Mode;
	repeat: number;
	model: string;
	success: boolean;
	stopReason:
		| "model_end"
		| "max_turns"
		| "token_cap"
		| "wall_clock_cap"
		| "max_tokens_truncated";
	turns: number;
	tokensInput: number;
	tokensOutput: number;
	tokensTotal: number;
	toolCalls: number;
	toolCallsByName: Record<string, number>;
	filesRead: number;
	filesModified: number;
	wallClockMs: number;
};
