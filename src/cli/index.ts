/**
 * The `doctor` CLI entry point (PRD-064f - the bin target).
 *
 * Builds the PRODUCTION {@link CliContext} - real stdout/stderr, a readline confirm
 * prompt, and live injected deps wired from the resolved config + the same primitives the
 * composition root uses - then dispatches one invocation and exits with the returned code.
 *
 * The heavy assembly (probe, ladder, update engine) is constructed here lazily for the CLI
 * surface; the long-running watchdog assembly lives in src/compose. Keeping the CLI's deps
 * here (rather than spinning the whole supervisor) means `status`/`diagnose` are cheap and
 * work with the daemon down (AC-064f.6).
 *
 * Built-ins only: node:readline/promises for the confirm prompt, node:process for argv +
 * streams. The `self-update` action is the SOLE path wired to Doctor's own package.
 */

import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { runApiaryMigrations } from "../apiary-migration.js";
import { legacyHoneycombRoot } from "../apiary-root.js";
import { resolveConfig } from "../config.js";
import { resolveDeviceId } from "../device-id.js";
import { probeHealth } from "../health-probe.js";
import { createInstallLock } from "../install-lock.js";
import { createLogger } from "../logger.js";
import { resolveRegistryEntries, type DaemonEntry } from "../registry.js";
import {
	createRemediationLadder,
	createReinstallRung,
	createRestartRung,
	createUninstallHivemindRung,
	createNpmHivemindDetector,
	createExecFileRunner,
} from "../remediation.js";
import {
	createServiceModule,
	deregisterLegacyUnit,
	isServiceRegistered,
	serviceStart,
	serviceStatus,
	serviceStop,
} from "../service/index.js";
import { readProductUninstallState, removeProductState } from "../product-uninstall.js";
import { createPurgeEngine } from "../purge/engine.js";
import { createStateStore } from "../state.js";
import { createLifecycleTelemetry } from "../telemetry/capture.js";
import { isOptedOut } from "../telemetry/emit.js";
import {
	createInstalledPackageVersionReader,
	createRegistryLatestReader,
	createUpdateEngine,
	PRIMARY_PACKAGE,
} from "../update/index.js";
import { DOCTOR_VERSION } from "../version.js";
import { parseArgs, hasFlag } from "./arg-parse.js";
import { createColors } from "./colors.js";
import { readDaemonVersion } from "./daemon-version.js";
import { dispatch } from "./dispatch.js";
import { createIncidentsTail } from "./incidents-tail.js";
import { resolveOptOut } from "./opt-out.js";
import { createSelfUpdate, parseApprovedVersion } from "./self-update.js";
import { createUpdateActions } from "./update-actions.js";
import { appendDoctorServiceLog, captureDoctorServiceOutput, doctorServiceLogPath, tailDoctorServiceLog } from "./service-logs.js";
import type { CliContext, ConfirmFn, ConfirmTokenFn, OutputSink } from "./context.js";
import type { HealthClassification } from "../health-probe.js";
import type { RungContext } from "../remediation.js";

/** The production output sink: writes to the real stdout/stderr. */
function realOutputSink(): OutputSink {
	return {
		out(text: string): void {
			process.stdout.write(`${text}\n`);
		},
		err(text: string): void {
			process.stderr.write(`${text}\n`);
		},
	};
}

/** A readline-backed confirm prompt; treats a non-interactive stdin as "no". */
function realConfirm(): ConfirmFn {
	return async (question: string): Promise<boolean> => {
		// A non-TTY stdin (piped/CI) can never confirm a destructive action: default to no.
		if (!process.stdin.isTTY) return false;
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		try {
			const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
			return answer === "y" || answer === "yes";
		} finally {
			rl.close();
		}
	};
}

/**
 * A readline-backed TYPED-TOKEN confirm prompt for `purge` (PRD-003c c-AC-1): resolves
 * true ONLY on an exact (trimmed) match of `expectedToken`. A non-TTY stdin never even
 * opens the prompt (the caller in dispatch.ts already gates on {@link CliContext.isInteractive}
 * before reaching this, but the check is repeated here too so this function is safe to call
 * standalone and NEVER hangs waiting on input that will never arrive).
 */
