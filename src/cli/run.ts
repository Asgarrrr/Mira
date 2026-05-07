import { CommandObserver } from "../command/command-observer.ts";
import { buildObservation } from "../core/command-observation.ts";
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

	const observation = buildObservation(run);
	store.writeObservationJson(run.id, observation);
	store.writeObservationMarkdown(run.id, renderObservationMd(observation, run));

	if (stdout) process.stdout.write(stdout);
	if (stderr) process.stderr.write(stderr);

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
