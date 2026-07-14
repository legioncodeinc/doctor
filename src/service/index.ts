/**
 * The real OS-service manager (PRD-064b) - the module the CLI's `install-service` /
 * `uninstall-service` commands delegate to via the {@link ServiceModule} seam declared in
 * src/cli/service-stub.ts.
 *
 * It does the three things the stub promised would land in 064b:
 *   - installService()  : resolve the platform plan, write the unit file (when file-based),
 *                         then run the manager's install argv. Userland scope by default,
 *                         privileged fallback ordering computed in {@link resolveServicePlan}.
 *   - uninstallService(): run the manager's uninstall argv, then delete the unit file, so
 *                         the unit does not resurrect on next boot (AC-064b.5).
 *   - serviceStatus()   : run the manager's status argv and classify the result.
 *
 * Crash-safe (parent AC-8 / design principle 1): every shell-out is the injected
 * {@link CommandRunner} (execFile, no shell) which never throws; every fs call is behind the
 * injected {@link ServiceFs} and wrapped, so a permission error becomes a returned {@link ServiceResult}
 * (never a thrown stack). The whole module is hermetic: a test injects a recording runner +
 * an in-memory fs and asserts the EXACT argv + unit text without touching the OS.
 *
 * Built-ins only: the production fs uses node:fs, the runner uses node:child_process.execFile.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { createExecFileRunner, type CommandResult, type CommandRunner } from "../remediation.js";
import type { Logger } from "../logger.js";
import { silentLogger } from "../logger.js";
import type { ServiceLifecycleModule, ServiceModule, ServiceResult } from "../cli/service-stub.js";
import {
	installCommands,
	legacyUninstallCommands,
	startCommands,
	statusCommand,
	stopCommands,
	uninstallCommands,
	type ServiceCommand,
} from "./argv.js";
import {
	legacyUnitPath,
	resolveServiceContext,
	resolveServicePlan,
	type ServiceEnvironment,
	type ServicePlan,
} from "./platform.js";
import { renderUnit } from "./templates.js";
import { liveWindowsIdentityFacts, resolveWindowsUserId, type WindowsIdentityFacts } from "./windows-identity.js";

/** A coarse, classified service status (what `doctor status` reports). */
export type ServiceStatus = "running" | "not-running" | "unknown";

/** Per-command timeout for a service-manager shell-out (these are fast, local commands). */
const SERVICE_COMMAND_TIMEOUT_MS = 15_000;

/** The minimal filesystem surface the service module needs (injected so tests are hermetic). */
export interface ServiceFs {
	/** Create a directory (recursive). Must be idempotent (no throw if it already exists). */
	mkdirp(dir: string): void;
	/** Write a file's text content, overwriting. */
	writeFile(path: string, content: string): void;
	/** Remove a file. Must NOT throw when the file is already absent. */
	removeFile(path: string): void;
	/**
	 * Does a path exist? Used by {@link isServiceRegistered} (PRD-003b b-AC-6 fix) to detect
	 * a registered-but-inactive unit FILE independent of the unit's runtime activity.
	 */
	exists(path: string): boolean;
}

/** The production {@link ServiceFs} over node:fs. */
export function createNodeServiceFs(): ServiceFs {
	return {
		mkdirp(dir: string): void {
			mkdirSync(dir, { recursive: true });
		},
		writeFile(path: string, content: string): void {
			writeFileSync(path, content, { encoding: "utf8" });
		},
		removeFile(path: string): void {
			// `force: true` makes a missing file a no-op (idempotent uninstall).
			rmSync(path, { force: true });
		},
		exists(path: string): boolean {
			return existsSync(path);
		},
	};
}

