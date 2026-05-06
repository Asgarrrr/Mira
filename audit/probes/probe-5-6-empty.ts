// Probe 5: generate_context_pack with empty .mira
// Probe 6: senseArchitecture in non-git dir

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { senseArchitecture } from "../../src/architecture/sense.ts";
import { createMiraMcpServer } from "../../src/mcp/server.ts";

async function main() {
	// Probe 5: empty project
	{
		const projectRoot = mkdtempSync(join(tmpdir(), "mira-probe5-"));
		console.log(`[probe 5] projectRoot=${projectRoot} (no .mira/, no .git/)`);

		const server = createMiraMcpServer();
		const [s, c] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "p5", version: "0" });
		await Promise.all([server.connect(s), client.connect(c)]);

		try {
			const r = await client.callTool({
				name: "generate_context_pack",
				arguments: { task: "anything", projectRoot },
			});
			const sc = r.structuredContent as {
				code?: string;
				message?: string;
				pack?: any;
			};
			if (r.isError) {
				console.log(
					`*** generate_context_pack errored on empty project: code=${sc.code} msg=${sc.message}`,
				);
			} else {
				console.log(
					`pack.id=${sc.pack?.id} task="${sc.pack?.task}" observationIds=${JSON.stringify(sc.pack?.observationIds)} suspectedFiles=${JSON.stringify(sc.pack?.suspectedFiles)}`,
				);
			}

			// list_recent_runs on empty
			const r2 = await client.callTool({
				name: "list_recent_runs",
				arguments: { projectRoot },
			});
			const sc2 = r2.structuredContent as { runs?: unknown[]; code?: string };
			console.log(
				`list_recent_runs(empty): isError=${r2.isError} runs=${sc2.runs?.length} code=${sc2.code}`,
			);
		} finally {
			await client.close();
			await server.close();
			rmSync(projectRoot, { recursive: true, force: true });
		}
	}

	// Probe 6: senseArchitecture outside a git repo
	{
		const cwd = mkdtempSync(join(tmpdir(), "mira-probe6-"));
		console.log(`\n[probe 6] cwd=${cwd} (NOT a git repo)`);
		try {
			const signals = await senseArchitecture(cwd);
			console.log(`signals: ${JSON.stringify(signals)}`);
			if (signals.length === 0) {
				console.log("OK: returned [] cleanly");
			}
		} catch (e) {
			console.log(
				`*** senseArchitecture threw: ${e instanceof Error ? e.message : e}`,
			);
		}
		rmSync(cwd, { recursive: true, force: true });
	}

	// Probe 6b: senseArchitecture where `git` binary doesn't exist (simulate via PATH=""):
	{
		const cwd = mkdtempSync(join(tmpdir(), "mira-probe6b-"));
		console.log(`\n[probe 6b] cwd=${cwd}, PATH=""`);
		const oldPath = process.env.PATH;
		process.env.PATH = "";
		try {
			const signals = await senseArchitecture(cwd);
			console.log(`signals: ${JSON.stringify(signals)}`);
		} catch (e) {
			console.log(
				`*** senseArchitecture threw with empty PATH: ${e instanceof Error ? e.message : e}`,
			);
		} finally {
			process.env.PATH = oldPath;
			rmSync(cwd, { recursive: true, force: true });
		}
	}
}

main().catch((e) => {
	console.error("FATAL", e);
	process.exit(1);
});
