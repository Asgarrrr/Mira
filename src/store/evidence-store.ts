import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { CommandObservation } from "../core/command-observation.ts";
import type { CommandRun } from "../core/command-run.ts";
import type { ContextPack } from "../core/context-pack.ts";
import { generateContextId, generateRunId } from "../core/ids.ts";

// Internal filename key for the file-backed store. One logical observation
// (EvidenceKind = "observation") is split into two files on disk, hence the
// _json / _md suffixes. Public refs use EvidenceKind; this enum stays local.
type RunFileKey =
	| "stdout"
	| "stderr"
	| "combined"
	| "metadata"
	| "observation_json"
	| "observation_md";

const FILENAMES: Record<RunFileKey, string> = {
	stdout: "stdout.log",
	stderr: "stderr.log",
	combined: "combined.log",
	metadata: "metadata.json",
	observation_json: "observation.json",
	observation_md: "observation.md",
};

export class FileEvidenceStore {
	private readonly runsDir: string;
	private readonly contextDir: string;

	constructor(projectRoot: string) {
		this.runsDir = join(projectRoot, ".mira", "runs");
		this.contextDir = join(projectRoot, ".mira", "context");
	}

	createRun(): { runId: string; runDir: string; metadataPath: string } {
		mkdirSync(this.runsDir, { recursive: true });
		const runId = generateRunId();
		const runDir = join(this.runsDir, runId);
		mkdirSync(runDir);
		const metadataPath = join(runDir, FILENAMES.metadata);
		return { runId, runDir, metadataPath };
	}

	writeStdout(runId: string, text: string): void {
		this.writeRunFile(runId, "stdout", text);
	}

	writeStderr(runId: string, text: string): void {
		this.writeRunFile(runId, "stderr", text);
	}

	writeCombined(runId: string, text: string): void {
		this.writeRunFile(runId, "combined", text);
	}

	writeMetadata(runId: string, run: CommandRun): void {
		this.writeRunFile(runId, "metadata", `${JSON.stringify(run, null, 2)}\n`);
	}

	writeObservationJson(runId: string, observation: CommandObservation): void {
		this.writeRunFile(
			runId,
			"observation_json",
			`${JSON.stringify(observation, null, 2)}\n`,
		);
	}

	writeObservationMarkdown(runId: string, markdown: string): void {
		this.writeRunFile(runId, "observation_md", markdown);
	}

	readRun(runId: string): CommandRun {
		return JSON.parse(this.readEvidence(runId, "metadata")) as CommandRun;
	}

	runDir(runId: string): string {
		return join(this.runsDir, runId);
	}

	readEvidence(runId: string, kind: RunFileKey): string {
		return readFileSync(join(this.runsDir, runId, FILENAMES[kind]), "utf8");
	}

	listRecentObservations(limit: number): CommandObservation[] {
		if (!existsSync(this.runsDir)) return [];
		// Walk newest-first and skip dirs whose observation.json is missing or
		// unreadable (missing file, partial write, malformed JSON, race between
		// existsSync and readFileSync). One corrupt entry must not poison the
		// projection — `get_observation(id)` still surfaces the parse error
		// per-row (single-target read → single-target failure). We must filter
		// *while* iterating, not after slicing: a corrupt dir at the top of the
		// sort would otherwise shrink the result below `limit` even when more
		// valid observations exist behind it.
		const observations: CommandObservation[] = [];
		const entries = readdirSync(this.runsDir).sort().reverse();
		for (const runId of entries) {
			if (observations.length >= limit) break;
			const path = join(this.runsDir, runId, FILENAMES.observation_json);
			if (!existsSync(path)) continue;
			let observation: CommandObservation;
			try {
				observation = JSON.parse(
					readFileSync(path, "utf8"),
				) as CommandObservation;
			} catch {
				continue;
			}
			observations.push(observation);
		}
		return observations;
	}

	createContext(): { contextId: string; jsonPath: string; mdPath: string } {
		mkdirSync(this.contextDir, { recursive: true });
		const contextId = generateContextId();
		return {
			contextId,
			jsonPath: join(this.contextDir, `${contextId}.json`),
			mdPath: join(this.contextDir, `${contextId}.md`),
		};
	}

	writeContextJson(contextId: string, pack: ContextPack): void {
		writeFileSync(
			join(this.contextDir, `${contextId}.json`),
			`${JSON.stringify(pack, null, 2)}\n`,
			"utf8",
		);
	}

	writeContextMarkdown(contextId: string, markdown: string): void {
		writeFileSync(join(this.contextDir, `${contextId}.md`), markdown, "utf8");
	}

	private writeRunFile(runId: string, kind: RunFileKey, text: string): void {
		writeFileSync(join(this.runsDir, runId, FILENAMES[kind]), text, "utf8");
	}
}