/** Construction deps for {@link createServiceModule}. All have production defaults. */
export interface ServiceModuleDeps {
	/** The absolute path to the `doctor` bin the unit execs. */
	readonly execPath: string;
	/** Opt into a system-scoped unit when privileged (enterprise path). Default false. */
	readonly preferSystemScope?: boolean;
	/** The command runner (execFile, no shell). Default: the real {@link createExecFileRunner}. */
	readonly runner?: CommandRunner;
	/** The filesystem seam. Default: the real {@link createNodeServiceFs}. */
	readonly fs?: ServiceFs;
	/** The numeric uid for launchd's `gui/<uid>` domain. Default: live uid (0 when unavailable). */
	readonly uid?: number;
	/** Override the resolved environment (tests inject a fixed platform/home/privilege). */
	readonly environment?: ServiceEnvironment;
	/**
	 * Windows LogonTrigger/Principal identity facts (schtasks `install()` only). Default:
	 * the live `process.env` facts ({@link liveWindowsIdentityFacts}). Injectable so a test
	 * can force the whoami/domain-fallback path without touching the real environment.
	 */
	readonly windowsIdentity?: WindowsIdentityFacts;
	/** Logger (default: silent). */
	readonly logger?: Logger;
}

/** Read the live numeric uid, defaulting to 0 when the platform does not expose it. */
function liveUid(): number {
	try {
		const getuid = (process as NodeJS.Process & { getuid?: () => number }).getuid;
		return typeof getuid === "function" ? getuid() : 0;
	} catch {
		return 0;
	}
}

/** Human-readable scope phrase for the result line. */
function scopePhrase(plan: ServicePlan): string {
	const base = plan.scope === "user" ? "user scope" : "system scope";
	return plan.fellBackToUser ? `${base} (fell back from system - unprivileged)` : base;
}

/** Cap how much of a command's own output we ever echo back in a result message. */
const MAX_FAILURE_DETAIL_CHARS = 200;

/**
 * Reduce a failed {@link CommandResult} to one short, secret-free line worth surfacing to the
 * operator (e.g. "Access is denied.", "ENOENT"). Prefers the runner's own `detail` (a
 * spawn-error code or timeout marker); otherwise falls back to the last non-empty line of
 * stderr, then stdout, since most service managers (schtasks, launchctl, systemctl) print
 * their real error there and a generic "a command failed" with no reason is not actionable
 * (IRD-192's own root-cause was only discoverable by reproducing the exact call by hand).
 * Output is a fixed-format OS/service-manager message, never a credential, but is still
 * length-capped defensively in case a manager is unexpectedly chatty.
 */
function describeFailure(result: CommandResult | null): string {
	if (result === null) return "unknown error";
	const candidate =
		result.detail ?? lastNonEmptyLine(result.stderr) ?? lastNonEmptyLine(result.stdout) ?? "unknown error";
	return candidate.length > MAX_FAILURE_DETAIL_CHARS
		? `${candidate.slice(0, MAX_FAILURE_DETAIL_CHARS)}...`
		: candidate;
}

function lastNonEmptyLine(text: string): string | null {
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "");
	return lines.length > 0 ? (lines[lines.length - 1] ?? null) : null;
}

function isAlreadyAbsentFailure(result: CommandResult | null): boolean {
	if (result === null) return false;
	const text = `${result.detail ?? ""}\n${result.stderr}\n${result.stdout}`.toLowerCase();
	return /not found|does not exist|not loaded|not installed|not (?:currently )?running|cannot find|could not find|no such (?:file|unit|service|task)|267011/u.test(text);
}

function isInstallReconciliationSuccess(command: ServiceCommand, result: CommandResult): boolean {
	const text = `${result.detail ?? ""}\n${result.stderr}\n${result.stdout}`.toLowerCase();
	if (command.command === "schtasks" && command.args[0]?.toLowerCase() === "/end") {
		return isAlreadyAbsentFailure(result);
	}
	if (command.command === "launchctl" && command.args[0] === "bootout") return isAlreadyAbsentFailure(result);
	if (command.command === "launchctl" && command.args[0] === "bootstrap") {
		return /already (?:loaded|bootstrapped)|service already exists/u.test(text);
	}
	if (command.command === "sc" && command.args[0] === "create") {
		return /already exists|1073/u.test(text);
	}
	if ((command.command === "sc" && command.args[0] === "start") ||
		(command.command === "schtasks" && command.args[0]?.toLowerCase() === "/run")) {
		return /already running|1056/u.test(text);
	}
	return false;
}

