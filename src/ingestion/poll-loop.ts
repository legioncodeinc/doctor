/**
 * The roughly one-second poll-and-merge loop (doctor PRD-001c; ADR-0001 decision 2,
 * ADR-0002 decision 3).
 *
 * This is the puller half of ADR-0001: about once per second, for every registered
 * service (PRD-001a `DaemonEntry`), it probes `/health` (`../health-probe.js`) and, when
 * the entry carries a `telemetryDbPath`, opens that service's SQLite database READ-ONLY
 * (`../telemetry/sqlite-reader.js`) and runs windowed queries. Both results are merged
 * into one in-memory {@link FleetTelemetryEvent} -- the single source of truth the SSE
 * producer (`./sse.js`) streams to hive.
 *
 * Fail-soft and crash-proof by construction (design principle 1):
 *   - a probe failure classifies as `unreachable` rather than throwing (mirrors
 *     `health-probe.ts`'s own total mapping; a defensive re-catch here covers even an
 *     injected test seam that throws);
 *   - one service's missing/locked/malformed telemetry DB is isolated to THAT service
 *     (PRD-001c c-AC-6): it is skipped this tick, degrades to its probe-only signal plus
 *     whatever was last known, and is flagged `telemetryFault`; every other service keeps
 *     polling normally;
 *   - memory stays bounded because every SQLite read is either a single-row lookup or a
 *     windowed `id > cursor LIMIT n` scan (PRD-001c c-AC-7, PRD-002c c-AC-1), and each
 *     tick's `logs` carries only the rows written since the PREVIOUS tick, not history
 *     (PRD-002c c-AC-2).
 *
 * Zero external dependency: builds only on `../health-probe.js` (node:http) and
 * `../telemetry/sqlite-reader.js` (node:sqlite) (PRD-001c c-AC-8).
 */

import type { DaemonEntry } from "../registry.js";
import { probeHealth, type HealthClassification } from "../health-probe.js";
import type { Logger } from "../logger.js";
import type {
	FleetHealth,
	FleetLogEntry,
	FleetServiceModel,
	FleetTelemetryEvent,
	ServiceMetrics,
	ServiceStatusRow,
	TelemetryFaultReason,
} from "../telemetry/schema.js";
import { openTelemetryDb, type TelemetryDbReader } from "../telemetry/sqlite-reader.js";

/** Clock seam (mirrors `SupervisorClock`) so the loop is deterministic in tests. */
export interface PollLoopClock {
	now(): number;
	sleep(ms: number): Promise<void>;
}

/** Injectable seams for {@link createPollLoop}. Tests override the prober/DB-opener so nothing real runs. */
export interface PollLoopOptions {
	/** The registered daemons to poll (PRD-001a). Call {@link PollLoop.reload} to change this set later without rebuilding the loop (PRD-001c c-AC-5). */
	readonly entries: readonly DaemonEntry[];
	readonly clock: PollLoopClock;
	readonly logger: Logger;
	/** Probe one entry's `/health` (default: the real {@link probeHealth} against `entry.healthUrl`). */
	readonly probe?: (entry: DaemonEntry) => Promise<HealthClassification>;
	/** Open one entry's telemetry DB read-only (default: the real {@link openTelemetryDb}). Tests inject a fixture/fake opener. */
	readonly openDb?: (path: string) => TelemetryDbReader;
	/** Probe timeout in ms, used only by the default probe (default 2000). */
	readonly probeTimeoutMs?: number;
	/** Poll interval in ms (default 1000, ADR-0001 decision 2: "about once per second"). */
	readonly intervalMs?: number;
	/** Max NEW log rows forwarded per service per tick (a bounded slice, PRD-002c c-AC-2). Default 200. */
	readonly logWindowLimit?: number;
	/** A service is "stale" (missed check-ins) once its `last_seen` is this many ms old. Default: 3x the entry's own `probeIntervalMs`. */
	readonly staleAfterMs?: (entry: DaemonEntry) => number;
}

