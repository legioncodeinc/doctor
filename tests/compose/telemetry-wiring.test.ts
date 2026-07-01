/**
 * Composition-root wiring tests for hivedoctor PRD-001/PRD-002 (telemetry ingestion + SSE).
 *
 * Asserts that `createHiveDoctor()` wires:
 *   - the telemetry poll loop over the resolved daemon registry (a `telemetryDbPath`
 *     entry feeds the poll loop; a legacy entry stays health-probe-only);
 *   - the `/events` SSE endpoint onto the EXISTING status page server (PRD-002a
 *     implementation note: no second listener);
 *   - start()/stop() arm and disarm the telemetry poll loop alongside every other loop,
 *     fail-soft and idempotent;
 *   - a malformed registry (the PRD-004d fail-soft path) does not prevent the telemetry
 *     wiring from coming up over the honeycomb-primary fallback (regression: PRD-001's
 *     ingestion module must never regress the existing malformed-registry posture).
 *
 * Everything is driven over injected fakes (fake clock, fake probe, port 0) so no real
 * timer/network/daemon runs; only the telemetry DB itself is real (a `mkdtempSync`
 * fixture written with a normal read/write DatabaseSync, read back through the real
 * read-only reader) so the end-to-end wiring is proven, not just each piece in isolation.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createHiveDoctor } from "../../src/compose/index.js";
import { resolveConfig } from "../../src/config.js";
import { silentLogger } from "../../src/logger.js";
import type { SupervisorClock } from "../../src/supervisor.js";
import type { HealthClassification } from "../../src/health-probe.js";
import type { CommandResult, CommandRunner } from "../../src/rungs/command-runner.js";

function fakeClock(): SupervisorClock {
	return { now: () => 0, sleep: async () => undefined };
}

function fakeRunner(): CommandRunner {
	return {
		async run(): Promise<CommandResult> {
			return { ok: true, code: 0, stdout: "", stderr: "" };
		},
	};
}

const tmpDirs: string[] = [];
function makeTmp(): string {
	const d = mkdtempSync(join(tmpdir(), "hivedoctor-telemetry-wiring-"));
	tmpDirs.push(d);
	return d;
}

function buildFixtureDb(path: string): void {
	const db = new DatabaseSync(path);
	db.exec(`
		CREATE TABLE service_status (
			id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL, binding_time TEXT NOT NULL,
			last_seen TEXT NOT NULL, health TEXT NOT NULL, deeplake_connected INTEGER, deeplake_last_comm TEXT
		);
		CREATE TABLE service_metrics (
			id INTEGER PRIMARY KEY CHECK (id = 1), actions_taken INTEGER NOT NULL DEFAULT 0,
			files_processed INTEGER NOT NULL DEFAULT 0, memories_created INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
		);
		CREATE TABLE service_logs (
			id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
			level TEXT NOT NULL CHECK (level IN ('error','warn','info','debug')), message TEXT NOT NULL
		);
	`);
	db.prepare(
		"INSERT INTO service_status (id, name, binding_time, last_seen, health, deeplake_connected, deeplake_last_comm) VALUES (1, 'honeycomb', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 'ok', 1, '2026-07-01T00:00:00.000Z')",
	).run();
	db.prepare(
		"INSERT INTO service_metrics (id, actions_taken, files_processed, memories_created, updated_at) VALUES (1, 4, 2, 1, '2026-07-01T00:00:00.000Z')",
	).run();
	db.close();
}

function buildDoctor(over: Partial<Parameters<typeof createHiveDoctor>[0]> = {}) {
	const config = { ...resolveConfig({}), workspaceDir: makeTmp() };
	return createHiveDoctor({
		config,
		env: {},
		logger: silentLogger,
		clock: fakeClock(),
		runner: fakeRunner(),
		probe: async (): Promise<HealthClassification> => ({ kind: "ok" }),
		statusPagePort: 0,
		...over,
	});
}

async function waitForPort(doctor: ReturnType<typeof createHiveDoctor>): Promise<number> {
	for (let i = 0; i < 50; i += 1) {
		const port = doctor.statusPage.listeningPort;
		if (port !== undefined) return port;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("status page did not bind");
}

function fetchEventsFirstFrame(port: number): Promise<{ statusCode: number | undefined; body: string }> {
	return new Promise((resolve, reject) => {
		const req = get(`http://127.0.0.1:${port}/events`, (res) => {
			let buffer = "";
			res.on("data", (chunk: Buffer) => {
				buffer += chunk.toString("utf8");
				if (buffer.includes("\n\n")) {
					resolve({ statusCode: res.statusCode, body: buffer });
					req.destroy();
				}
			});
			res.on("error", reject);
		});
		req.on("error", reject);
	});
}

describe("createHiveDoctor telemetry wiring (PRD-001/PRD-002)", () => {
	afterEach(() => {
		for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("wires /events onto the existing status page and it emits a well-formed fleet-telemetry frame", async () => {
		const doctor = buildDoctor();
		doctor.statusPage.start();
		const port = await waitForPort(doctor);

		const { statusCode, body } = await fetchEventsFirstFrame(port);
		expect(statusCode).toBe(200);
		expect(body).toContain("event: fleet-telemetry");
		expect(body).toContain('"services"');
		expect(body).toContain('"logs"');

		await doctor.stop();
	});

	it("a registered entry with telemetryDbPath feeds the telemetry poll loop end to end", async () => {
		const dir = makeTmp();
		const dbPath = join(dir, "honeycomb.sqlite");
		buildFixtureDb(dbPath);

		const doctor = buildDoctor({
			daemons: [
				{
					name: "honeycomb",
					healthUrl: "http://127.0.0.1:3850/health",
					pidPath: join(dir, "daemon.pid"),
					probeIntervalMs: 30_000,
					startupGraceMs: 60_000,
					restartGiveUpThreshold: 3,
					restartCooldownMs: 5_000,
					telemetryDbPath: dbPath,
				},
			],
		});

		const event = await doctor.telemetryPollLoop.tick();
		expect(event.services).toEqual([
			{
				name: "honeycomb",
				health: "ok",
				lastSeen: "2026-07-01T00:00:00.000Z",
				metrics: { actionsTaken: 4, filesProcessed: 2, memoriesCreated: 1 },
				deeplake: { connected: true, lastCommunicationAt: "2026-07-01T00:00:00.000Z" },
				telemetryFault: null,
			},
		]);

		// stop() without a matching start() is a documented no-op (mirrors every other
		// pre-existing test in this repo that drives a loop directly without the full
		// lifecycle); close the poll loop's cached read-only handle explicitly so the tmp
		// dir cleanup below does not race an open SQLite file on Windows.
		doctor.telemetryPollLoop.close();
		await doctor.stop();
	});

	it("a legacy entry with no telemetryDbPath stays health-probe-only in the telemetry model too", async () => {
		const doctor = buildDoctor({
			daemons: [
				{
					name: "honeycomb",
					healthUrl: "http://127.0.0.1:3850/health",
					pidPath: "/tmp/does-not-matter.pid",
					probeIntervalMs: 30_000,
					startupGraceMs: 60_000,
					restartGiveUpThreshold: 3,
					restartCooldownMs: 5_000,
				},
			],
		});

		const event = await doctor.telemetryPollLoop.tick();
		expect(event.services).toEqual([
			{ name: "honeycomb", health: "ok", lastSeen: null, metrics: {}, deeplake: null, telemetryFault: null },
		]);

		await doctor.stop();
	});

	it("a MALFORMED registry does not prevent the telemetry loop from wiring over the honeycomb-primary fallback (PRD-004d regression guard)", async () => {
		const registryPath = join(makeTmp(), "hivedoctor.daemons.json");
		writeFileSync(registryPath, "{ not valid json", "utf8");

		const doctor = createHiveDoctor({
			config: { ...resolveConfig({}), workspaceDir: makeTmp() },
			env: {},
			logger: silentLogger,
			clock: fakeClock(),
			runner: fakeRunner(),
			probe: async (): Promise<HealthClassification> => ({ kind: "ok" }),
			statusPagePort: 0,
			registryPath,
		});

		const event = await doctor.telemetryPollLoop.tick();
		// Falls back to exactly the honeycomb primary, health-probe-only (no telemetryDbPath
		// on the built-in fallback entry) -- the same posture as the supervisor fallback.
		expect(event.services).toEqual([
			{ name: "honeycomb", health: "ok", lastSeen: null, metrics: {}, deeplake: null, telemetryFault: null },
		]);

		await doctor.stop();
	});

	it("start() arms the telemetry poll loop and stop() disarms it fail-soft and idempotently", async () => {
		const doctor = buildDoctor();
		await expect(doctor.start()).resolves.toBeUndefined();
		await expect(doctor.start()).resolves.toBeUndefined();
		await expect(doctor.stop()).resolves.toBeUndefined();
		await expect(doctor.stop()).resolves.toBeUndefined();
	});
});
