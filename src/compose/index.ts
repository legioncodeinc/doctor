/**
 * The HiveDoctor composition root (PRD-064f - the production assembly).
 *
 * `createHiveDoctor()` constructs the WHOLE watchdog from the wave-built primitives and
 * returns a `{ start, stop }` handle the OS service (064b/064h) execs. It wires:
 *
 *   - the supervisor watch loop (064a) over the real probe + the remediation ladder with
 *     rungs 1/2/3 REGISTERED for production (the prior wave left rungs 2/3 as ladder slots
 *     in the supervisor path; this is where they are plugged in);
 *   - the escalation hook (064c -> 064g) wired to BOTH the local needs-attention store and
 *     the hosted PostHog sink, so a give-up reaches a human even when the daemon is down;
 *   - the auto-update poll loop (064e), respecting the resolved opt-out precedence
 *     (--no-auto-update flag > env > state > pin) computed here;
 *   - the local status page (064g) on the loopback comfort port.
 *
 * EVERYTHING is fail-soft (design principle 1, "incapable of crashing"): every external
 * action is behind an injected seam that resolves a value, the crash net is installed, and
 * `start()` never throws. `stop()` disarms every loop + closes the status page idempotently.
 *
 * The `self-update` boundary is SACRED here too: this assembly wires the auto-update engine
 * HARD-CODED to the PRIMARY daemon package (`@legioncodeinc/honeycomb`). There is no code
 * path in this composition that installs `@legioncodeinc/doctor`; that is reachable
 * ONLY through the explicit CLI `self-update` command (AC-064f.5 / parent AC-6).
 *
 * Built-ins only; all I/O behind seams so the smoke test drives the whole assembly hermetic.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";

import { createBackoff } from "../backoff.js";
import { resolveConfig, type HiveDoctorConfig } from "../config.js";
import { resolveDeviceId } from "../device-id.js";
import { defaultRegistryPath, readRegistryFile, RegistryError, type DaemonEntry } from "../registry.js";
import { probeHealth } from "../health-probe.js";
import { createPollLoop, type PollLoop } from "../ingestion/poll-loop.js";
import { handleSseRequest } from "../ingestion/sse.js";
import type { TelemetryDbReader } from "../telemetry/sqlite-reader.js";
import { createIncidentLog, type IncidentStep } from "../incidents.js";
import { createInstallLock } from "../install-lock.js";
import { createLogger, type Logger, type LogLevel } from "../logger.js";
import {
	createRemediationLadder,
	createReinstallRung,
	createRestartRung,
	createUninstallHivemindRung,
	createNpmHivemindDetector,
	createExecFileRunner,
	type CommandRunner,
	type EscalationHook,
	type RemediationLadder,
	type RestartFn,
} from "../remediation.js";
import { buildEscalationRecord } from "../rungs/escalation.js";
import { createStateStore, type StateStore } from "../state.js";
import { createSupervisor, installCrashNet, type Supervisor, type SupervisorClock } from "../supervisor.js";
import { readDaemonVersion } from "../cli/daemon-version.js";
import { resolveOptOut, type ResolvedOptOut } from "../cli/opt-out.js";
import {
	createNeedsAttentionStore,
	type NeedsAttentionFile,
	type NeedsAttentionStore,
} from "../escalation/needs-attention-store.js";
import { emitEscalationToHostedSink } from "../escalation/hosted-sink.js";
import { createLifecycleTelemetry } from "../telemetry/capture.js";
import { emitError, emitInstallHealth, type EmitDeps } from "../telemetry/emit.js";
import {
	createStatusPageServer,
	DEFAULT_STATUS_PAGE_PORT,
	type StatusJsonDaemon,
	type StatusPageHealth,
	type StatusPageServer,
} from "../status-page/server.js";
import {
	createUpdateEngine,
	createUpdatePollLoop,
	createInstalledPackageVersionReader,
	createRegistryLatestReader,
	fetchBlessedVersion,
	PRIMARY_PACKAGE,
	type BlessedChannelOptions,
	type UpdateEngine,
	type UpdatePollLoop,
} from "../update/index.js";
import { HIVEDOCTOR_VERSION } from "../version.js";
import { resolveInBase } from "../safe-path.js";

/**
 * Resolve the shared device id, with an absolute last-resort fallback. `resolveDeviceId`
 * is itself defensive and does not throw; this wrapper keeps "unknown-device" as the
 * documented sentinel ONLY for the impossible case that resolution somehow throws, so the
 * composition root never has a code path that crashes on identity resolution.
 */
function safeResolveDeviceId(): string {
	try {
		return resolveDeviceId();
	} catch {
		return "unknown-device";
	}
}

/** A real wall-clock {@link SupervisorClock} (timers + Date.now), used by both loops. */
export function createRealClock(): SupervisorClock {
	return {
		now: () => Date.now(),
		sleep: (ms: number) =>
			new Promise<void>((resolve) => {
				const t = setTimeout(resolve, ms);
				// Do not keep the event loop alive purely for a sleep timer.
				if (typeof t.unref === "function") t.unref();
			}),
	};
}

/**
 * A daemon-PID reader over the entry's own `pidPath` (PRD-004a a-AC-7). Reads the PID/lock
 * file, parses the leading integer, and returns it (or null when the file is absent/garbage).
 * Defensive by construction: any read/parse failure yields null so the restart rung's
 * lock-held-and-healthy guard simply proceeds rather than crashing the watchdog.
 */
