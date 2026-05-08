import type { TscCluster } from "./cluster.ts";
import type { TscDiagnostic } from "./parser.ts";

export type RenderOptions = { durationMs: number; unparsedLines?: number[] };

const PLACEHOLDER_LETTERS = ["X", "Y", "Z", "T", "U", "V", "W"];
const CONTINUATION_LIMIT = 240;
const TOP_CODES_LIMIT = 5;
const ALSO_LOCATIONS_LIMIT = 50;

export function renderTscMarkdown(
	clusters: TscCluster[],
	opts: RenderOptions,
): string {
	const unparsed = opts.unparsedLines ?? [];
	const footer = formatUnparsedFooter(unparsed);
	if (clusters.length === 0) {
		const head = `# tsc — pass (${opts.durationMs}ms)`;
		return footer === null ? `${head}\n` : `${head}\n\n${footer}\n`;
	}
	let errors = 0;
	let warnings = 0;
	let infos = 0;
	const fileSet = new Set<string>();
	for (const c of clusters) {
		for (const m of c.members) {
			fileSet.add(m.file);
			if (m.severity === "error") errors++;
			else if (m.severity === "warning") warnings++;
			else infos++;
		}
	}
	const fileWord = fileSet.size === 1 ? "file" : "files";
	const counts: string[] = [];
	if (errors > 0) counts.push(`${errors} ${errors === 1 ? "error" : "errors"}`);
	if (warnings > 0)
		counts.push(`${warnings} ${warnings === 1 ? "warning" : "warnings"}`);
	if (infos > 0) counts.push(`${infos} info`);
	const header = `# tsc — ${counts.join(", ")} in ${fileSet.size} ${fileWord} (${opts.durationMs}ms)`;
	const topLine = formatTopCodes(clusters);
	const headerBlock = topLine === null ? header : `${header}\n${topLine}`;
	const bullets = clusters.map(renderCluster);
	const body = `${headerBlock}\n\n${bullets.join("\n")}`;
	return footer === null ? `${body}\n` : `${body}\n\n${footer}\n`;
}

function formatUnparsedFooter(unparsed: number[]): string | null {
	if (unparsed.length === 0) return null;
	const word = unparsed.length === 1 ? "line" : "lines";
	return `⚠ ${unparsed.length} unparsed ${word} — see combined.log:${formatLineRanges(unparsed)}`;
}

export function formatLineRanges(lines: number[]): string {
	if (lines.length === 0) return "";
	const sorted = [...lines].sort((a, b) => a - b);
	const parts: string[] = [];
	let start = sorted[0] as number;
	let prev = start;
	for (let i = 1; i < sorted.length; i++) {
		const n = sorted[i] as number;
		if (n === prev + 1) {
			prev = n;
			continue;
		}
		parts.push(start === prev ? `${start}` : `${start}-${prev}`);
		start = n;
		prev = n;
	}
	parts.push(start === prev ? `${start}` : `${start}-${prev}`);
	return parts.join(", ");
}

// Skipped when one rule dominates — the cluster line below carries the
// same info, so the top line would be pure redundancy.
function formatTopCodes(clusters: TscCluster[]): string | null {
	const counts = new Map<string, number>();
	for (const c of clusters) {
		counts.set(c.ruleId, (counts.get(c.ruleId) ?? 0) + c.members.length);
	}
	if (counts.size < 2) return null;
	const sorted = [...counts.entries()].sort(
		(a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
	);
	const top = sorted
		.slice(0, TOP_CODES_LIMIT)
		.map(([code, n]) => `${code} (${n}×)`);
	return `_top: ${top.join(" · ")}_`;
}

function renderCluster(c: TscCluster): string {
	const [first, ...rest] = c.members;
	if (rest.length === 0) return renderSingle(first);
	return renderMultiCluster(c, first, rest);
}

function renderSingle(d: TscDiagnostic): string {
	const head = `- **${d.ruleId}** ${d.file}:${d.line}:${d.column} — ${d.message}`;
	const tail: string[] = [];
	if (d.continuation !== "") tail.push(renderContinuation(d.continuation));
	if (d.suggestion !== undefined)
		tail.push(`  💡 Did you mean '${d.suggestion}'?`);
	return tail.length === 0 ? head : `${head}\n${tail.join("\n")}`;
}

function renderMultiCluster(
	c: TscCluster,
	exemplar: TscDiagnostic,
	rest: TscDiagnostic[],
): string {
	const template = expandTemplate(c.normalizedMessage);
	const head = `- **${c.ruleId}** ×${c.members.length} — same shape: ${template}`;
	const eg = `  e.g. ${exemplar.file}:${exemplar.line}:${exemplar.column} — ${exemplar.message}`;
	const also = `  also: ${renderAlso(rest)}`;
	return `${head}\n${eg}\n${also}`;
}

function expandTemplate(normalized: string): string {
	let i = 0;
	return normalized.replace(/<x>/g, () => {
		const letter = PLACEHOLDER_LETTERS[i++];
		return letter ?? "<x>";
	});
}

function renderContinuation(continuation: string): string {
	let body = continuation;
	let truncated = false;
	if (body.length > CONTINUATION_LIMIT) {
		body = body.slice(0, CONTINUATION_LIMIT - 1);
		truncated = true;
	}
	const indented = body
		.split("\n")
		.map((l) => `  ${l}`)
		.join("\n");
	return truncated ? `${indented}…` : indented;
}

function renderAlso(members: TscDiagnostic[]): string {
	const groups = Map.groupBy(members, (m) => m.file);
	// Cap visible locations: a thousand-cascade collapsed into one bullet
	// must not re-expand into a multi-KB line. Overflow → "+N more".
	const parts: string[] = [];
	let shown = 0;
	let hidden = 0;
	for (const [file, diags] of groups) {
		diags.sort((a, b) => a.line - b.line);
		const remaining = ALSO_LOCATIONS_LIMIT - shown;
		if (remaining <= 0) {
			hidden += diags.length;
			continue;
		}
		const visible = diags.slice(0, remaining);
		hidden += diags.length - visible.length;
		const locs = visible.map((d) => `${d.line}:${d.column}`).join(", ");
		parts.push(`${file} at ${locs}`);
		shown += visible.length;
	}
	const joined = parts.join("; ");
	return hidden > 0 ? `${joined} · +${hidden} more` : joined;
}
