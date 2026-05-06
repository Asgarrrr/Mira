// Sandbox-guard tests for the eval harness `bash` tool. Self-contained: spins
// up a tmp workdir with a README and a `tests/` tree so the "allowed" cases
// have something to read. Exits non-zero on the first regression.
//
// Why not `bash.test.ts`: the file is intentionally named so Bun's auto-test
// discovery (`.test.ts`, `_test.ts`, `.spec.ts`, `_spec.ts`) does NOT pick it
// up. The eval tree must stay isolated from the root `tests/` suite — see
// `audit/07-M2-bash-sandbox.md` § Acceptance criteria.
//
// Run with: `bun harness/tools/bash-sandbox-tests.ts` from the eval/ root,
// or via the `test:bash-sandbox` script in eval/package.json.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBashTool } from "./bash.ts";

type Case = { name: string; cmd: string };

// B1–B5 from audit/07-M2-bash-sandbox.md plus a regression-guard catalog of
// vectors that the older guard already rejected and that the tightened guard
// must still reject. Every case here MUST come back with isError=true and
// content starting with "absolute path token rejected:".
const REJECTED: Case[] = [
	// B1
	{ name: "B1 var sub: x=/etc/passwd; cat $x", cmd: "x=/etc/passwd; cat $x" },
	// B2
	{
		name: "B2 env var with /tmp: FILE=/tmp/...; cat $FILE",
		cmd: "FILE=/tmp/probe-canary; cat $FILE",
	},
	// B3
	{ name: "B3 backslash escape: cat \\/etc/passwd", cmd: "cat \\/etc/passwd" },
	// B4
	{
		name: "B4 stdin redirect: read x </etc/passwd; echo $x",
		cmd: "read x </etc/passwd; echo $x",
	},
	// B5 — the confirmed write-outside-workdir vector
	{
		name: "B5 write redirect: echo pwned >/tmp/probe-pwned",
		cmd: "echo pwned >/tmp/mira-bash-sandbox-tests-pwned",
	},
	// Regression-guard: the old guard already rejected these. They must stay
	// rejected after the tightening.
	{ name: "direct absolute: cat /etc/passwd", cmd: "cat /etc/passwd" },
	{
		name: "command substitution: cat $(echo /etc/passwd)",
		cmd: "cat $(echo /etc/passwd)",
	},
	{ name: "chained: cd /; cat etc/passwd", cmd: "cd /; cat etc/passwd" },
	{
		name: "single-quoted absolute: cat '/etc/passwd'",
		cmd: "cat '/etc/passwd'",
	},
	// Extra: stdin redirect direct (B4 sibling, was a leak before fix).
	{ name: "stdin redirect direct: cat </etc/passwd", cmd: "cat </etc/passwd" },
];

// Legitimate commands the agent must still be able to issue. Every case here
// must NOT come back with the "absolute path token rejected:" message.
const ALLOWED: Case[] = [
	{ name: "echo only", cmd: "echo hello" },
	{ name: "cat README.md", cmd: "cat README.md" },
	{ name: "cat ./README.md", cmd: "cat ./README.md" },
	{ name: "cat ./tests/foo.test.ts", cmd: "cat ./tests/foo.test.ts" },
	{ name: "redirect 2>/dev/null", cmd: "echo hi 2>/dev/null" },
	{ name: "cat /dev/null", cmd: "cat /dev/null" },
];

async function main() {
	const workdir = mkdtempSync(join(tmpdir(), "mira-bash-sandbox-tests-"));
	writeFileSync(join(workdir, "README.md"), "hello\n");
	mkdirSync(join(workdir, "tests"));
	writeFileSync(join(workdir, "tests", "foo.test.ts"), "// dummy\n");

	const tool = makeBashTool(2000);
	const ctx = { workdir } as { workdir: string };

	let passed = 0;
	const failures: string[] = [];

	const isRejection = (content: string): boolean =>
		content.startsWith("absolute path token rejected:");

	for (const c of REJECTED) {
		const r = await tool.run({ command: c.cmd }, ctx);
		const content = String(r.content ?? "");
		if (r.isError === true && isRejection(content)) {
			passed += 1;
		} else {
			failures.push(
				`[want rejected] ${c.name}\n    cmd=${JSON.stringify(c.cmd)}\n    got isError=${r.isError} content=${JSON.stringify(content.slice(0, 160))}`,
			);
		}
	}

	for (const c of ALLOWED) {
		const r = await tool.run({ command: c.cmd }, ctx);
		const content = String(r.content ?? "");
		if (!isRejection(content)) {
			passed += 1;
		} else {
			failures.push(
				`[want allowed] ${c.name}\n    cmd=${JSON.stringify(c.cmd)}\n    got isError=${r.isError} content=${JSON.stringify(content.slice(0, 160))}`,
			);
		}
	}

	rmSync(workdir, { recursive: true, force: true });
	// Defensive: B5 must not have actually written anything. If it did, the
	// guard didn't fire and the rest of the suite is moot.
	const leakedPath = "/tmp/mira-bash-sandbox-tests-pwned";
	const { existsSync } = await import("node:fs");
	if (existsSync(leakedPath)) {
		failures.push(
			`[B5 write actually landed] file at ${leakedPath} exists — guard did not block the write`,
		);
		rmSync(leakedPath, { force: true });
	}

	const total = REJECTED.length + ALLOWED.length;
	console.log(`bash sandbox tests: ${passed}/${total} passed`);
	if (failures.length > 0) {
		for (const f of failures) console.error(`FAIL ${f}`);
		process.exit(1);
	}
	console.log("[bash-sandbox-tests] OK");
}

main().catch((e) => {
	console.error("FATAL", e);
	process.exit(1);
});
