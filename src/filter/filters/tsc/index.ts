import type { Finding } from "../../../core/finding.ts";
import type { Filter, FilteredView } from "../../types.ts";
import { clusterDiagnostics } from "./cluster.ts";
import {
	parseTscOutputWithStats,
	type TscDiagnostic,
	type UnparsedLine,
} from "./parser.ts";
import { renderTscMarkdown } from "./render.ts";

// Bump when the rendered markdown shape changes.
export const TSC_FILTER_VERSION = "tsc/4";

export const tscFilter: Filter = (input, ctx): FilteredView => {
	const text = mergeStreams(input.stdout, input.stderr);
	const { diags, unparsedLines } = parseTscOutputWithStats(text);
	const path = `.mira/runs/${ctx.runId}/combined.log`;
	const diagFindings = diags.map((d, i) => buildFinding(d, i, path));
	const unparsedFindings = unparsedLines.map((u) =>
		buildUnparsedFinding(u, path),
	);
	const clusters = clusterDiagnostics(diags);
	const markdown = renderTscMarkdown(clusters, {
		durationMs: input.durationMs,
		unparsedLines: unparsedLines.map((u) => u.line),
	});
	return { findings: [...diagFindings, ...unparsedFindings], markdown };
};

function mergeStreams(stdout: string, stderr: string): string {
	if (stderr === "") return stdout;
	if (stdout === "") return stderr;
	return stdout.endsWith("\n") ? `${stdout}${stderr}` : `${stdout}\n${stderr}`;
}

function buildFinding(d: TscDiagnostic, idx: number, path: string): Finding {
	return {
		id: `tsc-${idx}`,
		severity: d.severity,
		title: `${d.ruleId}: ${d.message.slice(0, 120)}`,
		description:
			d.continuation === "" ? d.message : `${d.message}\n${d.continuation}`,
		excerpts: [
			{
				ref: { path, kind: "combined" },
				text: d.rawText,
				lineStart: d.lineStart,
				lineEnd: d.lineEnd,
			},
		],
		evidenceRefs: [{ path, kind: "combined" }],
		relatedFiles: [d.file],
	};
}

function buildUnparsedFinding(u: UnparsedLine, path: string): Finding {
	return {
		id: `tsc-unparsed-${u.line}`,
		severity: "info",
		title: `unparsed: ${u.text.slice(0, 120)}`,
		description: u.text,
		excerpts: [
			{
				ref: { path, kind: "combined" },
				text: u.text,
				lineStart: u.line,
				lineEnd: u.line,
			},
		],
		evidenceRefs: [{ path, kind: "combined" }],
		relatedFiles: [],
	};
}
