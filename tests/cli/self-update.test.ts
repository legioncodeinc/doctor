/**
 * self-update tests (PRD-064f AC-064f.5): the SOLE path that installs Doctor's
 * own package, and only when explicitly invoked.
 */

import { describe, expect, it, vi } from "vitest";

import { createSelfUpdate, parseApprovedVersion } from "../../src/cli/self-update.js";
import { silentLogger } from "../../src/logger.js";
import { DOCTOR_PACKAGE } from "../../src/version.js";
import type { CommandResult, CommandRunner } from "../../src/rungs/command-runner.js";

/** A fake runner recording the exact argv it was asked to run. */
function recordingRunner(result: CommandResult): { runner: CommandRunner; calls: Array<{ cmd: string; args: string[] }> } {
	const calls: Array<{ cmd: string; args: string[] }> = [];
	return {
		calls,
		runner: {
			async run(cmd, args): Promise<CommandResult> {
				calls.push({ cmd, args: [...args] });
				return result;
			},
		},
	};
}

describe("createSelfUpdate", () => {
	it("runs `npm install -g @legioncodeinc/doctor@latest`", async () => {
		const r = recordingRunner({ ok: true, code: 0, stdout: "", stderr: "" });
		const selfUpdate = createSelfUpdate({ runner: r.runner, logger: silentLogger });
		const msg = await selfUpdate();

		expect(r.calls).toHaveLength(1);
		expect(r.calls[0]?.cmd).toBe("npm");
		expect(r.calls[0]?.args).toEqual(["install", "-g", `${DOCTOR_PACKAGE}@latest`]);
		expect(msg).toContain("Doctor updated");
	});

	it("targets the Doctor package, never the primary daemon package", async () => {
		const r = recordingRunner({ ok: true, code: 0, stdout: "", stderr: "" });
		await createSelfUpdate({ runner: r.runner, logger: silentLogger })();
		const spec = r.calls[0]?.args[2] ?? "";
		expect(spec.startsWith(DOCTOR_PACKAGE)).toBe(true);
		expect(spec).not.toContain("@legioncodeinc/honeycomb");
	});

	it("returns a failure message (never throws) on a failed install", async () => {
		const r = recordingRunner({ ok: false, code: 1, stdout: "", stderr: "", detail: "ENETDOWN" });
		const msg = await createSelfUpdate({ runner: r.runner, logger: silentLogger })();
		expect(msg).toContain("self-update failed");
		expect(msg).toContain("ENETDOWN");
	});

	it("honors a custom tag", async () => {
		const r = recordingRunner({ ok: true, code: 0, stdout: "", stderr: "" });
		await createSelfUpdate({ runner: r.runner, logger: silentLogger, tag: "1.0.0" })();
		expect(r.calls[0]?.args[2]).toBe(`${DOCTOR_PACKAGE}@1.0.0`);
	});

	it("pins the resolved release and rolls back when post-update service health fails", async () => {
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const runner: CommandRunner = {
			async run(cmd, args): Promise<CommandResult> {
				calls.push({ cmd, args: [...args] });
				if (args[0] === "view") return { ok: true, code: 0, stdout: '"9.9.9"', stderr: "" };
				return { ok: true, code: 0, stdout: "", stderr: "" };
			},
		};
		const verifyHealthy = vi.fn()
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true);
		const message = await createSelfUpdate({
			runner,
			logger: silentLogger,
			restartService: async () => true,
			verifyHealthy,
		})();
		expect(calls[0]?.args).toEqual(["view", `${DOCTOR_PACKAGE}@latest`, "version", "--json"]);
		expect(calls[1]?.args).toEqual(["install", "-g", `${DOCTOR_PACKAGE}@9.9.9`]);
		expect(calls[2]?.args[2]).toBe(`${DOCTOR_PACKAGE}@0.0.0-dev`);
		expect(message).toContain("rolled back");
		expect(verifyHealthy).toHaveBeenCalledTimes(2);
	});

	it.each([
		'"9.9.9 && whoami"',
		'"latest"',
		'"v9.9.9"',
		'"1.2"',
		'{"version":"9.9.9"}',
	])("rejects malicious or non-semver release metadata before install: %s", async (stdout) => {
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const runner: CommandRunner = {
			async run(cmd, args): Promise<CommandResult> {
				calls.push({ cmd, args: [...args] });
				return { ok: true, code: 0, stdout, stderr: "" };
			},
		};
		const message = await createSelfUpdate({
			runner,
			logger: silentLogger,
			restartService: async () => true,
			verifyHealthy: async () => true,
		})();
		expect(message).toContain("invalid release metadata");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.args[0]).toBe("view");
	});

	it("reports manual repair unless rollback restart and health verification both succeed", async () => {
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const runner: CommandRunner = {
			async run(cmd, args): Promise<CommandResult> {
				calls.push({ cmd, args: [...args] });
				return args[0] === "view"
					? { ok: true, code: 0, stdout: '"9.9.9"', stderr: "" }
					: { ok: true, code: 0, stdout: "", stderr: "" };
			},
		};
		const restartService = vi.fn()
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(false);
		const message = await createSelfUpdate({
			runner,
			logger: silentLogger,
			restartService,
			verifyHealthy: async () => false,
		})();
		expect(message).toContain("manual repair is required");
		expect(message).not.toContain("rolled back:");
		expect(calls[2]?.args[2]).toBe(`${DOCTOR_PACKAGE}@0.0.0-dev`);
	});

	it("accepts strict exact semver metadata only", () => {
		expect(parseApprovedVersion('"2.0.0-beta.1+build.7"')).toBe("2.0.0-beta.1+build.7");
		expect(parseApprovedVersion("2.0.0;rm -rf /")).toBeNull();
		expect(parseApprovedVersion('"01.2.3"')).toBeNull();
	});
});
