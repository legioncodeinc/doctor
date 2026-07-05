/**
 * The FROZEN fleet-wide purge coverage inventory (PRD-003c c-AC-3/c-AC-5).
 *
 * Source of truth: `library/ledger/EXECUTION_LEDGER-fleet-lifecycle.md`, section
 * "Coverage inventory (FROZEN 2026-07-04 22:35, code-derived from each repo's
 * SERVICE_LABEL / LEGACY_* constants; 003c purge + 003d scripts consume this verbatim)".
 * This module is doctor's copy of that frozen table - `doctor purge` and the (future)
 * uninstall scripts (PRD-003d) MUST consume the SAME names so the removal targets never
 * drift between the CLI verb and the script (mirrored, never imported, per the fleet's
 * cross-repo convention: doctor cannot import honeycomb/nectar/hive's own modules).
 *
 * This is a CLOSED allow-list (c-AC-5): `purge` only ever touches an absolute path or a
 * named unit/package drawn from here - no glob, no wildcard, no traversal outside it.
 *
 * doctor's OWN identifiers are NOT duplicated here as literals; they are imported from
 * {@link file://../service/platform.js} (the single source of truth for doctor's own
 * label/unit/task names) so there is exactly one place doctor's own names can drift.
 */

import {
	LEGACY_SERVICE_LABEL,
	LEGACY_SYSTEMD_UNIT_NAME,
	LEGACY_WINDOWS_TASK_NAME,
	SERVICE_LABEL,
	SYSTEMD_UNIT_NAME,
	WINDOWS_TASK_NAME,
} from "../service/platform.js";

/** The per-platform current + legacy unit/task identifiers for one product. */
export interface ProductUnitNames {
	/** The current reverse-DNS launchd label (macOS) / bare name otherwise, as applicable. */
	readonly launchdLabel: { readonly current: string; readonly legacy: readonly string[] };
	/** The current systemd --user unit file name (Linux). */
	readonly systemdUnit: { readonly current: string; readonly legacy: readonly string[] };
	/** The current Windows Scheduled Task name. */
	readonly windowsTask: { readonly current: string; readonly legacy: readonly string[] };
}

/** One OTHER product (not doctor itself) purge must deregister + remove the package for. */
export interface OtherProduct extends ProductUnitNames {
	readonly product: "honeycomb" | "nectar" | "hive";
	/** The current npm global package name. */
	readonly npmPackage: string;
}

/**
 * The three sibling products doctor does not control the registration of, but `purge`
 * removes anyway (parent AC-5 / c-AC-3). Literal per-product names (ledger-frozen, not
 * importable: each lives in its own repo).
 */
export const OTHER_PRODUCTS: readonly OtherProduct[] = [
	{
		product: "honeycomb",
		launchdLabel: { current: "com.legioncode.honeycomb", legacy: ["ai.honeycomb.daemon"] },
		systemdUnit: { current: "honeycomb.service", legacy: ["ai.honeycomb.daemon.service"] },
		windowsTask: { current: "honeycomb", legacy: ["HoneycombDaemon"] },
		npmPackage: "@legioncodeinc/honeycomb",
	},
	{
		product: "nectar",
		launchdLabel: { current: "com.legioncode.nectar", legacy: ["com.hivenectar.daemon"] },
		systemdUnit: { current: "nectar.service", legacy: ["hivenectar.service"] },
		windowsTask: { current: "nectar", legacy: ["HivenectarDaemon"] },
		npmPackage: "@legioncodeinc/nectar",
	},
	{
		product: "hive",
		launchdLabel: { current: "com.legioncode.hive", legacy: ["thehive"] },
		systemdUnit: { current: "hive.service", legacy: ["thehive.service"] },
		windowsTask: { current: "hive", legacy: ["thehive"] },
		npmPackage: "@legioncodeinc/hive",
	},
];

/**
 * doctor's OWN unit identifiers, mirrored from {@link file://../service/platform.js} (the
 * single source of truth) rather than re-declared, so the two can never drift.
 */
export const DOCTOR_UNIT_NAMES: ProductUnitNames = {
	launchdLabel: { current: SERVICE_LABEL, legacy: [LEGACY_SERVICE_LABEL] },
	systemdUnit: { current: SYSTEMD_UNIT_NAME, legacy: [LEGACY_SYSTEMD_UNIT_NAME] },
	windowsTask: { current: WINDOWS_TASK_NAME, legacy: [LEGACY_WINDOWS_TASK_NAME] },
};

/** doctor's OWN npm package, removed LAST and separately from {@link OTHER_PRODUCTS} (c-AC-4). */
export const DOCTOR_NPM_PACKAGE = "@legioncodeinc/doctor" as const;

/**
 * The macOS system-scope LaunchDaemon plist path for a given launchd label (report-only;
 * c-AC-3 / ledger orchestrator decision 13: purge never sudo-escalates, so a survivor here
 * is DETECTED and REPORTED with the exact command, never attempted).
 */
export function systemScopeLaunchdPath(label: string): string {
	return `/Library/LaunchDaemons/${label}.plist`;
}

/**
 * The Linux system-scope systemd unit path for a given unit file name (report-only; same
 * no-escalation rule as {@link systemScopeLaunchdPath}).
 */
export function systemScopeSystemdPath(unitName: string): string {
	return `/etc/systemd/system/${unitName}`;
}

/**
 * Legacy npm packages with no current-generation successor tracked separately above
 * (per the ledger: "no unscoped hivemind/hivenectar/hivedoctor npm packages ever shipped").
 */
export const LEGACY_NPM_PACKAGES: readonly string[] = ["@deeplake/hivemind"];

/**
 * The fixed, home-relative directory NAMES purge removes (never a glob, never a pattern -
 * each is joined onto a resolved absolute home dir once, at the point of use). `fleetRoot`
 * is the DIRECTORY NAME under home for the honeycomb-legacy-window default; the ACTUAL
 * fleet root purge targets is the live {@link resolveApiaryRoot} value (which may be
 * `APIARY_HOME`-overridden), not this literal, so a customized install is fully wiped too.
 */
export const STATE_DIR_NAMES = {
	/** `~/.deeplake` - shared Deeplake credentials (also used by a standalone Hivemind install). */
	deeplake: ".deeplake",
	/** `~/.hivemind` - a legacy pre-fleet directory name. */
	legacyHivemind: ".hivemind",
	/** `~/.honeycomb` - the pre-ADR-0003 shared root. */
	legacyHoneycomb: ".honeycomb",
} as const;
