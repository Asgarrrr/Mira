import type { Finding } from "../../../core/finding.ts";
import type { Filter, FilteredView } from "../../types.ts";
import { clusterDiagnostics } from "./cluster.ts";
import { parseTscOutput, type TscDiagnostic } from "./parser.ts";
import { renderTscMarkdown } from "./render.ts";

export { TSC_FILTER_VERSION } from "./version.ts";

export const tscFilter: Filter = (input, ctx): FilteredView => {
	const text = mergeStreams(input.stdout, input.stderr);
	const diags = parseTscOutput(text);
	const findings = diags.map((d, i) => buildFinding(d, i, ctx.runId));
	const clusters = clusterDiagnostics(diags);
	const markdown = renderTscMarkdown(clusters, {
		durationMs: input.durationMs,
	});
	return { findings, markdown };
};

function mergeStreams(stdout: string, stderr: string): string {
	if (stderr === "") return stdout;
	if (stdout === "") return stderr;
	return stdout.endsWith("\n") ? `${stdout}${stderr}` : `${stdout}\n${stderr}`;
}

function buildFinding(d: TscDiagnostic, idx: number, runId: string): Finding {
	const path = `.mira/runs/${runId}/combined.log`;
	const titleMsg = d.message.split("\n")[0]?.slice(0, 120) ?? "";
	return {
		id: `tsc-${idx}`,
		severity: d.severity,
		title: `${d.ruleId}: ${titleMsg}`,
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
