/**
 * The `doctor purge` execution engine (PRD-003c c-AC-2 .. c-AC-6).
 *
 * Fully injectable (the same {@link CommandRunner} seam every other rung uses, an
 * injectable filesystem, and doctor's OWN service module's `uninstall()`) so the whole
 * destructive wipe is hermetic in tests - nothing here ever touches a real OS service
 * manager, npm registry, or filesystem unless the caller wires the real primitives
 * (`cli/index.ts` does, for production).
 *
 * PURGE ORDERING (fixed, ledger-frozen): (1) other products' services, current labels
 * then legacy; (2) other products' npm packages, then legacy npm packages; (3) state
 * dirs; (4) doctor's OWN service; (5) doctor's OWN npm package, LAST and only once every
 * earlier step has succeeded (c-AC-4). Every step is logged with success/failure;
 * failures in steps (1)-(3) abort progression to (4)/(5) so doctor survives and a re-run
 * resumes (c-AC-4) - but never abort EACH OTHER: every step in (1)-(3) always runs, so
 * one failure does not hide the rest of the report.
 *
 * SAFETY (c-AC-5): every removal target is drawn from the closed allow-list in
 * {@link file://./inventory.js} - a literal absolute path (state dirs) or a literal
 * unit/task name (services) / package name (npm). There is no glob expansion and no
 * dynamic path construction from user input anywhere in this module. State-dir removal
 * uses Node's recursive `rm`, which unlinks a symlink it encounters rather than
 * dereferencing it, so a symlink planted inside (or as) a target directory can never
 * redirect the delete outside the intended root.
 */

import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { legacyHoneycombRoot, resolveApiaryRoot } from "../apiary-root.js";
import { isForbiddenWipeTarget } from "../safe-path.js";
import type { ServiceModule, ServiceResult } from "../cli/service-stub.js";
import type { CommandRunner } from "../rungs/command-runner.js";
import { normalizePlatform, type ServicePlatform } from "../service/platform.js";
import {
	DOCTOR_NPM_PACKAGE,
	DOCTOR_UNIT_NAMES,
	LEGACY_NPM_PACKAGES,
	OTHER_PRODUCTS,
	STATE_DIR_NAMES,
	systemScopeLaunchdPath,
	systemScopeSystemdPath,
	type OtherProduct,
	type ProductUnitNames,
} from "./inventory.js";

/** Every product's unit-name family purge must consider for the system-scope survivor
 * report (c-AC-3): the three sibling products PLUS doctor's own (current + legacy). */
const ALL_PRODUCT_UNIT_NAMES: ReadonlyArray<{ readonly product: string; readonly names: ProductUnitNames }> = [
	...OTHER_PRODUCTS.map((p) => ({ product: p.product, names: p })),
	{ product: "doctor", names: DOCTOR_UNIT_NAMES },
];

/** The minimal filesystem surface purge needs (injected so tests never touch real disk). */
export interface PurgeFs {
	/** Does a path exist? */
	exists(path: string): boolean;
	/** Remove a directory recursively. Must be idempotent (no throw on an absent path). */
	removeDir(path: string): void;
}

/** The production {@link PurgeFs} over node:fs. */
export function createNodePurgeFs(): PurgeFs {
	return {
		exists: (path: string) => existsSync(path),
		removeDir: (path: string) => rmSync(path, { recursive: true, force: true }),
	};
}

/** Construction deps for {@link createPurgeEngine}. All but `runner`/`serviceModule` have production defaults. */
export interface PurgeEngineDeps {
	/** The injected command runner (execFile, no shell) - the same seam every rung uses. */
	readonly runner: CommandRunner;
	/** doctor's OWN service module; only `uninstall()` is used (step 4). */
	readonly serviceModule: Pick<ServiceModule, "uninstall">;
	/** The filesystem seam. Default: the real {@link createNodePurgeFs}. */
	readonly fs?: PurgeFs;
	/** Home directory (default: `homedir()`). */
	readonly home?: string;
	/** The env the fleet-root chain reads (default `process.env`). */
	readonly env?: NodeJS.ProcessEnv;
	/** The platform purge targets (default `process.platform`). */
	readonly platform?: NodeJS.Platform;
	/** The numeric uid for launchd's `gui/<uid>` domain (default: live uid, 0 when unavailable). */
	readonly uid?: number;
}