async function defaultReadDaemonPid(pidPath: string): Promise<number | null> {
	try {
		const raw = readFileSync(pidPath, "utf8").trim();
		const pid = Number.parseInt(raw, 10);
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

/**
 * Build the honeycomb primary registry entry from the resolved {@link HiveDoctorConfig}. This
 * is the a-AC-2 fallback used when no registry file is present: it preserves the existing
 * single-daemon behavior INCLUDING any env overrides `resolveConfig` applied (the six
 * per-daemon fields), rather than dropping back to bare built-in defaults.
 */
function honeycombEntryFromConfig(config: HiveDoctorConfig): DaemonEntry {
	return {
		name: "honeycomb",
		healthUrl: config.healthUrl,
		pidPath: config.daemonPidPath,
		probeIntervalMs: config.probeIntervalMs,
		startupGraceMs: config.startupGraceMs,
		restartGiveUpThreshold: config.restartGiveUpThreshold,
		restartCooldownMs: config.restartCooldownMs,
	};
}

function toStatusPageHealth(value: string): StatusPageHealth {
	return value === "ok" || value === "degraded" || value === "unreachable" ? value : "unknown";
}

function aggregateDaemonHealth(daemons: readonly StatusJsonDaemon[]): StatusPageHealth {
	if (daemons.length === 0) return "unknown";
	// Deterministic aggregate for backward-compatible top-level `health`:
	// any unreachable -> unreachable; any degraded -> degraded; all unknown -> unknown;
	// unknown mixed with non-unknown -> degraded; otherwise all ok -> ok.
	if (daemons.some((daemon) => daemon.health === "unreachable")) return "unreachable";
	if (daemons.some((daemon) => daemon.health === "degraded")) return "degraded";
	if (daemons.every((daemon) => daemon.health === "unknown")) return "unknown";
	if (daemons.some((daemon) => daemon.health === "unknown")) return "degraded";
	return "ok";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function isRecommendedAction(
	value: unknown,
): value is
	| "investigate"
	| "reinstall-primary"
	| "uninstall-conflicting-hivemind"
	| "clear-credentials"
	| "manual-intervention" {
	return (
		value === "investigate" ||
		value === "reinstall-primary" ||
		value === "uninstall-conflicting-hivemind" ||
		value === "clear-credentials" ||
		value === "manual-intervention"
	);
}

function toIncidentStep(step: unknown): IncidentStep | null {
	if (!isRecord(step)) return null;
	const rung = typeof step.rung === "number" && Number.isInteger(step.rung) && step.rung > 0 ? step.rung : 1;
	const action = typeof step.action === "string" && step.action !== "" ? step.action : "unknown";
	const outcome =
		step.outcome === "succeeded" || step.outcome === "failed" || step.outcome === "skipped" ? step.outcome : "failed";
	const at = typeof step.at === "string" && step.at !== "" ? step.at : new Date(0).toISOString();
	const detail = typeof step.detail === "string" && step.detail !== "" ? step.detail : undefined;
	return { rung, action, outcome, at, ...(detail !== undefined ? { detail } : {}) };
}

function readPerDaemonEscalation(workspaceDir: string, daemonName: string): NeedsAttentionFile | null {
	try {
		const filePath = resolveInBase(workspaceDir, `incidents-${daemonName}.ndjson`);
		const lines = readFileSync(filePath, "utf8")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "");

		for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
			const rawLine = lines[idx];
			if (rawLine === undefined) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(rawLine);
			} catch {
				continue;
			}
			if (!isRecord(parsed)) continue;
			if (!Array.isArray(parsed.steps)) continue;

			const steps = parsed.steps.map(toIncidentStep).filter((step): step is IncidentStep => step !== null);
			const escalationStep = [...steps]
				.reverse()
				.find((step) => step.action === "escalate" || step.action === "escalate-needs-attention");
			if (escalationStep === undefined) continue;

			const recommendedAction = isRecommendedAction(escalationStep.detail)
				? escalationStep.detail
				: "manual-intervention";
			const at = typeof parsed.closedAt === "string" && parsed.closedAt !== "" ? parsed.closedAt : escalationStep.at;
			const resolved = parsed.resolved === true;

			return {
				version: 1,
				escalation: {
					diagnosis: `Escalation recorded for daemon "${daemonName}".`,
					steps,
					recommendedAction,
					at,
				},
				resolved,
				recordedAt: at,
				...(resolved ? { resolvedAt: at } : {}),
			};
		}
	} catch {
		// Missing shard or unreadable file means no known escalation for this daemon.
	}
	return null;
}

/**
 * The resolved supervised-daemon list plus any registry problem to surface (PRD-004d
 * "Failure handling"). A malformed registry does NOT throw here; see {@link resolveDaemons}.
 */
interface ResolvedDaemons {
	/** The daemons to supervise (always non-empty: the honeycomb primary is the floor). */
	readonly daemons: DaemonEntry[];
	/**
	 * A plain-language reason when the registry file was PRESENT but malformed, so the caller can
	 * log it and record a needs-attention banner. `null` when the registry loaded cleanly or was
	 * simply absent (the normal additive fallback).
	 */
	readonly registryProblem: string | null;
}

/**
 * Resolve the supervised-daemon list (PRD-004a). Precedence:
 *   1. an explicitly-injected `daemons` list (tests drive the multi-daemon path hermetically);
 *   2. the registry file at `~/.honeycomb/hivedoctor.daemons.json` (one supervisor per entry);
 *   3. when that file is ABSENT, the single honeycomb primary entry derived from `config`
 *      (a-AC-2 - the registry is additive; a missing file must not wedge the watchdog).
 *
 * A present-but-MALFORMED registry file must NOT throw (PRD-004d "Failure handling"): throwing
 * would exit `createHiveDoctor` -> `runWatchdog` exits non-zero -> the OS service unit's restart
 * policy (launchd `KeepAlive` / systemd `Restart=always`) restarts hivedoctor straight into the
 * same parse failure, i.e. a crash loop. Instead it falls back to the honeycomb primary at
 * defaults and returns a `registryProblem` the composition root surfaces (log + needs-attention).
 */
