import { z } from "zod";

import { renderObservationMd } from "../../cli/render-observation.ts";
import { CommandObserver } from "../../command/command-observer.ts";
import {
	buildObservation,
	type CommandObservation,
} from "../../core/command-observation.ts";
import { FileEvidenceStore } from "../../store/evidence-store.ts";
import { miraError } from "../errors.ts";
import { validateProjectRoot } from "../project-root.ts";

export const runCommandInputShape = {
	command: z.string().describe("Shell command to execute via `sh -c`."),
	projectRoot: z
		.string()
		.describe(
			"Absolute path to the project root. The server never reads process.cwd().",
		),
};

export type RunCommandInput = {
	command: string;
	projectRoot: string;
};

export type RunCommandOutput = {
	observation: CommandObservation;
};

// Wraps the Command Kernel. Equivalent to `mira run "<command>"` invoked in
// `projectRoot`. Process-level outcomes (non-zero exit, signal, timeout) are
// returned via `observation.exitCode`, `observation.signal`,
// `observation.killedByTimeout` — never via McpError. Only protocol-level
// failures (invalid input, spawn error) raise McpError. See ADR 0006.
export async function runRunCommandTool(
	input: RunCommandInput,
): Promise<RunCommandOutput> {
	const command = typeof input.command === "string" ? input.command.trim() : "";
	if (command.length === 0) {
		throw miraError("INVALID_INPUT", "command must be a non-empty string");
	}
	const projectRoot = validateProjectRoot(input.projectRoot);

	const store = new FileEvidenceStore(projectRoot);
	const observer = new CommandObserver(store);

	let result: Awaited<ReturnType<CommandObserver["observe"]>>;
	try {
		result = await observer.observe(command, projectRoot);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		throw miraError("INTERNAL", `command spawn failed: ${message}`);
	}

	const observation = buildObservation(result.run);
	store.writeObservationJson(result.run.id, observation);
	store.writeObservationMarkdown(
		result.run.id,
		renderObservationMd(observation, result.run),
	);

	return { observation };
}
