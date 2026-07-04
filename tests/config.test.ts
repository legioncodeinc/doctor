/** Config resolution tests (PRD-064a defaults + defensive env parsing). */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULTS, resolveConfig } from "../src/config.js";

const HOME = "/home/test";

describe("resolveConfig", () => {
	it("returns the PRD-064a defaults when env is empty", () => {
		const cfg = resolveConfig({}, HOME);
		expect(cfg.probeIntervalMs).toBe(DEFAULTS.probeIntervalMs); // 30s
		expect(cfg.probeTimeoutMs).toBe(DEFAULTS.probeTimeoutMs); // still short, not a 60s socket hang
		expect(cfg.startupGraceMs).toBe(DEFAULTS.startupGraceMs); // 60s boot grace (PRD-067)
		expect(cfg.healthUrl).toBe("http://127.0.0.1:3850/health");
		expect(cfg.statusPagePort).toBe(DEFAULTS.statusPagePort);
		expect(cfg.backoffFloorMs).toBe(1_000);
		expect(cfg.backoffCeilingMs).toBe(30_000);
		expect(cfg.restartGiveUpThreshold).toBe(3); // OD-4
		expect(cfg.installHealthIntervalMs).toBe(DEFAULTS.installHealthIntervalMs); // 60 min (064d)
		expect(cfg.workspaceDir).toContain("doctor");
		expect(cfg.daemonPidPath).toContain("daemon.pid");
	});

	it("reads the install-health interval env override", () => {
		const cfg = resolveConfig({ DOCTOR_INSTALL_HEALTH_INTERVAL_MS: "120000" }, HOME);
		expect(cfg.installHealthIntervalMs).toBe(120_000);
	});

	it("reads valid env overrides", () => {
		const cfg = resolveConfig(
			{
				DOCTOR_PROBE_INTERVAL_MS: "5000",
				DOCTOR_STARTUP_GRACE_MS: "90000",
				DOCTOR_HEALTH_URL: "http://127.0.0.1:9999/health",
				DOCTOR_STATUS_PAGE_PORT: "0",
				DOCTOR_RESTART_GIVE_UP: "7",
			},
			HOME,
		);
		expect(cfg.probeIntervalMs).toBe(5_000);
		expect(cfg.startupGraceMs).toBe(90_000);
		expect(cfg.healthUrl).toBe("http://127.0.0.1:9999/health");
		expect(cfg.statusPagePort).toBe(0);
		expect(cfg.restartGiveUpThreshold).toBe(7);
	});

	it("falls back to defaults on malformed values (never throws)", () => {
		const cfg = resolveConfig(
			{
				DOCTOR_PROBE_INTERVAL_MS: "not-a-number",
				DOCTOR_PROBE_TIMEOUT_MS: "-5",
				DOCTOR_STARTUP_GRACE_MS: "nope",
				DOCTOR_HEALTH_URL: "ftp://nope",
				DOCTOR_STATUS_PAGE_PORT: "99999",
				DOCTOR_RESTART_GIVE_UP: "0",
			},
			HOME,
		);
		expect(cfg.probeIntervalMs).toBe(DEFAULTS.probeIntervalMs);
		expect(cfg.probeTimeoutMs).toBe(DEFAULTS.probeTimeoutMs);
		expect(cfg.startupGraceMs).toBe(DEFAULTS.startupGraceMs);
		expect(cfg.healthUrl).toBe(DEFAULTS.healthUrl); // non-http scheme rejected
		expect(cfg.statusPagePort).toBe(DEFAULTS.statusPagePort);
		expect(cfg.restartGiveUpThreshold).toBe(DEFAULTS.restartGiveUpThreshold); // 0 rejected
	});

	it("rejects zero and negative startup grace overrides", () => {
		expect(resolveConfig({ DOCTOR_STARTUP_GRACE_MS: "0" }, HOME).startupGraceMs).toBe(
			DEFAULTS.startupGraceMs,
		);
		expect(resolveConfig({ DOCTOR_STARTUP_GRACE_MS: "-1" }, HOME).startupGraceMs).toBe(
			DEFAULTS.startupGraceMs,
		);
	});

	it("normalizes an inverted backoff floor/ceiling (ceiling clamped up to floor)", () => {
		const cfg = resolveConfig(
			{ DOCTOR_BACKOFF_FLOOR_MS: "10000", DOCTOR_BACKOFF_CEILING_MS: "2000" },
			HOME,
		);
		expect(cfg.backoffFloorMs).toBe(10_000);
		expect(cfg.backoffCeilingMs).toBe(10_000);
	});

	it("allows a zero cooldown but rejects a negative one", () => {
		expect(resolveConfig({ DOCTOR_RESTART_COOLDOWN_MS: "0" }, HOME).restartCooldownMs).toBe(0);
		expect(resolveConfig({ DOCTOR_RESTART_COOLDOWN_MS: "-1" }, HOME).restartCooldownMs).toBe(
			DEFAULTS.restartCooldownMs,
		);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// PRD-004a: doctor's own workspace under the neutral fleet root (ADR-0003)
// ────────────────────────────────────────────────────────────────────────────

describe("resolveConfig fleet-root workspace (PRD-004a / ADR-0003)", () => {
	it("a-AC-1 / AC-1 / AC-8: with no overrides the workspace is <home>/.apiary/doctor (never under ~/.honeycomb)", () => {
		const cfg = resolveConfig({}, HOME, "linux");
		expect(cfg.workspaceDir).toBe(join(HOME, ".apiary", "doctor"));
		// AC-8: no new writes land under the legacy ~/.honeycomb/doctor.
		expect(cfg.workspaceDir).not.toContain(".honeycomb");
	});

	it("a-AC-2 / AC-2: APIARY_HOME wins for the workspace on every platform", () => {
		for (const platform of ["linux", "darwin", "win32"] as const) {
			const cfg = resolveConfig({ APIARY_HOME: "/srv/apiary", XDG_STATE_HOME: "/xdg" }, HOME, platform);
			expect(cfg.workspaceDir).toBe(join("/srv/apiary", "doctor"));
		}
	});

	it("a-AC-2: on Linux with $XDG_STATE_HOME set, the workspace is $XDG_STATE_HOME/apiary/doctor", () => {
		const cfg = resolveConfig({ XDG_STATE_HOME: "/xdg/state" }, HOME, "linux");
		expect(cfg.workspaceDir).toBe(join("/xdg/state", "apiary", "doctor"));
	});

	it("a-AC-7: DOCTOR_WORKSPACE_DIR still wins over the new fleet-root default", () => {
		const cfg = resolveConfig({ DOCTOR_WORKSPACE_DIR: "/custom/ws", APIARY_HOME: "/srv/apiary" }, HOME, "linux");
		expect(cfg.workspaceDir).toBe("/custom/ws");
	});
});

describe("doctor design principle 1 (module AC-9): zero runtime dependencies", () => {
	it("AC-9: package.json declares no runtime `dependencies` (Node built-ins only)", () => {
		const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { dependencies?: Record<string, string> };
		// Either no dependencies key at all, or an empty one: no external runtime package is added.
		expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
	});
});