function resolveDaemons(
	options: CreateHiveDoctorOptions,
	config: HiveDoctorConfig,
	home: string,
): ResolvedDaemons {
	if (options.daemons !== undefined) return { daemons: [...options.daemons], registryProblem: null };
	try {
		const fromFile = readRegistryFile(options.registryPath ?? defaultRegistryPath(home), home);
		return { daemons: fromFile ?? [honeycombEntryFromConfig(config)], registryProblem: null };
	} catch (error) {
		// Malformed / unreadable registry (RegistryError) or any other parse failure: fall back to
		// the honeycomb primary and surface the reason rather than crash-looping the watchdog.
		const reason =
			error instanceof RegistryError || error instanceof Error ? error.message : "unknown registry parse error";
		return { daemons: [honeycombEntryFromConfig(config)], registryProblem: reason };
	}
}

/** Options for {@link createHiveDoctor}. All have production defaults; tests inject seams. */
export interface CreateHiveDoctorOptions {
	/** Resolved config (default: {@link resolveConfig} over the real env + home). */
	readonly config?: HiveDoctorConfig;
	/** The process env (for opt-out resolution). Defaults to `process.env`. */
	readonly env?: NodeJS.ProcessEnv;
	/**
	 * The supervised-daemon registry (PRD-004a). When set, hivedoctor spawns one supervisor
	 * per entry from this list (tests inject it to drive the multi-daemon path hermetically).
	 * When omitted, the registry file is read from disk, falling back to the honeycomb primary.
	 */
	readonly daemons?: readonly DaemonEntry[];
	/** Override the registry file path read when `daemons` is omitted (default: `~/.honeycomb/hivedoctor.daemons.json`). */
	readonly registryPath?: string;
	/** Home directory for the default registry path (default: `homedir()`). */
	readonly home?: string;
	/**
	 * Per-daemon PID/lock reader (PRD-004a a-AC-7). Given an entry's `pidPath`, resolves the
	 * running daemon's PID or null. Default reads the file from disk; tests inject a recorder so
	 * the restart rung's lock-held-and-healthy guard is asserted against the entry's own path.
	 */
	readonly readDaemonPid?: (pidPath: string) => Promise<number | null>;
	/** True when `--no-auto-update` was passed (the highest-precedence opt-out). */
	readonly cliNoAutoUpdate?: boolean;
	/** Logger (default: a leveled logger at `info`). */
	readonly logger?: Logger;
	/** Log level for the default logger. */
	readonly logLevel?: LogLevel;
	/** Injected clock (default: the real wall-clock). Tests inject a fake. */
	readonly clock?: SupervisorClock;
	/** The shared device id (PRD-033 UUID) stamped on telemetry + escalation. */
	readonly deviceId?: string;
	/**
	 * A static blessed version rung 2 verifies against. Normally left unset: the composition
	 * resolves the live blessed version from the blessed channel at remediation time (fail-soft).
	 * When set, it is the fallback the rung uses if the channel is unreachable/unparseable.
	 */
	readonly blessedVersion?: string;
	/**
	 * Injectable blessed-channel options (the network seam). Tests pass a recorder fetch so no
	 * real HTTP runs; production omits this and the channel hits the real CDN over global fetch.
	 */
	readonly blessedChannel?: BlessedChannelOptions;
	/** The status-page port (default {@link DEFAULT_STATUS_PAGE_PORT}). */
	readonly statusPagePort?: number;

	// ── Telemetry ingestion + SSE seams (hivedoctor PRD-001/PRD-002) ──────────────
	/**
	 * Override the telemetry poll-and-merge loop (PRD-001c). Default: the real loop
	 * (`ingestion/poll-loop.ts`) built over the resolved daemon registry, the shared
	 * probe, and the real read-only SQLite reader. Tests inject a fake loop (or override
	 * `openTelemetryDb`/`telemetryProbe` below) so nothing real polls.
	 */
	readonly pollLoop?: PollLoop;
	/** Override the telemetry DB opener the default poll loop uses (default: the real read-only `node:sqlite` reader). Tests inject a fixture/fake reader. */
	readonly openTelemetryDb?: (path: string) => TelemetryDbReader;
	/** Telemetry poll interval override, in ms (default 1000, ADR-0001 decision 2). */
	readonly telemetryPollIntervalMs?: number;

	// ── Injectable production seams (tests override these so nothing real runs) ──
	/** The restart action (064b/064h owns the real OS restart; default is a logged no-op). */
	readonly restart?: RestartFn;
	/** The command runner used by rungs 2/3 + auto-update (default: execFile, no shell). */
	readonly runner?: CommandRunner;
	/** Override the probe (default: the real node:http probe against config.healthUrl). */
	readonly probe?: () => ReturnType<typeof probeHealth>;
	/**
	 * Override the daemon-version read (default: the real node:http read against config.healthUrl).
	 * Injected so the install-health snapshot + the rungs stay hermetic in tests (no real /health).
	 */
	readonly readDaemonVersion?: () => Promise<string | null>;
	/** Override the auto-update engine (default: the real 064e engine). */
	readonly updateEngine?: UpdateEngine;
	/** Override the hosted escalation sink (default: emit through the 064d chokepoint). */
	readonly hostedEscalation?: EscalationHook;

