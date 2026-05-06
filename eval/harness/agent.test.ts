import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { Message } from "@anthropic-ai/sdk/resources/messages.mjs";

import { runAgent } from "./agent.ts";
import type { AgentConfig, HarnessTool, TranscriptEvent } from "./types.ts";

const CONFIG: AgentConfig = {
	model: "claude-test-model",
	temperature: 0,
	maxTurns: 5,
	tokenCap: 200_000,
	wallClockCapMs: 60_000,
	bashTimeoutMs: 5_000,
};

function makeMockClient(message: Message): Anthropic {
	return {
		messages: {
			create: async () => message,
		},
	} as unknown as Anthropic;
}

describe("runAgent — stop_reason handling", () => {
	test("refuses to execute a tool_use truncated by max_tokens", async () => {
		let toolRunCount = 0;
		const fakeTool: HarnessTool = {
			name: "fake_tool",
			description: "should never be invoked",
			inputSchema: { type: "object", properties: {} },
			run: async () => {
				toolRunCount += 1;
				return { isError: false, content: "ran" };
			},
		};

		const truncatedResponse = {
			id: "msg_test",
			type: "message",
			role: "assistant",
			model: "claude-test-model",
			content: [
				{
					type: "tool_use",
					id: "toolu_partial",
					name: "fake_tool",
					input: {},
				},
			],
			stop_reason: "max_tokens",
			stop_sequence: null,
			usage: {
				input_tokens: 10,
				output_tokens: 4096,
			},
		} as unknown as Message;

		const events: TranscriptEvent[] = [];
		const result = await runAgent({
			scenario: "test-m3",
			mode: "baseline",
			workdir: "/tmp/m3-test",
			task: "irrelevant — the mock returns max_tokens immediately",
			tools: [fakeTool],
			config: CONFIG,
			emit: (e) => events.push(e),
			client: makeMockClient(truncatedResponse),
		});

		expect(result.stopReason).toBe("max_tokens_truncated");
		expect(result.toolCalls).toBe(0);
		expect(toolRunCount).toBe(0);
		expect(result.turns).toBe(1);

		const toolCallEvents = events.filter((e) => e.type === "tool_call");
		expect(toolCallEvents).toHaveLength(0);
	});
});
