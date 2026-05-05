import { describe, expect, test } from "bun:test";

import { generateContextId, generateRunId } from "../src/core/ids.ts";

describe("generateRunId", () => {
	test("matches the documented format", () => {
		expect(generateRunId()).toMatch(/^run_\d{8}T\d{9}Z_[a-z0-9]{6}$/);
	});

	test("produces distinct ids across many sequential calls", () => {
		const ids = new Set(Array.from({ length: 1000 }, () => generateRunId()));
		expect(ids.size).toBe(1000);
	});
});

describe("generateContextId", () => {
	test("matches the documented format", () => {
		expect(generateContextId()).toMatch(/^ctx_\d{8}T\d{9}Z_[a-z0-9]{6}$/);
	});

	test("produces distinct ids across many sequential calls", () => {
		const ids = new Set(
			Array.from({ length: 1000 }, () => generateContextId()),
		);
		expect(ids.size).toBe(1000);
	});
});