/** An explicit stop is idempotent when the manager reports the requested stopped state. */
function isStopReconciliationSuccess(command: ServiceCommand, result: CommandResult): boolean {
	if (command.command === "schtasks" && command.args[0]?.toLowerCase() === "/end") {
		return isAlreadyAbsentFailure(result);
	}
	return false;
}

/**
 * Run an ordered list of commands, stopping at nothing (every result is recorded) but
 * reporting the first hard failure (and its result, for {@link describeFailure}). Never
 * throws (the runner never does). A command whose failure is tolerable (e.g. `bootout` on an
 * absent unit during reinstall) is the caller's concern; here we report every result faithfully.
 */
async function runAll(
	runner: CommandRunner,
	commands: readonly ServiceCommand[],
	tolerate: (command: ServiceCommand, result: CommandResult) => boolean = () => false,
): Promise<{ allOk: boolean; firstFailure: ServiceCommand | null; firstFailureResult: CommandResult | null }> {
	let firstFailure: ServiceCommand | null = null;
	let firstFailureResult: CommandResult | null = null;
	for (const cmd of commands) {
		const result = await runner.run(cmd.command, cmd.args, { timeoutMs: SERVICE_COMMAND_TIMEOUT_MS });
		if (!result.ok && !tolerate(cmd, result) && firstFailure === null) {
			firstFailure = cmd;
			firstFailureResult = result;
		}
	}
	return { allOk: firstFailure === null, firstFailure, firstFailureResult };
}

/**
 * The full module {@link createServiceModule} returns: {@link ServiceModule}'s
 * install/uninstall PLUS {@link ServiceLifecycleModule}'s start/stop (PRD-003b b-AC-1).
 * A caller that only cares about install/uninstall (every existing 064b callsite/fixture)
 * keeps working unchanged via structural typing; the CLI wires this same object into both
 * `deps.serviceModule` and `deps.serviceLifecycle`.
 */
export type FullServiceModule = ServiceModule & ServiceLifecycleModule;

/**
 * Build the real {@link FullServiceModule}. The composition root / CLI inject the resolved
 * exec path; tests inject the runner + fs + a fixed environment so nothing real runs.
 */
