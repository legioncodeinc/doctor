/**
 * Doctor durable state (`state.json`) - defensive read/write (PRD-064 data-model
 * section; PRD-064a "persist current rung + last-heal").
 *
 * `state.json` is Doctor's memory across its own restarts: the current backoff
 * rung, the consecutive-restart-failure count, the last-known daemon health, and the
 * last successful heal. Persisting it means a reboot does NOT reset a crash loop's
 * memory (064a technical consideration: "persisted across Doctor restarts so a
 * reboot does not reset a crash loop's memory").
 *
 * Both read and write are defensive (design principle 1, "incapable of crashing"):
 *   - read  - a missing file, a read-only dir, or garbage JSON yields the DEFAULT
 *             state, never a throw. A partially-valid object is hand-merged field by
 *             field over the defaults (zod-free; built-ins only).
 *   - write - mirrors the daemon's `canWriteDir` discipline: the dir is created, the
 *             write goes to a temp file then is atomically renamed, and ANY failure
 *             is swallowed-and-logged, never thrown.
 *
 * Built-ins only: node:fs + node:path + node:crypto (atomic-rename temp suffix).
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

import type { Logger } from "./logger.js";
import { resolveInBase } from "./safe-path.js";

/** The last-observed coarse daemon health Doctor recorded. */
export type LastKnownHealth = "ok" | "degraded" | "unreachable" | "unknown";

/** Doctor's durable state, persisted to `state.json`. */
export interface DoctorState {
	/** Schema version, so a later wave can migrate the file shape. */
	readonly version: 1;
	/** The last coarse daemon health Doctor observed. */
	readonly lastKnownHealth: LastKnownHealth;
	/** The current remediation rung (1 = restart). */
	readonly currentRung: number;
	/** Consecutive failed restarts at the current rung (drives the give-up-after-3 advance). */
	readonly consecutiveRestartFailures: number;
	/** The current backoff rung index (geometric step count), persisted so a reboot keeps the memory. */
	readonly backoffRung: number;
	/** ISO-8601 of the last confirmed return to healthy, or null if never. */
	readonly lastHealAt: string | null;
	/** ISO-8601 of the last restart Doctor performed, or null (drives the cooldown across restarts). */
	readonly lastRestartAt: string | null;
	/**
	 * True once the `doctor_installed` lifecycle capture event has been reported for this
	 * machine (lifecycle telemetry dedupe: re-installs never re-fire). Optional so existing
	 * state files and literals stay valid; absent means "not yet reported".
	 */
	readonly installedEventReported?: boolean;
	/**
	 * The to_version of the last `doctor_updated` lifecycle capture event reported
	 * (lifecycle telemetry dedupe: one event per target version). Optional; absent means
	 * "no update event reported yet".
	 */
	readonly updatedEventReportedVersion?: string;
}

/** The default state for a fresh box / unreadable file. */
export const DEFAULT_STATE: DoctorState = {
	version: 1,
	lastKnownHealth: "unknown",
	currentRung: 1,
	consecutiveRestartFailures: 0,
	backoffRung: 0,
	lastHealAt: null,
	lastRestartAt: null,
};

/** Options for {@link createStateStore}. */
export interface StateStoreOptions {
	/** Doctor's workspace dir; the state file is read/written under it. */
	readonly workspaceDir: string;
	/** Logger for defensive reporting of a failed write (never thrown). */
	readonly logger: Logger;
	/**
	 * Optional per-daemon shard name (PRD-004a a-AC-5). When set, state is written to
	 * `state-<name>.json` instead of the shared `state.json`, so one daemon's remediation
	 * state never cross-contaminates another's. Omitted for the legacy single-daemon store.
	 */
	readonly name?: string;
}

/** The state store: defensive read + defensive atomic write. */
export interface StateStore {
	/** Read the persisted state, or DEFAULT_STATE on any failure. Never throws. */
	read(): DoctorState;
	/** Persist `state` atomically. Swallows + logs any failure. Never throws. */
	write(state: DoctorState): void;
}