/** The running poll-and-merge loop handle. */
export interface PollLoop {
	/** Run the loop until `stop()`. Resolves once stopped. Never throws (design principle 1). */
	start(): Promise<void>;
	/** Disarm the loop; the `start()` promise resolves after the current sleep elapses. Idempotent. */
	stop(): void;
	/** Run exactly ONE poll-and-merge cycle and return the resulting snapshot. */
	tick(): Promise<FleetTelemetryEvent>;
	/** The most recent merged snapshot (the in-memory source of truth), without polling again. */
	snapshot(): FleetTelemetryEvent;
	/**
	 * Replace the registered-daemon set the loop polls (PRD-001a/001c reload trigger:
	 * boot, restart, or an explicit (de)registration). Drops per-entry runtime state
	 * (the log cursor, the open DB handle) for daemons no longer present; state for a
	 * daemon that persists across the reload survives untouched.
	 */
	reload(entries: readonly DaemonEntry[]): void;
	/** Subscribe to every snapshot the loop produces (the SSE producer's feed, `./sse.js`). Returns an unsubscribe function. */
	onSnapshot(listener: (event: FleetTelemetryEvent) => void): () => void;
	/**
	 * Close every currently-held telemetry DB handle without changing the polled entry
	 * set (unlike `reload([])`, which also clears it). Equivalent to `reload(entries)`'s
	 * handle-closing side effect alone; primarily a clean-shutdown / test-teardown hook so
	 * a stopped loop never holds a SQLite file open.
	 */
	close(): void;
}

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_LOG_WINDOW_LIMIT = 200;
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
/** A service is considered to have "missed check-ins" once its last-seen is this many poll intervals old. */
const DEFAULT_STALE_MULTIPLIER = 3;

/** Per-entry state carried ACROSS ticks: the open DB handle, the log-read cursor, and the last known good reading (for graceful degradation on a fault). */
interface EntryRuntime {
	db: TelemetryDbReader | null;
	lastLogId: number;
	lastKnownStatus: ServiceStatusRow | null;
	lastKnownMetrics: ServiceMetrics;
}

/** Map a `/health` probe classification onto the coarse fleet-visible vocabulary. */
function classifyProbe(classification: HealthClassification): FleetHealth {
	if (classification.kind === "ok") return "ok";
	if (classification.kind === "degraded") return "degraded";
	return "unreachable";
}

/** Heuristically classify a caught SQLite error for logging (PRD-001c c-AC-6); the isolation behavior itself does not depend on getting this exactly right. */
function classifyDbFault(error: unknown): TelemetryFaultReason {
	const message = error instanceof Error ? error.message.toLowerCase() : "";
	if (message.includes("unable to open") || message.includes("no such file") || message.includes("enoent")) {
		return "missing";
	}
	if (message.includes("locked") || message.includes("busy")) return "locked";
	if (message.includes("no such table") || message.includes("not a database") || message.includes("malformed")) {
		return "malformed";
	}
	return "read-error";
}