function realConfirmToken(): ConfirmTokenFn {
	return async (question: string, expectedToken: string): Promise<boolean> => {
		if (!process.stdin.isTTY) return false;
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		try {
			const answer = (await rl.question(`${question}\nType "${expectedToken}" to confirm: `)).trim();
			return answer === expectedToken;
		} finally {
			rl.close();
		}
	};
}

/** Build the production {@link CliContext}. Lazily wires the deps the commands need. */
export function buildCliContext(argv: readonly string[]): CliContext {
	const env = process.env;
	const config = resolveConfig(env);
	const logger = createLogger({ level: "warn" }); // The CLI is quiet unless something is wrong.
	const colors = createColors({
		env: hasFlag(parseArgs(argv), "no-color") ? { ...env, NO_COLOR: "1" } : env,
	});
	const runner = createExecFileRunner();
	const home = homedir();
	// PRD-004b: read the registry NEW-first with the legacy-additive merge (read-only; the
	// one-time migration runs from the long-running `run` boot, not this short-lived CLI).
	const daemonEntries =
		resolveRegistryEntries({ home, env }) ??
		([
			{
				name: "honeycomb",
				healthUrl: config.healthUrl,
				pidPath: config.daemonPidPath,
				probeIntervalMs: config.probeIntervalMs,
				startupGraceMs: config.startupGraceMs,
				restartGiveUpThreshold: config.restartGiveUpThreshold,
				restartCooldownMs: config.restartCooldownMs,
			},
		] satisfies readonly DaemonEntry[]);

	const daemonStateStores = daemonEntries.map((entry) => ({
		name: entry.name,
		healthUrl: entry.healthUrl,
		stateStore: createStateStore({ workspaceDir: config.workspaceDir, name: entry.name, logger }),
	}));
	const primaryDaemon = daemonStateStores[0] ?? {
		name: "honeycomb",
		healthUrl: config.healthUrl,
		stateStore: createStateStore({ workspaceDir: config.workspaceDir, name: "honeycomb", logger }),
	};
	const doctorStateStore = createStateStore({ workspaceDir: config.workspaceDir, logger });

	const statusDaemons = () =>
		daemonStateStores.map((daemon) => ({
			name: daemon.name,
			probe: () => probeHealth({ healthUrl: daemon.healthUrl, timeoutMs: config.probeTimeoutMs }),
			readDaemonVersion: () => readDaemonVersion({ healthUrl: daemon.healthUrl, timeoutMs: config.probeTimeoutMs }),
			readStatusState: () => {
				const s = daemon.stateStore.read();
				return { lastHealAt: s.lastHealAt, lastKnownHealth: s.lastKnownHealth };
			},
		}));
	// LEGACY-HONEYCOMB-WINDOW: the lock also honors a live holder at the pre-migration
	// workspace (`~/.honeycomb/doctor`) per the PRD-004a design; drop when the window closes.
	const installLock = createInstallLock({
		workspaceDir: config.workspaceDir,
		legacyWorkspaceDir: join(legacyHoneycombRoot(home), "doctor"),
		logger,
	});

	// The SHARED per-install device id (PRD-033/064d, relocated by PRD-004b): the daemon and
	// Doctor read/mint the same <root>/device.json (legacy ~/.honeycomb/device.json as the
	// window fallback) so every telemetry stream correlates to one install.
	// resolveDeviceId never throws; the try/catch keeps "unknown-device" as the last-resort net.
	let deviceId = "unknown-device";
	try {
		deviceId = resolveDeviceId();
	} catch {
		// Impossible (resolveDeviceId is defensive); the sentinel keeps the CLI build total.
	}

	const probe = (): Promise<HealthClassification> =>
		probeHealth({ healthUrl: primaryDaemon.healthUrl, timeoutMs: config.probeTimeoutMs });
	// The RUNNING daemon's reported version (from `/health`). This is what `status` shows, and
	// it is null when the daemon is down -- correct for a "what is running right now" display.
	const readDaemonVersionFn = (): Promise<string | null> =>
		readDaemonVersion({ healthUrl: primaryDaemon.healthUrl, timeoutMs: config.probeTimeoutMs });
	// The GLOBALLY-INSTALLED package version (from `npm ls -g`). This is what the update engine
	// and the reinstall rung's post-install verify mean by "installed": it is on disk even when
	// the daemon is DOWN, so auto-update/repair can still establish a rollback target then.
	const readInstalledPackageVersion = createInstalledPackageVersionReader({ runner, pkg: PRIMARY_PACKAGE });
	const isHealthy = async (): Promise<boolean> => (await probe()).kind === "ok";

	// The real 064b OS-service identity. The unit it registers execs `node <this-script> run`,
	// so the exec path is the running CLI script (process.argv[1]); the bundled bin resolves to
	// the same path under a global install. Userland scope is the default; an operator opts into
	// a system unit via DOCTOR_SERVICE_SYSTEM=1 (the enterprise path, parent index ruling).
	// Resolved BEFORE the restart rung below so `restart`'s PRD-003b wiring can use it.
	const serviceExecPath = process.argv[1] ?? "doctor";
	const preferSystemScope = (env["DOCTOR_SERVICE_SYSTEM"] ?? "") === "1";
	const serviceDeps = { execPath: serviceExecPath, preferSystemScope, runner, logger };

	let lastRestartAt: number | null = null;
	const clock = { now: () => Date.now() };
	const restartRung = createRestartRung({
		// PRD-003b b-AC-1: the only OS service Doctor itself controls is its OWN (there is no
		// cross-product service control - each product owns its own registration). A manual
		// `doctor restart`/`doctor heal` therefore stop+starts DOCTOR'S OWN service through the
		// same manager that already restarts it on crash; it does NOT restart the SUPERVISED
		// primary daemon's OS service (honeycomb has no such surface exposed to doctor). This
		// is a deliberate, narrower scope than the menu text implies; see the PRD-003b W1-D
		// report for the full rationale.
		restart: async () => {
			await serviceStop(serviceDeps);
			const started = await serviceStart(serviceDeps);
			if (!started.ok) logger.warn("cli.restart_self_service_failed", { detail: started.message });
			return started.ok;
		},
		readDaemonPid: async () => null,
		isHealthy,
		cooldownMs: config.restartCooldownMs,
		clock,
		lastRestartAt: () => lastRestartAt,
		markRestarted: (at: number) => {
			lastRestartAt = at;
		},
	});
	const reinstallRung = createReinstallRung({ runner, installLock, blessedVersion: "", readInstalledVersion: readInstalledPackageVersion });
	const uninstallRung = createUninstallHivemindRung({
		runner,
		detectHivemind: createNpmHivemindDetector(runner),
		workspaceDir: config.workspaceDir,
	});
	const ladder = createRemediationLadder({
		rungs: [restartRung, reinstallRung, uninstallRung],
		restartGiveUpThreshold: config.restartGiveUpThreshold,
		logger,
	});

	const optOut = resolveOptOut({ cliNoAutoUpdate: hasFlag(parseArgs(argv), "no-auto-update"), env });

	// The lifecycle capture-event emitter (doctor_installed / _updated / _uninstalled):
	// dedupe markers live in doctor's own un-sharded state.json; distinct_id prefers the
	// shared installer id (<root>/install-id, legacy ~/.honeycomb/install-id as the window
	// fallback) with the resolved device id as fallback.
	// Every method is gated (empty key / DO_NOT_TRACK / HONEYCOMB_TELEMETRY=0) + fail-soft.
	const lifecycle = createLifecycleTelemetry({
		stateStore: doctorStateStore,
		distinctId: { deviceId },
	});

	const updateEngine = createUpdateEngine({
		runner,
		installLock,
		readLatestVersion: createRegistryLatestReader({ pkg: PRIMARY_PACKAGE }),
		readInstalledVersion: readInstalledPackageVersion,
		// The CLI itself cannot restart the OS service (064b owns that); report `false` so the
		// engine's FIX-2 verify rule knows there is no supervised daemon to restart through and
		// does NOT roll back a still-unhealthy /health (it would only discard the new version).
		restartDaemon: async (): Promise<boolean> => {
			logger.warn("cli.update_restart_no_os_service");
			return false;
		},
		verifyHealthy: isHealthy,
		optOut: {
			autoUpdateDisabled: optOut.autoUpdateDisabled,
			...(optOut.pinnedVersion !== undefined ? { pinnedVersion: optOut.pinnedVersion } : {}),
		},
		deviceId,
		lifecycle,
		logger,
	});

	const selfUpdate = createSelfUpdate({
		runner,
		logger,
		restartService: async () => {
			await serviceStop(serviceDeps);
			return (await serviceStart(serviceDeps)).ok;
		},
		verifyHealthy: async () => (await serviceStatus(serviceDeps)) === "running",
	});
	const checkSelfUpdate = async (): Promise<string> => {
		const result = await runner.run("npm", ["view", "@legioncodeinc/doctor", "version", "--json"], { timeoutMs: 15_000 });
		if (!result.ok) return `Unable to resolve Doctor's approved release: ${result.detail ?? "npm query failed"}.`;
		const target = parseApprovedVersion(result.stdout);
		if (target === null) return "Unable to resolve Doctor's approved release: invalid registry metadata.";
		return target === DOCTOR_VERSION
			? `Doctor is up to date (${DOCTOR_VERSION}).`
			: `Doctor update available: ${DOCTOR_VERSION} -> ${target}.`;
	};

	// The real 064b OS-service module (install/uninstall/start/stop), built once and shared
	// by every seam below (`serviceModule`, `serviceLifecycle`, `productUninstall`, `purge`).
	const serviceModule = createServiceModule(serviceDeps);

	// PRD-003b b-AC-2/3/4/6: the fuller `uninstall` verb's deps, layered on top of the SAME
	// `serviceModule.uninstall()` the legacy `uninstall-service` verb also calls (unchanged
	// behavior there), PLUS a best-effort legacy-label deregister (b-AC-2 - `uninstall-service`
	// itself is left untouched so its exact-argv tests stay valid), PLUS the registry-entry +
	// state-dir removal (product-uninstall.ts).
	const productUninstall = {
		precheck: () => readProductUninstallState({ home, env }),
		serviceStatusAsync: () => serviceStatus(serviceDeps),
		isServiceRegistered: () => isServiceRegistered(serviceDeps),
		serviceUninstall: async () => {
			await deregisterLegacyUnit(serviceDeps);
			return serviceModule.uninstall();
		},
		removeState: () => removeProductState({ home, env }),
	};

	// PRD-003c: the destructive `purge` engine, wired to the SAME runner + service module so
	// nothing here spins up a second, differently-configured execFile path.
	const purge = createPurgeEngine({ runner, serviceModule, home, env });

	const rungContextFor = (classification: HealthClassification): RungContext => ({ classification, logger });

	return {
		io: realOutputSink(),
		confirm: realConfirm(),
		confirmToken: realConfirmToken(),
		isInteractive: () => process.stdin.isTTY === true,
		colors,
		deps: {
			probe,
			statusDaemons,
			readDaemonVersion: readDaemonVersionFn,
			doctorVersion: DOCTOR_VERSION,
			ladder,
			rungContextFor,
			decideRung: (n) => ladder.decide(n),
			readConsecutiveFailures: () => primaryDaemon.stateStore.read().consecutiveRestartFailures,
			readStatusState: () => {
				const s = primaryDaemon.stateStore.read();
				return { lastHealAt: s.lastHealAt, lastKnownHealth: s.lastKnownHealth };
			},
			// serviceState is the SYNC coarse read the test harness injects directly; the production
			// wiring prefers the bounded ASYNC probe below (serviceStateAsync) so `status` reports the
			// real service-manager state. Kept "unknown" so the sync seam never claims a state it did
			// not probe (it is only used when the async probe is absent, i.e. in tests).
			serviceState: () => "unknown",
			// IRD-192 AC-5: the real OS-service-manager probe (schtasks/launchctl/systemctl is-active),
			// bounded by SERVICE_COMMAND_TIMEOUT_MS inside serviceStatus(). Never throws; resolves
			// "unknown" on a spawn error or unsupported platform, so `status` stays fast and fail-safe.
			serviceStateAsync: () => serviceStatus(serviceDeps),
			serviceModule,
			// PRD-003b b-AC-1: the SAME module also satisfies the leaner start/stop seam.
			serviceLifecycle: serviceModule,
			productUninstall,
			purge,
			lifecycle,
			optOut,
			// `update --check` previews via previewUpdate() (READ-ONLY, never mutates); `update`
			// applies via runUpdateTransaction(); `self-update` is the sole own-package path.
			update: { ...createUpdateActions(updateEngine, selfUpdate), checkSelfUpdate },
			tailIncidents: createIncidentsTail(
				config.workspaceDir,
				daemonEntries.map((entry) => entry.name),
			),
			tailServiceLogs: (args, write, signal) =>
				tailDoctorServiceLog({ argv: args, workspaceDir: config.workspaceDir, write, ...(signal === undefined ? {} : { signal }) }),
			paths: { config: config.workspaceDir, logs: doctorServiceLogPath(config.workspaceDir) },
			telemetrySummary: () => {
				const disabled = isOptedOut(env);
				const controllingSetting = env["DO_NOT_TRACK"] !== undefined
						? "DO_NOT_TRACK"
						: env["HONEYCOMB_TELEMETRY"] === "0"
							? "HONEYCOMB_TELEMETRY"
							: "default";
				return {
					state: disabled ? "opted-out" : "enabled",
					controllingSetting,
					destination: disabled ? "disabled" : "hosted",
					optOutInstruction: "Set DO_NOT_TRACK=1 or HONEYCOMB_TELEMETRY=0",
				};
			},
		},
	};
}

