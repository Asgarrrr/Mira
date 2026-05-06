import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

import { runGetRawEvidenceTool } from "../src/mcp/tools/get-raw-evidence.ts";

describe("get_raw_evidence tool", () => {
	let projectRoot: string;

	beforeEach(() => {
		projectRoot = mkdtempSync(join(tmpdir(), "mira-mcp-raw-"));
		mkdirSync(join(projectRoot, ".mira", "runs", "run_x"), { recursive: true });
		writeFileSync(
			join(projectRoot, ".mira", "runs", "run_x", "stdout.log"),
			"hello\nworld\n",
			"utf8",
		);
	});

	afterEach(() => {
		rmSync(projectRoot, { recursive: true, force: true });
	});

	test("happy path: returns content verbatim with byte size", async () => {
		const result = await runGetRawEvidenceTool({
			ref: {
				path: join(projectRoot, ".mira", "runs", "run_x", "stdout.log"),
				kind: "stdout",
			},
			projectRoot,
		});

		expect(result.content).toBe("hello\nworld\n");
		expect(result.bytes).toBe(Buffer.byteLength("hello\nworld\n", "utf8"));
		expect(result.ref.path).toBe(
			join(projectRoot, ".mira", "runs", "run_x", "stdout.log"),
		);
		expect(result.ref.kind).toBe("stdout");
	});

	test("accepts a path relative to .mira/", async () => {
		const result = await runGetRawEvidenceTool({
			ref: { path: "runs/run_x/stdout.log", kind: "stdout" },
			projectRoot,
		});
		expect(result.content).toBe("hello\nworld\n");
	});

	test("PATH_OUTSIDE_EVIDENCE for relative `..` traversal", async () => {
		try {
			await runGetRawEvidenceTool({
				ref: { path: "../etc/passwd", kind: "other" },
				projectRoot,
			});
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			expect((err as McpError).data).toMatchObject({
				code: "PATH_OUTSIDE_EVIDENCE",
			});
		}
	});

	test("PATH_OUTSIDE_EVIDENCE for absolute path outside .mira/", async () => {
		try {
			await runGetRawEvidenceTool({
				ref: { path: "/etc/hosts", kind: "other" },
				projectRoot,
			});
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			expect((err as McpError).data).toMatchObject({
				code: "PATH_OUTSIDE_EVIDENCE",
			});
		}
	});

	test("PATH_OUTSIDE_EVIDENCE for a real symlink under .mira/ pointing outside", async () => {
		// Plant a symlink inside .mira/ that targets a real, existing file
		// outside the evidence root. The realpath check must reject this BEFORE
		// any read — if the test ever passes because the target is missing,
		// that's a regression.
		const linkDir = join(projectRoot, ".mira", "runs", "run_x");
		const linkPath = join(linkDir, "leak");
		const target = "/etc/hosts";
		symlinkSync(target, linkPath);

		try {
			await runGetRawEvidenceTool({
				ref: { path: linkPath, kind: "other" },
				projectRoot,
			});
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			expect((err as McpError).data).toMatchObject({
				code: "PATH_OUTSIDE_EVIDENCE",
			});
		}
	});

	test("NOT_FOUND when the file does not exist (lexically inside .mira/)", async () => {
		try {
			await runGetRawEvidenceTool({
				ref: {
					path: join(projectRoot, ".mira", "runs", "run_x", "missing.log"),
					kind: "stdout",
				},
				projectRoot,
			});
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			expect((err as McpError).data).toMatchObject({ code: "NOT_FOUND" });
		}
	});

	test("INVALID_INPUT when ref.path is empty", async () => {
		try {
			await runGetRawEvidenceTool({
				ref: { path: "", kind: "stdout" },
				projectRoot,
			});
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			expect((err as McpError).data).toMatchObject({ code: "INVALID_INPUT" });
		}
	});

	test("INVALID_INPUT when projectRoot is missing", async () => {
		try {
			await runGetRawEvidenceTool({
				ref: { path: "runs/run_x/stdout.log", kind: "stdout" },
				projectRoot: "/this/does/not/exist/anywhere",
			});
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			expect((err as McpError).data).toMatchObject({ code: "INVALID_INPUT" });
		}
	});

	test("INVALID_INPUT when ref.path is longer than the OS path limit (ENAMETOOLONG)", async () => {
		// 10k chars is well past the ~1 KB OS limit on Darwin/Linux. The catch
		// block must map ENAMETOOLONG to INVALID_INPUT, not INTERNAL — see ADR
		// 0006 § Error model and audit/08-L2-error-mapping.md.
		const longSegment = "a".repeat(10_000);
		try {
			await runGetRawEvidenceTool({
				ref: { path: `runs/run_x/${longSegment}`, kind: "stdout" },
				projectRoot,
			});
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			expect((err as McpError).data).toMatchObject({
				code: "INVALID_INPUT",
				message: "ref.path too long",
			});
		}
	});

	test("does not truncate or summarize content (large file is returned verbatim)", async () => {
		const big = `${"x".repeat(200_000)}\n`;
		writeFileSync(
			join(projectRoot, ".mira", "runs", "run_x", "stdout.log"),
			big,
			"utf8",
		);
		const result = await runGetRawEvidenceTool({
			ref: { path: "runs/run_x/stdout.log", kind: "stdout" },
			projectRoot,
		});
		expect(result.content).toBe(big);
		expect(result.bytes).toBe(big.length);
	});
});
