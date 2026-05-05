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

export function miraError(code: MiraErrorCode, message: string): McpError {
	return new McpError(WIRE_CODE[code], message, { code });
}
