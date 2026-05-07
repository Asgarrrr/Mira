import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { CommandObserver } from "../src/command/command-observer.ts";
import { buildObservation } from "../src/core/command-observation.ts";
import type { ContextPack } from "../src/core/context-pack.ts";
import { createMiraMcpServer } from "../src/mcp/server.ts";
import { FileEvidenceStore } from "../src/store/evidence-store.ts";

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

// Seed an observation directly via the Command Kernel + Evidence Store —
// the same path `mira run` uses. The hook is the data layer (ADR 0007), so
// the MCP tests no longer drive `run_command` to populate `.mira/runs/`.
async function seedRun(projectRoot: string, command: string): Promise<void> {
	const store = new FileEvidenceStore(projectRoot);
	const observer = new CommandObserver(store);
	const { run } = await observer.observe(command, projectRoot);
	const observation = buildObservation(run);
	store.writeObservationJson(run.id, observation);
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

	test("tools/list advertises only the surviving insight tools (ADR 0007)", async () => {
		const { client, close } = await connectClient();
		try {
			const { tools } = await client.listTools();
			const names = tools.map((t) => t.name).sort();
			expect(names).toEqual(["generate_context_pack", "list_recent_runs"]);
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

	test("generate_context_pack returns ContextPack and persists to disk", async () => {
		const { client, close } = await connectClient();
		try {
			await seedRun(projectRoot, "echo a");
			await seedRun(projectRoot, "echo b");

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
			await seedRun(projectRoot, "echo a");
			await seedRun(projectRoot, "echo b");

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

	test("Mira error code is carried in structuredContent.code on tool errors", async () => {
		const { client, close } = await connectClient();
		try {
			const result = await client.callTool({
				name: "list_recent_runs",
				arguments: { projectRoot: "relative/path" },
			});
			expect(result.isError).toBe(true);
			const structured = result.structuredContent as {
				code: string;
				message: string;
			};
			expect(structured.code).toBe("INVALID_INPUT");
			expect(structured.message).toContain("absolute path");
			// The text content also leads with the Mira code, for clients that
			// only inspect content[].
			const text = (result.content as Array<{ type: string; text: string }>)[0]
				?.text;
			expect(text).toContain("INVALID_INPUT:");
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
