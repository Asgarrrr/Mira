// Probe 1b: Symlink-as-directory escape — point .mira/runs/escape -> /etc,
// then try to read /etc/hosts via path "runs/escape/hosts".

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMiraMcpServer } from "../../src/mcp/server.ts";

async function main() {
	const projectRoot = mkdtempSync(join(tmpdir(), "mira-probe1b-"));
	console.log(`projectRoot=${projectRoot}`);
	mkdirSync(join(projectRoot, ".mira", "runs"), { recursive: true });
	symlinkSync("/etc", join(projectRoot, ".mira", "runs", "escape"));
	console.log(`/etc/hosts exists? ${existsSync("/etc/hosts")}`);
	console.log(
		`runs/escape/hosts via symlink exists? ${existsSync(join(projectRoot, ".mira", "runs", "escape", "hosts"))}`,
	);

	const server = createMiraMcpServer();
	const [s, c] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "p", version: "0" });
	await Promise.all([server.connect(s), client.connect(c)]);

	try {
		const result = await client.callTool({
			name: "get_raw_evidence",
			arguments: {
				ref: { path: "runs/escape/hosts", kind: "other" },
				projectRoot,
			},
		});
		const structured = result.structuredContent as {
			code?: string;
			message?: string;
			bytes?: number;
			content?: string;
		};
		if (result.isError) {
			console.log(
				`REJECTED code=${structured.code} msg=${(structured.message ?? "").slice(0, 120)}`,
			);
		} else {
			console.log(`*** ESCAPE: read ${structured.bytes} bytes`);
			console.log((structured.content ?? "").slice(0, 200));
		}

		// Also try a top-level dir symlink directly under .mira:  .mira/leak -> /etc
		symlinkSync("/etc", join(projectRoot, ".mira", "leak"));
		const r2 = await client.callTool({
			name: "get_raw_evidence",
			arguments: { ref: { path: "leak/hosts", kind: "other" }, projectRoot },
		});
		const s2 = r2.structuredContent as {
			code?: string;
			message?: string;
			bytes?: number;
			content?: string;
		};
		if (r2.isError) {
			console.log(
				`leak/hosts REJECTED code=${s2.code} msg=${(s2.message ?? "").slice(0, 120)}`,
			);
		} else {
			console.log(`*** ESCAPE (top-level): read ${s2.bytes} bytes`);
			console.log((s2.content ?? "").slice(0, 200));
		}
	} finally {
		await client.close();
		await server.close();
		rmSync(projectRoot, { recursive: true, force: true });
	}
}

main().catch((e) => {
	console.error("FATAL", e);
	process.exit(1);
});
