/** Config resolution tests (PRD-064a defaults + defensive env parsing). */

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
