export type TscDiagnostic = {
	file: string;
	line: number;
	column: number;
	severity: "error" | "warning" | "info";
	ruleId: string;
	message: string;
	continuation: string;
	suggestion?: string;
	// 1-indexed source range in the parser input.
	lineStart: number;
	lineEnd: number;
	rawText: string;
};

export type ParseStats = { linesTotal: number; linesParsed: number };

export type UnparsedLine = { line: number; text: string };

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape (0x1b) stripping is the rule's purpose — matching the control char is intentional, not a bug.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const DIAGNOSTIC_RE =
	/^(?<file>[^\s(][^(]*?)\((?<line>\d+),(?<col>\d+)\):\s+(?<sev>error|warning|info)\s+(?<rule>TS\d+):\s+(?<msg>.*)$/;
type DiagnosticGroups = {
	file: string;
	line: string;
	col: string;
	sev: string;
	rule: string;
	msg: string;
};
const CONTINUATION_RE = /^\s{2,}\S/;
const SUMMARY_RE = /^Found \d+ errors? in \d+ files?\.?\s*$/;
// `m.index` marks where the hint begins; we slice it off the message.
const SUGGESTION_RE = /\s*\.?\s*Did you mean ['"]([^'"]+)['"]\s*\?\s*$/;

function severityFrom(token: string): "error" | "warning" | "info" {
	if (token === "error") return "error";
	if (token === "warning") return "warning";
	return "info";
}

function extractSuggestion(diag: TscDiagnostic): void {
	const m = SUGGESTION_RE.exec(diag.message);
	if (m === null || m[1] === undefined) return;
	diag.suggestion = m[1];
	diag.message = diag.message.slice(0, m.index);
}

type LineKind =
	| { kind: "diag"; m: RegExpExecArray }
	| { kind: "continuation" }
	| { kind: "summary" }
	| { kind: "noise" }
	| { kind: "blank" };

function classifyLine(line: string, hasCurrent: boolean): LineKind {
	if (line.trim() === "") return { kind: "blank" };
	const m = DIAGNOSTIC_RE.exec(line);
	if (m !== null && m.groups !== undefined) return { kind: "diag", m };
	if (hasCurrent && CONTINUATION_RE.test(line)) return { kind: "continuation" };
	if (SUMMARY_RE.test(line)) return { kind: "summary" };
	return { kind: "noise" };
}

function startDiagnostic(
	m: RegExpExecArray,
	line: string,
	i: number,
): TscDiagnostic {
	// All named groups are mandatory — non-null match → all defined.
	const g = m.groups as DiagnosticGroups;
	return {
		file: g.file,
		line: Number.parseInt(g.line, 10),
		column: Number.parseInt(g.col, 10),
		severity: severityFrom(g.sev),
		ruleId: g.rule,
		message: g.msg,
		continuation: "",
		lineStart: i + 1,
		lineEnd: i + 1,
		rawText: line,
	};
}

function appendContinuation(
	diag: TscDiagnostic,
	line: string,
	i: number,
): void {
	diag.continuation =
		diag.continuation === "" ? line : `${diag.continuation}\n${line}`;
	diag.rawText = `${diag.rawText}\n${line}`;
	diag.lineEnd = i + 1;
}

export function parseTscOutputWithStats(text: string): {
	diags: TscDiagnostic[];
	stats: ParseStats;
	unparsedLines: UnparsedLine[];
} {
	// Normalize CRLF and lone \r before splitting so stray carriage returns
	// don't survive into rawText / unparsed text.
	const normalized = text.replace(ANSI_RE, "").replace(/\r\n?/g, "\n");
	const lines = normalized.split("\n");
	if (lines.at(-1) === "") lines.pop();

	// `tsc --pretty` lines fail DIAGNOSTIC_RE → zero findings → the
	// dispatcher's pretty-mode passthrough kicks in.
	const diags: TscDiagnostic[] = [];
	const unparsedLines: UnparsedLine[] = [];
	let current: TscDiagnostic | null = null;
	let linesParsed = 0;
	const flush = (): void => {
		if (current === null) return;
		extractSuggestion(current);
		diags.push(current);
		current = null;
	};
	for (const [i, line] of lines.entries()) {
		const c = classifyLine(line, current !== null);
		if (c.kind === "diag") {
			flush();
			current = startDiagnostic(c.m, line, i);
			linesParsed++;
		} else if (c.kind === "continuation" && current !== null) {
			appendContinuation(current, line, i);
			linesParsed++;
		} else {
			flush();
			if (c.kind === "summary") linesParsed++;
			else if (c.kind === "noise")
				unparsedLines.push({ line: i + 1, text: line });
		}
	}
	flush();
	return {
		diags,
		stats: { linesTotal: lines.length, linesParsed },
		unparsedLines,
	};
}

export function parseTscOutput(text: string): TscDiagnostic[] {
	return parseTscOutputWithStats(text).diags;
}
