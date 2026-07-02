/**
 * Read-only SQLite access over one service's telemetry database (doctor PRD-001b/001c,
 * ADR-0001 decision 4).
 *
 * doctor NEVER creates or writes these tables -- creation and writes are each
 * service's own job in its own repo (the pinned "Contract B" schema in the-apiary's
 * `library/ledger/EXECUTION_LEDGER.md`). This module only opens the database READ-ONLY
 * and runs windowed, schema-tolerant SELECTs against the three tables the contract
 * defines: `service_status`, `service_metrics`, `service_logs`.
 *
 * Zero external dependency: `node:sqlite` (`DatabaseSync`) only, the same built-in
 * honeycomb's local queue already relies on. Every read here is either a single-row
 * `id = 1` lookup (latest-wins status/metrics) or a windowed `id > ? LIMIT ?` scan
 * (logs), so memory stays bounded regardless of a service's total history (PRD-001c
 * c-AC-7, PRD-002c c-AC-1). `service_metrics`'s column set is intentionally NOT
 * hardcoded here (it varies per service, PRD-002b): every column except the bookkeeping
 * `id`/`updated_at` is forwarded, camelCased.
 *
 * A missing file, a lock held past the busy timeout, or a database that is not valid
 * SQLite (or is missing the expected tables) throws out of the relevant method; the
 * poll loop (`../ingestion/poll-loop.ts`) catches this PER SERVICE so one bad database
 * is isolated (PRD-001c c-AC-6) rather than wedging the loop or another service's read.
 */

import { DatabaseSync } from "node:sqlite";

import type { ServiceLogRow, ServiceMetrics, ServiceStatusRow } from "./schema.js";
import { toCamelCase } from "./schema.js";

/** Bookkeeping columns on `service_metrics` never forwarded as a generic counter (Contract B). */
const METRICS_IGNORED_COLUMNS = new Set(["id", "updated_at"]);

/** How long a read waits on a lock held by the writer before giving up (ms). WAL mode makes contention rare; this is a safety net, not the normal path. */
const BUSY_TIMEOUT_MS = 1_000;

/** A read-only handle over one service's telemetry SQLite database. */
export interface TelemetryDbReader {
	/** The latest-wins `service_status` row (`id = 1`), or `null` when the service is registered but has never checked in. */
	readStatus(): ServiceStatusRow | null;
	/** The latest-wins `service_metrics` row (`id = 1`), schema-tolerant and camelCased. `{}` when the service has never checked in. */
	readMetrics(): ServiceMetrics;
	/**
	 * A WINDOWED read of `service_logs`: only rows with `id > sinceId`, bounded to at
	 * most `limit` rows, oldest-of-the-window first. Never loads the whole log table
	 * (PRD-001c c-AC-7 / PRD-002c c-AC-1). Returns the highest `id` seen so the caller's
	 * next call can advance the cursor and never re-read the same rows.
	 */
	readNewLogs(sinceId: number, limit: number): { readonly rows: readonly ServiceLogRow[]; readonly maxId: number };
	/** Close the underlying connection. Idempotent; never throws. */
	close(): void;
}

function coerceRequiredString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function coerceNullableString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function coerceNullableBoolean(value: unknown): boolean | null {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0;
	if (typeof value === "bigint") return value !== 0n;
	return null;
}

function coerceMetricNumber(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "bigint") return Number(value);
	return null;
}

function coerceLogId(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isInteger(value)) return value;
	if (typeof value === "bigint") return Number(value);
	return fallback;
}

/**
 * Parse a raw `service_status` row into {@link ServiceStatusRow}. A row missing any
 * required text column (`name`/`binding_time`/`last_seen`/`health`) is treated as
 * "no usable status" (`null`) rather than a hard parse failure -- a partially-written
 * or schema-drifted row degrades to "unknown" upstream instead of throwing and
 * triggering this ENTIRE service's fault-isolation path over one soft field.
 */
function parseStatusRow(row: Record<string, unknown> | undefined): ServiceStatusRow | null {
	if (row === undefined) return null;
	const name = coerceRequiredString(row.name);
	const bindingTime = coerceRequiredString(row.binding_time);
	const lastSeen = coerceRequiredString(row.last_seen);
	const health = coerceRequiredString(row.health);
	if (name === null || bindingTime === null || lastSeen === null || health === null) return null;
	return {
		name,
		bindingTime,
		lastSeen,
		health,
		deeplakeConnected: coerceNullableBoolean(row.deeplake_connected),
		deeplakeLastComm: coerceNullableString(row.deeplake_last_comm),
	};
}

/** Parse a raw `service_metrics` row into a schema-tolerant, camelCased counter map (PRD-002b). */
function parseMetricsRow(row: Record<string, unknown> | undefined): ServiceMetrics {
	if (row === undefined) return {};
	const metrics: Record<string, number> = {};
	for (const [column, value] of Object.entries(row)) {
		if (METRICS_IGNORED_COLUMNS.has(column)) continue;
		const numeric = coerceMetricNumber(value);
		if (numeric === null) continue;
		metrics[toCamelCase(column)] = numeric;
	}
	return metrics;
}

/**
 * Open one service's telemetry database READ-ONLY (PRD-001b b-AC-3, ADR-0001 decision 4).
 * Throws when the file is missing, locked past the busy timeout, or not a valid SQLite
 * file -- callers (the poll loop) catch this per-entry so one bad database never wedges
 * the loop or another service's read (PRD-001c c-AC-6).
 */
export function openTelemetryDb(path: string): TelemetryDbReader {
	const db = new DatabaseSync(path, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
	let closed = false;

	return {
		readStatus(): ServiceStatusRow | null {
			const row = db.prepare("SELECT * FROM service_status WHERE id = 1 LIMIT 1").get() as
				| Record<string, unknown>
				| undefined;
			return parseStatusRow(row);
		},

		readMetrics(): ServiceMetrics {
			const row = db.prepare("SELECT * FROM service_metrics WHERE id = 1 LIMIT 1").get() as
				| Record<string, unknown>
				| undefined;
			return parseMetricsRow(row);
		},

		readNewLogs(sinceId, limit) {
			const rawRows = db
				.prepare("SELECT id, ts, level, message FROM service_logs WHERE id > ? ORDER BY id ASC LIMIT ?")
				.all(sinceId, limit) as Record<string, unknown>[];
			const rows: ServiceLogRow[] = [];
			let maxId = sinceId;
			for (const raw of rawRows) {
				const id = coerceLogId(raw.id, maxId);
				const ts = coerceRequiredString(raw.ts);
				const level = coerceRequiredString(raw.level);
				const message = coerceRequiredString(raw.message);
				if (ts === null || level === null || message === null) continue;
				rows.push({ id, ts, level, message });
				if (id > maxId) maxId = id;
			}
			return { rows, maxId };
		},

		close(): void {
			if (closed) return;
			closed = true;
			try {
				db.close();
			} catch {
				// Shutdown must never throw (design principle 1).
			}
		},
	};
}
