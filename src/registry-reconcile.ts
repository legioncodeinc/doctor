/**
 * Supervisor-set reconciliation (PRD-005b).
 *
 * Given a freshly-resolved `DaemonEntry[]` from the reload trigger (005a), reconcile
 * doctor's LIVE supervisor set to match it:
 *   - **ADD** a supervisor for a newly-registered daemon (build + arm + boot-grace), so a
 *     product installed during onboarding is watched + reported without a reboot (b-AC-1);
 *   - **REMOVE** the supervisor for a deregistered daemon (stop + drop), WITHOUT killing
 *     the daemon process and WITHOUT deleting its on-disk shards (b-AC-4/b-AC-5);
 *   - **UPDATE** a supervisor whose supervision fields changed by rebuilding ONLY that one
 *     entry (its per-entry `state-<name>.json` shard persists across the rebuild, b-AC-9);
 *   - **NO-OP** an entry whose name + every field are identical (b-AC-8);
 *
 * while keeping the primary (honeycomb) designation and every process-global surface it
 * backs stable (b-AC-6/b-AC-7) and the telemetry poll loop's entry set in lockstep
 * (b-AC-2/b-AC-7). A fault building/arming/stopping ONE supervisor is swallowed + logged;
 * the rest of the reconcile still applies and doctor never crashes (b-AC-10).
 *
 * This module is the diff + orchestration ONLY. It reuses the composition root's own
 * `buildDaemon` factory (via {@link ReconcileDeps.buildDaemon}) and its arm/hold lifecycle
 * (via {@link ReconcileDeps.armDaemon}) so an added daemon is supervised IDENTICALLY to a
 * boot-time one — no new supervisor wiring is invented here. Built-ins only; no I/O of its
 * own (it never touches the filesystem, which is precisely why removal cannot delete a
 * shard or signal a process).
 */

import type { DaemonEntry } from "./registry.js";
import type { Logger } from "./logger.js";
import type { RemediationLadder } from "./remediation.js";
import type { StateStore } from "./state.js";
import type { Supervisor } from "./supervisor.js";

/**
 * One fully-wired supervised daemon — the product of the composition root's `buildDaemon`
 * factory (`src/compose/index.ts`). Hoisted here so the reconciler and the compose root
 * share one type without a circular import.
 */
export interface BuiltDaemon {
	readonly entry: DaemonEntry;
	readonly supervisor: Supervisor;
	readonly ladder: RemediationLadder;
	readonly stateStore: StateStore;
}

/** Collaborators the composition root injects into {@link reconcileSupervisors}. */
export interface ReconcileDeps {
	/** The per-entry factory (`src/compose/index.ts` `buildDaemon`); rebuilds are identical to boot. */
	readonly buildDaemon: (entry: DaemonEntry) => BuiltDaemon;
	/**
	 * Arm a freshly-built supervisor: arm its watch loop and hold the run promise for the
	 * lifecycle join. The composition root owns this because it holds the run-promise list;
	 * when doctor is not yet running it defers (the boot `start()` arms every entry in the
	 * map). The startup grace is armed by the reconciler itself, BEFORE this call.
	 */
	readonly armDaemon: (built: BuiltDaemon) => void;
	/** Logger. */
	readonly logger: Logger;
	/**
	 * Update the telemetry poll loop's polled entry set to match the reconciled supervised
	 * set (the poll loop's `reload(entries)`), so a newly-supervised daemon with a
	 * `telemetryDbPath` starts being ingested and a removed one stops — WITHOUT disturbing
	 * the in-flight `/events` SSE stream (b-AC-2/b-AC-7, parent AC-7).
	 */
	readonly updateTelemetryEntries: (entries: readonly DaemonEntry[]) => void;
	/**
	 * The HARD primary name (honeycomb). Its slot is NEVER torn down on a transient omission
	 * (b-AC-7): a reload result that omits honeycomb keeps the honeycomb supervisor so every
	 * process-global surface it backs stays bound, and honeycomb is re-adopted when it
	 * reappears. A genuine honeycomb uninstall is out of scope for a live reload (005b DEFAULT).
	 */
	readonly primaryName: string;
	/**
	 * Read the composition root's CURRENT primary {@link BuiltDaemon}. Also protected from
	 * teardown (so the primary reference the global surfaces close over is never left
	 * dangling) and re-pointed on rebuild.
	 */
	readonly getPrimary: () => BuiltDaemon;
	/**
	 * Re-point the composition root's primary reference after the primary supervisor is
	 * rebuilt in place, so the status-page top-level health/escalation, the install-health
	 * snapshot source, and the auto-update restart re-arm all follow the rebuilt primary and
	 * are never left dangling (b-AC-6).
	 */
	readonly setPrimary: (built: BuiltDaemon) => void;
}

/**
 * The seven supervision fields whose change means "rebuild this supervisor" (b-AC-9). `name`
 * is the diff key (compared separately); `telemetryDbPath` is included because a telemetry
 * path change must re-point ingestion; `escalation` is opaque pass-through and is NEVER
 * compared (005b technical considerations).
 */
function supervisionFieldsEqual(a: DaemonEntry, b: DaemonEntry): boolean {
	return (
		a.healthUrl === b.healthUrl &&
		a.pidPath === b.pidPath &&
		a.probeIntervalMs === b.probeIntervalMs &&
		a.startupGraceMs === b.startupGraceMs &&
		a.restartGiveUpThreshold === b.restartGiveUpThreshold &&
		a.restartCooldownMs === b.restartCooldownMs &&
		a.telemetryDbPath === b.telemetryDbPath
	);
}

