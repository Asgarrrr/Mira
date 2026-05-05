import type {
	ArchitectureSignal,
	ArchitectureSignalKind,
} from "../architecture/architecture-signal.ts";
import type { CommandObservation } from "../core/command-observation.ts";
import type { ContextPack } from "../core/context-pack.ts";
import type { EvidenceRef } from "../core/evidence.ts";

export type BuildContextPackInput = {
	id: string;
	task: string;
	createdAt: string;
	observations: CommandObservation[]; // newest first
	architectureSignals?: ArchitectureSignal[];
};

const SUSPECTED_FILES_CAP = 20;

const KIND_ORDER: readonly ArchitectureSignalKind[] = [
	"changed-file",
	"related-file",
	"test-file",
	"import-hint",
];

export function buildContextPack(input: BuildContextPackInput): ContextPack {
	const { id, task, createdAt, observations, architectureSignals } = input;

	const succeeded = observations.filter((o) => o.status === "success").length;
	const failed = observations.length - succeeded;

	const evidenceRefs: EvidenceRef[] = [];
	for (const obs of observations) {
		const metadataRef = obs.evidenceRefs.find((r) => r.kind === "metadata");
		if (metadataRef) evidenceRefs.push(metadataRef);
	}

	const seen = new Set<string>();
	const verificationCommands: string[] = [];
	for (const obs of observations) {
		if (obs.status !== "success") continue;
		if (seen.has(obs.command)) continue;
		seen.add(obs.command);
		verificationCommands.push(obs.command);
	}

	const suspectedFiles = projectSuspectedFiles(architectureSignals ?? []);

	return {
		id,
		task,
		createdAt,
		summary: `Context pack for \`${task}\` based on ${observations.length} recent observations (${succeeded} succeeded, ${failed} failed).`,
		observationIds: observations.map((o) => o.id),
		evidenceRefs,
		suspectedFiles,
		verificationCommands,
		risks: [],
		nextRecommendedAction: "",
	};
}

// Project signals onto suspectedFiles per ADR 0005:
// kind order changed-file → related-file → test-file → import-hint;
// alphabetical (byte-wise) within each kind; deduplicated across kinds;
// capped at SUSPECTED_FILES_CAP.
function projectSuspectedFiles(signals: ArchitectureSignal[]): string[] {
	const result: string[] = [];
	const seen = new Set<string>();
	for (const kind of KIND_ORDER) {
		const paths = signals
			.filter((s) => s.kind === kind)
			.map((s) => s.path)
			.sort(byteCompare);
		for (const p of paths) {
			if (seen.has(p)) continue;
			seen.add(p);
			result.push(p);
			if (result.length >= SUSPECTED_FILES_CAP) return result;
		}
	}
	return result;
}

function byteCompare(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}
