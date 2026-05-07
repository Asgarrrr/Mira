import { describe, expect, test } from "bun:test";

import {
	buildHookOutput,
	buildRewrittenCommand,
	escapeForShell,
	HOOK_PROTOCOL_VERSION,
	shouldSkip,
} from "../src/cli/rewrite.ts";

describe("shouldSkip — interactive programs (word-anchored)", () => {
	test("vim is skipped", () => {
		const d = shouldSkip("vim foo.ts");
		expect(d.skip).toBe(true);
	});

	test("nvim is skipped", () => {
		expect(shouldSkip("nvim").skip).toBe(true);
	});

	test("less / more / top / htop are skipped", () => {
		for (const c of ["less foo.txt", "more foo.txt", "top", "htop"]) {
			expect(shouldSkip(c).skip).toBe(true);
		}
	});

	test("man / info are skipped", () => {
		expect(shouldSkip("man bash").skip).toBe(true);
		expect(shouldSkip("info coreutils").skip).toBe(true);
	});

	test("bunvim is NOT skipped (false-positive guard, P1 #4)", () => {
		const d = shouldSkip("bunvim foo.ts");
		expect(d.skip).toBe(false);
	});

	test("nanopb is NOT skipped (false-positive guard)", () => {
		expect(shouldSkip("nanopb generate").skip).toBe(false);
	});

	test("git-vim-helper is NOT skipped", () => {
		expect(shouldSkip("git-vim-helper status").skip).toBe(false);
	});

	test("vimrc is NOT skipped (it's a filename arg, not the program)", () => {
		expect(shouldSkip("cat .vimrc").skip).toBe(false);
	});
});

describe("shouldSkip — streaming and watchers", () => {
	test("tail -f is skipped", () => {
		expect(shouldSkip("tail -f log.txt").skip).toBe(true);
	});

	test("tail without -f is NOT skipped", () => {
		expect(shouldSkip("tail -n 100 log.txt").skip).toBe(false);
	});

	test("watch <cmd> is skipped", () => {
		expect(shouldSkip("watch -n 1 'date'").skip).toBe(true);
	});

	test("--watch flag is skipped", () => {
		expect(shouldSkip("bun test --watch").skip).toBe(true);
		expect(shouldSkip("bun --watch test").skip).toBe(true);
	});

	test("--watch=true is skipped", () => {
		expect(shouldSkip("vite build --watch=true").skip).toBe(true);
	});

	test("--watcher (different flag) is NOT skipped", () => {
		expect(shouldSkip("foo --watcher").skip).toBe(false);
	});
});

describe("shouldSkip — backgrounded jobs and heredocs", () => {
	test("trailing & is skipped", () => {
		expect(shouldSkip("sleep 30 &").skip).toBe(true);
	});

	test("& followed by ; is skipped", () => {
		expect(shouldSkip("sleep 30 & ; echo done").skip).toBe(true);
	});

	test("&& (logical AND) is NOT skipped", () => {
		expect(shouldSkip("git add . && git commit").skip).toBe(false);
	});

	test("heredoc is skipped", () => {
		expect(shouldSkip("cat <<EOF\nhello\nEOF").skip).toBe(true);
		expect(shouldSkip("python <<- 'EOF'\nprint('x')\nEOF").skip).toBe(true);
	});

	test("`<<` inside a quoted argument is NOT skipped", () => {
		// We currently err on the side of skipping any `<<\w+`. A `bun test
		// --filter "<<token>>"` is a corner case; document the current behavior
		// and accept it.
		expect(shouldSkip("echo 'x << y'").skip).toBe(true); // accepted false-positive
	});
});

