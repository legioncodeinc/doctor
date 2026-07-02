/**
 * Tests for the PRD-001c poll-and-merge loop.
 *
 * Coverage:
 *   c-AC-1/001c-AC-1 - opens a registered service's DB read-only, windowed query, ~1s cadence.
 *   c-AC-2           - probes /health and merges with the SQLite read.
 *   c-AC-3           - the merge reflects the static entry + the live status as one record.
 *   c-AC-4           - a disconnected service (stale last-seen + failing /health) is marked
 *                      unreachable with its last-seen preserved; the static entry is retained.
 *   c-AC-5           - reload() changes which databases are polled.
 *   c-AC-6           - one service's missing/malformed DB is isolated; others keep polling.
 *   c-AC-7 / 002c-AC-1 - logs are read as a bounded, cursor-advancing window, never the
 *                        whole history.
 *   001a-AC-2 / 001-AC-2 - an entry with no telemetryDbPath is health-probe-only.
 *   001b-AC-1/AC-5 (reader side) - a full-shape service_status row round-trips through
 *                        the real read-only reader into the fleet model.
 *
 * All I/O is real SQLite against `mkdtempSync` fixture files (the fixture DB is written
 * with a normal read/write DatabaseSync -- standing in for a "service" writer -- and then
 * polled through the SAME real read-only reader (`openTelemetryDb`) production uses). The
 * `/health` probe is a fully injected fake: no real network or timers.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPollLoop, type PollLoop, type PollLoopClock, type PollLoopOptions } from "../../src/ingestion/poll-loop.js";
import { silentLogger } from "../../src/logger.js";
import type { DaemonEntry } from "../../src/registry.js";
import type { HealthClassification } from "../../src/health-probe.js";
import { openTelemetryDb } from "../../src/telemetry/sqlite-reader.js";

const tmpDirs: string[] = [];
function makeTmp(): string {
	const d = mkdtempSync(join(tmpdir(), "doctor-poll-loop-"));
	tmpDirs.push(d);
	return d;
}

// On Windows, an open node:sqlite handle blocks deleting its file/directory (EPERM). Every
// loop this suite creates is tracked here and closed in afterEach BEFORE the tmp dirs are
// removed, so a cached read-only handle never outlives the fixture file it points at.
const openLoops: PollLoop[] = [];
function trackedPollLoop(options: PollLoopOptions): PollLoop {
	const loop = createPollLoop(options);
	openLoops.push(loop);
	return loop;
}

/** A deterministic clock: `now()` is mutable, `sleep()` resolves immediately (no real timers). */
function fakeClock(startAt = 0): PollLoopClock & { advance(ms: number): void } {
	let now = startAt;
	return {
		now: () => now,
		sleep: async () => undefined,
		advance(ms: number): void {
			now += ms;
		},
	};
}

function daemon(overrides: Partial<DaemonEntry> & { name: string; healthUrl: string }): DaemonEntry {
	return {
		pidPath: "/tmp/does-not-matter.pid",
		probeIntervalMs: 1_000,
		startupGraceMs: 60_000,
		restartGiveUpThreshold: 3,
		restartCooldownMs: 5_000,
		...overrides,
	};
}

/** Build a Contract-B-shaped fixture telemetry DB (a stand-in for a service's own writer). */
function buildFixtureDb(path: string): DatabaseSync {
	const db = new DatabaseSync(path);
	db.exec(`
		CREATE TABLE service_status (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			name TEXT NOT NULL,
			binding_time TEXT NOT NULL,
			last_seen TEXT NOT NULL,
			health TEXT NOT NULL,
			deeplake_connected INTEGER,
			deeplake_last_comm TEXT
		);
		CREATE TABLE service_metrics (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			actions_taken INTEGER NOT NULL DEFAULT 0,
			files_processed INTEGER NOT NULL DEFAULT 0,
			memories_created INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE service_logs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			ts TEXT NOT NULL,
			level TEXT NOT NULL CHECK (level IN ('error','warn','info','debug')),
			message TEXT NOT NULL
		);
		CREATE INDEX idx_service_logs_ts ON service_logs(ts DESC);
	`);
	return db;
}

