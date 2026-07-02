/**
 * Doctor's OWN package version, single-sourced (PRD-064f / PRD-064 OD-6).
 *
 * The version is build-injected via esbuild `define` (`__DOCTOR_VERSION__`),
 * mirroring the parent package's `__HONEYCOMB_VERSION__` discipline. The `typeof`
 * guard means an un-bundled dev/test build falls through to the env fallback and
 * finally a stable sentinel, so `tsc --noEmit` stays clean and the CLI still runs
 * without a bundle present.
 *
 * Why a constant and not a `package.json` read at runtime: the can't-crash runtime
 * is Node built-ins only and must never depend on a relative `package.json` being
 * present beside the bundle. The single source of truth remains `package.json`; the
 * later-wave `sync-versions` + esbuild `define` propagate it here. NOTHING in this
 * package hardcodes a version string anywhere else - every reader imports
 * {@link DOCTOR_VERSION}.
 */

/** The Doctor package version, build-injected with safe env/sentinel fallbacks. */
export const DOCTOR_VERSION: string =
	typeof __DOCTOR_VERSION__ === "string" && __DOCTOR_VERSION__.length > 0
		? __DOCTOR_VERSION__
		: (process.env["DOCTOR_VERSION"] ?? "0.0.0-dev");

/** The npm package name of Doctor itself (the ONLY thing `self-update` ever installs). */
export const DOCTOR_PACKAGE = "@legioncodeinc/doctor" as const;
