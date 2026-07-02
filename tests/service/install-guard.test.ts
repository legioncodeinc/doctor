/**
 * AC-064b.4 / parent AC-10: `--no-doctor` opt-out guard (pre-rename `--no-hivedoctor`
 * accepted as an alias).
 *
 * Asserts the pure decision the two shell installers mirror: when the flag or the env
 * equivalent is present, the Doctor bootstrap (npm install + service registration) is
 * skipped, so the service module is NEVER invoked and no Doctor process runs.
 */

import { describe, expect, it } from "vitest";

import { dispatch, EXIT_OK } from "../../src/cli/dispatch.js";
import { shouldBootstrapDoctor } from "../../src/service/install-guard.js";
import { createServiceModule } from "../../src/service/index.js";
import { buildCliHarness } from "../cli/helpers/fake-cli.js";
import { createMemoryFs, createRecordingRunner, fixedEnv } from "./helpers.js";

describe("shouldBootstrapDoctor (AC-064b.4)", () => {
	it("defaults to true with a plain install argv + clean env", () => {
		expect(shouldBootstrapDoctor({ argv: ["--ref", "mario"], env: {} })).toBe(true);
		expect(shouldBootstrapDoctor({ argv: [], env: {} })).toBe(true);
	});

	it("returns false when --no-doctor is passed", () => {
		expect(shouldBootstrapDoctor({ argv: ["--no-doctor"], env: {} })).toBe(false);
		expect(shouldBootstrapDoctor({ argv: ["--ref", "x", "--no-doctor"], env: {} })).toBe(false);
	});

	it("returns false when the pre-rename --no-hivedoctor alias is passed", () => {
		expect(shouldBootstrapDoctor({ argv: ["--no-hivedoctor"], env: {} })).toBe(false);
		expect(shouldBootstrapDoctor({ argv: ["--ref", "x", "--no-hivedoctor"], env: {} })).toBe(false);
	});

	it("returns false on the env opt-out (1 / true, case-insensitive)", () => {
		expect(shouldBootstrapDoctor({ argv: [], env: { HONEYCOMB_NO_DOCTOR: "1" } })).toBe(false);
		expect(shouldBootstrapDoctor({ argv: [], env: { HONEYCOMB_NO_DOCTOR: "true" } })).toBe(false);
		expect(shouldBootstrapDoctor({ argv: [], env: { HONEYCOMB_NO_DOCTOR: "TRUE" } })).toBe(false);
	});

	it("returns false on the pre-rename env alias (HONEYCOMB_NO_HIVEDOCTOR)", () => {
		expect(shouldBootstrapDoctor({ argv: [], env: { HONEYCOMB_NO_HIVEDOCTOR: "1" } })).toBe(false);
		expect(shouldBootstrapDoctor({ argv: [], env: { HONEYCOMB_NO_HIVEDOCTOR: "true" } })).toBe(false);
		expect(shouldBootstrapDoctor({ argv: [], env: { HONEYCOMB_NO_HIVEDOCTOR: "TRUE" } })).toBe(false);
	});

	it("a non-truthy env value does NOT opt out (0 / empty / garbage -> still bootstrap)", () => {
		expect(shouldBootstrapDoctor({ argv: [], env: { HONEYCOMB_NO_DOCTOR: "0" } })).toBe(true);
		expect(shouldBootstrapDoctor({ argv: [], env: { HONEYCOMB_NO_DOCTOR: "" } })).toBe(true);
		expect(shouldBootstrapDoctor({ argv: [], env: { HONEYCOMB_NO_DOCTOR: "no" } })).toBe(true);
		expect(shouldBootstrapDoctor({ argv: [], env: { HONEYCOMB_NO_HIVEDOCTOR: "0" } })).toBe(true);
	});
});

describe("AC-064b.4: opted out -> the service module is never invoked", () => {
	/**
	 * The installer's contract: if shouldBootstrapDoctor is false, it neither installs the
	 * package nor calls `doctor install-service`. We model that here: the install-service
	 * command is only dispatched when the guard allows it; under opt-out it never runs, so the
	 * real module's runner/fs are never touched.
	 */
	async function runInstallerStep(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<{
		ran: boolean;
		runnerCalls: number;
		writes: number;
	}> {
		const runner = createRecordingRunner();
		const fs = createMemoryFs();
		const serviceModule = createServiceModule({
			execPath: "/usr/bin/doctor",
			runner,
			fs,
			environment: fixedEnv({ platform: "linux", home: "/home/t" }),
		});
		const h = buildCliHarness({ serviceModule });

		if (!shouldBootstrapDoctor({ argv, env })) {
			return { ran: false, runnerCalls: runner.calls.length, writes: fs.writes.length };
		}
		const code = await dispatch(["install-service"], h.ctx);
		expect(code).toBe(EXIT_OK);
		return { ran: true, runnerCalls: runner.calls.length, writes: fs.writes.length };
	}

	it("with --no-doctor: install-service is never dispatched, runner + fs untouched", async () => {
		const result = await runInstallerStep(["--no-doctor"], {});
		expect(result.ran).toBe(false);
		expect(result.runnerCalls).toBe(0);
		expect(result.writes).toBe(0);
	});

	it("with the env opt-out: same - nothing installed/registered", async () => {
		const result = await runInstallerStep([], { HONEYCOMB_NO_DOCTOR: "1" });
		expect(result.ran).toBe(false);
		expect(result.runnerCalls).toBe(0);
		expect(result.writes).toBe(0);
	});

	it("WITHOUT opt-out: install-service IS dispatched and the module runs (control)", async () => {
		const result = await runInstallerStep(["--ref", "mario"], {});
		expect(result.ran).toBe(true);
		expect(result.runnerCalls).toBeGreaterThan(0);
		expect(result.writes).toBeGreaterThan(0);
	});
});
