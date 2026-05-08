import type { TscDiagnostic } from "./parser.ts";

type NonEmpty<T> = [T, ...T[]];

export type TscCluster = {
	ruleId: string;
	normalizedMessage: string;
	members: NonEmpty<TscDiagnostic>;
};

export function normalizeMessage(message: string): string {
	return message.replace(/'[^']+'/g, "<x>");
}

export function clusterDiagnostics(diags: TscDiagnostic[]): TscCluster[] {
	const buckets = new Map<string, Map<string, NonEmpty<TscDiagnostic>>>();
	for (const d of diags) {
		const norm = normalizeMessage(d.message);
		let byMessage = buckets.get(d.ruleId);
		if (byMessage === undefined) {
			byMessage = new Map();
			buckets.set(d.ruleId, byMessage);
		}
		const members = byMessage.get(norm);
		if (members === undefined) byMessage.set(norm, [d]);
		else members.push(d);
	}

	const clusters: TscCluster[] = [];
	for (const [ruleId, byMessage] of buckets) {
		for (const [normalizedMessage, members] of byMessage) {
			members.sort((a, b) =>
				a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file),
			);
			clusters.push({ ruleId, normalizedMessage, members });
		}
	}
	clusters.sort(
		(a, b) =>
			b.members.length - a.members.length ||
			a.ruleId.localeCompare(b.ruleId) ||
			a.members[0].file.localeCompare(b.members[0].file),
	);
	return clusters;
}
