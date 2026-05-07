import { join, resolve } from "node:path";

import { generateReport } from "./report.ts";

async function runReportFromCli(argv: string[]): Promise<void> {
	const dir = argv[0];
	if (!dir) {
		console.error("usage: bun harness/run.ts report <resultsDir>");
		process.exit(2);
	}
	const resolved = resolve(dir);
	await generateReport(resolved);
	console.log(`[report] wrote ${join(resolved, "summary.md")}`);
}

if (import.meta.main) {
	const subcommand = process.argv[2];
	if (subcommand === "report") {
		await runReportFromCli(process.argv.slice(3));
	} else {
		console.error("usage: bun harness/run.ts report <resultsDir>");
		process.exit(2);
	}
}
