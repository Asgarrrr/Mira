import { CommandObserver } from "../command/command-observer.ts";
import {
	buildObservation,
	commandObservationSchema,
} from "../core/command-observation.ts";
import { dispatchFilter } from "../filter/dispatch.ts";
import { renderObservationMd } from "../render/render-observation.ts";
import { FileEvidenceStore } from "../store/evidence-store.ts";

export async function runCommand(args: string[]): Promise<number> {
	// `--quiet` suppresses the trailing `[mira] <id> · …` footer. The hook
	// rewriter passes it so agent-facing tool results stay clean (the footer
	// is metadata, not output). Direct CLI invocations keep it as a useful
	// "yes, Mira observed this run X" confirmation.
	const quiet = args.includes("--quiet");
	const cmdArgs = args.filter((a) => a !== "--quiet");
	const command = cmdArgs.join(" ").trim();
	if (!command) {
		process.stderr.write('usage: mira run [--quiet] "<command>"\n');
		return 2;
	}

	const cwd = process.cwd();
	const store = new FileEvidenceStore(cwd);
	const observer = new CommandObserver(store);

	const { run, stdout, stderr } = await observer.observe(command, cwd);

	const dispatchResult = dispatchFilter(
		command,
		{
			stdout,
			stderr,
			exitCode: run.exitCode,
			signal: run.signal,
			durationMs: run.durationMs,
		},
		{ command, cwd, runId: run.id },
	);

	const observation = buildObservation(run);
	if (dispatchResult.kind === "hit") {
		observation.findings = dispatchResult.view.findings;
		observation.filterVersion = dispatchResult.filterVersion;
	}
	// Defensive parse against schema drift after post-build mutation.
	const validated = commandObservationSchema.parse(observation);
	store.writeObservationJson(run.id, validated);
	store.writeObservationMarkdown(run.id, renderObservationMd(validated, run));

	if (dispatchResult.kind === "hit") {
		const md = dispatchResult.view.markdown;
		const trail = md.endsWith("\n") ? "" : "\n";
		store.writeFiltered(run.id, md);
		process.stdout.write(`${md}${trail}_evidence: .mira/runs/${run.id}/_\n`);
	} else {
		if (stdout) process.stdout.write(stdout);
		if (stderr) process.stderr.write(stderr);
		// Dispatcher swallowed the filter exception to keep the agent alive;
		// surface a one-line notice so the failure is not silent.
		if (dispatchResult.kind === "error") {
			process.stderr.write(
				`[mira] filter threw for "${dispatchResult.program}"; passthrough used\n`,
			);
		}
	}

	if (!quiet) {
		const statusBit =
			run.exitCode === null
				? `signal ${run.signal ?? "unknown"}`
				: `exit ${run.exitCode}`;
		const timeoutBit = run.killedByTimeout ? " · timed-out" : "";
		process.stderr.write(
			`[mira] ${run.id} · ${observation.status} · ${statusBit}${timeoutBit} · ${run.durationMs}ms · .mira/runs/${run.id}/\n`,
		);
	}

	return run.exitCode ?? 1;
}