/**
 * Reconcile the live supervisor set (`current`, keyed by name) against the freshly-resolved
 * `next` entry list, applying add / remove / update / no-op with the primary invariant + the
 * telemetry-loop update. Mutates `current` in place. Never throws (b-AC-10): a per-entry fault
 * is swallowed + logged and the rest of the reconcile still applies.
 */
export function reconcileSupervisors(
	current: Map<string, BuiltDaemon>,
	next: readonly DaemonEntry[],
	deps: ReconcileDeps,
): void {
	// Index the new list by name (first occurrence wins; resolveRegistryEntries already
	// dedupes, this is defense in depth against an injected duplicate).
	const nextByName = new Map<string, DaemonEntry>();
	for (const entry of next) {
		if (!nextByName.has(entry.name)) nextByName.set(entry.name, entry);
	}

	// The protected slot(s): the HARD primary (honeycomb) AND the composition root's current
	// primary reference. Neither is ever torn down on a transient omission (b-AC-7), and a
	// rebuild of either re-points the process-global surfaces (b-AC-6) so nothing dangles.
	const isPrimary = (name: string): boolean => name === deps.primaryName || name === deps.getPrimary().entry.name;

	let changed = false;

	// ── REMOVE: a live name absent from the new list (b-AC-4/b-AC-5) ──────────────────────
	// Iterate a snapshot copy so deleting from `current` mid-loop is safe. The primary slot is
	// NEVER removed on a transient omission (b-AC-7). Removal stops the supervisor loop ONLY —
	// it never signals the daemon process, and it never touches the entry's persisted
	// `state-<name>.json` / `incidents-<name>.ndjson` shards (this module performs no file I/O).
	for (const [name, built] of [...current]) {
		if (nextByName.has(name)) continue;
		if (isPrimary(name)) {
			deps.logger.info("registry.reconcile_primary_omission_kept", { daemon: name });
			continue;
		}
		try {
			built.supervisor.stop();
		} catch (error) {
			// b-AC-10: one supervisor's teardown fault is isolated; the rest still applies.
			deps.logger.warn("registry.reconcile_stop_threw", {
				daemon: name,
				reason: error instanceof Error ? error.message : "unknown",
			});
		}
		current.delete(name);
		changed = true;
	}

	// ── ADD / UPDATE / NO-OP ──────────────────────────────────────────────────────────────
	for (const entry of nextByName.values()) {
		const existing = current.get(entry.name);

		if (existing === undefined) {
			// ADD (b-AC-1/b-AC-2): build + arm startup grace (so the just-registered daemon is
			// not immediately escalated during its cold boot) + arm the watch loop.
			try {
				const built = deps.buildDaemon(entry);
				built.supervisor.armStartupGrace();
				deps.armDaemon(built);
				current.set(entry.name, built);
				changed = true;
			} catch (error) {
				deps.logger.warn("registry.reconcile_add_threw", {
					daemon: entry.name,
					reason: error instanceof Error ? error.message : "unknown",
				});
			}
			continue;
		}

		if (supervisionFieldsEqual(existing.entry, entry)) {
			// NO-OP (b-AC-8): name + every field identical -> leave the supervisor exactly as-is
			// (no rebuild, no re-arm, no probe reset).
			continue;
		}

		// UPDATE (b-AC-6/b-AC-9): rebuild ONLY this supervisor (stop old -> buildDaemon(new) ->
		// arm). The per-entry `state-<name>.json` shard persists (buildDaemon reads it by name),
		// so no remediation history or boot-grace accounting is lost; every other supervisor is
		// untouched. The two try blocks isolate the stop from the rebuild so a stop fault does
		// not skip the rebuild (b-AC-10).
		try {
			existing.supervisor.stop();
		} catch (error) {
			deps.logger.warn("registry.reconcile_stop_threw", {
				daemon: entry.name,
				reason: error instanceof Error ? error.message : "unknown",
			});
		}
		try {
			const rebuilt = deps.buildDaemon(entry);
			rebuilt.supervisor.armStartupGrace();
			deps.armDaemon(rebuilt);
			current.set(entry.name, rebuilt);
			changed = true;
			if (isPrimary(entry.name)) {
				// Re-point the process-global surfaces at the rebuilt primary (b-AC-6): never a
				// dangling reference to the stopped supervisor.
				deps.setPrimary(rebuilt);
			}
		} catch (error) {
			deps.logger.warn("registry.reconcile_rebuild_threw", {
				daemon: entry.name,
				reason: error instanceof Error ? error.message : "unknown",
			});
		}
	}

	// ── Telemetry coherence (b-AC-2/b-AC-7, parent AC-7) ──────────────────────────────────
	// Only touch the poll loop when the supervised set actually changed, so a pure-touch reload
	// (a changed mtime but an identical entry list) never disturbs the in-flight `/events` SSE
	// stream and never churns the ingestion runtime (parent AC-4). The poll loop's own reload()
	// drops per-entry state for daemons no longer present and reopens for new/changed ones.
	if (changed) {
		try {
			deps.updateTelemetryEntries([...current.values()].map((built) => built.entry));
		} catch (error) {
			deps.logger.warn("registry.reconcile_telemetry_update_threw", {
				reason: error instanceof Error ? error.message : "unknown",
			});
		}
	}
}
