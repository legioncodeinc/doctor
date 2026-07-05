/**
 * Windows identity resolution tests (Windows 11 25H2 Administrator Protection fix):
 * the SID probe (via the injected CommandRunner, never a bare `whoami`/shell), the
 * domain\user fallback, and the "render with no UserId" terminal fallback.
 */

import { describe, expect, it } from "vitest";

import {
	liveWindowsIdentityFacts,
	resolveWindowsUserId,
	SID_PATTERN,
	type WindowsIdentityFacts,
} from "../../src/service/windows-identity.js";
import { createRecordingRunner } from "./helpers.js";

const FACTS: WindowsIdentityFacts = {
	systemRoot: "C:\\Windows",
	userDomain: "CORP",
	userName: "alice",
};

describe("resolveWindowsUserId - whoami SID path", () => {
	it("calls the ABSOLUTE whoami.exe path under SystemRoot, never a bare `whoami`", async () => {
		const runner = createRecordingRunner(() => ({
			ok: true,
			code: 0,
			stdout: `"CORP\\alice","S-1-5-21-111111111-222222222-333333333-1001"\r\n`,
			stderr: "",
		}));
		await resolveWindowsUserId(runner, FACTS);
		expect(runner.calls).toHaveLength(1);
		expect(runner.calls[0]?.command).toBe("C:\\Windows\\System32\\whoami.exe");
		expect(runner.calls[0]?.args).toEqual(["/user", "/fo", "csv", "/nh"]);
	});

	it("parses the LAST CSV field as the SID and validates it", async () => {
		const runner = createRecordingRunner(() => ({
			ok: true,
			code: 0,
			stdout: `"CORP\\alice","S-1-5-21-111111111-222222222-333333333-1001"\r\n`,
			stderr: "",
		}));
		const userId = await resolveWindowsUserId(runner, FACTS);
		expect(userId).toBe("S-1-5-21-111111111-222222222-333333333-1001");
	});

	it("strips surrounding quotes and whitespace from the parsed field", async () => {
		const runner = createRecordingRunner(() => ({
			ok: true,
			code: 0,
			stdout: `"CORP\\alice",  "S-1-5-21-1-2-3-1001"  \r\n`,
			stderr: "",
		}));
		const userId = await resolveWindowsUserId(runner, FACTS);
		expect(userId).toBe("S-1-5-21-1-2-3-1001");
	});

	it("a username containing a comma does not shift the SID out of the last field", async () => {
		const runner = createRecordingRunner(() => ({
			ok: true,
			code: 0,
			stdout: `"CORP\\Smith, Alice","S-1-5-21-1-2-3-1001"\r\n`,
			stderr: "",
		}));
		const userId = await resolveWindowsUserId(runner, FACTS);
		expect(userId).toBe("S-1-5-21-1-2-3-1001");
	});

	it("SID_PATTERN rejects anything that is not S-1-<n>(-<n>)+", () => {
		expect(SID_PATTERN.test("S-1-5-21-1-2-3-1001")).toBe(true);
		expect(SID_PATTERN.test("S-1-5")).toBe(false);
		expect(SID_PATTERN.test("CORP\\alice")).toBe(false);
		expect(SID_PATTERN.test("")).toBe(false);
		expect(SID_PATTERN.test("S-1-abc-1")).toBe(false);
	});
});

describe("resolveWindowsUserId - fallback ordering", () => {
	it("whoami exit non-zero -> falls back to domain\\user", async () => {
		const runner = createRecordingRunner(() => ({ ok: false, code: 1, stdout: "", stderr: "access denied" }));
		const userId = await resolveWindowsUserId(runner, FACTS);
		expect(userId).toBe("CORP\\alice");
	});

	it("whoami output with an invalid/garbage SID field -> falls back to domain\\user", async () => {
		const runner = createRecordingRunner(() => ({
			ok: true,
			code: 0,
			stdout: `"CORP\\alice","not-a-sid"\r\n`,
			stderr: "",
		}));
		const userId = await resolveWindowsUserId(runner, FACTS);
		expect(userId).toBe("CORP\\alice");
	});

	it("whoami output with no quoted fields at all -> falls back to domain\\user", async () => {
		const runner = createRecordingRunner(() => ({ ok: true, code: 0, stdout: "", stderr: "" }));
		const userId = await resolveWindowsUserId(runner, FACTS);
		expect(userId).toBe("CORP\\alice");
	});

	it("a runner that rejects is tolerated (never throws) and falls back to domain\\user", async () => {
		const throwingRunner = {
			run(): Promise<never> {
				throw new Error("spawn EPERM");
			},
		};
		await expect(resolveWindowsUserId(throwingRunner, FACTS)).resolves.toBe("CORP\\alice");
	});

	it("no SID AND no domain/user -> undefined (render with no UserId)", async () => {
		const runner = createRecordingRunner(() => ({ ok: false, code: 1, stdout: "", stderr: "" }));
		const userId = await resolveWindowsUserId(runner, { systemRoot: "C:\\Windows" });
		expect(userId).toBeUndefined();
	});

	it("an empty-string domain or user is treated as absent, not a literal `\\`", async () => {
		const runner = createRecordingRunner(() => ({ ok: false, code: 1, stdout: "", stderr: "" }));
		const userId = await resolveWindowsUserId(runner, {
			systemRoot: "C:\\Windows",
			userDomain: "",
			userName: "alice",
		});
		expect(userId).toBeUndefined();
	});
});

describe("liveWindowsIdentityFacts", () => {
	it("defaults systemRoot to C:\\Windows when %SystemRoot% is unset/blank", () => {
		const original = process.env["SystemRoot"];
		try {
			delete process.env["SystemRoot"];
			expect(liveWindowsIdentityFacts().systemRoot).toBe("C:\\Windows");
		} finally {
			if (original !== undefined) process.env["SystemRoot"] = original;
		}
	});

	it("reads a real %SystemRoot% when set", () => {
		const original = process.env["SystemRoot"];
		try {
			process.env["SystemRoot"] = "D:\\WINNT";
			expect(liveWindowsIdentityFacts().systemRoot).toBe("D:\\WINNT");
		} finally {
			if (original !== undefined) process.env["SystemRoot"] = original;
			else delete process.env["SystemRoot"];
		}
	});
});