export function createServiceModule(deps: ServiceModuleDeps): FullServiceModule {
	const runner = deps.runner ?? createExecFileRunner();
	const fs = deps.fs ?? createNodeServiceFs();
	const logger = deps.logger ?? silentLogger;
	const uid = deps.uid ?? liveUid();
	const environment =
		deps.environment ?? resolveServiceContext(deps.execPath, deps.preferSystemScope ?? false);
	const windowsIdentity = deps.windowsIdentity ?? liveWindowsIdentityFacts();

	/** Resolve the plan, mapping an unsupported platform to a thrown error the caller catches. */
	function plan(): ServicePlan {
		return resolveServicePlan(environment);
	}

	return {
		async install(): Promise<ServiceResult> {
			let p: ServicePlan;
			try {
				p = plan();
			} catch (error) {
				return {
					ok: false,
					message: `Could not register Doctor service: ${error instanceof Error ? error.message : "unknown error"}.`,
				};
			}

			// 0) Migrate away from the pre-decision-#32 unit names: best-effort deregister the
			//    legacy unit (`com.legioncode.hivedoctor` / `hivedoctor.service` / `HiveDoctor`)
			//    and remove its unit file, so a re-run never leaves two units racing over one
			//    daemon. Expected to fail harmlessly when no legacy unit exists; never blocks
			//    the install.
			await runAll(runner, legacyUninstallCommands(p, uid));
			try {
				const legacyPath = legacyUnitPath(p);
				if (legacyPath !== "") fs.removeFile(legacyPath);
			} catch {
				// Best-effort migration cleanup only; a remove failure never blocks the install.
			}

			// 0.5) Windows only: resolve the LogonTrigger/Principal UserId BEFORE rendering the
			//      XML (Windows 11 25H2 Administrator Protection fix - see windows-identity.ts).
			//      Never blocks the install: an unresolved SID/fallback just renders with no
			//      UserId, matching the pre-fix template.
			let renderPlan: ServicePlan = p;
			if (p.manager === "schtasks") {
				const windowsUserId = await resolveWindowsUserId(runner, windowsIdentity);
				if (windowsUserId !== undefined) renderPlan = { ...p, windowsUserId };
			}

			// 1) Write the unit file FIRST (when this manager is file-based). schtasks consumes the
			//    XML file too, so a non-empty unitPath OR the schtasks manager means we lay down text.
			const needsFile = p.unitPath !== "" || p.manager === "schtasks";
			let unitTarget = p.unitPath;
			if (needsFile) {
				try {
					if (p.manager === "schtasks" && unitTarget === "") {
						// Per-user task: stage the XML beside Doctor's workspace so schtasks /XML can read it.
						// ADR-0003 (PRD-004a): the workspace is `<root>/doctor` (was `~/.honeycomb/doctor`).
						unitTarget = `${p.stateDir}/doctor-task.xml`;
					}
					fs.mkdirp(dirname(unitTarget));
					fs.writeFile(unitTarget, renderUnit(renderPlan));
				} catch (error) {
					return {
						ok: false,
						message: `Could not write the Doctor unit file at ${unitTarget}: ${error instanceof Error ? error.message : "unknown error"}.`,
					};
				}
			}

			// 2) Run the manager's install argv. For schtasks the staged file path is the unit path.
			const planForArgv: ServicePlan = unitTarget === p.unitPath ? p : { ...p, unitPath: unitTarget };
			const { allOk, firstFailure, firstFailureResult } = await runAll(
				runner,
				installCommands(planForArgv, uid),
				isInstallReconciliationSuccess,
			);
			if (!allOk) {
				// A manager-command failure (e.g. schtasks /Create rejecting invalid XML) is NOT a
				// successful install: surface ok:false so the CLI maps it to a non-zero exit (IRD-192 AC-6).
				const detail = describeFailure(firstFailureResult);
				logger.warn("service.install_command_failed", { command: firstFailure?.command, detail });
				return {
					ok: false,
					message: `Registered the Doctor unit but a service-manager command failed (${firstFailure?.command ?? "unknown"}): ${detail}. It will start at next login/boot; run \`doctor status\` to check.`,
				};
			}

			logger.info("service.installed", { manager: p.manager, scope: p.scope });
			return {
				ok: true,
				message: `Doctor registered as a ${p.manager} service (${scopePhrase(p)}) and started. It will restart on crash and start on boot.`,
			};
		},

		async uninstall(): Promise<ServiceResult> {
			let p: ServicePlan;
			try {
				p = plan();
			} catch (error) {
				return {
					ok: false,
					message: `Could not unregister Doctor service: ${error instanceof Error ? error.message : "unknown error"}.`,
				};
			}

			// 1) Stop + deregister via the manager (idempotent - a missing unit is tolerated).
			const { allOk, firstFailure, firstFailureResult } = await runAll(
				runner,
				uninstallCommands(p, uid),
				isStopReconciliationSuccess,
			);

			// 2) Delete the unit file so it cannot resurrect on next boot (AC-064b.5). For schtasks the
			//    staged XML lives beside the workspace; remove that too.
			const stagedXml = p.manager === "schtasks" ? `${p.stateDir}/doctor-task.xml` : "";
			try {
				if (p.unitPath !== "") fs.removeFile(p.unitPath);
				if (stagedXml !== "") fs.removeFile(stagedXml);
			} catch (error) {
				logger.warn("service.unit_remove_failed", {
					reason: error instanceof Error ? error.message : "unknown",
				});
			}

			if (!allOk && isAlreadyAbsentFailure(firstFailureResult)) {
				logger.info("service.already_uninstalled", { manager: p.manager, scope: p.scope });
				return {
					ok: true,
					message: `Doctor service was already gone (${p.manager}, ${scopePhrase(p)}): ${describeFailure(firstFailureResult)}.`,
				};
			}
			if (!allOk) {
				const detail = describeFailure(firstFailureResult);
				logger.warn("service.uninstall_command_failed", { command: firstFailure?.command, detail });
				return {
					ok: false,
					message: `Removed the Doctor unit file; a deregister command (${firstFailure?.command ?? "unknown"}) reported an error (often because it was already gone): ${detail}.`,
				};
			}
			logger.info("service.uninstalled", { manager: p.manager, scope: p.scope });
			return {
				ok: true,
				message: `Doctor service unregistered (${p.manager}, ${scopePhrase(p)}). It will not start on next boot.`,
			};
		},

		async start(): Promise<ServiceResult> {
			let p: ServicePlan;
			try {
				p = plan();
			} catch (error) {
				return {
					ok: false,
					message: `Could not start the Doctor service: ${error instanceof Error ? error.message : "unknown error"}.`,
				};
			}
			const { allOk, firstFailure, firstFailureResult } = await runAll(
				runner,
				startCommands(p, uid),
				isInstallReconciliationSuccess,
			);
			if (!allOk) {
				const detail = describeFailure(firstFailureResult);
				logger.warn("service.start_command_failed", { command: firstFailure?.command, detail });
				return {
					ok: false,
					message: `Could not start the Doctor service (${firstFailure?.command ?? "unknown"}): ${detail}. Is it registered? Run \`doctor service-install\` first.`,
				};
			}
			logger.info("service.started", { manager: p.manager, scope: p.scope });
			return { ok: true, message: `Doctor service started (${p.manager}, ${scopePhrase(p)}).` };
		},

		async stop(): Promise<ServiceResult> {
			let p: ServicePlan;
			try {
				p = plan();
			} catch (error) {
				return {
					ok: false,
					message: `Could not stop the Doctor service: ${error instanceof Error ? error.message : "unknown error"}.`,
				};
			}
			const { allOk, firstFailure, firstFailureResult } = await runAll(
				runner,
				stopCommands(p, uid),
				isStopReconciliationSuccess,
			);
			if (!allOk) {
				const detail = describeFailure(firstFailureResult);
				logger.warn("service.stop_command_failed", { command: firstFailure?.command, detail });
				return {
					ok: false,
					message: `Could not stop the Doctor service (${firstFailure?.command ?? "unknown"}): ${detail}.`,
				};
			}
			logger.info("service.stopped", { manager: p.manager, scope: p.scope });
			// The unit stays REGISTERED (unlike uninstall): a crash/manual `start` brings it back.
			return { ok: true, message: `Doctor service stopped (${p.manager}, ${scopePhrase(p)}). It remains registered.` };
		},
	};
}