	// ── Telemetry seams (PRD-064d -- install-health + error streams) ──────────────
	/**
	 * Injectable telemetry deps passed to the 064d chokepoint (`emitInstallHealth` /
	 * `emitError`). Tests inject `{ posthogKey, fetch }` so nothing real is posted; production
	 * omits this and the chokepoint reads the build-injected key + the global fetch. The
	 * chokepoint already honors the opt-out gates, so wiring this changes no opt-out behavior.
	 */
	readonly emitDeps?: EmitDeps;
	/**
	 * Override the install-health emitter (default: the real {@link emitInstallHealth}). Tests
	 * inject a recorder to assert the snapshot is emitted on start + on the interval.
	 */
	readonly emitInstallHealthFn?: typeof emitInstallHealth;
	/**
	 * Override the error emitter (default: the real {@link emitError}). Tests inject a recorder
	 * to assert a thrown supervisor step routes to the error stream.
	 */
	readonly emitErrorFn?: typeof emitError;
	/**
	 * Install-health emit interval in ms (default: `config.installHealthIntervalMs`, 60 min).
	 * Exposed so a test drives the interval deterministically with a fake clock.
	 */
	readonly installHealthIntervalMs?: number;
}

/** The running HiveDoctor handle the OS service execs. */
export interface HiveDoctor {
	/** Arm every loop + the status page + the crash net. Fail-soft; never throws. */
	start(): Promise<void>;
	/** Disarm every loop + close the status page + remove the crash net. Idempotent. */
	stop(): Promise<void>;
	/** The primary daemon's supervisor (exposed for the smoke test to step a tick). */
	readonly supervisor: Supervisor;
	/**
	 * Every registered daemon's supervisor loop, in registry order (PRD-004a a-AC-1). `supervisor`
	 * is `supervisors[0]` (the honeycomb primary). Exposed so a test can step each daemon's loop
	 * independently and 004b can aggregate them for the status page.
	 */
	readonly supervisors: readonly Supervisor[];
	/**
	 * Every registered daemon's remediation ladder, in registry order (PRD-004a). `ladder` is
	 * `ladders[0]` (the honeycomb primary). Exposed so a test can drive a NON-primary entry's
	 * `escalate()` directly and assert its escalation hook is isolated from the shared
	 * needs-attention store (see the isolation note on `buildEscalationHookFor` above).
	 */
	readonly ladders: readonly RemediationLadder[];
	/** The auto-update poll loop (exposed so the smoke test asserts opt-out wiring). */
	readonly pollLoop: UpdatePollLoop;
	/** The status page server (exposed so the smoke test asserts it started). */
	readonly statusPage: StatusPageServer;
	/**
	 * The telemetry poll-and-merge loop (PRD-001c) feeding the `/events` SSE stream
	 * (PRD-002a). Exposed so a test can step a tick directly, read the current
	 * fleet-telemetry snapshot, or drive `reload()` without waiting on the real interval.
	 */
	readonly telemetryPollLoop: PollLoop;
	/** The resolved opt-out (exposed so the smoke test asserts precedence). */
	readonly optOut: ResolvedOptOut;
	/** The remediation ladder (exposed so the smoke test confirms rungs 1/2/3 + escalate). */
	readonly ladder: RemediationLadder;
}

/**
 * Build the full production HiveDoctor assembly. Every collaborator is constructed here and
 * wired together; the result starts the watch loop, the auto-update poll loop, and the
 * status page, all fail-soft. Returns a handle exposing the wired pieces for the smoke test.
 */
