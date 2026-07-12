/**
 * Registry live-reload trigger (PRD-005a): a bounded, mtime-gated periodic re-resolve of
 * the supervised-daemon registry.
 *
 * doctor reads its registry ONCE at boot today; a daemon registered AFTER boot (the
 * onboarding install order installs doctor first, then honeycomb + nectar) is never
 * supervised until a reboot, which deadlocks the "Bringing the fleet up green" gate. This
 * loop closes that gap WITHOUT a reboot and WITHOUT any cross-product coordination: each
 * tick cheaply `stat`s BOTH registry locations and, only when a file's mtime/existence
 * actually changed, re-runs {@link resolveRegistryEntries} and hands the fresh entry list
 * to a reconcile callback (005b).
 *
 * Design (matches honeycomb's shipped `src/daemon/storage/live-reload.ts` prior art):
 *   - **Pull, mtime-gated, not `fs.watch`.** Every product writes the registry via
 *     temp-file-plus-atomic-rename; `fs.watch` loses its target when a rename swaps the
 *     inode and is unreliable on Windows (doctor's primary platform for this bug). A
 *     periodic `statSync` on each path comparing `mtimeMs` + existence survives atomic
 *     replaces and is deterministic + cross-platform (a-AC-1/a-AC-2).
 *   - **Torn/malformed read = transient.** A CHANGED file that fails to resolve
 *     (unparseable JSON, wrong shape, {@link RegistryError}, any read error) NEVER calls
 *     the reconcile callback and NEVER advances the observed mtimes, so the next tick
 *     re-attempts the SAME file; the live supervised set is preserved (a-AC-4). Unlike
 *     boot (`src/compose/index.ts` resolveDaemons), reload NEVER falls back to the
 *     honeycomb primary — boot bootstraps the set, reload preserves it (a-AC-6).
 *   - **Can't-crash.** Every exception anywhere in the tick is swallowed with a log and
 *     the loop continues on its next tick (a-AC-9). Driven by the injected {@link
 *     SupervisorClock} so tests are deterministic with a fake clock.
 *
 * Built-ins only: `node:fs` (`statSync`) + the existing {@link resolveRegistryEntries}.
 * No external runtime dependency (parent AC-9).
 */

import { statSync } from "node:fs";

import {
	defaultRegistryPath,
	legacyRegistryPath,
	RegistryError,
	resolveRegistryEntries,
	type DaemonEntry,
} from "./registry.js";
import type { Logger } from "./logger.js";
import type { SupervisorClock } from "./supervisor.js";

/** A cheap snapshot of one registry file's presence + mtime, compared tick-to-tick. */
interface FileSnapshot {
	/** True when the file exists + could be `stat`ed this tick. */
	readonly exists: boolean;
	/** The file's `mtimeMs` (meaningless when `exists` is false; held as 0). */
	readonly mtimeMs: number;
}

/** The running reload-loop handle. */
export interface RegistryReloadLoop {
	/**
	 * Arm the loop: capture the current on-disk baseline (so an unchanged registry since
	 * boot is a strict no-op on the first tick, a-AC-2) and start ticking on the interval.
	 * Idempotent.
	 */
	arm(): void;
	/** Disarm the loop (the run promise resolves after the current sleep elapses). Idempotent (a-AC-8). */
	stop(): void;
	/**
	 * Run exactly ONE reload cycle (stat-gate -> resolve -> onEntries / onProblem). Never
	 * throws (a-AC-9). Exposed so tests can step the loop deterministically without the
	 * interval wait, mirroring the supervisor/poll-loop `tick()` convention.
	 */
	tick(): Promise<void>;
}

