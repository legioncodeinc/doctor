/**
 * The CLI execution context: IO seams + injected dependencies (PRD-064f).
 *
 * Every command runs against a {@link CliContext} so the whole CLI is hermetic: stdout,
 * the confirm prompt, and every external action (probe, ladder run, npm install, version
 * reads, incident-log tail) are injected. A test captures `out`, scripts `confirm`, and
 * asserts which deps were called. The real `process.stdout` / interactive prompt / live
 * deps are wired by the entry point ({@link file://./index.ts}) and the composition root.
 *
 * AC-064f.6 falls out of this design: `status` and `diagnose` only ever call the injected
 * probe/version seams, each of which resolves a value when the daemon is down - so they
 * work with no daemon present.
 *
 * Built-ins only; this module is types + the IO surface, no I/O of its own.
 */

import type { Colors } from "./colors.js";
import type { ReadInstalledVersionFn } from "../update/update-engine.js";
import type { HealthClassification } from "../health-probe.js";
import type { LadderDecision, RemediationLadder, RungContext } from "../remediation.js";
import type { LifecycleTelemetry } from "../telemetry/capture.js";
import type { ServiceLifecycleModule, ServiceModule, ServiceResult } from "./service-stub.js";
import type { ResolvedOptOut } from "./opt-out.js";
import type { LogTailResult, TelemetrySummary } from "@legioncodeinc/cli-kit";

/** A captured line of output (text + which stream it went to). */
export interface OutputLine {
	readonly stream: "stdout" | "stderr";
	readonly text: string;
}

/** The output sink: tests capture; production writes to the real streams. */
export interface OutputSink {
	/** Write a line to stdout (a trailing newline is added by the sink). */
	out(text: string): void;
	/** Write a line to stderr (a trailing newline is added by the sink). */
	err(text: string): void;
}

/** The confirm prompt seam (gated/destructive commands). Resolves true to proceed. */
export type ConfirmFn = (question: string) => Promise<boolean>;

/**
 * The TYPED-TOKEN confirm seam (PRD-003c c-AC-1): resolves true ONLY when the operator's
 * input exactly matches `expectedToken` (a y/N reflex is too easy to blow through for a
 * credential-destroying action, per the orchestrator's confirmation-strength ruling).
 * Declared separately from {@link ConfirmFn} so `purge`'s stronger gate never weakens (or
 * is weakened by) every other command's existing y/N `confirm` seam - `realConfirm` in
 * cli/index.ts stays completely untouched.
 */
export type ConfirmTokenFn = (question: string, expectedToken: string) => Promise<boolean>;

/** How the auto-update poll loop / engine bits are exposed to the CLI `update`/`self-update`. */
export interface UpdateActions {
	/**
	 * Preview the primary-daemon update decision WITHOUT installing (`update --check`).
	 * Returns a human-readable line describing what an update would do.
	 */
	checkPrimaryUpdate(): Promise<string>;
	/** Apply the primary-daemon update through the blessed gate (`update`). */
	applyPrimaryUpdate(): Promise<string>;
	/**
	 * The ONE path that updates Doctor's own package (`self-update`, AC-064f.5).
	 * Implemented in {@link file://./self-update.ts}; injected so tests assert it is the
	 * only command that ever calls it.
	 */
	selfUpdate(): Promise<string>;
	/** Preview Doctor's own approved release without installing it. */
	readonly checkSelfUpdate?: () => Promise<string>;
}

/** Reads the recent incident-log lines for `logs`. */
export type TailIncidentsFn = (limit: number, daemonName?: string) => Promise<readonly string[]>;

/** Tail only Doctor's authoritative OS-service log. */
export type TailServiceLogsFn = (
	argv: readonly string[],
	write: (line: string) => void,
	signal?: AbortSignal,
) => Promise<LogTailResult>;

/** Snapshot of the persisted state the `status` command reports (read defensively). */
export interface StatusStateSnapshot {
	/** The last confirmed heal time (ISO-8601), or null. */
	readonly lastHealAt: string | null;
	/** The last coarse daemon health Doctor recorded. */
	readonly lastKnownHealth: string;
}

/** Reads the durable state snapshot for `status`. */
export type ReadStatusStateFn = () => StatusStateSnapshot;

