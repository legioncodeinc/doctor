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

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { createExecFileRunner, type CommandResult, type CommandRunner } from "../remediation.js";
import type { Logger } from "../logger.js";
import { silentLogger } from "../logger.js";
import type { ServiceModule, ServiceResult } from "../cli/service-stub.js";
import {
	installCommands,
	legacyUninstallCommands,
	statusCommand,
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

/**
 * Run an ordered list of commands, stopping at nothing (every result is recorded) but
 * reporting the first hard failure (and its result, for {@link describeFailure}). Never
 * throws (the runner never does). A command whose failure is tolerable (e.g. `bootout` on an
 * absent unit during reinstall) is the caller's concern; here we report every result faithfully.
 */
async function runAll(
	runner: CommandRunner,
	commands: readonly ServiceCommand[],
): Promise<{ allOk: boolean; firstFailure: ServiceCommand | null; firstFailureResult: CommandResult | null }> {
	let firstFailure: ServiceCommand | null = null;
	let firstFailureResult: CommandResult | null = null;
	for (const cmd of commands) {
		const result = await runner.run(cmd.command, cmd.args, { timeoutMs: SERVICE_COMMAND_TIMEOUT_MS });
		if (!result.ok && firstFailure === null) {
			firstFailure = cmd;
			firstFailureResult = result;
		}
	}
	return { allOk: firstFailure === null, firstFailure, firstFailureResult };
}

/**
 * Build the real {@link ServiceModule}. The composition root / CLI inject the resolved
 * exec path; tests inject the runner + fs + a fixed environment so nothing real runs.
 */
export function createServiceModule(deps: ServiceModuleDeps): ServiceModule {
	const runner = deps.runner ?? createExecFileRunner();
	const fs = deps.fs ?? createNodeServiceFs();
	const logger = deps.logger ?? silentLogger;
	const uid = deps.uid ?? liveUid();
	const environment =
		deps.environment ?? resolveServiceContext(deps.execPath, deps.preferSystemScope ?? false);

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

			// 1) Write the unit file FIRST (when this manager is file-based). schtasks consumes the
			//    XML file too, so a non-empty unitPath OR the schtasks manager means we lay down text.
			const needsFile = p.unitPath !== "" || p.manager === "schtasks";
			let unitTarget = p.unitPath;
			if (needsFile) {
				try {
					if (p.manager === "schtasks" && unitTarget === "") {
						// Per-user task: stage the XML beside Doctor's workspace so schtasks /XML can read it.
						unitTarget = `${p.home}/.honeycomb/doctor/doctor-task.xml`;
					}
					fs.mkdirp(dirname(unitTarget));
					fs.writeFile(unitTarget, renderUnit(p));
				} catch (error) {
					return {
						ok: false,
						message: `Could not write the Doctor unit file at ${unitTarget}: ${error instanceof Error ? error.message : "unknown error"}.`,
					};
				}
			}

			// 2) Run the manager's install argv. For schtasks the staged file path is the unit path.
			const planForArgv: ServicePlan = unitTarget === p.unitPath ? p : { ...p, unitPath: unitTarget };
			const { allOk, firstFailure, firstFailureResult } = await runAll(runner, installCommands(planForArgv, uid));
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
			const { allOk, firstFailure, firstFailureResult } = await runAll(runner, uninstallCommands(p, uid));

			// 2) Delete the unit file so it cannot resurrect on next boot (AC-064b.5). For schtasks the
			//    staged XML lives beside the workspace; remove that too.
			const stagedXml = p.manager === "schtasks" ? `${p.home}/.honeycomb/doctor/doctor-task.xml` : "";
			try {
				if (p.unitPath !== "") fs.removeFile(p.unitPath);
				if (stagedXml !== "") fs.removeFile(stagedXml);
			} catch (error) {
				logger.warn("service.unit_remove_failed", {
					reason: error instanceof Error ? error.message : "unknown",
				});
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
	};
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
	return "running";
}

export { resolveServicePlan, resolveServiceContext } from "./platform.js";
export type { ServicePlan, ServiceEnvironment } from "./platform.js";