/** Construction deps for {@link createRegistryReloadLoop}. */
export interface RegistryReloadLoopDeps {
	/** Home dir for the two-location registry resolution (the fleet + legacy paths). */
	readonly home: string;
	/** Env the fleet-root chain reads. */
	readonly env: NodeJS.ProcessEnv;
	/** Platform the fleet-root chain reads. */
	readonly platform: NodeJS.Platform;
	/** Injected clock/scheduler so the loop is deterministic in tests. */
	readonly clock: SupervisorClock;
	/** Logger (loud on the hard path, silent on the happy path). */
	readonly logger: Logger;
	/** The re-read cadence in ms (PRD-005a a-AC-7; `config.registryReloadIntervalMs`). */
	readonly intervalMs: number;
	/**
	 * Called with the freshly-resolved entries when EITHER registry file changed and the
	 * merged result parsed. The consumer (005b's reconciler) diffs it against the live set.
	 */
	readonly onEntries: (entries: DaemonEntry[]) => void;
	/**
	 * Called when a CHANGED registry file is present but unparseable, so the composition
	 * root can record a needs-attention entry naming the offending file. Fired ONCE per
	 * distinct (path + reason) failure (a-AC-4); never on an unchanged tick.
	 */
	readonly onProblem: (reason: string, registryPath: string) => void;
	/**
	 * Called when a previously-failing file parses again, so the composition root can clear
	 * the problem banner (a-AC-5). Optional.
	 */
	readonly onRecovered?: () => void;

	// ── Test seams (default to the real node:fs + two-location resolution) ──────────
	/** Stat a file's `mtimeMs`, or null when absent/unreadable. Default: {@link statSync}. */
	readonly statMtime?: (path: string) => number | null;
	/** Resolve both registry locations. Default: {@link resolveRegistryEntries}(`{home,env,platform}`). */
	readonly resolveEntries?: () => DaemonEntry[] | null;
}

/** Default mtime probe: a file that cannot be `stat`ed is treated as absent (null), never a throw. */
function defaultStatMtime(path: string): number | null {
	try {
		return statSync(path).mtimeMs;
	} catch {
		// ENOENT (no file yet) or any other stat error -> "not present"; the gate handles it.
		return null;
	}
}

/**
 * Build the mtime-gated registry reload loop. Nothing runs until {@link RegistryReloadLoop.arm}
 * (or a manual {@link RegistryReloadLoop.tick}) is called.
 */
