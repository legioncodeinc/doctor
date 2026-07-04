/**
 * The shared fleet-root helper (PRD-004a, fleet ADR-0003).
 *
 * Proves the canonical `resolveFleetRoot` chain byte-for-byte (a-AC-1/2/3), that
 * process.cwd() never participates (module AC-1), and the legacy-aware pid-path default
 * (backs PRD-004c c-AC-1/c-AC-2, exercised end-to-end in apiary-supervision.test.ts).
 *
 * Every test injects `env`, `home`, and `platform` so nothing reads the real host.
 */

import { chdir, cwd } from "node:process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	defaultHoneycombPidPath,
	legacyHoneycombRoot,
	legacyTelemetryRoot,
	productTelemetryRoot,
	resolveApiaryRoot,
} from "../src/apiary-root.js";

const HOME = "/home/test";

describe("resolveApiaryRoot (PRD-004a / ADR-0003 canonical chain)", () => {
	it("a-AC-1: APIARY_HOME wins over XDG and the default on every platform", () => {
		for (const platform of ["linux", "darwin", "win32"] as const) {
			expect(
				resolveApiaryRoot({ APIARY_HOME: "/srv/apiary", XDG_STATE_HOME: "/xdg/state" }, HOME, platform),
			).toBe("/srv/apiary");
		}
	});

	it("a-AC-1: a blank or whitespace-only APIARY_HOME is treated as unset", () => {
		expect(resolveApiaryRoot({ APIARY_HOME: "" }, HOME, "linux")).toBe(join(HOME, ".apiary"));
		expect(resolveApiaryRoot({ APIARY_HOME: "   " }, HOME, "darwin")).toBe(join(HOME, ".apiary"));
	});

	it("security: a relative APIARY_HOME or XDG_STATE_HOME is ignored (env roots honored only when absolute; never cwd-anchored)", () => {
		expect(resolveApiaryRoot({ APIARY_HOME: "relative/root" }, HOME, "linux")).toBe(join(HOME, ".apiary"));
		expect(resolveApiaryRoot({ XDG_STATE_HOME: "relative/state" }, HOME, "linux")).toBe(join(HOME, ".apiary"));
		// Windows-shaped absolutes are still honored on any host (win32.isAbsolute superset).
		expect(resolveApiaryRoot({ APIARY_HOME: "C:\\fleet\\root" }, HOME, "win32")).toBe("C:\\fleet\\root");
	});

	it("a-AC-2: on Linux with $XDG_STATE_HOME set and no APIARY_HOME, the root is $XDG_STATE_HOME/apiary", () => {
		expect(resolveApiaryRoot({ XDG_STATE_HOME: "/xdg/state" }, HOME, "linux")).toBe(join("/xdg/state", "apiary"));
	});

	it("a-AC-2: XDG is honored ONLY on Linux (darwin/win32 ignore it) and ONLY when explicitly set", () => {
		// Non-Linux ignores XDG entirely.
		expect(resolveApiaryRoot({ XDG_STATE_HOME: "/xdg/state" }, HOME, "darwin")).toBe(join(HOME, ".apiary"));
		expect(resolveApiaryRoot({ XDG_STATE_HOME: "/xdg/state" }, HOME, "win32")).toBe(join(HOME, ".apiary"));
		// Linux with XDG unset or blank falls through to the home default (no ~/.local/state default).
		expect(resolveApiaryRoot({}, HOME, "linux")).toBe(join(HOME, ".apiary"));
		expect(resolveApiaryRoot({ XDG_STATE_HOME: "  " }, HOME, "linux")).toBe(join(HOME, ".apiary"));
	});

	it("a-AC-3 / AC-1: with no overrides the root is <home>/.apiary on every platform", () => {
		for (const platform of ["linux", "darwin", "win32"] as const) {
			expect(resolveApiaryRoot({}, HOME, platform)).toBe(join(HOME, ".apiary"));
		}
	});
});

describe("resolveApiaryRoot never consults process.cwd() (module AC-1)", () => {
	let previousCwd: string;
	let tmp: string;

	afterEach(() => {
		chdir(previousCwd);
		if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true });
	});

	it("AC-1: the resolved root is unchanged when process.cwd() changes (home-anchored, never cwd)", () => {
		previousCwd = cwd();
		tmp = mkdtempSync(join(tmpdir(), "doctor-cwd-"));
		const before = resolveApiaryRoot({}, HOME, "win32");
		// Moving the working directory (the service-manager footgun) must not shift the root.
		chdir(tmp);
		const after = resolveApiaryRoot({}, HOME, "win32");
		expect(after).toBe(before);
		expect(after).toBe(join(HOME, ".apiary"));
	});
});

describe("root-derived path helpers", () => {
	it("legacy + per-product telemetry roots resolve under the expected bases", () => {
		const root = join(HOME, ".apiary");
		expect(legacyHoneycombRoot(HOME)).toBe(join(HOME, ".honeycomb"));
		expect(productTelemetryRoot(root, "nectar")).toBe(join(root, "nectar", "telemetry"));
		expect(legacyTelemetryRoot(HOME)).toBe(join(HOME, ".honeycomb", "telemetry"));
	});

	it("defaultHoneycombPidPath is new-first, legacy-fallback-aware, via the injected existence probe", () => {
		const root = join(HOME, ".apiary");
		const newPid = join(root, "honeycomb", "daemon.pid");
		const legacyPid = join(HOME, ".honeycomb", "daemon.pid");
		// New present -> new.
		expect(defaultHoneycombPidPath(root, HOME, () => true)).toBe(newPid);
		// Both absent -> new (the default).
		expect(defaultHoneycombPidPath(root, HOME, () => false)).toBe(newPid);
		// New absent, legacy present -> legacy (mid-window supervision continuity).
		expect(defaultHoneycombPidPath(root, HOME, (p) => p === legacyPid)).toBe(legacyPid);
	});
});