export function createHiveDoctor(options: CreateHiveDoctorOptions = {}): HiveDoctor {
	const env = options.env ?? process.env;
	const config = options.config ?? resolveConfig(env);
	const logger = options.logger ?? createLogger({ level: options.logLevel ?? "info" });
	const clock = options.clock ?? createRealClock();
	// Resolve the SHARED per-install device id (PRD-033/064d): read ~/.honeycomb/device.json,
	// or mint+persist one in the daemon's exact shape so both processes converge on one id.
	// resolveDeviceId never throws; "unknown-device" is the absolute last-resort net only.
	const deviceId = options.deviceId ?? safeResolveDeviceId();
	const runner = options.runner ?? createExecFileRunner();

	// Process-global incident/escalation log + install lock, bound to the workspace dir. Per-daemon
	// remediation state + incident episodes live in per-entry shards built in the supervisor loop
	// below (PRD-004a a-AC-4/5/6); this shared incident log backs the process-global
	// needs-attention store (the 064g escalation surface, which stays process-level).
	const incidents = createIncidentLog({ workspaceDir: config.workspaceDir, logger });
	const installLock = createInstallLock({ workspaceDir: config.workspaceDir, logger });

	// Resolve the supervised-daemon registry (PRD-004a a-AC-1/2): one supervisor per entry, or the
	// honeycomb primary fallback when no registry file is present. The per-entry PID reader lets
	// each restart rung read its OWN pidPath (a-AC-7).
	const home = options.home ?? homedir();
	const { daemons, registryProblem } = resolveDaemons(options, config, home);
	const readDaemonPid = options.readDaemonPid ?? defaultReadDaemonPid;

	// The needs-attention store (064g) - the dashboard read seam + incident append.
	const needsAttention: NeedsAttentionStore = createNeedsAttentionStore({
		workspaceDir: config.workspaceDir,
		incidentLog: incidents,
		logger,
	});

	// PRD-004d "Failure handling": a PRESENT-but-malformed registry file did not wedge the watchdog
	// (resolveDaemons fell back to the honeycomb primary). Surface it so an operator fixes the file
	// instead of silently running degraded: a loud error log AND a needs-attention record (the
	// dashboard banner + durable incident, `escalation/needs-attention-store.ts`) recommending
	// manual intervention. Both seams are fail-soft and never throw, so surfacing the problem can
	// itself never re-wedge boot.
	if (registryProblem !== null) {
		const registryPath = options.registryPath ?? defaultRegistryPath(home);
		logger.error("registry.malformed_fallback", { registryPath, reason: registryProblem });
		needsAttention.record(
			buildEscalationRecord({
				diagnosis: `The hivedoctor daemon registry at ${registryPath} is present but malformed (${registryProblem}). hivedoctor is supervising the honeycomb primary daemon at built-in defaults until the file is fixed; any other daemons listed in the registry are NOT being supervised.`,
				steps: [],
				recommendedAction: "manual-intervention",
				now: () => clock.now(),
			}),
		);
	}

	// Probe + version reads (injected so the assembly is hermetic in tests).
	const probe = options.probe ?? (() => probeHealth({ healthUrl: config.healthUrl, timeoutMs: config.probeTimeoutMs }));
	// The RUNNING daemon's reported version (from `/health`). Used for the install-health snapshot
	// + escalation DISPLAY ("what version is running"); null when the daemon is down.
	const readInstalledVersion: () => Promise<string | null> =
		options.readDaemonVersion ??
		((): Promise<string | null> => readDaemonVersion({ healthUrl: config.healthUrl, timeoutMs: config.probeTimeoutMs }));
	// The GLOBALLY-INSTALLED package version (from `npm ls -g`). This is what the update engine
	// and the reinstall rung's post-install verify mean by "installed": it is on disk even when
	// the daemon is DOWN, so auto-update/repair can still establish a rollback target then. Tests
	// that inject `readDaemonVersion` also drive this reader by overriding the shared `runner`.
	const readInstalledPackageVersion = createInstalledPackageVersionReader({ runner, pkg: PRIMARY_PACKAGE });
	const isHealthy = async (): Promise<boolean> => (await probe()).kind === "ok";

	// Restart: 064b/064h owns the real OS restart; default to a logged no-op that reports it
	// could not act, so the give-up path still escalates rather than silently "succeeding".
	const restart: RestartFn =
		options.restart ??
		(async (): Promise<boolean> => {
			logger.warn("compose.restart_no_os_service");
			return false;
		});

	// ── The shared higher rungs (reinstall / uninstall) - honeycomb-primary scoped ────────
	// Rung 1 (restart) is built PER daemon in the supervisor loop below so each entry reads its
	// OWN pidPath + cooldown with an entry-local lastRestartAt (PRD-004a a-AC-7/a-AC-8). Rungs 2/3
	// act on the primary honeycomb package (reinstall / uninstall-conflicting-hivemind) and are
	// stateless factories, so they are built once and SHARED across every entry's ladder.
	// Resolve the blessed version from the blessed channel at remediation time, fail-soft: a
	// non-ok channel (unreachable until B-3 ships the CDN object) yields "" so the reinstall
	// rung degrades its verify gracefully and still proceeds (it never throws or blocks).
	const resolveBlessedVersion = async (): Promise<string> => {
		const result = await fetchBlessedVersion(options.blessedChannel);
		return result.ok ? result.manifest.version : "";
	};
	const reinstallRung = createReinstallRung({
		runner,
		installLock,
		blessedVersion: options.blessedVersion ?? "",
		resolveBlessedVersion,
		// Verify the reinstall against the GLOBALLY-INSTALLED package version, not `/health`: the
		// reinstall fires precisely when the daemon is sick, when `/health` cannot be trusted.
		readInstalledVersion: readInstalledPackageVersion,
	});
	const uninstallRung = createUninstallHivemindRung({
		runner,
		detectHivemind: createNpmHivemindDetector(runner),
		workspaceDir: config.workspaceDir,
	});

	// The escalation hook (064c -> 064g): record locally AND emit to the hosted sink, both
	// fail-soft. This is the give-up surface the ladder calls when it cannot heal.
	const hostedEscalation: EscalationHook =
		options.hostedEscalation ??
		(async (record): Promise<void> => {
			const daemonVersion = (await readInstalledVersion()) ?? "unknown";
			await emitEscalationToHostedSink({
				escalation: record,
				deviceId,
				hivedoctorVersion: HIVEDOCTOR_VERSION,
				daemonVersion,
				logger,
			});
		});
	// PRD-004a isolation: `needsAttention` backs a SINGLE process-global `needs-attention.json`
	// (the pre-existing honeycomb dashboard read seam, `escalation/needs-attention-store.ts`).
	// It is not sharded per-daemon. Wiring EVERY entry's ladder to a hook that writes this same
	// file would let a non-primary daemon's escalation (e.g. hivenectar giving up) silently
	// overwrite honeycomb's own escalation record - polluting honeycomb's dashboard banner AND
	// the "honeycomb" row hivedoctor's own status page reads via `needsAttention.read()` below
	// (b-AC-1/b-AC-2 require "that daemon's latest escalation", not another daemon's). Only the
	// honeycomb entry writes to the shared file; every other entry's escalation step is already
	// durably recorded in ITS OWN `incidents-<name>.ndjson` (`heal()` in supervisor.ts appends the
	// escalate step to the per-entry incident builder), which `readPerDaemonEscalation` below
	// reads back for its status-page/CLI row - no shared state, no cross-daemon contamination.
	// The hosted telemetry sink still fires for every entry regardless (useful signal either way).
	const buildEscalationHookFor = (entryName: string): EscalationHook => {
		return async (record): Promise<void> => {
			if (entryName === "honeycomb") {
				needsAttention.record(record);
			}
			await hostedEscalation(record);
		};
	};

	// ── Telemetry seams (PRD-064d): error stream + install-health stream ──────────
	// Both default to the real chokepoint helpers (which already honor the opt-out gates)
	// and both are fully fail-soft. Tests inject recorders so the wiring is asserted without
	// touching the network.
	const emitInstallHealthFn = options.emitInstallHealthFn ?? emitInstallHealth;
	const emitErrorFn = options.emitErrorFn ?? emitError;
	const emitDeps: EmitDeps = { hivedoctorVersion: HIVEDOCTOR_VERSION, ...options.emitDeps };

	// The error-telemetry seam handed to the supervisor + the crash net (AC-064d.1). Fire-and-
	// forget: we never await the emit and never let it throw into the loop. The chokepoint is
	// already fail-soft, so the void+catch here is defense in depth.
	const onError = (errorClass: string, errorDetail: string): void => {
		void emitErrorFn(
			{ errorClass, errorDetail, deviceId, timestampMs: clock.now() },
			emitDeps,
		).catch(() => {
			// emitError never rejects; this catch keeps the seam total even if a test stub does.
		});
	};

	// ── One independent supervisor per registered daemon (PRD-004a US-1/US-2/US-3) ───────
	// Each entry gets: a dedicated probe (its healthUrl), a dedicated rung-1 restart whose guards
	// read ITS pidPath + cooldown via an ENTRY-LOCAL lastRestartAt (a-AC-7/a-AC-8), a dedicated
	// backoff, a dedicated ladder (its restartGiveUpThreshold + the shared higher rungs), and
	// dedicated state-<name>.json + incidents-<name>.ndjson shards (a-AC-4/5/6). N calls to the
	// per-instance createSupervisor factory produce N fully-independent loops.
	interface BuiltDaemon {
		readonly entry: DaemonEntry;
		readonly supervisor: Supervisor;
		readonly ladder: RemediationLadder;
		readonly stateStore: StateStore;
	}
	const buildDaemon = (entry: DaemonEntry): BuiltDaemon => {
		const entryProbe: () => ReturnType<typeof probeHealth> =
			options.probe ?? (() => probeHealth({ healthUrl: entry.healthUrl, timeoutMs: config.probeTimeoutMs }));
		const entryIsHealthy = async (): Promise<boolean> => (await entryProbe()).kind === "ok";
		const entryStateStore: StateStore = createStateStore({ workspaceDir: config.workspaceDir, name: entry.name, logger });
		const entryIncidents = createIncidentLog({ workspaceDir: config.workspaceDir, name: entry.name, logger });
		// Entry-LOCAL restart timestamp: the cooldown gates only THIS entry's restarts (a-AC-8),
		// never a single process-shared clock.
		let entryLastRestartAt: number | null = null;
		const entryRestartRung = createRestartRung({
			restart,
			readDaemonPid: () => readDaemonPid(entry.pidPath),
			isHealthy: entryIsHealthy,
			cooldownMs: entry.restartCooldownMs,
			clock,
			lastRestartAt: () => entryLastRestartAt,
			markRestarted: (at: number) => {
				entryLastRestartAt = at;
			},
		});
		const entryLadder = createRemediationLadder({
			rungs: [entryRestartRung, reinstallRung, uninstallRung],
			restartGiveUpThreshold: entry.restartGiveUpThreshold,
			logger,
			escalationHook: buildEscalationHookFor(entry.name),
		});
		const entryBackoff = createBackoff({ floorMs: config.backoffFloorMs, ceilingMs: config.backoffCeilingMs });
		const entrySupervisor = createSupervisor({
			probe: entryProbe,
			ladder: entryLadder,
			backoff: entryBackoff,
			stateStore: entryStateStore,
			incidents: entryIncidents,
			logger,
			clock,
			probeIntervalMs: entry.probeIntervalMs,
			startupGraceMs: entry.startupGraceMs,
			onError,
		});
		return { entry, supervisor: entrySupervisor, ladder: entryLadder, stateStore: entryStateStore };
	};

	// The primary daemon (honeycomb, listed first) backs the process-global surfaces below: the
	// status page, the install-health snapshot, the auto-update restart re-arm, and the exposed
	// `supervisor`/`ladder`. `daemons` is non-empty (resolveDaemons guarantees it), but the
	// `?? honeycombEntryFromConfig` keeps the primary selection total for the type checker
	// (noUncheckedIndexedAccess) without an unsafe assertion.
	const primary = buildDaemon(daemons[0] ?? honeycombEntryFromConfig(config));
	const built: BuiltDaemon[] = [primary, ...daemons.slice(1).map(buildDaemon)];

	// ── Auto-update poll loop (064e), respecting the resolved opt-out precedence ───
	const optOut = resolveOptOut({
		cliNoAutoUpdate: options.cliNoAutoUpdate ?? false,
		env,
		// Wave-0 state.json has no auto-update toggle/pin fields yet; read defensively as absent.
		stateAutoUpdateDisabled: undefined,
		statePinnedVersion: undefined,
	});

	// The lifecycle capture-event emitter for the additive `hivedoctor_updated` event
	// (deduped per to_version in hivedoctor's own un-sharded state.json). distinct_id
	// prefers the shared installer id (~/.honeycomb/install-id) with the device id as
	// fallback. Gated (empty key / DO_NOT_TRACK / HONEYCOMB_TELEMETRY=0) + fail-soft, so
	// wiring it changes no opt-out behavior and can never destabilize the watchdog.
	const lifecycle = createLifecycleTelemetry({
		stateStore: createStateStore({ workspaceDir: config.workspaceDir, logger }),
		distinctId: { deviceId },
	});

	const updateEngine: UpdateEngine =
		options.updateEngine ??
		createUpdateEngine({
			runner,
			installLock,
			readLatestVersion: createRegistryLatestReader({ pkg: PRIMARY_PACKAGE }),
			// "Installed" = the globally-installed npm PACKAGE version (on disk even when the daemon
			// is down), NOT the daemon's `/health` version. This is the fix for the live bug where a
			// down daemon made auto-update bail with "installed unknown".
			readInstalledVersion: readInstalledPackageVersion,
			// Forward the restart's own success/failure so the engine's FIX-2 verify rule can tell a
			// supervised restart from a no-op one: `restart()` resolves false when there is no OS
			// service / nothing to restart, and the engine must then NOT roll back a still-unhealthy
			// /health (the update cannot make an already-down daemon worse).
			restartDaemon: async (): Promise<boolean> => {
				const restarted = await restart();
				// Auto-update targets the primary honeycomb package, so re-arm the primary supervisor's
				// startup grace on a successful restart (PRD-067) - not every entry's.
				if (restarted) primary.supervisor.armStartupGrace();
				return restarted;
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

	const pollLoop = createUpdatePollLoop({
		engine: updateEngine,
		logger,
		clock,
		autoUpdateDisabled: optOut.autoUpdateDisabled,
	});

	// ── Telemetry poll-and-merge loop (PRD-001c) + SSE producer (PRD-002a) ────────
	// Built over the SAME resolved `daemons` registry (PRD-001a) the supervisors above
	// use, so a service with a `telemetryDbPath` is polled read-only about once a second
	// and merged with its `/health` probe into the in-memory fleet model the `/events`
	// SSE stream (wired below, on the status page) forwards to the-hive. Entirely
	// independent of the supervision/remediation loops above: a telemetry fault here
	// (PRD-001c c-AC-6) can never affect restart/escalation decisions, and vice versa.
	// The injected `options.probe` seam is honored here exactly as it is for the
	// supervisors above (buildDaemon), so a test-injected probe governs telemetry
	// health too; only the default falls back to the real per-entry probeHealth.
	const injectedProbe = options.probe;
	const telemetryProbe =
		injectedProbe === undefined
			? (entry: DaemonEntry) => probeHealth({ healthUrl: entry.healthUrl, timeoutMs: config.probeTimeoutMs })
			: async () => injectedProbe();
	const telemetryPollLoop: PollLoop =
		options.pollLoop ??
		createPollLoop({
			entries: daemons,
			clock,
			logger,
			probe: telemetryProbe,
			openDb: options.openTelemetryDb,
			intervalMs: options.telemetryPollIntervalMs,
		});

	// ── Local status page (064g) on the loopback comfort port ─────────────────────
	const readDaemonStatusRows = (): StatusJsonDaemon[] =>
		built.map(({ entry, stateStore }) => {
			const state = stateStore.read();
			const escalation =
				entry.name === "honeycomb" ? needsAttention.read() : readPerDaemonEscalation(config.workspaceDir, entry.name);
			return {
				name: entry.name,
				health: toStatusPageHealth(state.lastKnownHealth),
				escalation,
			};
		});

	const statusPage = createStatusPageServer({
		port: options.statusPagePort ?? config.statusPagePort,
		state: {
			health: () => aggregateDaemonHealth(readDaemonStatusRows()),
			daemons: () => readDaemonStatusRows(),
			// Keep top-level escalation as the primary-honeycomb record for backward compatibility.
			escalation: () => needsAttention.read(),
		},
		logger,
		// PRD-002a: the single hivedoctor-to-the-hive SSE stream, mounted onto the EXISTING
		// loopback status page rather than a second listener (PRD-002 API changes note).
		onEvents: (req, res) => handleSseRequest(req, res, { pollLoop: telemetryPollLoop, logger }),
	});

	// ── Install-health snapshot loop (PRD-064d AC-064d.2) ─────────────────────────
	const installHealthIntervalMs = options.installHealthIntervalMs ?? config.installHealthIntervalMs;

	/**
	 * Emit ONE install-health snapshot through the 064d chokepoint, fail-soft. Reads the
	 * current state (last-known health + last-heal age) and the daemon version, stamps the
	 * shared device id + the HiveDoctor version, and emits. Never throws: any failure reading
	 * state/version or emitting is swallowed so a telemetry heartbeat can never wedge the loop.
	 * The opt-out gates live inside the chokepoint, so a disabled install honors opt-out here.
	 */
	async function emitInstallHealthSnapshot(): Promise<void> {
		try {
			// The install-health heartbeat reflects the primary honeycomb daemon's shard.
			const s = primary.stateStore.read();
			const nowMs = clock.now();
			// Age since last confirmed heal in SECONDS (the chokepoint buckets it), or null if never.
			const lastHealMs = s.lastHealAt !== null ? Date.parse(s.lastHealAt) : NaN;
			const lastHealAgeSeconds = Number.isFinite(lastHealMs) ? Math.max(0, Math.round((nowMs - lastHealMs) / 1000)) : null;
			const daemonVersion = (await readInstalledVersion()) ?? "unknown";
			await emitInstallHealthFn(
				{
					deviceId,
					timestampMs: nowMs,
					lastKnownHealth: s.lastKnownHealth,
					lastHealAgeSeconds,
					hivedoctorVersion: HIVEDOCTOR_VERSION,
					daemonVersion,
				},
				emitDeps,
			);
		} catch (error) {
			// Telemetry must never destabilize the watchdog (design principle 1).
			logger.warn("compose.install_health_emit_failed", {
				reason: error instanceof Error ? error.message : "unknown",
			});
		}
	}

	let installHealthStopped = false;
	let installHealthRun: Promise<void> | null = null;

	/**
	 * The periodic install-health loop: emit once immediately on arm, then every
	 * `installHealthIntervalMs` until disarmed. Driven by the SAME injected `clock` the poll
	 * loop uses so a fake clock makes it deterministic in tests. Each emit is fail-soft.
	 */
	async function runInstallHealthLoop(): Promise<void> {
		await emitInstallHealthSnapshot();
		while (!installHealthStopped) {
			await clock.sleep(installHealthIntervalMs);
			if (installHealthStopped) break;
			await emitInstallHealthSnapshot();
		}
	}

	let uninstallCrashNet: (() => void) | null = null;
	let running = false;
	// One held run-promise per supervisor loop (PRD-004a): start() arms them all, stop() joins them.
	let supervisorRuns: Promise<void>[] = [];
	let pollRun: Promise<void> | null = null;
	let telemetryPollRun: Promise<void> | null = null;

	return {
		// The exposed supervisor/ladder are the PRIMARY honeycomb daemon's (the process-global
		// smoke-test surface); every registered daemon's own loop is armed by start() below.
		supervisor: primary.supervisor,
		supervisors: built.map((b) => b.supervisor),
		pollLoop,
		telemetryPollLoop,
		statusPage,
		optOut,
		ladder: primary.ladder,
		ladders: built.map((b) => b.ladder),

		async start(): Promise<void> {
			if (running) return;
			running = true;
			// The crash net first - so anything thrown during wiring/boot is caught (parent AC-8).
			// Route a caught crash to the error stream too (PRD-064d AC-064d.1), fail-soft.
			uninstallCrashNet = installCrashNet(logger, onError);
			logger.info("compose.start", { autoUpdateDisabled: optOut.autoUpdateDisabled });

			// Status page is best-effort: a bind failure is swallowed inside start() already.
			try {
				statusPage.start();
			} catch (error) {
				logger.warn("compose.status_page_start_failed", {
					reason: error instanceof Error ? error.message : "unknown",
				});
			}

			// Arm the loops. Each loop's start() resolves only when stopped, so do NOT await them
			// here - hold the promises and let stop() resolve them. A disabled poll loop is a no-op.
			// One supervisor loop per registered daemon (PRD-004a a-AC-1).
			supervisorRuns = built.map((b) => b.supervisor.start());
			pollRun = pollLoop.start();
			// Arm the telemetry poll-and-merge loop (PRD-001c): about once per second, feeds
			// the `/events` SSE stream (PRD-002a) wired onto the status page above.
			telemetryPollRun = telemetryPollLoop.start();
			// Arm the install-health heartbeat (PRD-064d AC-064d.2): one snapshot now, then on the
			// interval. Held like the other loops; stop() disarms it. Fail-soft per emit.
			installHealthStopped = false;
			installHealthRun = runInstallHealthLoop();
			// Surface (but never rethrow) a loop that rejected unexpectedly.
			for (const run of supervisorRuns) {
				void run.catch((error: unknown) => {
					logger.error("compose.supervisor_loop_threw", {
						reason: error instanceof Error ? error.message : "unknown",
					});
				});
			}
			void pollRun.catch((error: unknown) => {
				logger.error("compose.poll_loop_threw", {
					reason: error instanceof Error ? error.message : "unknown",
				});
			});
			void telemetryPollRun.catch((error: unknown) => {
				logger.error("compose.telemetry_poll_loop_threw", {
					reason: error instanceof Error ? error.message : "unknown",
				});
			});
			void installHealthRun.catch((error: unknown) => {
				logger.error("compose.install_health_loop_threw", {
					reason: error instanceof Error ? error.message : "unknown",
				});
			});
		},

		async stop(): Promise<void> {
			if (!running) return;
			running = false;
			logger.info("compose.stop");
			// Disarm every registered daemon's supervisor loop (PRD-004a).
			for (const b of built) b.supervisor.stop();
			pollLoop.stop();
			telemetryPollLoop.stop();
			// Release every open read-only SQLite handle (PRD-001c): a stopped watchdog must
			// never keep a service's telemetry database file locked open.
			telemetryPollLoop.close();
			// Disarm the install-health heartbeat so its sleep returns and the loop exits.
			installHealthStopped = true;
			try {
				statusPage.stop();
			} catch (error) {
				logger.warn("compose.status_page_stop_failed", {
					reason: error instanceof Error ? error.message : "unknown",
				});
			}
			// Let the loops unwind their final iteration.
			try {
				await Promise.allSettled([
					...supervisorRuns,
					pollRun ?? Promise.resolve(),
					telemetryPollRun ?? Promise.resolve(),
					installHealthRun ?? Promise.resolve(),
				]);
			} catch {
				// allSettled never rejects; this catch is belt-and-suspenders.
			}
			supervisorRuns = [];
			pollRun = null;
			telemetryPollRun = null;
			installHealthRun = null;
			if (uninstallCrashNet !== null) {
				uninstallCrashNet();
				uninstallCrashNet = null;
			}
		},
	};
}
