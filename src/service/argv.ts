/**
 * Exact argv construction for every service-manager command (PRD-064b Scope).
 *
 * The service module shells out to the OS service manager (technical consideration:
 * shell out, do NOT take a dependency). Each operation - install, uninstall, status -
 * maps to one OR MORE ordered argv arrays. This module is the single source of truth for
 * those argv arrays; it is pure (a {@link ServicePlan} in, argv arrays out) so a test
 * asserts the EXACT command line per platform without ever executing it.
 *
 * Every command goes through the injected {@link CommandRunner} (execFile, no shell), so a
 * unit path or label can never be re-parsed as a shell metacharacter. The arrays here are
 * the argv that runner receives.
 *
 * launchd: `launchctl bootstrap gui/<uid> <plist>` (modern) to load, `bootout` to unload.
 *          The legacy `load -w` / `unload -w` are intentionally avoided.
 * systemd: `systemctl --user enable --now doctor.service` to install+start,
 *          `disable --now` to remove, `is-active` for status. `--user` for user scope,
 *          no flag for system scope.
 * schtasks: `/Create /XML <file> /TN doctor /F` (per-user, no admin),
 *           `/Delete /TN doctor /F`, `/Query /TN doctor` for status.
 * sc.exe:  `create` + `start` (system service, enterprise opt-in), `stop`+`delete`,
 *          `query` for status.
 *
 * Built-ins only; pure functions.
 */

import {
	LEGACY_SERVICE_LABEL,
	LEGACY_SYSTEMD_UNIT_NAME,
	LEGACY_WINDOWS_TASK_NAME,
	SYSTEMD_UNIT_NAME,
	WINDOWS_TASK_NAME,
	type ServicePlan,
} from "./platform.js";

/** A single command: the executable + its argv (no shell). */
export interface ServiceCommand {
	/** The binary to exec (e.g. `launchctl`, `systemctl`, `schtasks`, `sc`). */
	readonly command: string;
	/** The argv array (no shell parsing). */
	readonly args: readonly string[];
}

/** Fixed PowerShell host used only for the Windows Scheduled Task descendant cleanup. */
export const WINDOWS_POWERSHELL_PATH =
	"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" as const;

/**
 * Task Scheduler can end the `conhost --headless` action while leaving its Node child alive.
 * This fixed script receives the trusted Doctor bundle path and Node executable as separate argv
 * values, then terminates only an exact `node <doctor-cli> run` identity. No value is interpolated
 * into the script and the command is executed through execFile, not a shell string.
 */
export const WINDOWS_DOCTOR_PROCESS_CLEANUP_SCRIPT =
	"& { param([string]$cli64,[string]$node64); " +
	"$ErrorActionPreference='Stop'; " +
	"$cli=[IO.Path]::GetFullPath([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($cli64))); " +
	"$node=[IO.Path]::GetFullPath([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($node64))); " +
	"Get-CimInstance Win32_Process | Where-Object { " +
	"$_.Name -ieq 'node.exe' -and $_.CommandLine -and $_.ExecutablePath -and " +
	"[IO.Path]::GetFullPath($_.ExecutablePath) -ieq $node -and " +
	"$_.CommandLine.IndexOf($cli,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and " +
	"$_.CommandLine -match '\\srun(?:\\s|$)' " +
	"} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } }";

/** Encode a path as UTF-16LE/base64 so PowerShell's `-Command` parser cannot split it. */
export function encodeWindowsCleanupPath(value: string): string {
	return Buffer.from(value, "utf16le").toString("base64");
}

/** Kill only orphaned/running Doctor children for this exact installed bundle path. */
export function windowsDoctorProcessCleanupCommand(plan: ServicePlan): ServiceCommand {
	return {
		command: WINDOWS_POWERSHELL_PATH,
		args: [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			WINDOWS_DOCTOR_PROCESS_CLEANUP_SCRIPT,
			encodeWindowsCleanupPath(plan.execPath),
			encodeWindowsCleanupPath(process.execPath),
		],
	};
}

/** The user's numeric uid for the launchd `gui/<uid>` domain target. Injected (default: live uid). */
export type ReadUidFn = () => number;

/** Build the launchd `gui/<uid>` domain-target string used by bootstrap/bootout. */
export function launchdDomainTarget(plan: ServicePlan, uid: number): string {
	// System scope uses the `system` domain; user scope uses the per-user GUI domain.
	return plan.scope === "system" ? "system" : `gui/${uid}`;
}

