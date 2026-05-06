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
	getObservationInputShape,
	runGetObservationTool,
} from "./tools/get-observation.ts";
import {
	getRawEvidenceInputShape,
	runGetRawEvidenceTool,
} from "./tools/get-raw-evidence.ts";
import {
	listRecentRunsInputShape,
	runListRecentRunsTool,
} from "./tools/list-recent-runs.ts";
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
			return guardHandler(async () => {
				const { observation } = await runRunCommandTool(input);
				return {
					structuredContent: { observation },
					content: [
						{ type: "text", text: JSON.stringify(observation, null, 2) },
					],
				};
			});
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
			return guardHandler(async () => {
				const { observation } = await runGetObservationTool(input);
				return {
					structuredContent: { observation },
					content: [
						{ type: "text", text: JSON.stringify(observation, null, 2) },
					],
				};
			});
		},
	);

	server.registerTool(
		"get_raw_evidence",
		{
			title: "Get raw evidence by reference",
			description:
				"Read the raw bytes of a stored evidence file referenced by an existing EvidenceRef. ref.path is resolved against <projectRoot>/.mira/; traversal, out-of-tree absolute paths, and symlinks that escape the evidence root are rejected before any read. Returned verbatim — never truncated, summarized, or re-encoded.",
			inputSchema: getRawEvidenceInputShape,
		},
		async (input) => {
			return guardHandler(async () => {
				const { ref, bytes, content } = await runGetRawEvidenceTool(input);
				return {
					structuredContent: { ref, bytes, content },
					content: [{ type: "text", text: content }],
				};
			});
		},
	);

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