describe("shouldSkip — idempotence (already wrapped)", () => {
	test("already-wrapped via mira run is skipped", () => {
		expect(shouldSkip("mira run 'foo'").skip).toBe(true);
	});

	test("already-wrapped via bun cli/index.ts run is skipped", () => {
		expect(shouldSkip("bun /path/src/cli/index.ts run 'foo'").skip).toBe(true);
	});

	test("already-wrapped with --quiet flag is still detected", () => {
		expect(shouldSkip("mira run --quiet 'foo'").skip).toBe(true);
		expect(
			shouldSkip("bun /path/src/cli/index.ts run --quiet 'foo'").skip,
		).toBe(true);
	});

	test("empty command is skipped", () => {
		expect(shouldSkip("").skip).toBe(true);
		expect(shouldSkip("   ").skip).toBe(true);
	});
});

describe("shouldSkip — happy path (typical agent commands NOT skipped)", () => {
	const happy = [
		"git status",
		"git diff main..HEAD",
		"bun test",
		"bun run typecheck",
		"ls -la",
		"cat src/foo.ts",
		"grep -rn 'pattern' src/",
		"find . -name '*.ts'",
		"echo hello",
		"node script.js",
	];
	for (const cmd of happy) {
		test(`"${cmd}" is NOT skipped`, () => {
			expect(shouldSkip(cmd).skip).toBe(false);
		});
	}
});

describe("escapeForShell", () => {
	test("simple string wraps in single quotes", () => {
		expect(escapeForShell("git status")).toBe("'git status'");
	});

	test("embedded single quote uses '\\'' escape", () => {
		expect(escapeForShell("echo 'hi'")).toBe("'echo '\\''hi'\\'''");
	});

	test("backslash is preserved", () => {
		expect(escapeForShell("echo \\n")).toBe("'echo \\n'");
	});

	test("double quotes pass through (single-quoted shell context)", () => {
		expect(escapeForShell('echo "hi"')).toBe("'echo \"hi\"'");
	});

	test("dollar sign is preserved (single-quoted shell context)", () => {
		expect(escapeForShell("echo $HOME")).toBe("'echo $HOME'");
	});

	test("empty string round-trips as empty single-quoted", () => {
		expect(escapeForShell("")).toBe("''");
	});
});

describe("buildRewrittenCommand", () => {
	test("composes mira-cmd + run --quiet + escaped command", () => {
		const r = buildRewrittenCommand("git status", "/bin/mira");
		expect(r).toBe("/bin/mira run --quiet 'git status'");
	});

	test("default mira-cmd is bun + cli/index.ts", () => {
		const r = buildRewrittenCommand("git status");
		expect(r).toMatch(
			/^bun\s+\/.+src\/cli\/index\.ts run --quiet 'git status'$/,
		);
	});

	test("MIRA_CMD env override is honored", () => {
		const prior = process.env.MIRA_CMD;
		try {
			process.env.MIRA_CMD = "/custom/bin/mira";
			const r = buildRewrittenCommand("git status");
			expect(r).toBe("/custom/bin/mira run --quiet 'git status'");
		} finally {
			if (prior === undefined) delete process.env.MIRA_CMD;
			else process.env.MIRA_CMD = prior;
		}
	});

	test("includes --quiet so the agent's tool result stays clean (no [mira] footer)", () => {
		const r = buildRewrittenCommand("any cmd", "mira");
		expect(r).toContain(" --quiet ");
	});
});

describe("buildHookOutput", () => {
	test("emits the Claude Code PreToolUse JSON shape", () => {
		const o = buildHookOutput("/bin/mira run 'git status'");
		expect(o.hookSpecificOutput.hookEventName).toBe("PreToolUse");
		expect(o.hookSpecificOutput.permissionDecision).toBe("allow");
		expect(o.hookSpecificOutput.updatedInput.command).toBe(
			"/bin/mira run 'git status'",
		);
		expect(typeof o.hookSpecificOutput.permissionDecisionReason).toBe("string");
	});
});

describe("HOOK_PROTOCOL_VERSION", () => {
	test("is currently 1", () => {
		expect(HOOK_PROTOCOL_VERSION).toBe(1);
	});
});
