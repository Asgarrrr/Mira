import type { TscCluster } from "./cluster.ts";
import type { TscDiagnostic } from "./parser.ts";

export type RenderOptions = { durationMs: number };

const PLACEHOLDER_LETTERS = ["X", "Y", "Z", "T", "U", "V", "W"];
const CONTINUATION_LIMIT = 240;
const TOP_CODES_LIMIT = 5;

export function renderTscMarkdown(
	clusters: TscCluster[],
	opts: RenderOptions,
): string {
	if (clusters.length === 0) {
		return `# tsc — pass (${opts.durationMs}ms)\n`;
	}
	const totalDiags = clusters.reduce((sum, c) => sum + c.members.length, 0);
	const fileSet = new Set<string>();
	for (const c of clusters) for (const m of c.members) fileSet.add(m.file);
	const errorWord = totalDiags === 1 ? "error" : "errors";
	const fileWord = fileSet.size === 1 ? "file" : "files";
	const header = `# tsc — ${totalDiags} ${errorWord} in ${fileSet.size} ${fileWord} (${opts.durationMs}ms)`;
	const topLine = formatTopCodes(clusters);
	const headerBlock = topLine === null ? header : `${header}\n${topLine}`;
	const bullets = clusters.map(renderCluster);
	return `${headerBlock}\n\n${bullets.join("\n")}\n`;
}

// One-line dominant-rule summary (top 5 by count, ruleId alpha tiebreaker).
// Skipped when there's only a single unique ruleId — the cluster line below
// already carries the same info, so the line would be pure redundancy.
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
	// Clusters always carry ≥1 member by clusterDiagnostics' construction; the
	// guard satisfies noUncheckedIndexedAccess without a non-null assertion.
	if (first === undefined) return "";
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
	type Loc = { line: number; col: number };
	// Map preserves insertion order — no parallel `order` array needed.
	const groups = new Map<string, Loc[]>();
	for (const m of members) {
		const existing = groups.get(m.file);
		const loc: Loc = { line: m.line, col: m.column };
		if (existing === undefined) groups.set(m.file, [loc]);
		else existing.push(loc);
	}
	const parts: string[] = [];
	for (const [file, locations] of groups) {
		locations.sort((a, b) => a.line - b.line);
		const locs = locations.map((l) => `${l.line}:${l.col}`).join(", ");
		parts.push(`${file} at ${locs}`);
	}
	return parts.join("; ");
}
