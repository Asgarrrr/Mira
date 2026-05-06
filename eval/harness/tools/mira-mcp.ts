import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Imported via relative path: the eval consumes Mira's published surface
// (`createMiraMcpServer`) only — it never reaches into kernels or storage.
// See docs/eval/03-harness-design.md "Dependency scope".
import { createMiraMcpServer } from "../../../src/mcp/server.ts";
import type { HarnessTool } from "../types.ts";

type ListedTool = {
	name: string;
	description?: string;
	inputSchema: {
		type?: string;
		properties?: Record<string, unknown>;
		required?: string[];
		additionalProperties?: boolean;
	};
};

// Drop `projectRoot` from the tool's advertised schema so the agent does not
// see it. The wrapper injects ctx.workdir as projectRoot at call time.
function stripProjectRoot(
	schema: ListedTool["inputSchema"],
): ListedTool["inputSchema"] {
	const properties = { ...(schema.properties ?? {}) };
	delete properties.projectRoot;
	const required = (schema.required ?? []).filter((k) => k !== "projectRoot");
	return {
		type: schema.type ?? "object",
		properties,
		required,
		additionalProperties: schema.additionalProperties ?? false,
	};
}

export type MiraMcpHandle = {
	tools: HarnessTool[];
	close: () => Promise<void>;
};

export async function createMiraMcpForAgent(): Promise<MiraMcpHandle> {
	const server = createMiraMcpServer();
	const [serverTransport, clientTransport] =
		InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "mira-eval-harness", version: "0.0.1" });
	await Promise.all([
		server.connect(serverTransport),
		client.connect(clientTransport),
	]);

	const { tools: listed } = await client.listTools();
	const tools: HarnessTool[] = (listed as ListedTool[]).map((t) => ({
		name: t.name,
		description:
			t.description ??
			"Mira MCP tool. projectRoot is supplied automatically by the harness.",
		inputSchema: stripProjectRoot(t.inputSchema) as Record<string, unknown>,
		async run(input, ctx) {
			const args = { ...input, projectRoot: ctx.workdir };
			const result = await client.callTool({ name: t.name, arguments: args });
			const isError = result.isError === true;
			// Prefer structuredContent if present; fall back to the text content.
			let payload: string;
			if (result.structuredContent !== undefined) {
				payload = JSON.stringify(result.structuredContent, null, 2);
			} else if (Array.isArray(result.content)) {
				payload = result.content
					.map((c: { type?: string; text?: string }) =>
						c.type === "text" ? (c.text ?? "") : JSON.stringify(c),
					)
					.join("\n");
			} else {
				payload = JSON.stringify(result);
			}
			return { isError, content: payload };
		},
	}));

	return {
		tools,
		close: async () => {
			await client.close();
			await server.close();
		},
	};
}
