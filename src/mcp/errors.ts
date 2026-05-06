import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

// Mira-specific error code names (ADR 0006). Carried as `data.code` on the
// JSON-RPC error envelope; the wire-level numeric code is mapped below.
export type MiraErrorCode =
	| "INVALID_INPUT"
	| "NOT_FOUND"
	| "PATH_OUTSIDE_EVIDENCE"
	| "INTERNAL";

const WIRE_CODE: Record<MiraErrorCode, ErrorCode> = {
	INVALID_INPUT: ErrorCode.InvalidParams,
	// NOT_FOUND and PATH_OUTSIDE_EVIDENCE are input/argument problems from the
	// protocol's point of view — the standard JSON-RPC code for "your request
	// pointed at something the server cannot use" is InvalidParams. The Mira
	// name is what callers actually branch on.
	NOT_FOUND: ErrorCode.InvalidParams,
	PATH_OUTSIDE_EVIDENCE: ErrorCode.InvalidParams,
	INTERNAL: ErrorCode.InternalError,
};

// `McpError`'s constructor mangles the message into `"MCP error <code>: <msg>"`,
// so we stash the unprefixed message on `data.message`. `miraErrorResult`
// reads that back to compose a clean wire-level result.
type MiraErrorData = {
	code: MiraErrorCode;
	message: string;
};

export function miraError(code: MiraErrorCode, message: string): McpError {
	const data: MiraErrorData = { code, message };
	return new McpError(WIRE_CODE[code], message, data);
}

// Tool-handler error CallToolResult.
//
// ADR 0006 specifies errors via the SDK's `McpError` mechanism. The high-level
// `McpServer` actually catches every thrown McpError (except UrlElicitation)
// and converts it to an `isError: true` tool result rather than a JSON-RPC
// error envelope, dropping `data.code` in the process. To keep the Mira code
// names visible on the wire — which is what an MCP client actually branches
// on — each handler catches its own McpError and returns a structured error
// result here. Throwing still happens in the pure tool functions so unit
// tests can assert on `data.code` directly.
export function miraErrorResult(err: McpError): {
	isError: true;
	structuredContent: { code: MiraErrorCode; message: string };
	content: Array<{ type: "text"; text: string }>;
} {
	const data = isMiraErrorData(err.data) ? err.data : null;
	const code = data?.code ?? defaultMiraCodeFor(err);
	const message = data?.message ?? stripMcpPrefix(err.message);
	return {
		isError: true,
		structuredContent: { code, message },
		content: [{ type: "text", text: `${code}: ${message}` }],
	};
}

function isMiraErrorData(value: unknown): value is MiraErrorData {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { code?: unknown; message?: unknown };
	return (
		typeof candidate.code === "string" && typeof candidate.message === "string"
	);
}

function defaultMiraCodeFor(err: McpError): MiraErrorCode {
	// Zod input-validation failures inside the SDK throw `McpError` with no
	// Mira `data` block. Map the JSON-RPC code back to the closest Mira name
	// so clients always branch on a known code, regardless of whether the
	// rejection happened in the schema layer or in the tool body.
	return err.code === ErrorCode.InvalidParams ? "INVALID_INPUT" : "INTERNAL";
}

function stripMcpPrefix(message: string): string {
	const m = /^MCP error -?\d+: (.*)$/s.exec(message);
	return m?.[1] ?? message;
}
