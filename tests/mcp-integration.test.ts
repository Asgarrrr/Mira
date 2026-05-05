import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { CommandObservation } from "../src/core/command-observation.ts";
import type { ContextPack } from "../src/core/context-pack.ts";
import { createMiraMcpServer } from "../src/mcp/server.ts";

async function connectClient() {
	const server = createMiraMcpServer();
	const [serverTransport, clientTransport] =
		InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "mira-test", version: "0.0.1" });
	await Promise.all([
		server.connect(serverTransport),
		client.connect(clientTransport),
	]);
	return {
		client,
		close: async () => {
			await client.close();
			await server.close();
		},
	};
}

describe("Mira MCP server (in-process integration)", () => {
	let projectRoot: string;

	beforeEach(() => {
		projectRoot = mkdtempSync(join(tmpdir(), "mira-mcp-int-"));
	});

	afterEach(() => {
		rmSync(projectRoot, { recursive: true, force: true });
	});

	test("handshake exposes server info", async () => {
		const { client, close } = await connectClient();
		try {
			expect(client.getServerVersion()).toEqual({
				name: "mira",
				version: "0.3.0",
			});
		} finally {
			await close();
		}
	});

	test("tools/list advertises exactly the five V0.3 tools", async () => {
		const { client, close } = await connectClient();
		try {
			const { tools } = await client.listTools();
			const names = tools.map((t) => t.name).sort();
			expect(names).toEqual(
				[
					"generate_context_pack",
					"get_observation",
					"get_raw_evidence",
					"list_recent_runs",
					"run_command",
				].sort(),
			);
			// Each tool advertises an inputSchema requiring projectRoot.
			for (const tool of tools) {
				const required = tool.inputSchema?.required as string[] | undefined;
				expect(required).toBeDefined();
				expect(required).toContain("projectRoot");
			}
		} finally {
			await close();
		}
	});

	test("end-to-end: run_command → get_observation → get_raw_evidence", async () => {
		const { client, close } = await connectClient();
		try {
			const runResult = await client.callTool({
				name: "run_command",
				arguments: { command: "echo flowed", projectRoot },
			});
			expect(runResult.isError).toBeFalsy();
			const runStructured = runResult.structuredContent as {
				observation: CommandObservation;
			};
			expect(runStructured.observation.status).toBe("success");
			expect(runStructured.observation.exitCode).toBe(0);
			const observationId = runStructured.observation.id;

			const getResult = await client.callTool({
				name: "get_observation",
				arguments: { observationId, projectRoot },
			});
			expect(getResult.isError).toBeFalsy();
			const getStructured = getResult.structuredContent as {
				observation: CommandObservation;
			};
			expect(getStructured.observation.id).toBe(observationId);
			expect(getStructured.observation.command).toBe("echo flowed");

			const stdoutRef = getStructured.observation.evidenceRefs.find(
				(r) => r.kind === "stdout",
			);
			expect(stdoutRef).toBeDefined();

			const rawResult = await client.callTool({
				name: "get_raw_evidence",
				arguments: { ref: stdoutRef, projectRoot },
			});
			expect(rawResult.isError).toBeFalsy();
			const rawStructured = rawResult.structuredContent as {
				ref: { path: string; kind: string };
				bytes: number;
				content: string;
			};
			expect(rawStructured.content).toBe("flowed\n");
			expect(rawStructured.bytes).toBe(7);
		} finally {
			await close();
		}
	});

	test("generate_context_pack returns ContextPack and persists to disk", async () => {
		const { client, close } = await connectClient();
		try {
			// Seed two runs so the pack references something.
			await client.callTool({
				name: "run_command",
				arguments: { command: "echo a", projectRoot },
			});
			await client.callTool({
				name: "run_command",
				arguments: { command: "echo b", projectRoot },
			});

			const result = await client.callTool({
				name: "generate_context_pack",
				arguments: { task: "investigate", projectRoot },
			});
			expect(result.isError).toBeFalsy();
			const structured = result.structuredContent as { pack: ContextPack };
			expect(structured.pack.task).toBe("investigate");
			expect(structured.pack.observationIds.length).toBe(2);
			expect(structured.pack.id).toMatch(/^ctx_/);
		} finally {
			await close();
		}
	});

	test("list_recent_runs returns a slim projection", async () => {
		const { client, close } = await connectClient();
		try {
			await client.callTool({
				name: "run_command",
				arguments: { command: "echo a", projectRoot },
			});
			await client.callTool({
				name: "run_command",
				arguments: { command: "echo b", projectRoot },
			});

			const result = await client.callTool({
				name: "list_recent_runs",
				arguments: { projectRoot },
			});
			expect(result.isError).toBeFalsy();
			const structured = result.structuredContent as {
				runs: Array<{ id: string; command: string; startedAt: string }>;
			};
			expect(structured.runs.length).toBe(2);
			// newest-first
			expect(structured.runs[0]?.command).toBe("echo b");
			expect(structured.runs[1]?.command).toBe("echo a");
		} finally {
			await close();
		}
	});

	test("non-zero exit is preserved through run_command without becoming an MCP error", async () => {
		const { client, close } = await connectClient();
		try {
			const result = await client.callTool({
				name: "run_command",
				arguments: { command: "exit 7", projectRoot },
			});
			expect(result.isError).toBeFalsy(); // process-level outcome ≠ MCP error
			const structured = result.structuredContent as {
				observation: CommandObservation;
			};
			expect(structured.observation.status).toBe("failure");
			expect(structured.observation.exitCode).toBe(7);
		} finally {
			await close();
		}
	});

	test("Mira error code is carried in structuredContent.code on tool errors", async () => {
		const { client, close } = await connectClient();
		try {
			const result = await client.callTool({
				name: "get_raw_evidence",
				arguments: {
					ref: { path: "../etc/passwd", kind: "other" },
					projectRoot,
				},
			});
			expect(result.isError).toBe(true);
			const structured = result.structuredContent as {
				code: string;
				message: string;
			};
			expect(structured.code).toBe("PATH_OUTSIDE_EVIDENCE");
			expect(structured.message).toContain("../etc/passwd");
			// The text content also leads with the Mira code, for clients that
			// only inspect content[].
			const text = (result.content as Array<{ type: string; text: string }>)[0]
				?.text;
			expect(text).toContain("PATH_OUTSIDE_EVIDENCE:");
		} finally {
			await close();
		}
	});

	test("INVALID_INPUT for empty command is structured", async () => {
		const { client, close } = await connectClient();
		try {
			const result = await client.callTool({
				name: "run_command",
				arguments: { command: "", projectRoot },
			});
			expect(result.isError).toBe(true);
			const structured = result.structuredContent as {
				code: string;
				message: string;
			};
			expect(structured.code).toBe("INVALID_INPUT");
		} finally {
			await close();
		}
	});

	test("NOT_FOUND for a missing observation is structured", async () => {
		const { client, close } = await connectClient();
		try {
			const result = await client.callTool({
				name: "get_observation",
				arguments: { observationId: "run_does_not_exist", projectRoot },
			});
			expect(result.isError).toBe(true);
			const structured = result.structuredContent as {
				code: string;
				message: string;
			};
			expect(structured.code).toBe("NOT_FOUND");
		} finally {
			await close();
		}
	});

	test("schema-level validation errors come back as isError without a Mira code (SDK behaviour)", async () => {
		// limit > 50 is rejected by Zod before the handler runs. The SDK's
		// `validateToolInput` throws and is caught into a text-only tool error;
		// no `structuredContent` is set. This is a known SDK gap noted in the
		// PR body. The wire-level code is still -32602 (InvalidParams).
		const { client, close } = await connectClient();
		try {
			const result = await client.callTool({
				name: "list_recent_runs",
				arguments: { projectRoot, limit: 51 },
			});
			expect(result.isError).toBe(true);
			expect(result.structuredContent).toBeUndefined();
			const text = (result.content as Array<{ type: string; text: string }>)[0]
				?.text;
			expect(text).toContain("Input validation error");
		} finally {
			await close();
		}
	});
});
