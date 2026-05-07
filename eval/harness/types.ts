// Shared types for the eval harness. Kept narrow on purpose — the harness is
// internal scaffolding for the eval; it is not a public surface.

export type Mode = "baseline" | "mira";

export type AgentConfig = {
	model: string;
	temperature: number;
	maxTurns: number;
	maxTokensPerTurn: number;
	tokenCap: number;
	wallClockCapMs: number;
	bashTimeoutMs: number;
};

export type ToolContext = {
	// The agent's working directory. For Mira MCP tools this is also passed as
	// `projectRoot` (the agent never sees the field — the wrapper injects it).
	workdir: string;
};

export type ToolResult = {
	isError: boolean;
	content: string;
};

export type HarnessTool = {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	run: (
		input: Record<string, unknown>,
		ctx: ToolContext,
	) => Promise<ToolResult>;
};

export type TranscriptEvent =
	| {
			type: "header";
			scenario: string;
			mode: Mode;
			model: string;
			startedAt: string;
			workdir: string;
	  }
	| {
			type: "turn";
			turn: number;
			usage: { inputTokens: number; outputTokens: number };
			stopReason: string | null;
	  }
	| {
			type: "tool_call";
			turn: number;
			name: string;
			argsPreview: string;
			resultPreview: string;
			isError: boolean;
			durationMs: number;
	  }
	| {
			type: "footer";
			endedAt: string;
			success: boolean;
			turns: number;
			tokensInput: number;
			tokensOutput: number;
			toolCalls: number;
			toolCallsByName: Record<string, number>;
			filesRead: number;
			filesModified: number;
			wallClockMs: number;
			stopReason:
				| "model_end"
				| "max_turns"
				| "token_cap"
				| "wall_clock_cap"
				| "max_tokens_truncated";
	  };

// One row per (scenario, mode, repeat) execution. Persisted as metrics.json
// alongside the transcript; consumed by report.ts in PR 3.
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
