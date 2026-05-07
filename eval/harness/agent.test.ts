import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { Message } from "@anthropic-ai/sdk/resources/messages.mjs";

import { runAgent } from "./agent.ts";
import type { AgentConfig, HarnessTool, TranscriptEvent } from "./types.ts";

const CONFIG: AgentConfig = {
	model: "claude-test-model",
	temperature: 0,
	maxTurns: 5,
	maxTokensPerTurn: 8192,
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

function makeSequencedMockClient(messages: Message[]): Anthropic {
	let i = 0;
	return {
		messages: {
			create: async () => {
				const m = messages[i] ?? messages[messages.length - 1];
				i += 1;
				return m as Message;
			},
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

describe("runAgent — file metrics", () => {
	test("counts distinct paths from read/write tools, not call counts", async () => {
		const readStub: HarnessTool = {
			name: "read",
			description: "stub read",
			inputSchema: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			},
			run: async () => ({ isError: false, content: "stubbed" }),
		};
		const writeStub: HarnessTool = {
			name: "write",
			description: "stub write",
			inputSchema: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			},
			run: async () => ({ isError: false, content: "stubbed" }),
		};

		// Turn 1: agent reads a, b, then a again (re-read), and writes c.
		// Turn 2: agent ends with no tool_use.
		const turn1: Message = {
			id: "msg_1",
			type: "message",
			role: "assistant",
			model: "claude-test-model",
			content: [
				{ type: "tool_use", id: "u1", name: "read", input: { path: "a.txt" } },
				{ type: "tool_use", id: "u2", name: "read", input: { path: "b.txt" } },
				{ type: "tool_use", id: "u3", name: "read", input: { path: "a.txt" } },
				{ type: "tool_use", id: "u4", name: "write", input: { path: "c.txt" } },
			],
			stop_reason: "tool_use",
			stop_sequence: null,
			usage: { input_tokens: 10, output_tokens: 20 },
		} as unknown as Message;

		const turn2: Message = {
			id: "msg_2",
			type: "message",
			role: "assistant",
			model: "claude-test-model",
			content: [{ type: "text", text: "done" }],
			stop_reason: "end_turn",
			stop_sequence: null,
			usage: { input_tokens: 5, output_tokens: 1 },
		} as unknown as Message;

		const events: TranscriptEvent[] = [];
		const result = await runAgent({
			scenario: "files-test",
			mode: "baseline",
			workdir: "/tmp/files-test",
			task: "irrelevant — driven by sequenced mock",
			tools: [readStub, writeStub],
			config: CONFIG,
			emit: (e) => events.push(e),
			client: makeSequencedMockClient([turn1, turn2]),
		});

		expect(result.toolCalls).toBe(4);
		expect(result.filesRead).toBe(2); // a.txt and b.txt; the re-read of a.txt does not double-count
		expect(result.filesModified).toBe(1); // c.txt

		const footer = events.find((e) => e.type === "footer");
		expect(footer?.type).toBe("footer");
		if (footer?.type === "footer") {
			expect(footer.filesRead).toBe(2);
			expect(footer.filesModified).toBe(1);
		}
	});
});
