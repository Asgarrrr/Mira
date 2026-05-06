import Anthropic from "@anthropic-ai/sdk";
import type {
	ContentBlock,
	MessageParam,
	Tool,
	ToolResultBlockParam,
	ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages.mjs";

import type {
	AgentConfig,
	HarnessTool,
	Mode,
	ToolContext,
	TranscriptEvent,
} from "./types.ts";

const SYSTEM_PROMPT =
	"You are a coding agent. Solve the task described by the user. Use the provided tools. " +
	"When done, return a final answer (no tool call). Do not ask follow-up questions; act on best understanding.";

const PREVIEW_LEN = 200;

function preview(s: string): string {
	if (s.length <= PREVIEW_LEN) return s;
	return `${s.slice(0, PREVIEW_LEN)}…(+${s.length - PREVIEW_LEN} chars)`;
}

export type RunResult = {
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
	toolCalls: number;
	toolCallsByName: Record<string, number>;
	wallClockMs: number;
};

export type RunAgentArgs = {
	scenario: string;
	mode: Mode;
	workdir: string;
	task: string;
	tools: HarnessTool[];
	config: AgentConfig;
	emit: (event: TranscriptEvent) => void;
	successCheck?: () => Promise<boolean>;
	// Optional injection point. Default: a real Anthropic client built from
	// process.env.ANTHROPIC_API_KEY. Tests pass a mock here.
	client?: Anthropic;
};

export async function runAgent(args: RunAgentArgs): Promise<RunResult> {
	const { scenario, mode, workdir, task, tools, config, emit, successCheck } =
		args;

	let client: Anthropic;
	if (args.client) {
		client = args.client;
	} else {
		const apiKey = process.env.ANTHROPIC_API_KEY;
		if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
		client = new Anthropic({ apiKey });
	}

	const anthropicTools: Tool[] = tools.map((t) => ({
		name: t.name,
		description: t.description,
		// biome-ignore lint/suspicious/noExplicitAny: harness schemas are JSON Schema dicts
		input_schema: t.inputSchema as any,
	}));
	const toolByName = new Map(tools.map((t) => [t.name, t]));
	const ctx: ToolContext = { workdir };

	emit({
		type: "header",
		scenario,
		mode,
		model: config.model,
		startedAt: new Date().toISOString(),
		workdir,
	});

	const messages: MessageParam[] = [{ role: "user", content: task }];
	const toolCallsByName: Record<string, number> = {};
	let tokensInput = 0;
	let tokensOutput = 0;
	let toolCalls = 0;
	let turn = 0;
	let stopReason: RunResult["stopReason"] = "model_end";

	const startedAt = Date.now();
	const wallClockExceeded = () =>
		Date.now() - startedAt >= config.wallClockCapMs;

	while (true) {
		if (turn >= config.maxTurns) {
			stopReason = "max_turns";
			break;
		}
		if (tokensInput + tokensOutput >= config.tokenCap) {
			stopReason = "token_cap";
			break;
		}
		if (wallClockExceeded()) {
			stopReason = "wall_clock_cap";
			break;
		}

		turn += 1;
		const response = await client.messages.create({
			model: config.model,
			max_tokens: config.maxTokensPerTurn,
			temperature: config.temperature,
			system: SYSTEM_PROMPT,
			tools: anthropicTools,
			messages,
		});

		tokensInput += response.usage.input_tokens;
		tokensOutput += response.usage.output_tokens;
		emit({
			type: "turn",
			turn,
			usage: {
				inputTokens: response.usage.input_tokens,
				outputTokens: response.usage.output_tokens,
			},
			stopReason: response.stop_reason ?? null,
		});

		messages.push({ role: "assistant", content: response.content });

		// A trailing tool_use may be partially serialized — never execute it.
		if (response.stop_reason === "max_tokens") {
			stopReason = "max_tokens_truncated";
			break;
		}

		const toolUses: ToolUseBlock[] = response.content.filter(
			(b: ContentBlock): b is ToolUseBlock => b.type === "tool_use",
		);

		if (toolUses.length === 0) {
			stopReason = "model_end";
			break;
		}

		const toolResults: ToolResultBlockParam[] = [];
		for (const use of toolUses) {
			const tool = toolByName.get(use.name);
			toolCalls += 1;
			toolCallsByName[use.name] = (toolCallsByName[use.name] ?? 0) + 1;

			const startedToolAt = Date.now();
			let result: { isError: boolean; content: string };
			if (!tool) {
				result = {
					isError: true,
					content: `unknown tool: ${use.name}`,
				};
			} else {
				try {
					result = await tool.run(
						(use.input ?? {}) as Record<string, unknown>,
						ctx,
					);
				} catch (e) {
					result = {
						isError: true,
						content: `tool threw: ${(e as Error).message}`,
					};
				}
			}
			const durationMs = Date.now() - startedToolAt;

			emit({
				type: "tool_call",
				turn,
				name: use.name,
				argsPreview: preview(JSON.stringify(use.input ?? {})),
				resultPreview: preview(result.content),
				isError: result.isError,
				durationMs,
			});

			toolResults.push({
				type: "tool_result",
				tool_use_id: use.id,
				content: result.content,
				is_error: result.isError,
			});
		}

		messages.push({ role: "user", content: toolResults });
	}

	const success = successCheck ? await successCheck() : true;
	const wallClockMs = Date.now() - startedAt;

	emit({
		type: "footer",
		endedAt: new Date().toISOString(),
		success,
		turns: turn,
		tokensInput,
		tokensOutput,
		toolCalls,
		toolCallsByName,
		wallClockMs,
		stopReason,
	});

	return {
		success,
		stopReason,
		turns: turn,
		tokensInput,
		tokensOutput,
		toolCalls,
		toolCallsByName,
		wallClockMs,
	};
}