/**
 * The long-running `run` entry the OS service execs (PRD-064b). It is NOT a return-then-exit
 * command: it builds the full watchdog assembly (compose root, 064f) and keeps the process
 * alive until the service manager sends SIGTERM/SIGINT, then stops every loop gracefully so
 * the OS records a clean shutdown rather than a crash. Resolves with an exit code only after
 * the process is asked to stop. Crash-safe: a wiring error is caught and mapped to exit 1.
 */
async function runWatchdog(argv: readonly string[]): Promise<number> {
	const cliNoAutoUpdate = hasFlag(parseArgs(argv), "no-auto-update");
	// Arm termination before the first asynchronous startup step. A service manager may
	// request shutdown while migrations, the dynamic compose import, or doctor.start() is
	// still in flight; registering later loses that signal and leaves the watchdog alive.
	let resolveTermination: (() => void) | undefined;
	const termination = new Promise<void>((resolve) => {
		resolveTermination = resolve;
	});
	const stop = (): void => resolveTermination?.();
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	try {
		// PRD-004 (ADR-0003): run the one-time, idempotent, best-effort state migrations on boot
		// BEFORE assembling the watchdog: doctor's own workspace (004a) and the fleet-shared
		// registry (004b) move from the legacy `~/.honeycomb` root to the neutral `~/.apiary` root.
		// runApiaryMigrations is TOTAL (never throws), so a migration hiccup can never block boot;
		// readers fall back to the legacy location until the new path exists. The workspace leg is
		// skipped (and logged) when DOCTOR_WORKSPACE_DIR pins the workspace explicitly.
		runApiaryMigrations({ logger: createLogger({ level: "info" }) });
		const config = resolveConfig(process.env);
		await appendDoctorServiceLog(config.workspaceDir, "Doctor service starting");
		const restoreServiceOutput = captureDoctorServiceOutput(config.workspaceDir);
		// Keep the watchdog assembly (and its experimental node:sqlite reader) off every
		// one-shot CLI path. JSON commands must emit exactly one document with no runtime warning.
		const { createDoctor } = await import("../compose/index.js");
		const doctor = createDoctor({ cliNoAutoUpdate });
		await doctor.start();
		// Keep `run` alive even when optional referenced handles (notably the status page)
		// fail to bind and all internal loop timers are deliberately unref'ed.
		const keepAlive = setInterval(() => undefined, 60 * 60 * 1000);
		try {
			// Block until a termination signal arrives; the service manager owns the lifecycle.
			await termination;
		} finally {
			clearInterval(keepAlive);
			await doctor.stop();
			await appendDoctorServiceLog(config.workspaceDir, "Doctor service stopped");
			restoreServiceOutput();
		}
		return 0;
	} finally {
		process.removeListener("SIGTERM", stop);
		process.removeListener("SIGINT", stop);
	}
}

/** Run the CLI: build the context, dispatch, resolve the exit code. Never throws. */
export async function runCli(argv: readonly string[]): Promise<number> {
	try {
		// `run` is the long-running OS-service entry (064b); it bypasses the return-then-exit
		// dispatcher and stays alive until a termination signal.
		if (argv[0] === "run") {
			return await runWatchdog(argv);
		}
		const ctx = buildCliContext(argv);
		return await dispatch(argv, ctx);
	} catch (error) {
		// Last-resort net: even a wiring error must not crash with a stack trace.
		process.stderr.write(`doctor: ${error instanceof Error ? error.message : "unexpected error"}\n`);
		return 1;
	}
}