/** A coarse coercion of a known health string, defaulting to "unknown". */
function coerceHealth(value: unknown): LastKnownHealth {
	return value === "ok" || value === "degraded" || value === "unreachable" ? value : "unknown";
}

/** Coerce a finite, non-negative integer or fall back. */
function coerceCount(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

/** Coerce a positive integer (rung is 1-based) or fall back. */
function coercePositive(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Coerce a nullable ISO string (any string is accepted; a non-string becomes null). */
function coerceIso(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Hand-merge an arbitrary parsed object over {@link DEFAULT_STATE}, field by field.
 * Zod-free (built-ins only). An unrecognized or wrong-typed field is replaced by its
 * default, so a partially-corrupt file degrades gracefully to a coherent state object
 * rather than propagating garbage into the loop.
 */
export function mergeState(parsed: unknown): DoctorState {
	if (parsed === null || typeof parsed !== "object") return DEFAULT_STATE;
	const o = parsed as Record<string, unknown>;
	return {
		version: 1,
		lastKnownHealth: coerceHealth(o.lastKnownHealth),
		currentRung: coercePositive(o.currentRung, DEFAULT_STATE.currentRung),
		consecutiveRestartFailures: coerceCount(o.consecutiveRestartFailures, DEFAULT_STATE.consecutiveRestartFailures),
		backoffRung: coerceCount(o.backoffRung, DEFAULT_STATE.backoffRung),
		lastHealAt: coerceIso(o.lastHealAt),
		lastRestartAt: coerceIso(o.lastRestartAt),
		// Lifecycle capture-event dedupe markers: only well-typed values survive; anything
		// else degrades to "absent" (= not yet reported), never to garbage.
		...(o.installedEventReported === true ? { installedEventReported: true } : {}),
		...(typeof o.updatedEventReportedVersion === "string" && o.updatedEventReportedVersion !== ""
			? { updatedEventReportedVersion: o.updatedEventReportedVersion }
			: {}),
	};
}

/** The state filename for a store: `state-<name>.json` per-daemon (PRD-004a), else `state.json`. */
function stateFileName(name: string | undefined): string {
	return name !== undefined && name !== "" ? `state-${name}.json` : "state.json";
}

/** Build a state store bound to a workspace dir. */
export function createStateStore(options: StateStoreOptions): StateStore {
	const fileName = stateFileName(options.name);
	return {
		read(): DoctorState {
			try {
				// Containment: the fixed state-file name is joined under the variable workspace
				// dir and asserted to stay inside it (defense-in-depth + SAST taint visibility). A
				// containment violation throws and is caught here, degrading exactly like a read error.
				const filePath = resolveInBase(options.workspaceDir, fileName);
				const raw = readFileSync(filePath, "utf8");
				return mergeState(JSON.parse(raw));
			} catch {
				// Missing file (first run), unreadable dir, or unparseable JSON: the DEFAULT state
				// is the correct, non-throwing answer. A corrupt file must never wedge startup.
				return DEFAULT_STATE;
			}
		},

		write(state: DoctorState): void {
			let tmpPath: string | null = null;
			try {
				// Containment: the fixed state-file name is joined under the variable workspace
				// dir and asserted to stay inside it (defense-in-depth + SAST taint visibility). A
				// containment violation throws and is caught below, degrading like a write failure.
				const filePath = resolveInBase(options.workspaceDir, fileName);
				// Atomic write: serialize to a uniquely-named temp file in the same dir, then rename
				// over the target. A crash mid-write thus never leaves a half-written state.json.
				tmpPath = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
				mkdirSync(options.workspaceDir, { recursive: true });
				writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
				renameSync(tmpPath, filePath);
			} catch (error) {
				// Defensive (design principle 1): a read-only/wrong cwd must NOT crash the watchdog.
				// Best-effort cleanup of the temp file, then report + continue.
				if (tmpPath !== null) {
					try {
						rmSync(tmpPath, { force: true });
					} catch {
						// Temp cleanup is itself best-effort; a leftover .tmp is harmless and rare.
					}
				}
				options.logger.error("state.write_failed", {
					reason: error instanceof Error ? error.message : "unknown",
				});
			}
		},
	};
}
