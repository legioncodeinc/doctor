/**
 * Shared telemetry row shapes and fleet event types (hivedoctor PRD-001b/002a/002b).
 *
 * hivedoctor is a READER ONLY: it never creates or writes any of these tables. Creation
 * and writes are each SERVICE's own job in its own repo (ADR-0001 decision 1, ADR-0002
 * decision 2; the pinned "Contract B" in the-apiary's
 * `library/ledger/EXECUTION_LEDGER.md`). This module defines:
 *
 *   - the row shapes {@link ServiceStatusRow}/{@link ServiceLogRow} the poll loop
 *     (`../ingestion/poll-loop.ts`) parses out of each service's read-only SQLite handle
 *     (via `./sqlite-reader.ts`), and
 *   - the fleet-wide model/event shapes ({@link FleetServiceModel}/{@link FleetTelemetryEvent})
 *     the SSE producer (`../ingestion/sse.ts`) emits to the-hive (Contract C).
 *
 * `service_metrics` column sets VARY per service (honeycomb ships 3 counters, hivenectar
 * 5); this module -- and every reader built on it -- is deliberately schema-tolerant: it
 * never hardcodes a fixed counter list, only the bookkeeping columns to exclude
 * (`id`/`updated_at`, see `sqlite-reader.ts`).
 */

/** Coarse fleet-visible health for one service, matching the status-page's existing vocabulary. */
export type FleetHealth = "ok" | "degraded" | "unreachable" | "unknown";

/**
 * One `service_status` row, as written by a service on check-in (PRD-001b b-AC-1). The
 * `health` column is the service's own self-reported value (PRD-001b: "sourced from the
 * same signal the service's own `/health` reports"); hivedoctor does not recompute it,
 * it only merges it with its OWN `/health` probe result (PRD-001c c-AC-2/c-AC-3).
 */
export interface ServiceStatusRow {
	/** The service identity; ties this row back to its static registry entry by `name` (PRD-001b b-AC-5). */
	readonly name: string;
	/** ISO-8601, set once when the service bound its port/socket for the current run. */
	readonly bindingTime: string;
	/** ISO-8601, updated on every check-in/heartbeat. */
	readonly lastSeen: string;
	/** The service's self-reported health at check-in (free-form; not hivedoctor's own probe classification). */
	readonly health: string;
	/** Whether the service's Deep Lake connection is alive, or `null` when not reported. */
	readonly deeplakeConnected: boolean | null;
	/** ISO-8601 of the last successful Deep Lake communication, or `null`. */
	readonly deeplakeLastComm: string | null;
}

/**
 * A schema-tolerant metrics snapshot: every `service_metrics` column except the
 * bookkeeping `id`/`updated_at`, camelCased (PRD-002b). Never a fixed shape -- honeycomb
 * and hivenectar ship different counter sets on the same table name.
 */
export type ServiceMetrics = Readonly<Record<string, number>>;

/** One `service_logs` row (PRD-002b b-AC-2: timestamp, verbosity level, message). */
export interface ServiceLogRow {
	readonly id: number;
	readonly ts: string;
	readonly level: string;
	readonly message: string;
}

/** Why a service's telemetry read was skipped this tick (PRD-001c c-AC-6 fault isolation). */
export type TelemetryFaultReason = "missing" | "locked" | "malformed" | "read-error";

/** Deep Lake connection/stats fields carried on the fleet model (PRD-002 AC-4, PRD-002b b-AC-3). */
export interface FleetDeeplakeStats {
	readonly connected: boolean | null;
	readonly lastCommunicationAt: string | null;
}

/**
 * One service's merged fleet-model row: the static "should exist" registry entry plus
 * its live runtime status and `/health` probe result, as one authoritative record
 * (PRD-001c c-AC-3). A never-registered service simply never appears in
 * {@link FleetTelemetryEvent.services}; a registered-but-silent one appears here with
 * `health: "unknown"` (Contract C).
 */
export interface FleetServiceModel {
	readonly name: string;
	readonly health: FleetHealth;
	/** ISO-8601 of the last confirmed check-in, or `null` when never seen. Stops advancing on disconnect (PRD-001c c-AC-4) rather than being cleared. */
	readonly lastSeen: string | null;
	readonly metrics: ServiceMetrics;
	/** `null` when the service has no telemetry DB, or has one but never checked in. */
	readonly deeplake: FleetDeeplakeStats | null;
	/** Non-null when this service's telemetry DB was skipped THIS tick (missing/locked/malformed), isolated from the rest of the fleet (PRD-001c c-AC-6). */
	readonly telemetryFault: TelemetryFaultReason | null;
}

/** One forwarded log line, tagged with its originating service (Contract C). */
export interface FleetLogEntry {
	readonly service: string;
	readonly ts: string;
	readonly level: string;
	readonly message: string;
}

/**
 * The single `fleet-telemetry` SSE event payload (Contract C, PRD-002a). `logs` is a
 * BOUNDED SLICE of only the new rows since the previous tick (PRD-002c c-AC-2), never a
 * full history, so both hivedoctor and the portal stay memory-bounded regardless of how
 * much a service has logged in total.
 */
export interface FleetTelemetryEvent {
	readonly asOf: string;
	readonly services: readonly FleetServiceModel[];
	readonly logs: readonly FleetLogEntry[];
}

/** Convert a `snake_case` SQL column name to `camelCase` (PRD-002b generic metrics passthrough). */
export function toCamelCase(column: string): string {
	return column.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
}