/**
 * Start Doctor's own service (PRD-003b b-AC-1), standalone (no install/uninstall surface),
 * mirroring {@link serviceStatus}'s shape: a caller (the CLI's `restart` wiring, the
 * composition root) that only needs start/stop does not have to build the full
 * {@link createServiceModule}. Never throws; a resolution/plan failure becomes `ok:false`.
 */
export async function serviceStart(deps: ServiceModuleDeps): Promise<ServiceResult> {
	const runner = deps.runner ?? createExecFileRunner();
	const uid = deps.uid ?? liveUid();
	const environment = deps.environment ?? resolveServiceContext(deps.execPath, deps.preferSystemScope ?? false);
	let p: ServicePlan;
	try {
		p = resolveServicePlan(environment);
	} catch (error) {
		return {
			ok: false,
			message: `Could not start the Doctor service: ${error instanceof Error ? error.message : "unknown error"}.`,
		};
	}
	const { allOk, firstFailure, firstFailureResult } = await runAll(
		runner,
		startCommands(p, uid),
		isInstallReconciliationSuccess,
	);
	if (!allOk) {
		const detail = describeFailure(firstFailureResult);
		return {
			ok: false,
			message: `Could not start the Doctor service (${firstFailure?.command ?? "unknown"}): ${detail}. Is it registered? Run \`doctor service-install\` first.`,
		};
	}
	return { ok: true, message: `Doctor service started (${p.manager}, ${scopePhrase(p)}).` };
}

