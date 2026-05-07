import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	type CallToolResult,
	McpError,
} from "@modelcontextprotocol/sdk/types.js";

import { miraErrorResult } from "./errors.ts";
import {
	generateContextPackInputShape,
	runGenerateContextPackTool,
} from "./tools/generate-context-pack.ts";
import {
	listRecentRunsInputShape,
	runListRecentRunsTool,
} from "./tools/list-recent-runs.ts";

// V0.3 boundary: a single MCP server that re-exposes Mira's insight kernels.
// `@modelcontextprotocol/sdk` is consumed only inside `src/mcp/`. Tools are
// hard-coded — clients cannot register new ones. See ADR 0006 for the original
// scope and ADR 0007 for the hook-as-data / MCP-as-insight split that
// deprecated `run_command`, `get_observation`, and `get_raw_evidence`.
export function createMiraMcpServer(): McpServer {
	const server = new McpServer({
		name: "mira",
		version: "0.3.0",
	});

	server.registerTool(
		"generate_context_pack",
		{
			title: "Generate a context pack",
			description:
				"Build a ContextPack for a free-text task: last-10 observations from the project's .mira/, architecture sensing applied (V0.2), suspectedFiles capped at 20 by the Context Kernel. Persists .mira/context/<id>.{json,md} and returns the pack verbatim.",
			inputSchema: generateContextPackInputShape,
		},
		async (input) => {
			return guardHandler(async () => {
				const { pack } = await runGenerateContextPackTool(input);
				return {
					structuredContent: { pack },
					content: [{ type: "text", text: JSON.stringify(pack, null, 2) }],
				};
			});
		},
	);

	server.registerTool(
		"list_recent_runs",
		{
			title: "List recent runs",
			description:
				"Return a slim projection of recent CommandObservations/CommandRuns for browsing. Default limit 10, max 50. Each row mirrors fields already present on CommandObservation/CommandRun — no new field is introduced.",
			inputSchema: listRecentRunsInputShape,
		},
		async (input) => {
			return guardHandler(async () => {
				const { runs } = await runListRecentRunsTool(input);
				return {
					structuredContent: { runs },
					content: [{ type: "text", text: JSON.stringify(runs, null, 2) }],
				};
			});
		},
	);

	return server;
}

// Thrown McpError → structured `isError: true` CallToolResult that preserves
// the Mira code on the wire. The high-level McpServer would otherwise drop
// `data.code` (see comment on miraErrorResult). Non-McpError throws are
// re-raised so they remain genuine bugs rather than masquerading as tool
// errors with empty Mira codes.
async function guardHandler(
	body: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
	try {
		return await body();
	} catch (e) {
		if (e instanceof McpError) return miraErrorResult(e);
		throw e;
	}
}

export async function runStdioServer(): Promise<void> {
	const server = createMiraMcpServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
}
