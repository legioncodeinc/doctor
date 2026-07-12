/**
 * End-to-end composition test for the registry live-reload + supervisor reconcile
 * (PRD-005 module ACs).
 *
 * Boots `createDoctor` over a REAL two-location registry under a temp home (env {} ->
 * `<home>/.apiary/registry.json`), then drives `doctor.registryReloadLoop.tick()`
 * explicitly (deterministic, no spinning loop) after each registry write to prove doctor
 * re-reads and reconciles its live supervisor set without a reboot:
 *
 *   - AC-1/AC-2/b-AC-3: boot on [hive], append honeycomb then nectar -> doctor converges to
 *     supervising [hive, honeycomb, nectar] and reports honeycomb on the status page + the
 *     telemetry model (AC-7);
 *   - AC-4: an unchanged registry across ticks causes zero supervisor churn;
 *   - AC-3: a genuine non-primary removal stops + drops that supervisor;
 *   - AC-6/b-AC-7: a transient omission of honeycomb keeps the primary slot bound;
 *   - AC-5/AC-8: a malformed reload preserves the live set + records needs-attention, then
 *     recovers when the file parses again — and never throws;
 *   - AC-9: doctor ships with no external runtime dependency.
 *
 * mtimes are advanced explicitly with `utimesSync` after each write so the loop's mtime gate
 * reliably sees each change (two sub-millisecond writes could otherwise share an mtime).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDoctor } from "../../src/compose/index.js";
import { resolveConfig } from "../../src/config.js";
import { silentLogger } from "../../src/logger.js";
import { defaultRegistryPath } from "../../src/registry.js";
import type { HealthClassification } from "../../src/health-probe.js";
import type { CommandResult, CommandRunner } from "../../src/rungs/command-runner.js";
import type { SupervisorClock } from "../../src/supervisor.js";
import type { StatusJson } from "../../src/status-page/server.js";

const PLATFORM = process.platform;

function fakeClock(): SupervisorClock {
	return { now: () => 0, sleep: async () => undefined };
}

function fakeRunner(): CommandRunner {
	return {
		async run(): Promise<CommandResult> {
			return { ok: true, code: 0, stdout: "", stderr: "" };
		},
	};
}

const tmpDirs: string[] = [];
function makeHome(): string {
	const d = mkdtempSync(join(tmpdir(), "doctor-reload-e2e-"));
	tmpDirs.push(d);
	return d;
}

/** Write the fleet registry with the given daemon entries, then advance its mtime. */
let mtimeTick = 0;
function writeRegistry(path: string, daemons: Array<Record<string, unknown>>): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({ daemons }), "utf8");
	touch(path);
}

/** Write raw (possibly invalid) bytes to the registry, then advance its mtime. */
function writeRaw(path: string, raw: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, raw, "utf8");
	touch(path);
}

/** Force a strictly-increasing mtime so the loop's mtime gate always sees the change. */
function touch(path: string): void {
	mtimeTick += 1;
	const t = new Date(2030, 0, 1, 0, 0, mtimeTick * 30);
	utimesSync(path, t, t);
}

function hive(): Record<string, unknown> {
	return { name: "hive", healthUrl: "http://127.0.0.1:3853/health" };
}
function honeycomb(): Record<string, unknown> {
	return { name: "honeycomb", healthUrl: "http://127.0.0.1:3850/health" };
}
function nectar(): Record<string, unknown> {
	return { name: "nectar", healthUrl: "http://127.0.0.1:3854/health" };
}

function bootDoctor(home: string): ReturnType<typeof createDoctor> {
	const workspaceDir = join(home, "ws");
	const config = { ...resolveConfig({}, home, PLATFORM), workspaceDir };
	return createDoctor({
		config,
		env: {},
		home,
		logger: silentLogger,
		clock: fakeClock(),
		runner: fakeRunner(),
		probe: async (): Promise<HealthClassification> => ({ kind: "ok" }),
		statusPagePort: 0,
		deviceId: "test-device-id", // hermetic: never mint/read the real device.json
		// NOTE: no `daemons`/`registryPath` -> boot reads the REAL <home>/.apiary/registry.json,
		// exactly the file the reload loop re-reads.
	});
}