/** One purge step's outcome. */
interface StepOutcome {
	readonly label: string;
	/** True iff there was actually something at this target (vs. already absent). */
	readonly present: boolean;
	/** True iff the step succeeded (irrelevant when `present` is false - nothing to fail at). */
	readonly ok: boolean;
	readonly detail?: string;
}

/** The final, resolved purge report (matches {@link import("../cli/context.js").PurgeReport}). */
export interface PurgeReport {
	readonly ok: boolean;
	readonly nothingToRemove: boolean;
	readonly lines: readonly string[];
}

/** The engine surface (matches {@link import("../cli/context.js").PurgeDeps}). */
export interface PurgeEngine {
	readonly summaryLines: () => readonly string[];
	readonly run: () => Promise<PurgeReport>;
}

/** Read the live numeric uid, defaulting to 0 (mirrors service/index.ts's `liveUid`). */
function liveUid(): number {
	try {
		const getuid = (process as NodeJS.Process & { getuid?: () => number }).getuid;
		return typeof getuid === "function" ? getuid() : 0;
	} catch {
		return 0;
	}
}

/** Which of a product's per-manager identifiers applies on `platform`. Exhaustive over {@link ServicePlatform}. */
function unitNamesForPlatform(
	platform: ServicePlatform,
	names: ProductUnitNames,
): { readonly current: string; readonly legacy: readonly string[] } {
	switch (platform) {
		case "darwin":
			return names.launchdLabel;
		case "linux":
			return names.systemdUnit;
		case "win32":
			return names.windowsTask;
		default: {
			const _exhaustive: never = platform;
			return _exhaustive;
		}
	}
}

/**
 * Best-effort deregister ONE unit name on `platform`. Always resolves `ok: true`: a
 * manager-command failure here is the expected, tolerated shape of "this name was never
 * registered" (the SAME tolerance every other install/uninstall path in this codebase
 * already applies to a missing unit) - `present` records whether the manager reported an
 * actual removal, purely for the report and the c-AC-6 "nothing found" determination.
 */
async function deregisterUnit(
	runner: CommandRunner,
	platform: ServicePlatform,
	uid: number,
	label: string,
	name: string,
): Promise<StepOutcome> {
	switch (platform) {
		case "darwin": {
			const result = await runner.run("launchctl", ["bootout", `gui/${uid}/${name}`]);
			return { label: `${label} (launchd ${name})`, present: result.ok, ok: true };
		}
		case "linux": {
			const result = await runner.run("systemctl", ["--user", "disable", "--now", name]);
			return { label: `${label} (systemd ${name})`, present: result.ok, ok: true };
		}
		case "win32": {
			const result = await runner.run("schtasks", ["/Delete", "/TN", name, "/F"]);
			return { label: `${label} (scheduled task ${name})`, present: result.ok, ok: true };
		}
		default: {
			const _exhaustive: never = platform;
			return _exhaustive;
		}
	}
}

/**
 * Best-effort stop+delete of a Windows sc-scope (system) service sharing `name` with a
 * Scheduled Task (c-AC-3: "no Apiary service unit, current or legacy, remains registered
 * with ... schtasks" - the enterprise `sc` opt-in path in `service/platform.ts` registers
 * under the SAME name family, so a system-scope `sc`-registered unit must be attempted too,
 * not just the per-user Scheduled Task {@link deregisterUnit} already covers). Always
 * resolves `ok: true` (best-effort, non-fatal): an unprivileged process cannot always stop
 * or delete a system service, and that failure must never block the rest of purge.
 */
async function deregisterScScope(runner: CommandRunner, label: string, name: string): Promise<StepOutcome> {
	const stopResult = await runner.run("sc", ["stop", name]);
	const deleteResult = await runner.run("sc", ["delete", name]);
	return { label: `${label} (sc ${name})`, present: stopResult.ok || deleteResult.ok, ok: true };
}

/** Detect an npm global package via `npm ls -g`, then `npm uninstall -g` it IF present. */
async function removeNpmPackageIfPresent(runner: CommandRunner, pkg: string): Promise<StepOutcome> {
	const detect = await runner.run("npm", ["ls", "-g", pkg, "--depth", "0"]);
	const present = detect.ok && detect.stdout.includes(pkg);
	if (!present) return { label: `npm package ${pkg}`, present: false, ok: true };
	const result = await runner.run("npm", ["uninstall", "-g", pkg]);
	return {
		label: `npm package ${pkg}`,
		present: true,
		ok: result.ok,
		...(result.ok ? {} : { detail: result.detail ?? `npm-exit-${result.code}` }),
	};
}

