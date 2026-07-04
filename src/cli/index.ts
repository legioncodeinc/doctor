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
import { createDoctor } from "../compose/index.js";
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
import { createServiceModule, serviceStatus } from "../service/index.js";
import { createStateStore } from "../state.js";
import { createLifecycleTelemetry } from "../telemetry/capture.js";
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
import { createSelfUpdate } from "./self-update.js";
import { createUpdateActions } from "./update-actions.js";
import type { CliContext, ConfirmFn, OutputSink } from "./context.js";
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

/** Build the production {@link CliContext}. Lazily wires the deps the commands need. */
export function buildCliContext(argv: readonly string[]): CliContext {
	const env = process.env;
	const config = resolveConfig(env);
	const logger = createLogger({ level: "warn" }); // The CLI is quiet unless something is wrong.
	const colors = createColors();
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

	let lastRestartAt: number | null = null;
	const clock = { now: () => Date.now() };
	const restartRung = createRestartRung({
		// The CLI cannot itself restart the OS service (064b); a manual `restart` reports it.
		restart: async () => {
			logger.warn("cli.restart_no_os_service");
			return false;
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
		stateStore: createStateStore({ workspaceDir: config.workspaceDir, logger }),
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

	const selfUpdate = createSelfUpdate({ runner, logger });

	// The real 064b OS-service module. The unit it registers execs `node <this-script> run`,
	// so the exec path is the running CLI script (process.argv[1]); the bundled bin resolves to
	// the same path under a global install. Userland scope is the default; an operator opts into
	// a system unit via DOCTOR_SERVICE_SYSTEM=1 (the enterprise path, parent index ruling).
	const serviceExecPath = process.argv[1] ?? "doctor";
	const preferSystemScope = (env["DOCTOR_SERVICE_SYSTEM"] ?? "") === "1";
	const serviceModule = createServiceModule({ execPath: serviceExecPath, preferSystemScope, runner, logger });

	const rungContextFor = (classification: HealthClassification): RungContext => ({ classification, logger });

	return {
		io: realOutputSink(),
		confirm: realConfirm(),
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
			serviceStateAsync: () => serviceStatus({ execPath: serviceExecPath, preferSystemScope, runner }),
			serviceModule,
			lifecycle,
			optOut,
			// `update --check` previews via previewUpdate() (READ-ONLY, never mutates); `update`
			// applies via runUpdateTransaction(); `self-update` is the sole own-package path.
			update: createUpdateActions(updateEngine, selfUpdate),
			tailIncidents: createIncidentsTail(
				config.workspaceDir,
				daemonEntries.map((entry) => entry.name),
			),
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
	// PRD-004 (ADR-0003): run the one-time, idempotent, best-effort state migrations on boot
	// BEFORE assembling the watchdog: doctor's own workspace (004a) and the fleet-shared
	// registry (004b) move from the legacy `~/.honeycomb` root to the neutral `~/.apiary` root.
	// runApiaryMigrations is TOTAL (never throws), so a migration hiccup can never block boot;
	// readers fall back to the legacy location until the new path exists. The workspace leg is
	// skipped (and logged) when DOCTOR_WORKSPACE_DIR pins the workspace explicitly.
	runApiaryMigrations({ logger: createLogger({ level: "info" }) });
	const doctor = createDoctor({ cliNoAutoUpdate });
	await doctor.start();
	// Keep `run` alive even when optional referenced handles (notably the status page)
	// fail to bind and all internal loop timers are deliberately unref'ed.
	const keepAlive = setInterval(() => undefined, 60 * 60 * 1000);
	try {
		// Block until a termination signal arrives; the service manager owns the lifecycle.
		await new Promise<void>((resolve) => {
			const stop = (): void => resolve();
			process.once("SIGTERM", stop);
			process.once("SIGINT", stop);
		});
	} finally {
		clearInterval(keepAlive);
		await doctor.stop();
	}
	return 0;
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