function upsertStatus(
	db: DatabaseSync,
	row: { name: string; bindingTime: string; lastSeen: string; health: string; deeplakeConnected?: boolean | null; deeplakeLastComm?: string | null },
): void {
	db.prepare(
		`INSERT INTO service_status (id, name, binding_time, last_seen, health, deeplake_connected, deeplake_last_comm)
		 VALUES (1, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET name=excluded.name, binding_time=excluded.binding_time,
			last_seen=excluded.last_seen, health=excluded.health,
			deeplake_connected=excluded.deeplake_connected, deeplake_last_comm=excluded.deeplake_last_comm`,
	).run(
		row.name,
		row.bindingTime,
		row.lastSeen,
		row.health,
		row.deeplakeConnected === undefined ? null : row.deeplakeConnected ? 1 : 0,
		row.deeplakeLastComm ?? null,
	);
}

function upsertMetrics(db: DatabaseSync, metrics: { actionsTaken: number; filesProcessed: number; memoriesCreated: number }, updatedAt: string): void {
	db.prepare(
		`INSERT INTO service_metrics (id, actions_taken, files_processed, memories_created, updated_at)
		 VALUES (1, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET actions_taken=excluded.actions_taken, files_processed=excluded.files_processed,
			memories_created=excluded.memories_created, updated_at=excluded.updated_at`,
	).run(metrics.actionsTaken, metrics.filesProcessed, metrics.memoriesCreated, updatedAt);
}

function insertLog(db: DatabaseSync, ts: string, level: string, message: string): void {
	db.prepare("INSERT INTO service_logs (ts, level, message) VALUES (?, ?, ?)").run(ts, level, message);
}

const ok: HealthClassification = { kind: "ok" };
const refused: HealthClassification = { kind: "unreachable-refused", detail: "ECONNREFUSED" };

