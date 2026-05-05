#!/usr/bin/env bun
import { runStdioServer } from "../mcp/server.ts";
import { runContext } from "./context.ts";
import { runCommand } from "./run.ts";

const USAGE = `usage: mira <command> [args...]

Commands:
  run "<command>"     execute a command, capture evidence, write an observation
  context "<task>"    bundle the last 10 observations into a ContextPack
  mcp                 run the MCP server on stdio
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
		case "context": {
			const code = await runContext(rest);
			process.exit(code);
			break;
		}
		case "mcp": {
			if (rest.length > 0) {
				process.stderr.write("usage: mira mcp\n");
				process.exit(2);
			}
			await runStdioServer();
			return;
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