/**
 * Stop Doctor's own service (PRD-003b b-AC-1), standalone; see {@link serviceStart}. Never
 * throws. The unit stays REGISTERED (unlike uninstall's deregister-and-delete-unit-file).
 */
export async function serviceStop(deps: ServiceModuleDeps): Promise<ServiceResult> {
	const runner = deps.runner ?? createExecFileRunner();
	const uid = deps.uid ?? liveUid();
	const environment = deps.environment ?? resolveServiceContext(deps.execPath, deps.preferSystemScope ?? false);
	let p: ServicePlan;
	try {
		p = resolveServicePlan(environment);
	} catch (error) {
		return {
			ok: false,
			message: `Could not stop the Doctor service: ${error instanceof Error ? error.message : "unknown error"}.`,
		};
	}
	const { allOk, firstFailure, firstFailureResult } = await runAll(
		runner,
		stopCommands(p, uid),
		isStopReconciliationSuccess,
	);
	if (!allOk) {
		const detail = describeFailure(firstFailureResult);
		return { ok: false, message: `Could not stop the Doctor service (${firstFailure?.command ?? "unknown"}): ${detail}.` };
	}
	return { ok: true, message: `Doctor service stopped (${p.manager}, ${scopePhrase(p)}). It remains registered.` };
}

/**
 * Probe the current service status (used by `doctor status` once 064b is wired). Returns
 * a coarse {@link ServiceStatus}; never throws. Exposed separately because the CLI's
 * `serviceState` dep reads status without the full install/uninstall surface.
 */
export async function serviceStatus(deps: ServiceModuleDeps): Promise<ServiceStatus> {
	const runner = deps.runner ?? createExecFileRunner();
	const uid = deps.uid ?? liveUid();
	const environment =
		deps.environment ?? resolveServiceContext(deps.execPath, deps.preferSystemScope ?? false);
	let p: ServicePlan;
	try {
		p = resolveServicePlan(environment);
	} catch {
		return "unknown";
	}
	const cmd = statusCommand(p, uid);
	const result = await runner.run(cmd.command, cmd.args, { timeoutMs: SERVICE_COMMAND_TIMEOUT_MS });
	if (!result.ok) {
		// systemd `is-active` exits non-zero when inactive; schtasks/sc/launchctl non-zero when absent.
		// Treat a clean "inactive"/"not found" as not-running; an actual spawn error as unknown.
		if (result.detail !== undefined && /ENOENT|spawn/i.test(result.detail)) return "unknown";
		return "not-running";
	}
	// systemd is-active prints "active"; launchctl print / schtasks query / sc query a populated block.
	if (p.manager === "systemd") {
		return /\bactive\b/.test(result.stdout) && !/inactive|failed/.test(result.stdout) ? "running" : "not-running";
	}
	if (p.manager === "schtasks") {
		return /\b(?:status\s*:\s*)?running\b/iu.test(result.stdout) ? "running" : "not-running";
	}
	if (p.manager === "sc") {
		return /\b(?:state\s*:\s*\d+\s+)?running\b/iu.test(result.stdout) ? "running" : "not-running";
	}
	return "running";
}

/**
 * Best-effort deregister doctor's OWN pre-decision-#32 (legacy) unit
 * (`com.legioncode.hivedoctor` / `hivedoctor.service` / `HiveDoctor`), mirroring the exact
 * migration cleanup {@link createServiceModule}'s `install()` already performs at its step
 * 0 - but callable standalone for `uninstall` (PRD-003b b-AC-2: uninstall removes the
 * current label PLUS a best-effort legacy label, so a re-run never leaves a legacy unit
 * still registered to start at boot). Declared SEPARATELY from
 * {@link FullServiceModule.uninstall} (rather than folded into it) so `uninstall-service`'s
 * existing exact-argv contract and tests are completely unaffected; the new `uninstall`
 * verb (`cli/index.ts`) calls this FIRST, then `uninstall()`. Never throws.
 */