/** Remove one state dir IF it exists. Never follows a symlink out of it (see module doc). */
function removeStateDirIfPresent(fs: PurgeFs, absPath: string, label: string): StepOutcome {
	if (!fs.exists(absPath)) return { label, present: false, ok: true };
	try {
		fs.removeDir(absPath);
		return { label, present: true, ok: true };
	} catch (error) {
		return { label, present: true, ok: false, detail: error instanceof Error ? error.message : "unknown" };
	}
}

/** Format one {@link StepOutcome} as a report line. */
function formatOutcome(o: StepOutcome): string {
	if (!o.present) return `  - ${o.label}: not present (nothing to remove).`;
	if (o.ok) return `  - ${o.label}: removed.`;
	return `  - ${o.label}: FAILED${o.detail !== undefined ? ` (${o.detail})` : ""}.`;
}

/**
 * The exact pre-confirmation summary text (c-AC-1): every category, naming `~/.deeplake`
 * explicitly. When the engine passes the RESOLVED fleet root, the first line names it,
 * so an operator confirming the wipe sees the actual directory an `APIARY_HOME` /
 * `XDG_STATE_HOME` override points at, never just the default.
 */
export function purgeSummaryLines(resolvedFleetRoot?: string): readonly string[] {
	const rootPhrase = resolvedFleetRoot === undefined ? "default ~/.apiary" : `resolved: ${resolvedFleetRoot}`;
	return [
		`Every Apiary state directory under the fleet root (${rootPhrase}): registry.json, device.json, install-id, and every product's own data.`,
		'~/.deeplake - shared Deeplake credentials. This directory is ALSO used by a standalone Hivemind ("@deeplake/hivemind") install if you have one; removing it will sign that out too.',
		"Legacy ~/.hivemind and ~/.honeycomb directories left over from older installs.",
		"The honeycomb, nectar, and hive OS services on this machine (current AND legacy names).",
		"The honeycomb, nectar, and hive npm global packages, plus the legacy @deeplake/hivemind package.",
		`Doctor's own OS service and its own npm package (${DOCTOR_NPM_PACKAGE}) - removed LAST, only once everything above has succeeded.`,
	];
}

/**
 * Build the purge engine. Every external action (shell-outs, fs) is injected; the
 * production wiring (`cli/index.ts`) passes the real {@link CommandRunner}, the real
 * {@link createNodePurgeFs}, and doctor's own already-constructed service module.
 */