/** The launchd service target (`<domain>/<label>`) used by `bootout` + `kickstart`. */
export function launchdServiceTarget(plan: ServicePlan, uid: number): string {
	return `${launchdDomainTarget(plan, uid)}/${plan.label}`;
}

/**
 * The argv to INSTALL (register + start) the service for this plan. Returns the ordered
 * list of commands to run; the caller writes the unit file first (when the plan has a
 * unitPath), then runs these.
 */
export function installCommands(plan: ServicePlan, uid: number): readonly ServiceCommand[] {
	switch (plan.manager) {
		case "launchd": {
			const domain = launchdDomainTarget(plan, uid);
			return [
				// Reconcile a previously loaded definition. A clean "not loaded" result is
				// tolerated by the service module; any real permission failure remains fatal.
				{ command: "launchctl", args: ["bootout", launchdServiceTarget(plan, uid)] },
				// Modern load: bootstrap the unit into the (user GUI | system) domain.
				{ command: "launchctl", args: ["bootstrap", domain, plan.unitPath] },
				// Ensure it is started now (idempotent kick; harmless if already running).
				{ command: "launchctl", args: ["kickstart", "-k", launchdServiceTarget(plan, uid)] },
			];
		}
		case "systemd": {
			const scopeArgs = plan.scope === "user" ? ["--user"] : [];
			return [
				// enable --now both starts it and wires start-on-boot in one shot.
				{ command: "systemctl", args: [...scopeArgs, "enable", "--now", SYSTEMD_UNIT_NAME] },
			];
		}
		case "schtasks": {
			// Per-user Scheduled Task from the rendered XML; /F overwrites idempotently.
			return [
				// Reconciliation must stop the tracked wrapper and any legacy orphaned child
				// before replacing the definition; otherwise the new `/Run` can create a
				// second watchdog while the old one still owns Doctor's status port.
				{ command: "schtasks", args: ["/End", "/TN", WINDOWS_TASK_NAME] },
				windowsDoctorProcessCleanupCommand(plan),
				{ command: "schtasks", args: ["/Create", "/XML", plan.unitPath, "/TN", WINDOWS_TASK_NAME, "/F"] },
				// Start it immediately so a clean install is running without waiting for the next logon.
				{ command: "schtasks", args: ["/Run", "/TN", WINDOWS_TASK_NAME] },
			];
		}
		case "sc": {
			// Windows Service (enterprise opt-in). binPath wraps node + the bin + the run verb.
			const binPath = `"${process.execPath}" "${plan.execPath}" run`;
			return [
				{
					command: "sc",
					args: ["create", WINDOWS_TASK_NAME, `binPath=${binPath}`, "start=", "auto"],
				},
				// `create` establishes a missing service; `config` reconciles an existing one.
				{ command: "sc", args: ["config", WINDOWS_TASK_NAME, `binPath=${binPath}`, "start=", "auto"] },
				{ command: "sc", args: ["start", WINDOWS_TASK_NAME] },
			];
		}
	}
}

/** The argv to UNINSTALL (stop + remove) the service for this plan, in order. */
export function uninstallCommands(plan: ServicePlan, uid: number): readonly ServiceCommand[] {
	switch (plan.manager) {
		case "launchd":
			return [
				// bootout unloads the unit from its domain; the caller then deletes the plist file.
				{ command: "launchctl", args: ["bootout", launchdServiceTarget(plan, uid)] },
			];
		case "systemd": {
			const scopeArgs = plan.scope === "user" ? ["--user"] : [];
			return [
				// disable --now stops it and removes the start-on-boot wiring; the caller deletes the unit.
				{ command: "systemctl", args: [...scopeArgs, "disable", "--now", SYSTEMD_UNIT_NAME] },
			];
		}
		case "schtasks":
			return [
				{ command: "schtasks", args: ["/End", "/TN", WINDOWS_TASK_NAME] },
				windowsDoctorProcessCleanupCommand(plan),
				{ command: "schtasks", args: ["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"] },
			];
		case "sc":
			return [
				{ command: "sc", args: ["stop", WINDOWS_TASK_NAME] },
				{ command: "sc", args: ["delete", WINDOWS_TASK_NAME] },
			];
	}
}

/**
 * The argv to START (without registering) the service for this plan (PRD-003b b-AC-1).
 * Assumes the unit is already registered (via {@link installCommands} / `install-service`);
 * a caller invoking this against an unregistered unit gets the manager's own honest
 * "not found" failure rather than doctor silently registering one.
 */
