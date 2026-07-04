/**
 * The shared fleet-root helper (PRD-004a, implementing fleet ADR-0003).
 *
 * ADR-0003 gives the fleet one brand-neutral, home-anchored state root and mandates that
 * "every product resolves the root through one shared helper so the chain is identical
 * everywhere". doctor is a zero-runtime-dependency codebase that MIRRORS (never imports)
 * shared patterns across the process boundary, so this module is doctor's copy of that one
 * chain, implemented byte-for-byte from the ADR's canonical "resolveFleetRoot" definition.
 *
 * The resolution chain, in precedence order (ADR-0003 "Resolved decisions", confirmed
 * 2026-07-04):
 *   1. APIARY_HOME env var, when set and non-blank (the installer's --home= pin is delivered
 *      as APIARY_HOME in the service environment).
 *   2. On Linux only: $XDG_STATE_HOME/apiary, when $XDG_STATE_HOME is set and non-blank.
 *      There is no ~/.local/state/apiary default.
 *   3. Otherwise: <home>/.apiary, on every platform including Linux.
 *
 * process.cwd() NEVER participates at any step. That is the structural fix for the
 * service-manager working-directory footgun ADR-0003 documents: state anchored on
 * os.homedir() cannot land in System32 or / via an inherited working directory.
 *
 * The shared coordination surface (registry.json, device.json, install-id) sits at the
 * root itself; each product's own state is <root>/<product>/ (doctor's is <root>/doctor/).
 *
 * Built-ins only: node:os + node:fs + node:path (zero runtime deps, design principle 1).
 * Every function here is TOTAL: any unexpected condition resolves to the home-anchored
 * default rather than throwing, mirroring the can't-crash posture of config.ts.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, win32 } from "node:path";

/** The env var that pins the fleet root (installer --home= is delivered as this). */
export const APIARY_HOME_ENV = "APIARY_HOME" as const;

/** The XDG state-home env var honored on Linux only, when explicitly set. */
export const XDG_STATE_HOME_ENV = "XDG_STATE_HOME" as const;

/** The neutral fleet-root directory name under the home dir (the default). */
export const APIARY_DIR_NAME = ".apiary" as const;

/**
 * LEGACY-HONEYCOMB-WINDOW: the pre-migration shared root name. Read-side fallback only,
 * removed together with every other window-only branch when ADR-0003's removal criterion
 * is met (all supported install paths ship the migration).
 */
export const LEGACY_HONEYCOMB_DIR_NAME = ".honeycomb" as const;

/** Trim an env value; return null when it is undefined, empty, or whitespace-only. */
function nonBlank(value: string | undefined): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

/**
 * Env roots are honored only when ABSOLUTE (fleet security rule, 2026-07-04; the XDG
 * Base Directory spec also requires ignoring relative values). A relative value would
 * anchor the fleet root, and the supervisor's trust roots derived from it, on
 * process.cwd(), which this resolver must never do. `win32.isAbsolute` accepts `/x`,
 * `\x`, and `C:\x`, a strict superset of the posix check, so a relative value is
 * never mistaken for absolute on any host.
 */
function isAbsoluteRoot(value: string): boolean {
	return win32.isAbsolute(value);
}

/**
 * Resolve the fleet root through the canonical ADR-0003 chain. `env`, `home`, and
 * `platform` are injected so tests are hermetic (no real `~`, no real `process.env`,
 * no real `process.platform`), matching the seam pattern of `resolveConfig`.
 *
 * NEVER reads process.cwd(); NEVER throws (any surprise falls through to `<home>/.apiary`).
 */
export function resolveApiaryRoot(
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
	platform: NodeJS.Platform = process.platform,
): string {
	try {
		// 1. APIARY_HOME wins on every platform when set, non-blank, and absolute.
		const apiaryHome = nonBlank(env[APIARY_HOME_ENV]);
		if (apiaryHome !== null && isAbsoluteRoot(apiaryHome)) return apiaryHome;

		// 2. Linux only: honor $XDG_STATE_HOME when explicitly set and absolute. No ~/.local/state default.
		if (platform === "linux") {
			const xdgStateHome = nonBlank(env[XDG_STATE_HOME_ENV]);
			if (xdgStateHome !== null && isAbsoluteRoot(xdgStateHome)) return join(xdgStateHome, "apiary");
		}

		// 3. The home-anchored default, uniform across all platforms.
		return join(home, APIARY_DIR_NAME);
	} catch {
		// Total by construction: any unexpected failure falls back to the home default.
		return join(home, APIARY_DIR_NAME);
	}
}

/**
 * LEGACY-HONEYCOMB-WINDOW: the pre-migration shared root `~/.honeycomb`. Every window-only
 * legacy-fallback read routes through this so the removal is one sweep.
 */
export function legacyHoneycombRoot(home: string = homedir()): string {
	return join(home, LEGACY_HONEYCOMB_DIR_NAME);
}

/** A product's own state directory under the fleet root: `<root>/<product>`. */
export function apiaryProductDir(root: string, product: string): string {
	return join(root, product);
}

/** doctor's own per-product state directory: `<root>/doctor`. */
export function doctorStateDir(root: string): string {
	return apiaryProductDir(root, "doctor");
}

/**
 * The new per-product telemetry trusted root: `<root>/<product>/telemetry` (PRD-004c).
 * A registry entry's telemetry DB must live under its OWN product's telemetry dir.
 */
export function productTelemetryRoot(root: string, product: string): string {
	return join(apiaryProductDir(root, product), "telemetry");
}

/**
 * LEGACY-HONEYCOMB-WINDOW: the legacy telemetry trusted root `~/.honeycomb/telemetry`
 * (PRD-004c). Accepted alongside the new per-product roots for the migration window only.
 */
export function legacyTelemetryRoot(home: string = homedir()): string {
	return join(legacyHoneycombRoot(home), "telemetry");
}

/**
 * Resolve the default honeycomb-primary pid/lock path with a legacy-aware existence check
 * (PRD-004c): return the new-location `<root>/honeycomb/daemon.pid` UNLESS that file does
 * not exist AND the legacy `~/.honeycomb/daemon.pid` does, in which case return the legacy
 * path so a not-yet-migrated honeycomb keeps being supervised through the window.
 *
 * The check runs at resolution time (boot / registry reload), which matches how the pid
 * default is consumed today. `existsFn` is injected so tests drive both branches without
 * a real filesystem. NEVER throws.
 */
export function defaultHoneycombPidPath(
	root: string,
	home: string = homedir(),
	existsFn: (path: string) => boolean = existsSync,
): string {
	const newPath = join(apiaryProductDir(root, "honeycomb"), "daemon.pid");
	// LEGACY-HONEYCOMB-WINDOW: fall back to the legacy pid only when the new one is absent
	// and the legacy one is present.
	const legacyPath = join(legacyHoneycombRoot(home), "daemon.pid");
	try {
		if (!existsFn(newPath) && existsFn(legacyPath)) return legacyPath;
	} catch {
		// A failing existence probe must never wedge resolution: prefer the new default.
	}
	return newPath;
}