export function createPurgeEngine(deps: PurgeEngineDeps): PurgeEngine {
	const runner = deps.runner;
	const serviceModule = deps.serviceModule;
	const fs = deps.fs ?? createNodePurgeFs();
	const home = deps.home ?? homedir();
	const env = deps.env ?? process.env;
	const platform = deps.platform ?? process.platform;
	const uid = deps.uid ?? liveUid();

	return {
		// c-AC-1: the summary names the RESOLVED fleet root, so an env-overridden root is
		// visible to the operator BEFORE they type the confirmation token.
		summaryLines: () => purgeSummaryLines(resolveApiaryRoot(env, home, platform)),

		async run(): Promise<PurgeReport> {
			const outcomes: StepOutcome[] = [];
			const normalized = normalizePlatform(platform);

			// (1) Other products' services: current label then every legacy label, per product.
			// On win32, ALSO attempt the sc-scope (system service) stop+delete for the same
			// name family - the enterprise `sc` opt-in in `service/platform.ts` registers under
			// the SAME name a Scheduled Task would use, so a system-scope `sc` service sharing
			// that name must be attempted too, not just the per-user Scheduled Task (c-AC-3).
			if (normalized !== null) {
				for (const product of OTHER_PRODUCTS as readonly OtherProduct[]) {
					const names = unitNamesForPlatform(normalized, product);
					for (const name of [names.current, ...names.legacy]) {
						outcomes.push(await deregisterUnit(runner, normalized, uid, `${product.product} service`, name));
						if (normalized === "win32") {
							outcomes.push(await deregisterScScope(runner, `${product.product} service`, name));
						}
					}
				}
			}

			// (1b) System-scope survivors (report-only, NO escalation - ledger orchestrator
			// decision 13): launchd system daemons (/Library/LaunchDaemons) and systemd system
			// units (/etc/systemd/system) purge cannot remove without sudo. Detect every
			// CURRENT + LEGACY label across every product (including doctor's own) and report
			// the exact command the operator must run themselves; purge NEVER attempts the
			// removal here (an unprivileged attempt would just fail, and doctor never re-execs
			// itself with sudo) - the survivor is surfaced, never silently skipped (c-AC-3).
			const systemScopeLines: string[] = [];
			let systemScopeSurvivorFound = false;
			if (normalized === "darwin") {
				for (const entry of ALL_PRODUCT_UNIT_NAMES) {
					for (const label of [entry.names.launchdLabel.current, ...entry.names.launchdLabel.legacy]) {
						const path = systemScopeLaunchdPath(label);
						if (fs.exists(path)) {
							systemScopeSurvivorFound = true;
							systemScopeLines.push(
								`  - System-scope launchd unit for ${entry.product} (${label}) is still registered at ${path}; this requires elevation and was NOT removed. Run: sudo launchctl bootout system/${label} && sudo rm ${path}`,
							);
						}
					}
				}
			} else if (normalized === "linux") {
				for (const entry of ALL_PRODUCT_UNIT_NAMES) {
					for (const unitName of [entry.names.systemdUnit.current, ...entry.names.systemdUnit.legacy]) {
						const path = systemScopeSystemdPath(unitName);
						if (fs.exists(path)) {
							systemScopeSurvivorFound = true;
							systemScopeLines.push(
								`  - System-scope systemd unit for ${entry.product} (${unitName}) is still registered at ${path}; this requires elevation and was NOT removed. Run: sudo systemctl disable --now ${unitName} && sudo rm ${path}`,
							);
						}
					}
				}
			}

			// (2) Other products' npm packages, then the legacy npm packages.
			for (const product of OTHER_PRODUCTS) {
				outcomes.push(await removeNpmPackageIfPresent(runner, product.npmPackage));
			}
			for (const pkg of LEGACY_NPM_PACKAGES) {
				outcomes.push(await removeNpmPackageIfPresent(runner, pkg));
			}

			// (3) State dirs: the ACTUAL resolved fleet root (honors an APIARY_HOME override,
			// so a customized install is fully wiped too), plus the three fixed legacy roots.
			// SECURITY (c-AC-5 / parent AC-8): the resolved root is refused outright when it
			// is a filesystem root, the home dir, or an ancestor of home - a poisoned or
			// mistaken APIARY_HOME/XDG_STATE_HOME must never turn this recursive delete into
			// a whole-disk or whole-home wipe. The refusal is a hard failure, so doctor's own
			// removal (steps 4/5) never runs either.
			const fleetRoot = resolveApiaryRoot(env, home, platform);
			if (isForbiddenWipeTarget(fleetRoot, home)) {
				outcomes.push({
					label: `Apiary fleet root (${fleetRoot})`,
					present: true,
					ok: false,
					detail:
						"REFUSED: the resolved fleet root is a filesystem root, the home directory, or a parent of it; check APIARY_HOME / XDG_STATE_HOME",
				});
			} else {
				outcomes.push(removeStateDirIfPresent(fs, fleetRoot, `Apiary fleet root (${fleetRoot})`));
			}
			outcomes.push(
				removeStateDirIfPresent(
					fs,
					join(home, STATE_DIR_NAMES.deeplake),
					"~/.deeplake (shared Deeplake credentials)",
				),
			);
			outcomes.push(removeStateDirIfPresent(fs, join(home, STATE_DIR_NAMES.legacyHivemind), "~/.hivemind (legacy)"));
			outcomes.push(removeStateDirIfPresent(fs, legacyHoneycombRoot(home), "~/.honeycomb (legacy)"));

			const lines: string[] = outcomes.map(formatOutcome);
			lines.push(...systemScopeLines);
			const hardFailures = outcomes.filter((o) => o.present && !o.ok);
			const anyOtherPresent = outcomes.some((o) => o.present) || systemScopeSurvivorFound;

			// c-AC-4: a failure in (1)-(3) means doctor survives untouched - (4)/(5) never run,
			// so a re-run resumes exactly where it left off (everything already removed is a
			// no-op the second time; nothing new is destroyed by re-running).
			if (hardFailures.length > 0) {
				lines.push("");
				lines.push(
					`${hardFailures.length} step(s) above FAILED. Doctor's own service and npm package were NOT touched (they are removed last, only once everything else succeeds).`,
				);
				lines.push("Fix the issue(s) above, then re-run `doctor purge` to finish; already-removed items are skipped.");
				return { ok: false, nothingToRemove: false, lines };
			}

			// (4) doctor's OWN service - best-effort and purely informational: its own
			// `uninstall()` reports ok:false even for the extremely common "was never
			// registered" case (see service/index.ts), so its outcome never gates step (5).
			// `uninstall()` only deregisters doctor's CURRENT label; before it runs, ALSO
			// best-effort deregister doctor's OWN legacy label(s) here (the same
			// bootout/disable-now/schtasks-delete argv shapes `deregisterLegacyUnit`/
			// `legacyUninstallCommands` use for the same purpose at install/uninstall time,
			// applied via this module's own per-name `deregisterUnit`/`deregisterScScope`
			// helpers so purge never needs a full `ServicePlan` resolution), so a purge never
			// leaves a legacy doctor unit registered (c-AC-3).
			if (normalized !== null) {
				const ownNames = unitNamesForPlatform(normalized, DOCTOR_UNIT_NAMES);
				for (const legacyName of ownNames.legacy) {
					lines.push(formatOutcome(await deregisterUnit(runner, normalized, uid, "Doctor's own legacy service", legacyName)));
					if (normalized === "win32") {
						lines.push(formatOutcome(await deregisterScScope(runner, "Doctor's own legacy service", legacyName)));
					}
				}
				if (normalized === "win32") {
					// The CURRENT label too: `serviceModule.uninstall()` below only tries the
					// manager the resolved plan uses (schtasks by default); best-effort try the
					// sc-scope name as well in case a system-scope `sc` service shares it.
					lines.push(formatOutcome(await deregisterScScope(runner, "Doctor's own service", ownNames.current)));
				}
			}

			let ownServiceResult: ServiceResult;
			try {
				ownServiceResult = await serviceModule.uninstall();
			} catch (error) {
				ownServiceResult = { ok: false, message: error instanceof Error ? error.message : "unknown error" };
			}
			lines.push(`  - Doctor's own service: ${ownServiceResult.message}`);

			// Detect doctor's OWN npm package (an accurate presence signal, unlike the service
			// step above) BEFORE deciding "nothing to remove" (c-AC-6), so a machine with
			// nothing anywhere - including doctor's own package (e.g. doctor run from a local
			// checkout, never installed globally) - reports the friendly no-op honestly.
			const ownPkgDetect = await runner.run("npm", ["ls", "-g", DOCTOR_NPM_PACKAGE, "--depth", "0"]);
			const ownPkgPresent = ownPkgDetect.ok && ownPkgDetect.stdout.includes(DOCTOR_NPM_PACKAGE);

			if (!anyOtherPresent && !ownPkgPresent) {
				return {
					ok: true,
					nothingToRemove: true,
					lines: ["Nothing to remove: no Apiary services, packages, or state directories were found on this machine."],
				};
			}

			// (5) doctor's OWN npm package, LAST: the success message for everything else
			// prints BEFORE this step (ledger orchestrator decision 9 / PRD-003c implementation
			// notes), and this step's own failure is reported but never flips the overall
			// result to a failure - a re-run resumes here (the package must still exist for
			// `npm uninstall -g` to matter, hence why it is always tried last).
			lines.push("Purge succeeded: every other product's services, packages, and state directories are removed.");
			if (ownPkgPresent) {
				const ownPkgResult = await runner.run("npm", ["uninstall", "-g", DOCTOR_NPM_PACKAGE]);
				lines.push(
					ownPkgResult.ok
						? `  - Doctor's own npm package (${DOCTOR_NPM_PACKAGE}): removed.`
						: `  - Doctor's own npm package (${DOCTOR_NPM_PACKAGE}): could not remove it automatically (${ownPkgResult.detail ?? `exit ${ownPkgResult.code}`}). Run \`npm uninstall -g ${DOCTOR_NPM_PACKAGE}\` yourself, or re-run \`doctor purge\` to retry.`,
				);
			} else {
				lines.push(`  - Doctor's own npm package (${DOCTOR_NPM_PACKAGE}): not present (nothing to remove).`);
			}

			return { ok: true, nothingToRemove: false, lines };
		},
	};
}
