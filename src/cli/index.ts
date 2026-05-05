#!/usr/bin/env bun
import { runCommand } from "./run.ts";

const USAGE = `usage: mira <command> [args...]

Commands:
  run "<command>"   execute a command, capture evidence, write an observation
`;

async function main(): Promise<void> {
	const [, , subcommand, ...rest] = process.argv;

	if (!subcommand) {
		process.stderr.write(USAGE);
		process.exit(2);
	}

	switch (subcommand) {
		case "run": {
			const code = await runCommand(rest);
			process.exit(code);
			break;
		}
		default:
			process.stderr.write(`mira: unknown command "${subcommand}"\n${USAGE}`);
			process.exit(2);
	}
}

main().catch((err) => {
	process.stderr.write(
		`mira: ${err instanceof Error ? err.message : String(err)}\n`,
	);
	process.exit(1);
});