export async function deregisterLegacyUnit(deps: ServiceModuleDeps): Promise<void> {
	const runner = deps.runner ?? createExecFileRunner();
	const fs = deps.fs ?? createNodeServiceFs();
	const uid = deps.uid ?? liveUid();
	const environment = deps.environment ?? resolveServiceContext(deps.execPath, deps.preferSystemScope ?? false);
	let p: ServicePlan;
	try {
		p = resolveServicePlan(environment);
	} catch {
		return;
	}
	await runAll(runner, legacyUninstallCommands(p, uid));
	try {
		const legacyPath = legacyUnitPath(p);
		if (legacyPath !== "") fs.removeFile(legacyPath);
	} catch {
		// Best-effort cleanup only; a remove failure never blocks the rest of uninstall.
	}
}

/**
 * Best-effort REGISTRATION-evidence probe (PRD-003b b-AC-6 fix): is doctor's OWN unit
 * actually registered with the OS, regardless of whether it is currently active? This is
 * a STRONGER signal than {@link serviceStatus}'s activity check for systemd, where
 * `systemctl is-active` fails identically for "the unit exists but is inactive" and "the
 * unit was never registered at all" - so `serviceStatus()` alone cannot tell an
 * installed-but-stopped unit apart from a genuinely absent one (the exact false-no-op the
 * verifier caught: an installed-but-inactive systemd unit with no registry entry and no
 * state dir was wrongly classified as nothing-to-remove).
 *
 * For the file-based managers (launchd/systemd) this checks the unit-FILE's existence at
 * the plan's resolved `unitPath`, which `install()` writes and `uninstall()` removes,
 * independent of the unit's runtime activity. For the Windows managers (schtasks/sc), a
 * status query already succeeds for a registered-but-stopped task/service (schtasks
 * `/Query` and `sc query` both succeed regardless of Ready/Running/Stopped state), so this
 * delegates to {@link serviceStatus} for those platforms rather than duplicating its argv.
 *
 * Bias: resolves `true` (registered) whenever the answer is ambiguous - an unresolved
 * plan, a filesystem read error, or a spawn error. The uninstall steps this probe gates
 * are all individually idempotent/best-effort, so a false positive here costs nothing at
 * most an extra no-op deregister attempt, while a false negative (a wrongly-claimed no-op)
 * would silently leave a real unit registered forever. Never throws.
 */
export async function isServiceRegistered(deps: ServiceModuleDeps): Promise<boolean> {
	const fs = deps.fs ?? createNodeServiceFs();
	const environment = deps.environment ?? resolveServiceContext(deps.execPath, deps.preferSystemScope ?? false);
	let p: ServicePlan;
	try {
		p = resolveServicePlan(environment);
	} catch {
		return true;
	}
	if (p.manager === "launchd" || p.manager === "systemd") {
		try {
			return fs.exists(p.unitPath);
		} catch {
			return true;
		}
	}
	// schtasks / sc: registration is the query's success, independent of whether its parsed
	// runtime state is Ready/Stopped/Running. Spawn ambiguity biases toward registered.
	const runner = deps.runner ?? createExecFileRunner();
	const uid = deps.uid ?? liveUid();
	const cmd = statusCommand(p, uid);
	const result = await runner.run(cmd.command, cmd.args, { timeoutMs: SERVICE_COMMAND_TIMEOUT_MS });
	if (result.ok) return true;
	if (result.detail !== undefined && /ENOENT|spawn/iu.test(result.detail)) return true;
	return false;
}

export { resolveServicePlan, resolveServiceContext } from "./platform.js";
export type { ServicePlan, ServiceEnvironment } from "./platform.js";
export { liveWindowsIdentityFacts, resolveWindowsUserId, SID_PATTERN } from "./windows-identity.js";
export type { WindowsIdentityFacts } from "./windows-identity.js";