/** One daemon-specific status source for `status`. */
export interface StatusDaemonSource {
	readonly name: string;
	readonly probe: () => Promise<HealthClassification>;
	readonly readDaemonVersion: ReadInstalledVersionFn;
	readonly readStatusState: ReadStatusStateFn;
}

/** Coarse Doctor service state for `status` (064b owns the real registration). */
export type ServiceState = "running" | "not-running" | "unknown";

/**
 * The deps `uninstall` (PRD-003b b-AC-2/3/4/6) needs beyond {@link ServiceModule}: a
 * read-only pre-check (b-AC-6's "nothing to remove" friendly no-op) and the actual
 * registry-entry + state-dir removal. Kept separate from `serviceModule` (which stays the
 * unchanged install/uninstall-service seam) so `uninstall-service` keeps its exact
 * pre-existing behavior while the new `uninstall` verb does the fuller three-part job.
 */
export interface ProductUninstallDeps {
	/** Does doctor currently have a registry entry, or a state dir? (b-AC-6 pre-check). */
	readonly precheck: () => { registryEntryExists: boolean; stateDirExists: boolean };
	/** The bounded async service-manager status probe (reused from `serviceStateAsync`'s wiring). */
	readonly serviceStatusAsync: () => Promise<ServiceState>;
	/**
	 * Is the service actually REGISTERED (unit-file present / a query succeeds), regardless
	 * of activity? A "not-running" {@link serviceStatusAsync} result alone cannot tell an
	 * installed-but-inactive unit apart from a genuinely absent one on every platform (most
	 * notably systemd, where `is-active` fails identically for both) - this is the stronger
	 * signal the b-AC-6 pre-check requires so it never wrongly claims a no-op. See
	 * `service/index.ts`'s `isServiceRegistered`, which this is wired to in production.
	 */
	readonly isServiceRegistered: () => Promise<boolean>;
	/** Stop + deregister + remove the unit file (delegates to `serviceModule.uninstall()`). */
	readonly serviceUninstall: () => Promise<ServiceResult>;
	/** Delete the registry entry (if any) and remove the state dir (if any). */
	readonly removeState: () => { registryEntryRemoved: boolean; stateDirRemoved: boolean };
}

/** One line of {@link PurgeReport} describing what happened to one purge target. */
export interface PurgeReport {
	/** True iff every step that found something to remove also succeeded at removing it. */
	readonly ok: boolean;
	/** True iff NOTHING was found anywhere (c-AC-6): every category was already clean. */
	readonly nothingToRemove: boolean;
	/** Human-readable step-by-step lines, in execution order, ready to print verbatim. */
	readonly lines: readonly string[];
}

/** The deps `purge` (PRD-003c) needs: the pre-confirmation summary and the actual wipe. */
export interface PurgeDeps {
	/** The lines describing exactly what WILL be destroyed (c-AC-1's pre-confirmation summary). */
	readonly summaryLines: () => readonly string[];
	/** Run the full purge (c-AC-2 .. c-AC-6). Never throws; failures are reported in the result. */
	readonly run: () => Promise<PurgeReport>;
}

