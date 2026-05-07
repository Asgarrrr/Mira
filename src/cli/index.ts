#!/usr/bin/env bun
import { runStdioServer } from "../mcp/server.ts";
import { runContext } from "./context.ts";
import { runHooks } from "./hooks/index.ts";
import { runRewrite } from "./rewrite.ts";
import { runCommand } from "./run.ts";

const USAGE = `usage: mira <command> [args...]

Commands:
  run "<command>"     execute a command, capture evidence, write an observation
  context "<task>"    bundle the last 10 observations into a ContextPack
  mcp                 run the MCP server on stdio
  hooks <subcommand>  install/uninstall/status the PreToolUse hook for a client
  rewrite             rewrite a hook payload (internal — invoked by hook script)
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
			// `runStdioServer` resolves once the transport is wired up — it does
			// NOT block until shutdown. We deliberately do not call
			// `process.exit` here: the open stdin handle keeps the event loop
			// alive, the SDK shuts down when stdin closes, and the process
			// exits naturally with the right status.
			await runStdioServer();
			return;
		}
		case "hooks": {
			const code = await runHooks(rest);
			process.exit(code);
			break;
		}
		case "rewrite": {
			const code = await runRewrite(rest);
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