/** Build the poll-and-merge loop. Nothing runs until `start()` (or a manual `tick()`) is called. */
export function createPollLoop(options: PollLoopOptions): PollLoop {
	const { clock, logger } = options;
	const probe = options.probe ?? ((entry: DaemonEntry) => probeHealth({ healthUrl: entry.healthUrl, timeoutMs: options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS }));
	const openDb = options.openDb ?? openTelemetryDb;
	const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
	const logWindowLimit = options.logWindowLimit ?? DEFAULT_LOG_WINDOW_LIMIT;
	const staleAfterMs = options.staleAfterMs ?? ((entry: DaemonEntry): number => entry.probeIntervalMs * DEFAULT_STALE_MULTIPLIER);

	let entries: readonly DaemonEntry[] = options.entries;
	const runtime = new Map<string, EntryRuntime>();
	let latest: FleetTelemetryEvent = { asOf: new Date(clock.now()).toISOString(), services: [], logs: [] };
	const listeners = new Set<(event: FleetTelemetryEvent) => void>();
	let stopped = true;

	function runtimeFor(name: string): EntryRuntime {
		let r = runtime.get(name);
		if (r === undefined) {
			r = { db: null, lastLogId: 0, lastKnownStatus: null, lastKnownMetrics: {} };
			runtime.set(name, r);
		}
		return r;
	}

	function closeHandle(r: EntryRuntime): void {
		if (r.db === null) return;
		try {
			r.db.close();
		} catch {
			// Shutdown must never throw (design principle 1).
		}
		r.db = null;
	}

	/** Poll one entry: probe `/health`, and when it carries a telemetry DB, merge in its runtime status/metrics/logs. Never throws. */
	async function pollEntry(entry: DaemonEntry, logsOut: FleetLogEntry[]): Promise<FleetServiceModel> {
		const r = runtimeFor(entry.name);

		let classification: HealthClassification;
		try {
			classification = await probe(entry);
		} catch (error) {
			// probeHealth itself never throws by contract; this re-catch is defense in depth
			// against a test/production seam override that does, so ONE entry's probe seam
			// misbehaving can never take down the whole tick.
			logger.warn("poll-loop.probe_threw", { daemon: entry.name, reason: error instanceof Error ? error.message : "unknown" });
			classification = { kind: "unreachable-refused", detail: "probe_threw" };
		}
		const probeHealthState = classifyProbe(classification);

		if (entry.telemetryDbPath === undefined) {
			// a-AC-2 / c-AC-1 scope: health-probe-only, no SQLite ingestion for this entry.
			return { name: entry.name, health: probeHealthState, lastSeen: null, metrics: {}, deeplake: null, telemetryFault: null };
		}

		try {
			if (r.db === null) r.db = openDb(entry.telemetryDbPath);
			const status = r.db.readStatus();
			if (status !== null && status.name !== entry.name) {
				// `ServiceStatusRow.name` is the contract key back to the registry entry
				// (PRD-001b b-AC-5). A DB whose own recorded name does not match this entry
				// is treated as MALFORMED, not attributed: a mispointed telemetryDbPath must
				// never cross-wire one service's status/metrics/logs onto another. Throwing
				// here routes through the c-AC-6 isolation path below (close + drop the
				// handle, degrade to probe-only, flag telemetryFault) BEFORE any row from
				// this DB is cached or forwarded.
				throw new Error(
					`malformed telemetry db: service_status.name "${status.name}" does not match registry entry "${entry.name}"`,
				);
			}
			const metrics = r.db.readMetrics();
			const { rows, maxId } = r.db.readNewLogs(r.lastLogId, logWindowLimit);
			r.lastLogId = maxId;
			for (const row of rows) logsOut.push({ service: entry.name, ts: row.ts, level: row.level, message: row.message });

			r.lastKnownStatus = status;
			r.lastKnownMetrics = metrics;

			if (status === null) {
				// Registered but never checked in (Contract C: "registered-but-silent -> unknown").
				return { name: entry.name, health: "unknown", lastSeen: null, metrics, deeplake: null, telemetryFault: null };
			}

			const lastSeenMs = Date.parse(status.lastSeen);
			const isStale = Number.isFinite(lastSeenMs) ? clock.now() - lastSeenMs > staleAfterMs(entry) : true;

			// c-AC-4: "disconnect" = missed check-ins (a stale last-seen) together with a
			// failing /health probe. The static entry is NEVER dropped; last-seen simply stops
			// advancing, which IS the recorded disconnect signal (ADR-0002 decision 3) -- there
			// is no separate "disconnectedAt" field to maintain.
			let health: FleetHealth;
			if (probeHealthState === "unreachable") {
				health = "unreachable";
			} else if (probeHealthState === "degraded") {
				health = "degraded";
			} else if (isStale) {
				// /health still answers ok, but the service stopped checking in to its own
				// telemetry DB: a real (if unusual) signal worth surfacing rather than
				// reporting a stale "ok".
				health = "degraded";
			} else {
				health = "ok";
			}

			return {
				name: entry.name,
				health,
				lastSeen: status.lastSeen,
				metrics,
				deeplake: { connected: status.deeplakeConnected, lastCommunicationAt: status.deeplakeLastComm },
				telemetryFault: null,
			};
		} catch (error) {
			// c-AC-6: isolate the fault to THIS entry. Close + drop the handle so the next
			// tick retries opening fresh (recovers from a transient lock or a rewritten file)
			// instead of holding a handle onto a now-invalid connection forever.
			closeHandle(r);
			const reason = classifyDbFault(error);
			logger.warn("poll-loop.telemetry_db_fault", {
				daemon: entry.name,
				reason,
				detail: error instanceof Error ? error.message : "unknown",
			});
			// A healthy `/health` probe is AUTHORITATIVE about the service's coarse liveness:
			// when the process answers ok, an unreadable/missing telemetry DB is a TELEMETRY
			// fault, not a service fault. Forcing `health` to "degraded" here was the live bug
			// that made hive render a perfectly healthy service as sick just because doctor
			// could not open its telemetry sidecar DB. So when the probe is ok, the coarse
			// `health` reflects that ok, and the missing-telemetry condition stays visible ONLY
			// through `telemetryFault`; metrics/deeplake are left null because we have no
			// trustworthy telemetry to report this tick (the DB is precisely what is unreadable).
			if (probeHealthState === "ok") {
				return {
					name: entry.name,
					health: "ok",
					lastSeen: r.lastKnownStatus?.lastSeen ?? null,
					metrics: {},
					deeplake: null,
					telemetryFault: reason,
				};
			}

			// A FAILING probe (degraded/unreachable): the service itself is unhealthy, so carry
			// the probe signal through unchanged (never regressing the disconnect/wedged signals)
			// and degrade to whatever telemetry was last known rather than dropping the service
			// from the model entirely -- the static entry (and its last observed state) is
			// retained even while its DB is unavailable.
			return {
				name: entry.name,
				health: probeHealthState,
				lastSeen: r.lastKnownStatus?.lastSeen ?? null,
				metrics: r.lastKnownMetrics,
				deeplake:
					r.lastKnownStatus === null
						? null
						: { connected: r.lastKnownStatus.deeplakeConnected, lastCommunicationAt: r.lastKnownStatus.deeplakeLastComm },
				telemetryFault: reason,
			};
		}
	}

	async function runTick(): Promise<FleetTelemetryEvent> {
		const logs: FleetLogEntry[] = [];
		// Each entry is polled independently (its own try/catch inside pollEntry); Promise.all
		// here is safe because pollEntry itself never rejects.
		const services = await Promise.all(entries.map((entry) => pollEntry(entry, logs)));
		const event: FleetTelemetryEvent = { asOf: new Date(clock.now()).toISOString(), services, logs };
		latest = event;
		for (const listener of listeners) {
			try {
				listener(event);
			} catch (error) {
				// A misbehaving subscriber (e.g. one SSE consumer's write path) must never
				// affect the loop itself or any other subscriber (PRD-002a a-AC-6/PRD-002 AC-6).
				logger.warn("poll-loop.listener_threw", { reason: error instanceof Error ? error.message : "unknown" });
			}
		}
		return event;
	}

	return {
		async start(): Promise<void> {
			if (!stopped) return;
			stopped = false;
			while (!stopped) {
				await runTick();
				if (stopped) break;
				await clock.sleep(intervalMs);
			}
		},

		stop(): void {
			stopped = true;
		},

		tick: runTick,

		snapshot: (): FleetTelemetryEvent => latest,

		reload(nextEntries: readonly DaemonEntry[]): void {
			// Evict runtime state for daemons no longer present, AND for a same-name daemon
			// whose telemetryDbPath changed or disappeared: pollEntry reopens only when the
			// cached handle is null, so keeping the runtime would keep reading the OLD file,
			// and its stale lastLogId could skip the start of the new DB entirely. Dropping
			// the runtime closes the old handle and resets the cursor so the next tick
			// reopens the new path fresh.
			const previousPaths = new Map(entries.map((entry) => [entry.name, entry.telemetryDbPath]));
			const nextPaths = new Map(nextEntries.map((entry) => [entry.name, entry.telemetryDbPath]));
			entries = nextEntries;
			for (const [name, r] of runtime) {
				if (!nextPaths.has(name) || nextPaths.get(name) !== previousPaths.get(name)) {
					closeHandle(r);
					runtime.delete(name);
				}
			}
			logger.info("poll-loop.reloaded", { daemonCount: nextEntries.length });
		},

		onSnapshot(listener: (event: FleetTelemetryEvent) => void): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},

		close(): void {
			for (const r of runtime.values()) closeHandle(r);
			runtime.clear();
		},
	};
}