/** The injected dependencies every command shares. */
export interface CliDeps {
	/** Probe + classify `/health` (returns a classification even when the daemon is down). */
	readonly probe: () => Promise<HealthClassification>;
	/** Registry-aware daemon status sources (`status` prints one block per source). */
	readonly statusDaemons: () => readonly StatusDaemonSource[];
	/** Read the daemon's reported version from `/health`, or null when unreachable. */
	readonly readDaemonVersion: ReadInstalledVersionFn;
	/** Doctor's own package version (single-sourced via src/version.ts). */
	readonly doctorVersion: string;
	/** The remediation ladder (decide + run rungs), shared with the watch loop. */
	readonly ladder: RemediationLadder;
	/** Build a rung context from a classification (logger comes from the dep wiring). */
	readonly rungContextFor: (classification: HealthClassification) => RungContext;
	/** Decide the recommended rung for the current failure count (for `diagnose`). */
	readonly decideRung: (consecutiveRestartFailures: number) => LadderDecision;
	/** Read the persisted consecutive-restart-failure count (for `diagnose` rung choice). */
	readonly readConsecutiveFailures: () => number;
	/** Read the status-state snapshot (last heal, last-known health). */
	readonly readStatusState: ReadStatusStateFn;
	/**
	 * Coarse Doctor service state - the SYNC seam, retained for the test harness. The production
	 * wiring injects the ASYNC {@link serviceStateAsync} instead; `runStatus` only falls back to this
	 * when the async probe is absent.
	 */
	readonly serviceState: () => ServiceState;
	/**
	 * The bounded ASYNC service-state probe `status` prefers (IRD-192 AC-5): wired to
	 * `serviceStatus()` (the real OS-service-manager query) in the composition root, bounded by the
	 * existing service-command timeout so `status` never blocks indefinitely. A registered task
	 * resolves to a real state, not a hardcoded "unknown". Optional: when absent, `runStatus` uses the
	 * sync {@link serviceState} seam (the test-harness default).
	 */
	readonly serviceStateAsync?: () => Promise<ServiceState>;
	/** The resolved opt-out + pin (auto-update disabled? pinned? which layer?). */
	readonly optOut: ResolvedOptOut;
	/** Update actions (primary update + the sacred self-update). */
	readonly update: UpdateActions;
	/** Tail recent incident-log lines for `logs`. */
	readonly tailIncidents: TailIncidentsFn;
	/** Canonical service-log tailer; deliberately separate from fleet incident records. */
	readonly tailServiceLogs?: TailServiceLogsFn;
	/** Doctor-owned paths used by the common status contract. */
	readonly paths?: { readonly config: string; readonly logs: string };
	/** Read-only common telemetry summary. */
	readonly telemetrySummary?: () => TelemetrySummary;
	/**
	 * The 064b service module, when wired in. When absent, `install-service`/`uninstall-service`
	 * print the "not yet available" stub message. The composition root injects the real module.
	 */
	readonly serviceModule?: ServiceModule;
	/**
	 * The `start`/`stop` lifecycle seam (PRD-003b b-AC-1), when wired in. When absent, `start`
	 * and `stop` print the same "not yet available" stub message `install-service` does.
	 */
	readonly serviceLifecycle?: ServiceLifecycleModule;
	/** Injectable bounded-poll delay; production uses a timer and tests use an immediate seam. */
	readonly lifecycleSleep?: (milliseconds: number) => Promise<void>;
	/**
	 * The full three-part `uninstall` seam (PRD-003b b-AC-2/3/4/6), when wired in. When
	 * absent, `uninstall` prints the "not yet available" stub message. `uninstall-service`
	 * is UNCHANGED and does not use this - it stays on `serviceModule.uninstall()` alone.
	 */
	readonly productUninstall?: ProductUninstallDeps;
	/**
	 * The destructive full-machine `purge` seam (PRD-003c), when wired in. When absent,
	 * `purge` prints the "not yet available" stub message rather than pretending to wipe.
	 */
	readonly purge?: PurgeDeps;
	/**
	 * The lifecycle capture-event emitter (PostHog `doctor_installed` /
	 * `doctor_uninstalled`), when wired in. Every method is gated + fail-soft and never
	 * throws; the dispatcher fires it around the service verbs. Optional so the test harness
	 * and any partial wiring stay valid (absent = no lifecycle events).
	 */
	readonly lifecycle?: LifecycleTelemetry;
}

/** Everything a command needs: IO + styling + deps. */
export interface CliContext {
	/** Output sink. */
	readonly io: OutputSink;
	/** Confirm prompt (gated commands). */
	readonly confirm: ConfirmFn;
	/**
	 * The stronger typed-token confirm prompt `purge` uses (PRD-003c c-AC-1). Optional so
	 * every existing harness/fixture that only sets `confirm` keeps compiling; `runPurge`
	 * treats an absent seam as "cannot confirm" (declines) rather than throwing.
	 */
	readonly confirmToken?: ConfirmTokenFn;
	/**
	 * Whether stdin is an interactive TTY right now (PRD-003c c-AC-1: a non-TTY stdin
	 * without `--yes` must refuse with instructions, never hang, never proceed). Optional;
	 * `runPurge` treats an absent seam as non-interactive (the safer default).
	 */
	readonly isInteractive?: () => boolean;
	/** Styling surface. */
	readonly colors: Colors;
	/** Injected dependencies. */
	readonly deps: CliDeps;
}