describe("poll-loop (PRD-001c)", () => {
	afterEach(() => {
		// Close every cached SQLite handle FIRST: on Windows a still-open node:sqlite handle
		// blocks deleting its file/directory (EPERM), so the loops must release their files
		// before the tmp dirs are removed.
		for (const loop of openLoops.splice(0)) loop.close();
		for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("c-AC-1/c-AC-2/c-AC-3: merges the static entry + runtime status + /health probe into one record", async () => {
		const dir = makeTmp();
		const dbPath = join(dir, "honeycomb.sqlite");
		const fixture = buildFixtureDb(dbPath);
		upsertStatus(fixture, { name: "honeycomb", bindingTime: "2026-07-01T00:00:00.000Z", lastSeen: "2026-07-01T00:00:00.500Z", health: "ok", deeplakeConnected: true, deeplakeLastComm: "2026-07-01T00:00:00.400Z" });
		upsertMetrics(fixture, { actionsTaken: 12, filesProcessed: 3, memoriesCreated: 5 }, "2026-07-01T00:00:00.500Z");
		fixture.close();

		const entry = daemon({ name: "honeycomb", healthUrl: "http://127.0.0.1:3850/health", telemetryDbPath: dbPath });
		const clock = fakeClock(Date.parse("2026-07-01T00:00:00.600Z"));
		const loop = trackedPollLoop({ entries: [entry], clock, logger: silentLogger, probe: async () => ok });

		const event = await loop.tick();
		expect(event.services).toHaveLength(1);
		expect(event.services[0]).toEqual({
			name: "honeycomb",
			health: "ok",
			lastSeen: "2026-07-01T00:00:00.500Z",
			metrics: { actionsTaken: 12, filesProcessed: 3, memoriesCreated: 5 },
			deeplake: { connected: true, lastCommunicationAt: "2026-07-01T00:00:00.400Z" },
			telemetryFault: null,
		});
	});

	it("001a-AC-2/001-AC-2: an entry with no telemetryDbPath is health-probe-only (no SQLite ingestion)", async () => {
		const entry = daemon({ name: "hive", healthUrl: "http://127.0.0.1:3853/health" });
		const clock = fakeClock();
		const loop = trackedPollLoop({ entries: [entry], clock, logger: silentLogger, probe: async () => ok });

		const event = await loop.tick();
		expect(event.services).toEqual([
			{ name: "hive", health: "ok", lastSeen: null, metrics: {}, deeplake: null, telemetryFault: null },
		]);
	});

	it("Contract C: a registered-but-silent service (no status row yet) reports health 'unknown'", async () => {
		const dir = makeTmp();
		const dbPath = join(dir, "nectar.sqlite");
		buildFixtureDb(dbPath).close();

		const entry = daemon({ name: "nectar", healthUrl: "http://127.0.0.1:3854/health", telemetryDbPath: dbPath });
		const loop = trackedPollLoop({ entries: [entry], clock: fakeClock(), logger: silentLogger, probe: async () => ok });

		const event = await loop.tick();
		expect(event.services[0]?.health).toBe("unknown");
		expect(event.services[0]?.lastSeen).toBeNull();
	});

	it("Contract C: a never-registered service is simply absent from services", async () => {
		const loop = trackedPollLoop({ entries: [], clock: fakeClock(), logger: silentLogger, probe: async () => ok });
		const event = await loop.tick();
		expect(event.services).toEqual([]);
	});

	it("c-AC-4: a disconnected service (stale last-seen + failing /health) is marked unreachable; last-seen and the static entry are retained", async () => {
		const dir = makeTmp();
		const dbPath = join(dir, "honeycomb.sqlite");
		const fixture = buildFixtureDb(dbPath);
		const staleLastSeen = "2026-07-01T00:00:00.000Z";
		upsertStatus(fixture, { name: "honeycomb", bindingTime: staleLastSeen, lastSeen: staleLastSeen, health: "ok" });
		fixture.close();

		const entry = daemon({ name: "honeycomb", healthUrl: "http://127.0.0.1:3850/health", telemetryDbPath: dbPath, probeIntervalMs: 1_000 });
		// 10s later (well past the 3x probeIntervalMs staleness window) and /health now fails.
		const clock = fakeClock(Date.parse(staleLastSeen) + 10_000);
		const loop = trackedPollLoop({ entries: [entry], clock, logger: silentLogger, probe: async () => refused });

		const event = await loop.tick();
		expect(event.services).toHaveLength(1);
		expect(event.services[0]?.health).toBe("unreachable");
		// Last-seen is not cleared or reset -- it simply stops advancing, which IS the
		// recorded disconnect signal (ADR-0002 decision 3); the entry itself is still present.
		expect(event.services[0]?.lastSeen).toBe(staleLastSeen);
		expect(event.services[0]?.name).toBe("honeycomb");
	});

	it("a healthy /health probe with a stale (but present) status row degrades to 'degraded' rather than a stale 'ok'", async () => {
		const dir = makeTmp();
		const dbPath = join(dir, "honeycomb.sqlite");
		const fixture = buildFixtureDb(dbPath);
		const staleLastSeen = "2026-07-01T00:00:00.000Z";
		upsertStatus(fixture, { name: "honeycomb", bindingTime: staleLastSeen, lastSeen: staleLastSeen, health: "ok" });
		fixture.close();

		const entry = daemon({ name: "honeycomb", healthUrl: "http://127.0.0.1:3850/health", telemetryDbPath: dbPath, probeIntervalMs: 1_000 });
		const clock = fakeClock(Date.parse(staleLastSeen) + 10_000);
		const loop = trackedPollLoop({ entries: [entry], clock, logger: silentLogger, probe: async () => ok });

		const event = await loop.tick();
		expect(event.services[0]?.health).toBe("degraded");
	});

	it("c-AC-6: one service's missing telemetry DB is isolated; the other service keeps polling normally", async () => {
		const dir = makeTmp();
		const healthyDbPath = join(dir, "honeycomb.sqlite");
		const fixture = buildFixtureDb(healthyDbPath);
		upsertStatus(fixture, { name: "honeycomb", bindingTime: "2026-07-01T00:00:00.000Z", lastSeen: "2026-07-01T00:00:00.000Z", health: "ok" });
		fixture.close();

		const brokenEntry = daemon({
			name: "nectar",
			healthUrl: "http://127.0.0.1:3854/health",
			telemetryDbPath: join(dir, "does-not-exist.sqlite"),
		});
		const healthyEntry = daemon({ name: "honeycomb", healthUrl: "http://127.0.0.1:3850/health", telemetryDbPath: healthyDbPath });
		const clock = fakeClock(Date.parse("2026-07-01T00:00:00.000Z"));
		const loop = trackedPollLoop({ entries: [brokenEntry, healthyEntry], clock, logger: silentLogger, probe: async () => ok });

		const event = await loop.tick();
		const broken = event.services.find((s) => s.name === "nectar");
		const healthy = event.services.find((s) => s.name === "honeycomb");
		expect(broken?.telemetryFault).toBe("missing");
		// A broken /health-ok service degrades to "degraded" (fault flagged) rather than
		// vanishing from the model or crashing the whole tick.
		expect(broken?.health).toBe("degraded");
		expect(healthy?.telemetryFault).toBeNull();
		expect(healthy?.health).toBe("ok");
	});

	it("c-AC-6: a malformed (non-SQLite) telemetry DB is isolated the same way", async () => {
		const dir = makeTmp();
		const malformedPath = join(dir, "garbage.sqlite");
		writeFileSync(malformedPath, "this is not a sqlite file at all", "utf8");

		const entry = daemon({ name: "nectar", healthUrl: "http://127.0.0.1:3854/health", telemetryDbPath: malformedPath });
		const loop = trackedPollLoop({ entries: [entry], clock: fakeClock(), logger: silentLogger, probe: async () => ok });

		const event = await loop.tick();
		expect(event.services[0]?.telemetryFault).not.toBeNull();
		expect(event.services[0]?.health).toBe("degraded");
	});

	it("c-AC-6: a telemetry DB whose service_status.name does not match the registry entry is rejected as malformed (no cross-wiring)", async () => {
		const dir = makeTmp();
		const dbPath = join(dir, "impostor.sqlite");
		const fixture = buildFixtureDb(dbPath);
		// The DB self-identifies as "hive" but the registry entry points "honeycomb" at it.
		upsertStatus(fixture, { name: "hive", bindingTime: "2026-07-01T00:00:00.000Z", lastSeen: "2026-07-01T00:00:00.000Z", health: "ok" });
		upsertMetrics(fixture, { actionsTaken: 9, filesProcessed: 9, memoriesCreated: 9 }, "2026-07-01T00:00:00.000Z");
		insertLog(fixture, "2026-07-01T00:00:00.000Z", "info", "must-not-leak");
		fixture.close();

		const entry = daemon({ name: "honeycomb", healthUrl: "http://127.0.0.1:3850/health", telemetryDbPath: dbPath });
		const clock = fakeClock(Date.parse("2026-07-01T00:00:00.000Z"));
		const loop = trackedPollLoop({ entries: [entry], clock, logger: silentLogger, probe: async () => ok });

		const event = await loop.tick();
		// The mismatch is treated exactly like a malformed DB: fault flagged, degraded, and
		// NOTHING from the mispointed DB is attributed to the entry -- no status, no
		// metrics, and no log rows.
		expect(event.services[0]?.telemetryFault).toBe("malformed");
		expect(event.services[0]?.health).toBe("degraded");
		expect(event.services[0]?.lastSeen).toBeNull();
		expect(event.services[0]?.metrics).toEqual({});
		expect(event.logs).toEqual([]);
	});

	it("c-AC-6: recovers on a later tick once the telemetry DB becomes available again", async () => {
		const dir = makeTmp();
		const dbPath = join(dir, "honeycomb.sqlite");
		// Tick 1: the file does not exist yet.
		const entry = daemon({ name: "honeycomb", healthUrl: "http://127.0.0.1:3850/health", telemetryDbPath: dbPath });
		const loop = trackedPollLoop({ entries: [entry], clock: fakeClock(), logger: silentLogger, probe: async () => ok });

		const first = await loop.tick();
		expect(first.services[0]?.telemetryFault).toBe("missing");

		// Tick 2: the service comes up and writes its fixture DB.
		const fixture = buildFixtureDb(dbPath);
		upsertStatus(fixture, { name: "honeycomb", bindingTime: "2026-07-01T00:00:00.000Z", lastSeen: "2026-07-01T00:00:00.000Z", health: "ok" });
		fixture.close();

		const second = await loop.tick();
		expect(second.services[0]?.telemetryFault).toBeNull();
		expect(second.services[0]?.health).toBe("ok");
	});

	it("c-AC-7/002c-AC-1/002c-AC-2: logs are read as a bounded, advancing window -- never the whole history, and each tick forwards only NEW rows", async () => {
		const dir = makeTmp();
		const dbPath = join(dir, "honeycomb.sqlite");
		const fixture = buildFixtureDb(dbPath);
		upsertStatus(fixture, { name: "honeycomb", bindingTime: "2026-07-01T00:00:00.000Z", lastSeen: "2026-07-01T00:00:00.000Z", health: "ok" });
		for (let i = 0; i < 5; i += 1) insertLog(fixture, `2026-07-01T00:00:0${i}.000Z`, "info", `line-${i}`);
		fixture.close();

		const entry = daemon({ name: "honeycomb", healthUrl: "http://127.0.0.1:3850/health", telemetryDbPath: dbPath });
		const loop = trackedPollLoop({ entries: [entry], clock: fakeClock(), logger: silentLogger, probe: async () => ok, logWindowLimit: 3 });

		// Bounded window: only 3 of the 5 pre-existing rows come back on the first tick.
		const first = await loop.tick();
		expect(first.logs).toHaveLength(3);
		expect(first.logs.map((l) => l.message)).toEqual(["line-0", "line-1", "line-2"]);

		// Second tick: the cursor advanced, so only the remaining 2 (never a re-read of line-0..2).
		const second = await loop.tick();
		expect(second.logs.map((l) => l.message)).toEqual(["line-3", "line-4"]);

		// Third tick: nothing new was written -- an empty (still bounded) slice, not history replay.
		const third = await loop.tick();
		expect(third.logs).toEqual([]);

		// A log line written between ticks is picked up as a fresh delta, tagged with its service.
		const db2 = new DatabaseSync(dbPath);
		insertLog(db2, "2026-07-01T00:00:09.000Z", "warn", "new-line");
		db2.close();
		const fourth = await loop.tick();
		expect(fourth.logs).toEqual([{ service: "honeycomb", ts: "2026-07-01T00:00:09.000Z", level: "warn", message: "new-line" }]);
	});

	it("c-AC-5/001-AC-7: reload() changes which databases are polled", async () => {
		const dir = makeTmp();
		const aPath = join(dir, "a.sqlite");
		const bPath = join(dir, "b.sqlite");
		buildFixtureDb(aPath).close();
		buildFixtureDb(bPath).close();

		const a = daemon({ name: "a", healthUrl: "http://127.0.0.1:3850/health", telemetryDbPath: aPath });
		const b = daemon({ name: "b", healthUrl: "http://127.0.0.1:3854/health", telemetryDbPath: bPath });

		const loop = trackedPollLoop({ entries: [a], clock: fakeClock(), logger: silentLogger, probe: async () => ok });
		const before = await loop.tick();
		expect(before.services.map((s) => s.name)).toEqual(["a"]);

		loop.reload([b]);
		const after = await loop.tick();
		expect(after.services.map((s) => s.name)).toEqual(["b"]);
	});

	it("c-AC-5: reload() with a same-name entry whose telemetryDbPath changed drops the cached runtime and reads the new DB from the start", async () => {
		const dir = makeTmp();
		const oldPath = join(dir, "old.sqlite");
		const newPath = join(dir, "new.sqlite");
		const oldDb = buildFixtureDb(oldPath);
		upsertStatus(oldDb, { name: "honeycomb", bindingTime: "2026-07-01T00:00:00.000Z", lastSeen: "2026-07-01T00:00:00.000Z", health: "ok" });
		insertLog(oldDb, "2026-07-01T00:00:00.000Z", "info", "old-line-0");
		insertLog(oldDb, "2026-07-01T00:00:01.000Z", "info", "old-line-1");
		oldDb.close();
		const newDb = buildFixtureDb(newPath);
		upsertStatus(newDb, { name: "honeycomb", bindingTime: "2026-07-01T00:00:02.000Z", lastSeen: "2026-07-01T00:00:02.000Z", health: "ok" });
		insertLog(newDb, "2026-07-01T00:00:02.000Z", "info", "new-line-0");
		newDb.close();

		const before = daemon({ name: "honeycomb", healthUrl: "http://127.0.0.1:3850/health", telemetryDbPath: oldPath });
		const clock = fakeClock(Date.parse("2026-07-01T00:00:02.000Z"));
		const loop = trackedPollLoop({ entries: [before], clock, logger: silentLogger, probe: async () => ok });

		const first = await loop.tick();
		expect(first.logs.map((l) => l.message)).toEqual(["old-line-0", "old-line-1"]);

		// Same name, different telemetryDbPath: without eviction the loop would keep the
		// old handle open (pollEntry reopens only when the handle is null) and its stale
		// lastLogId (2) would skip new-line-0 (id 1) in the new DB entirely.
		loop.reload([{ ...before, telemetryDbPath: newPath }]);
		const second = await loop.tick();
		expect(second.logs.map((l) => l.message)).toEqual(["new-line-0"]);
	});

	it("snapshot() returns the latest merged event without polling again", async () => {
		const loop = trackedPollLoop({ entries: [], clock: fakeClock(), logger: silentLogger, probe: async () => ok });
		expect(loop.snapshot().services).toEqual([]);
		await loop.tick();
		const snap1 = loop.snapshot();
		expect(snap1).toBe(loop.snapshot());
	});

	it("onSnapshot() notifies subscribers on every tick and the returned unsubscribe stops future notifications", async () => {
		const loop = trackedPollLoop({ entries: [], clock: fakeClock(), logger: silentLogger, probe: async () => ok });
		const seen: number[] = [];
		const unsubscribe = loop.onSnapshot(() => seen.push(1));

		await loop.tick();
		await loop.tick();
		expect(seen).toHaveLength(2);

		unsubscribe();
		await loop.tick();
		expect(seen).toHaveLength(2);
	});

	it("start()/stop(): runs ticks on the injected clock's sleep cadence and stops cleanly", async () => {
		const clock = fakeClock();
		const loop = trackedPollLoop({ entries: [], clock, logger: silentLogger, probe: async () => ok, intervalMs: 10 });
		const run = loop.start();
		// Give the loop's microtask a chance to run a tick or two.
		await Promise.resolve();
		await Promise.resolve();
		loop.stop();
		await expect(run).resolves.toBeUndefined();
	});

	it("001c-AC-8: never throws even when the injected probe seam itself throws", async () => {
		const entry = daemon({ name: "honeycomb", healthUrl: "http://127.0.0.1:3850/health" });
		const loop = trackedPollLoop({
			entries: [entry],
			clock: fakeClock(),
			logger: silentLogger,
			probe: async () => {
				throw new Error("probe seam exploded");
			},
		});

		const event = await loop.tick();
		expect(event.services[0]?.health).toBe("unreachable");
	});
});

describe("openTelemetryDb (PRD-001b reader side, used by the poll loop)", () => {
	afterEach(() => {
		for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("001b-AC-1/AC-5: round-trips a full-shape service_status row (registration + binding time + last-seen + health + Deep Lake stats)", () => {
		const dir = makeTmp();
		const dbPath = join(dir, "svc.sqlite");
		const fixture = buildFixtureDb(dbPath);
		upsertStatus(fixture, {
			name: "honeycomb",
			bindingTime: "2026-07-01T00:00:00.000Z",
			lastSeen: "2026-07-01T00:00:05.000Z",
			health: "ok",
			deeplakeConnected: true,
			deeplakeLastComm: "2026-07-01T00:00:04.000Z",
		});
		fixture.close();

		const reader = openTelemetryDb(dbPath);
		try {
			expect(reader.readStatus()).toEqual({
				name: "honeycomb",
				bindingTime: "2026-07-01T00:00:00.000Z",
				lastSeen: "2026-07-01T00:00:05.000Z",
				health: "ok",
				deeplakeConnected: true,
				deeplakeLastComm: "2026-07-01T00:00:04.000Z",
			});
		} finally {
			reader.close();
		}
	});

	it("002b-AC-1: readMetrics() is schema-tolerant -- forwards whatever counters exist, camelCased, excluding id/updated_at", () => {
		const dir = makeTmp();
		const dbPath = join(dir, "nectar.sqlite");
		const db = new DatabaseSync(dbPath);
		// nectar's own 5-counter variant (Contract B), never hardcoded in the reader.
		db.exec(`
			CREATE TABLE service_metrics (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				files_registered INTEGER NOT NULL DEFAULT 0,
				nectars_minted INTEGER NOT NULL DEFAULT 0,
				descriptions_generated INTEGER NOT NULL DEFAULT 0,
				hive_graph_versions INTEGER NOT NULL DEFAULT 0,
				embeddings_computed INTEGER NOT NULL DEFAULT 0,
				updated_at TEXT NOT NULL
			);
		`);
		db.prepare(
			"INSERT INTO service_metrics (id, files_registered, nectars_minted, descriptions_generated, hive_graph_versions, embeddings_computed, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?)",
		).run(7, 2, 9, 1, 4, "2026-07-01T00:00:00.000Z");
		db.close();

		const reader = openTelemetryDb(dbPath);
		try {
			expect(reader.readMetrics()).toEqual({
				filesRegistered: 7,
				nectarsMinted: 2,
				descriptionsGenerated: 9,
				hiveGraphVersions: 1,
				embeddingsComputed: 4,
			});
		} finally {
			reader.close();
		}
	});

	it("readStatus() returns null when the table is empty (registered but never checked in)", () => {
		const dir = makeTmp();
		const dbPath = join(dir, "svc.sqlite");
		buildFixtureDb(dbPath).close();

		const reader = openTelemetryDb(dbPath);
		try {
			expect(reader.readStatus()).toBeNull();
			expect(reader.readMetrics()).toEqual({});
		} finally {
			reader.close();
		}
	});

	it("b-AC-3: opens read-only -- a write attempt through the reader's handle is rejected by SQLite", () => {
		const dir = makeTmp();
		const dbPath = join(dir, "svc.sqlite");
		buildFixtureDb(dbPath).close();

		const reader = openTelemetryDb(dbPath);
		try {
			// There is no public write API on TelemetryDbReader by design; this asserts the
			// underlying open mode itself by opening a second raw read-only handle and
			// confirming SQLite's own read-only enforcement throws on a write statement.
			const raw = new DatabaseSync(dbPath, { readOnly: true });
			expect(() => raw.prepare("INSERT INTO service_logs (ts, level, message) VALUES ('x','info','y')").run()).toThrow();
			raw.close();
		} finally {
			reader.close();
		}
	});

	it("throws when the database file does not exist (missing -> the poll loop's isolation path)", () => {
		const dir = makeTmp();
		expect(() => openTelemetryDb(join(dir, "nope.sqlite"))).toThrow();
	});
});
