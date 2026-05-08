export type TscDiagnostic = {
	file: string;
	line: number;
	column: number;
	severity: "error" | "warning" | "info";
	ruleId: string;
	message: string;
	continuation: string;
	suggestion?: string;
	// Source range (1-indexed) in the parser input. The glue (index.ts) uses
	// these to build excerpt.lineStart / lineEnd pointing into combined.log.
	lineStart: number;
	lineEnd: number;
	rawText: string;
};

export type ParseStats = { linesTotal: number; linesParsed: number };

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
// Matches the trailing "Did you mean '<x>'?" hint with its leading
// separator (optional whitespace + dot). Group 1 is the suggestion;
// `m.index` is where the hint begins, used to slice it off the message.
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

export function parseTscOutputWithStats(text: string): {
	diags: TscDiagnostic[];
	stats: ParseStats;
} {
	const lines = text.replace(ANSI_RE, "").split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

	// Pretty-mode (`tsc --pretty`) is not parsed: those lines fail
	// DIAGNOSTIC_RE so we produce zero findings, and the dispatcher's
	// "0 findings + non-empty output + non-zero exit" check turns it into
	// a passthrough (`{ kind: "miss" }`). See `dispatchFilter`.
	const diags: TscDiagnostic[] = [];
	let current: TscDiagnostic | null = null;
	let linesParsed = 0;

	const flush = (): void => {
		if (current === null) return;
		extractSuggestion(current);
		diags.push(current);
		current = null;
	};

	for (const [i, line] of lines.entries()) {
		const m = DIAGNOSTIC_RE.exec(line);
		if (m !== null && m.groups !== undefined) {
			flush();
			// Every named group in DIAGNOSTIC_RE is mandatory; if .exec returned
			// non-null, .groups holds defined strings for all of them.
			const g = m.groups as DiagnosticGroups;
			current = {
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
			linesParsed++;
			continue;
		}
		if (current !== null && CONTINUATION_RE.test(line)) {
			current.continuation =
				current.continuation === "" ? line : `${current.continuation}\n${line}`;
			current.rawText = `${current.rawText}\n${line}`;
			current.lineEnd = i + 1;
			linesParsed++;
			continue;
		}
		if (SUMMARY_RE.test(line)) {
			flush();
			linesParsed++;
			continue;
		}
		flush();
	}
	flush();

	return { diags, stats: { linesTotal: lines.length, linesParsed } };
}

export function parseTscOutput(text: string): TscDiagnostic[] {
	return parseTscOutputWithStats(text).diags;
}