export function createRegistryReloadLoop(deps: RegistryReloadLoopDeps): RegistryReloadLoop {
	const statMtime = deps.statMtime ?? defaultStatMtime;
	const resolveEntries =
		deps.resolveEntries ??
		((): DaemonEntry[] | null =>
			resolveRegistryEntries({ home: deps.home, env: deps.env, platform: deps.platform }));

	// The two locations gated on every tick (a-AC-1): the fleet-shared `<root>/registry.json`
	// and the legacy `~/.honeycomb/doctor.daemons.json` (the ADR-0003 window).
	const fleetPath = defaultRegistryPath(deps.home, deps.env, deps.platform);
	const legacyPath = legacyRegistryPath(deps.home);

	function snapshot(path: string): FileSnapshot {
		const mtimeMs = statMtime(path);
		return mtimeMs === null ? { exists: false, mtimeMs: 0 } : { exists: true, mtimeMs };
	}
	function same(a: FileSnapshot, b: FileSnapshot): boolean {
		return a.exists === b.exists && a.mtimeMs === b.mtimeMs;
	}

	// Last-observed snapshots. Seeded on arm() so an unchanged registry since boot is a strict
	// no-op on the first tick (a-AC-2); NOT advanced on a parse failure (a-AC-4).
	let observedFleet: FileSnapshot = { exists: false, mtimeMs: 0 };
	let observedLegacy: FileSnapshot = { exists: false, mtimeMs: 0 };

	// Distinct-failure gate: log + record the problem ONCE per distinct (path + reason), and
	// (non-null) mark that a recovery signal is owed on the next healthy read (a-AC-4/a-AC-5).
	let lastProblemKey: string | null = null;

	let stopped = true;
	let run: Promise<void> | null = null;

	async function tick(): Promise<void> {
		try {
			const fleetSnap = snapshot(fleetPath);
			const legacySnap = snapshot(legacyPath);

			// a-AC-1/a-AC-2: neither location's mtime/existence changed -> nothing further this
			// tick (no read, no parse, no reconcile). This is the strict-idempotence fast path.
			if (same(fleetSnap, observedFleet) && same(legacySnap, observedLegacy)) {
				return;
			}

			// a-AC-3: something changed -> re-resolve both locations.
			let entries: DaemonEntry[] | null;
			try {
				entries = resolveEntries();
			} catch (error) {
				handleResolveFailure(error);
				return;
			}

			// A successful resolve: advance the observed snapshots so an unchanged next tick is a
			// strict no-op again.
			observedFleet = fleetSnap;
			observedLegacy = legacySnap;

			// a-AC-5: a previously-failing file now parses -> signal recovery so the banner clears.
			if (lastProblemKey !== null) {
				lastProblemKey = null;
				if (deps.onRecovered !== undefined) {
					try {
						deps.onRecovered();
					} catch (hookError) {
						deps.logger.warn("registry.reload_on_recovered_threw", {
							reason: hookError instanceof Error ? hookError.message : "unknown",
						});
					}
				}
			}

			// Both files absent (`null`) is NOT a malformed read: preserve the live supervised set
			// (a-AC-6, reload NEVER falls back to the honeycomb primary the way boot does) by NOT
			// calling the reconcile callback with an empty list.
			if (entries !== null) {
				deps.onEntries(entries);
			} else {
				deps.logger.info("registry.reload_absent_preserved");
			}
		} catch (error) {
			// a-AC-9: any exception ANYWHERE in the tick is swallowed with a log; the loop continues.
			deps.logger.warn("registry.reload_tick_threw", {
				reason: error instanceof Error ? error.message : "unknown",
			});
		}
	}

	/**
	 * A CHANGED-but-unparseable read (a-AC-4/a-AC-6): do NOT advance the observed mtimes (so the
	 * next tick re-attempts the SAME file), NEVER call onEntries (never tear the live set down,
	 * never fall back to the primary), and surface the problem ONCE per distinct failure.
	 */
	function handleResolveFailure(error: unknown): void {
		// RegistryError carries the path of the file that ACTUALLY failed (mid-window that may be
		// the legacy file), so the operator-facing banner names the right file.
		const registryPath =
			error instanceof RegistryError && error.registryPath !== undefined ? error.registryPath : fleetPath;
		const reason = error instanceof Error ? error.message : "unknown registry parse error";
		const key = `${registryPath}::${reason}`;
		if (key === lastProblemKey) return; // already logged + recorded this exact failure
		lastProblemKey = key;
		deps.logger.error("registry.reload_malformed", { registryPath, reason });
		try {
			deps.onProblem(reason, registryPath);
		} catch (hookError) {
			deps.logger.warn("registry.reload_on_problem_threw", {
				reason: hookError instanceof Error ? hookError.message : "unknown",
			});
		}
	}

	async function loop(): Promise<void> {
		while (!stopped) {
			await deps.clock.sleep(deps.intervalMs);
			if (stopped) break;
			await tick();
		}
	}

	return {
		arm(): void {
			if (!stopped) return; // idempotent: already armed
			stopped = false;
			// Capture the current on-disk state as the baseline so an unchanged registry since boot
			// is a strict no-op on the first tick (a-AC-2).
			observedFleet = snapshot(fleetPath);
			observedLegacy = snapshot(legacyPath);
			run = loop();
			void run.catch((error: unknown) => {
				// The loop is total (tick swallows all); this is defense in depth for the promise itself.
				deps.logger.error("registry.reload_loop_threw", {
					reason: error instanceof Error ? error.message : "unknown",
				});
			});
		},
		stop(): void {
			stopped = true; // idempotent (a-AC-8)
		},
		tick,
	};
}
