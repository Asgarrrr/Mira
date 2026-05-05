import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// V0.3 boundary: a single MCP server that re-exposes the existing kernels.
// `@modelcontextprotocol/sdk` is consumed only inside `src/mcp/`. The five
// tools registered here are hard-coded — clients cannot register new ones.
// See ADR 0006.
export function createMiraMcpServer(): McpServer {
	const server = new McpServer({
		name: "mira",
		version: "0.3.0",
	});

	// Tools are registered in subsequent commits.

	return server;
}

export async function runStdioServer(): Promise<void> {
	const server = createMiraMcpServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
}