export function startCommands(plan: ServicePlan, uid: number): readonly ServiceCommand[] {
	switch (plan.manager) {
		case "launchd":
			// Explicit stop unloads the job so KeepAlive cannot resurrect it. Start therefore
			// bootstraps the installed plist before kickstarting; "already loaded" is tolerated.
			return [
				{ command: "launchctl", args: ["bootstrap", launchdDomainTarget(plan, uid), plan.unitPath] },
				{ command: "launchctl", args: ["kickstart", "-k", launchdServiceTarget(plan, uid)] },
			];
		case "systemd": {
			const scopeArgs = plan.scope === "user" ? ["--user"] : [];
			return [{ command: "systemctl", args: [...scopeArgs, "start", SYSTEMD_UNIT_NAME] }];
		}
		case "schtasks":
			// A previous Task Scheduler `/End` can leave the headless Node child orphaned.
			// Reap only Doctor's exact child before starting so a stale process cannot race
			// the new task for the status port.
			return [
				windowsDoctorProcessCleanupCommand(plan),
				{ command: "schtasks", args: ["/Run", "/TN", WINDOWS_TASK_NAME] },
			];
		case "sc":
			return [{ command: "sc", args: ["start", WINDOWS_TASK_NAME] }];
	}
}

/**
 * The argv to STOP (without deregistering) the service for this plan (PRD-003b b-AC-1).
 * Unlike {@link uninstallCommands}, this never deletes the installed definition. launchd
 * must unload the job because an unconditional KeepAlive job cannot otherwise remain
 * explicitly stopped; a later start bootstraps the retained plist again.
 */
export function stopCommands(plan: ServicePlan, uid: number): readonly ServiceCommand[] {
	switch (plan.manager) {
		case "launchd":
			// Keep the plist installed but unload the job, guaranteeing KeepAlive cannot race
			// an explicit stop. `startCommands` reloads this same retained definition.
			return [{ command: "launchctl", args: ["bootout", launchdServiceTarget(plan, uid)] }];
		case "systemd": {
			const scopeArgs = plan.scope === "user" ? ["--user"] : [];
			return [{ command: "systemctl", args: [...scopeArgs, "stop", SYSTEMD_UNIT_NAME] }];
		}
		case "schtasks":
			return [
				{ command: "schtasks", args: ["/End", "/TN", WINDOWS_TASK_NAME] },
				windowsDoctorProcessCleanupCommand(plan),
			];
		case "sc":
			return [{ command: "sc", args: ["stop", WINDOWS_TASK_NAME] }];
	}
}

/**
 * The argv to deregister the PRE-decision-#32 unit names (`com.legioncode.hivedoctor` /
 * `hivedoctor.service` / `HiveDoctor`). Run best-effort at the start of every install so
 * a re-run migrates a legacy unit; when no legacy unit exists these commands fail
 * harmlessly and the install proceeds.
 */
export function legacyUninstallCommands(plan: ServicePlan, uid: number): readonly ServiceCommand[] {
	switch (plan.manager) {
		case "launchd":
			return [{ command: "launchctl", args: ["bootout", `${launchdDomainTarget(plan, uid)}/${LEGACY_SERVICE_LABEL}`] }];
		case "systemd": {
			const scopeArgs = plan.scope === "user" ? ["--user"] : [];
			return [{ command: "systemctl", args: [...scopeArgs, "disable", "--now", LEGACY_SYSTEMD_UNIT_NAME] }];
		}
		case "schtasks":
			return [{ command: "schtasks", args: ["/Delete", "/TN", LEGACY_WINDOWS_TASK_NAME, "/F"] }];
		case "sc":
			return [
				{ command: "sc", args: ["stop", LEGACY_WINDOWS_TASK_NAME] },
				{ command: "sc", args: ["delete", LEGACY_WINDOWS_TASK_NAME] },
			];
	}
}

/** The single argv to QUERY status. The caller interprets the command's exit/stdout. */
export function statusCommand(plan: ServicePlan, uid: number): ServiceCommand {
	switch (plan.manager) {
		case "launchd":
			return { command: "launchctl", args: ["print", launchdServiceTarget(plan, uid)] };
		case "systemd": {
			const scopeArgs = plan.scope === "user" ? ["--user"] : [];
			return { command: "systemctl", args: [...scopeArgs, "is-active", SYSTEMD_UNIT_NAME] };
		}
		case "schtasks":
			return { command: "schtasks", args: ["/Query", "/TN", WINDOWS_TASK_NAME] };
		case "sc":
			return { command: "sc", args: ["query", WINDOWS_TASK_NAME] };
	}
}