async function fetchStatus(doctor: ReturnType<typeof createDoctor>): Promise<StatusJson> {
	doctor.statusPage.start();
	try {
		let port: number | undefined;
		for (let i = 0; i < 50; i += 1) {
			port = doctor.statusPage.listeningPort;
			if (port !== undefined) break;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		if (port === undefined) throw new Error("status page did not bind");
		const response = await fetch(`http://127.0.0.1:${port}/status.json`);
		return (await response.json()) as StatusJson;
	} finally {
		doctor.statusPage.stop();
	}
}

describe("createDoctor registry live-reload + reconcile (PRD-005)", () => {
	afterEach(() => {
		for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("AC-1/AC-2/b-AC-3/AC-7: boots on [hive], adopts honeycomb then nectar on reload, reporting them — no reboot", async () => {
		const home = makeHome();
		const registryPath = defaultRegistryPath(home, {}, PLATFORM);
		writeRegistry(registryPath, [hive()]);

		const doctor = bootDoctor(home);
		try {
			// Boot supervises exactly [hive].
			expect(doctor.supervisors).toHaveLength(1);

			// honeycomb registers AFTER boot; one reload adopts it (AC-1).
			writeRegistry(registryPath, [hive(), honeycomb()]);
			await doctor.registryReloadLoop.tick();
			expect(doctor.supervisors).toHaveLength(2);

			// nectar registers next; the next reload adopts it -> converges to [hive, honeycomb, nectar] (b-AC-3).
			writeRegistry(registryPath, [hive(), honeycomb(), nectar()]);
			await doctor.registryReloadLoop.tick();
			expect(doctor.supervisors).toHaveLength(3);

			// AC-2: honeycomb is reported on the status page (the isFleetReady gate reads this).
			const status = await fetchStatus(doctor);
			expect(status.daemons.map((d) => d.name).sort()).toEqual(["hive", "honeycomb", "nectar"]);

			// AC-7: the telemetry poll-and-merge model now includes honeycomb + nectar.
			const event = await doctor.telemetryPollLoop.tick();
			expect(event.services.map((s) => s.name).sort()).toEqual(["hive", "honeycomb", "nectar"]);
		} finally {
			doctor.telemetryPollLoop.close();
			await doctor.stop();
		}
	});

	it("AC-4: an unchanged registry across many reload ticks causes zero supervisor churn", async () => {
		const home = makeHome();
		const registryPath = defaultRegistryPath(home, {}, PLATFORM);
		writeRegistry(registryPath, [hive(), honeycomb()]);

		const doctor = bootDoctor(home);
		try {
			// First tick picks up the current file (baseline was unseeded) — a no-op reconcile since
			// boot already built these entries with identical fields.
			await doctor.registryReloadLoop.tick();
			const honeycombRef = doctor.supervisors[1];
			expect(doctor.supervisors).toHaveLength(2);

			// Many further ticks on the UNCHANGED file: the mtime gate makes each a strict no-op, so
			// the supervisor objects are never rebuilt (identical references) and the set never grows.
			for (let i = 0; i < 5; i += 1) await doctor.registryReloadLoop.tick();
			expect(doctor.supervisors).toHaveLength(2);
			expect(doctor.supervisors[1]).toBe(honeycombRef); // no rebuild, no re-arm
		} finally {
			doctor.telemetryPollLoop.close();
			await doctor.stop();
		}
	});

	it("AC-6/b-AC-7 then AC-3: a transient honeycomb omission keeps the primary; a genuine nectar removal drops it", async () => {
		const home = makeHome();
		const registryPath = defaultRegistryPath(home, {}, PLATFORM);
		writeRegistry(registryPath, [honeycomb(), hive(), nectar()]);

		const doctor = bootDoctor(home);
		try {
			await doctor.registryReloadLoop.tick();
			expect(doctor.supervisors).toHaveLength(3);
			const primarySupervisor = doctor.supervisor; // honeycomb (daemons[0])

			// A reload transiently OMITS honeycomb (another writer mid-update): the primary slot is
			// kept, never torn down (b-AC-7 / AC-6).
			writeRegistry(registryPath, [hive(), nectar()]);
			await doctor.registryReloadLoop.tick();
			const afterOmission = await fetchStatus(doctor);
			expect(afterOmission.daemons.map((d) => d.name)).toContain("honeycomb");
			expect(doctor.supervisor).toBe(primarySupervisor); // primary reference never dangled

			// A GENUINE deregister of a non-primary daemon (nectar uninstalled): its supervisor is
			// stopped + dropped from the set / status / telemetry (AC-3). honeycomb (the omitted
			// primary) is written back at the same time and stays supervised.
			writeRegistry(registryPath, [honeycomb(), hive()]);
			await doctor.registryReloadLoop.tick();
			const afterRemoval = await fetchStatus(doctor);
			expect(afterRemoval.daemons.map((d) => d.name).sort()).toEqual(["hive", "honeycomb"]);

			const event = await doctor.telemetryPollLoop.tick();
			expect(event.services.map((s) => s.name)).not.toContain("nectar"); // stops being polled
		} finally {
			doctor.telemetryPollLoop.close();
			await doctor.stop();
		}
	});

	it("AC-5/AC-8: a malformed reload preserves the live set + records needs-attention, then recovers cleanly (never throws)", async () => {
		const home = makeHome();
		const registryPath = defaultRegistryPath(home, {}, PLATFORM);
		const workspaceDir = join(home, "ws");
		writeRegistry(registryPath, [honeycomb(), hive()]);

		const doctor = bootDoctor(home);
		try {
			await doctor.registryReloadLoop.tick(); // establish the baseline
			expect(doctor.supervisors).toHaveLength(2);

			// The registry is rewritten with garbage (a torn/broken mid-write): the reload must NOT
			// tear the live set down, must NOT throw, and must record a needs-attention banner.
			writeRaw(registryPath, "{ not valid json");
			await expect(doctor.registryReloadLoop.tick()).resolves.toBeUndefined(); // never throws (AC-8)
			expect(doctor.supervisors).toHaveLength(2); // live set preserved (AC-5)

			const naPath = join(workspaceDir, "needs-attention.json");
			const na = JSON.parse(readFileSync(naPath, "utf8")) as {
				resolved: boolean;
				escalation: { diagnosis: string };
			};
			expect(na.resolved).toBe(false);
			expect(na.escalation.diagnosis).toContain("malformed");

			// The file is fixed: the reload resolves it and clears the banner (AC-5 recovery).
			writeRegistry(registryPath, [honeycomb(), hive()]);
			await doctor.registryReloadLoop.tick();
			expect(doctor.supervisors).toHaveLength(2);
			const naAfter = JSON.parse(readFileSync(naPath, "utf8")) as { resolved: boolean };
			expect(naAfter.resolved).toBe(true); // needs-attention resolved on recovery
		} finally {
			doctor.telemetryPollLoop.close();
			await doctor.stop();
		}
	});

	it("AC-9: doctor ships with no external runtime dependency", () => {
		const pkg = JSON.parse(
			readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8"),
		) as { dependencies?: Record<string, string> };
		expect(pkg.dependencies ?? {}).toEqual({});
	});
});
