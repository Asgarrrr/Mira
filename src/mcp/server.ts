import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
	getObservationInputShape,
	runGetObservationTool,
} from "./tools/get-observation.ts";
import {
	runCommandInputShape,
	runRunCommandTool,
} from "./tools/run-command.ts";

// V0.3 boundary: a single MCP server that re-exposes the existing kernels.
// `@modelcontextprotocol/sdk` is consumed only inside `src/mcp/`. The five
// tools registered here are hard-coded — clients cannot register new ones.
// See ADR 0006.
export function createMiraMcpServer(): McpServer {
	const server = new McpServer({
		name: "mira",
		version: "0.3.0",
	});

	server.registerTool(
		"run_command",
		{
			title: "Run a command",
			description:
				"Execute a shell command in the given project root, capture evidence, and return the resulting CommandObservation. Process-level outcomes (non-zero exit, signal, timeout) are returned via the observation's fields, never via MCP errors.",
			inputSchema: runCommandInputShape,
		},
		async (input) => {
			const result = await runRunCommandTool(input);
			return {
				structuredContent: result as unknown as Record<string, unknown>,
				content: [
					{ type: "text", text: JSON.stringify(result.observation, null, 2) },
				],
			};
		},
	);

	server.registerTool(
		"get_observation",
		{
			title: "Get an observation by id",
			description:
				"Load the persisted CommandObservation for an observationId from the given project root's .mira/runs/<id>/observation.json. Returned verbatim; never includes ArchitectureSignal[].",
			inputSchema: getObservationInputShape,
		},
		async (input) => {
			const result = await runGetObservationTool(input);
			return {
				structuredContent: result as unknown as Record<string, unknown>,
				content: [
					{ type: "text", text: JSON.stringify(result.observation, null, 2) },
				],
			};
		},
	);

	return server;
}

export async function runStdioServer(): Promise<void> {
	const server = createMiraMcpServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
}
