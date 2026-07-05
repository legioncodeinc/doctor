/**
 * Multi-daemon composition tests (PRD-004a US-1/US-2/US-3).
 *
 * Drives `createDoctor` over an injected registry to prove the composition root spawns
 * one independent supervisor per entry (a-AC-1) with fully isolated per-daemon state +
 * incident shards (a-AC-4/5/6) and per-entry watchdog-war guards that read each entry's own
 * pidPath (a-AC-7) and apply each entry's own cooldown without gating any other entry (a-AC-8).
 *
 * Each entry probes its OWN `healthUrl` (a real ephemeral loopback server), so the isolation
 * is exercised over the real probe path, not a shared mock. Built-ins + the shared test helpers.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDoctor } from "../../src/compose/index.js";
import { resolveConfig } from "../../src/config.js";
import { silentLogger } from "../../src/logger.js";
import { deleteRegistryEntry, type DaemonEntry } from "../../src/registry.js";
import { createFakeClock } from "../helpers/harness.js";
import { okBody, startMockHealthServer, type MockHealthServer } from "../helpers/health-server.js";
import type { StatusJson } from "../../src/status-page/server.js";

let dir: string;
const servers: MockHealthServer[] = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "doctor-multi-"));
});
afterEach(async () => {
	for (const s of servers.splice(0)) await s.close();
	rmSync(dir, { recursive: true, force: true });
});

/** Build a DaemonEntry with test-friendly defaults (grace 0 so a tick heals immediately). */
function entry(name: string, healthUrl: string, over: Partial<DaemonEntry> = {}): DaemonEntry {
	return {
		name,
		healthUrl,
		pidPath: join(dir, `${name}.pid`),
		probeIntervalMs: 30_000,
		startupGraceMs: 0,
		restartGiveUpThreshold: 3,
		restartCooldownMs: 5_000,
		...over,
	};
}

/** An always-unhealthy handler (answers non-200 -> classified `degraded`). */
const unhealthy = (): { statusCode: number; body: string } => ({ statusCode: 503, body: "" });

async function statusJsonUrl(doctor: ReturnType<typeof createDoctor>): Promise<string> {
	for (let i = 0; i < 50; i += 1) {
		const port = doctor.statusPage.listeningPort;
		if (port !== undefined) return `http://127.0.0.1:${port}/status.json`;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("status page did not bind");
}

describe("createDoctor multi-daemon (PRD-004a)", () => {
	it("a-AC-1: spawns one independent supervisor per registry entry", () => {
		const doctor = createDoctor({
			config: { ...resolveConfig({}), workspaceDir: dir },
			deviceId: "test-device-id", // hermetic: never mint/read the real device.json
			daemons: [
				entry("honeycomb", "http://127.0.0.1:3850/health"),
				entry("hive", "http://127.0.0.1:3853/health"),
				entry("nectar", "http://127.0.0.1:3854/health"),
			],
			logger: silentLogger,
			clock: createFakeClock(),
			statusPagePort: 0,
		});
		expect(doctor.supervisors).toHaveLength(3);
		// The primary (exposed `supervisor`) is the first entry's loop.
		expect(doctor.supervisor).toBe(doctor.supervisors[0]);
	});

	it("b-AC-7: registry without an entry => no supervisor built for it (true by construction)", () => {
		const registryPath = join(dir, "registry.json");
		writeFileSync(
			registryPath,
			JSON.stringify({
				daemons: [
					{ name: "honeycomb", healthUrl: "http://127.0.0.1:3850/health" },
					{ name: "hive", healthUrl: "http://127.0.0.1:3853/health" },
				],
			}),
		);

		const before = createDoctor({
			config: { ...resolveConfig({}), workspaceDir: dir },
			deviceId: "test-device-id",
			registryPath,
			logger: silentLogger,
			clock: createFakeClock(),
			statusPagePort: 0,
		});
		// Both registered entries get their own supervisor + ladder (PRD-004a a-AC-1).
		expect(before.supervisors).toHaveLength(2);
		expect(before.ladders).toHaveLength(2);

		// Simulate `hive uninstall` deleting its OWN registry entry (PRD-003b b-AC-3's writer).
		const { deleted } = deleteRegistryEntry("hive", { registryPath, home: dir, env: {}, platform: "linux" });
		expect(deleted).toBe(true);

		const after = createDoctor({
			config: { ...resolveConfig({}), workspaceDir: dir },
			deviceId: "test-device-id",
			registryPath,
			logger: silentLogger,
			clock: createFakeClock(),
			statusPagePort: 0,
		});
		// The removed entry is simply absent from what a fresh boot reads: no supervisor, no
		// ladder is ever built for it - doctor never probes or remediates it again (b-AC-7).
		expect(after.supervisors).toHaveLength(1);
		expect(after.ladders).toHaveLength(1);
	});

	it("a-AC-4/5/6: per-daemon state + incident shards are isolated (A's failures never touch B)", async () => {
		const serverA = await startMockHealthServer(unhealthy);
		const serverB = await startMockHealthServer(okBody);
		servers.push(serverA, serverB);

		const pidReads: string[] = [];
		const doctor = createDoctor({
			config: { ...resolveConfig({}), workspaceDir: dir },
			deviceId: "test-device-id", // hermetic: never mint/read the real device.json
			daemons: [entry("a", serverA.url), entry("b", serverB.url)],
			logger: silentLogger,
			clock: createFakeClock(),
			// A restart that never succeeds so daemon A accumulates consecutive-restart-failures.
			restart: async () => false,
			readDaemonPid: async (p) => {
				pidReads.push(p);
				return null;
			},
			statusPagePort: 0,
		});
		const [supA, supB] = doctor.supervisors;

		// Daemon A: two unhealthy ticks -> two failed restarts + two incident episodes.
		await supA?.tick();
		await supA?.tick();
		// Daemon B: one healthy tick -> confirmed ok, no remediation, no incident.
		await supB?.tick();

		const stateA = JSON.parse(readFileSync(join(dir, "state-a.json"), "utf8")) as Record<string, unknown>;
		const stateB = JSON.parse(readFileSync(join(dir, "state-b.json"), "utf8")) as Record<string, unknown>;

		// A's shard shows the accumulated failure; B's is pristine and untouched by A (a-AC-4).
		expect(stateA.consecutiveRestartFailures).toBe(2);
		expect(stateA.lastKnownHealth).toBe("degraded");
		expect(stateB.consecutiveRestartFailures).toBe(0);
		expect(stateB.lastKnownHealth).toBe("ok");

		// State is sharded per name (a-AC-5): there is no single shared state.json.
		expect(existsSync(join(dir, "state.json"))).toBe(false);

		// Incidents are sharded per name (a-AC-6): A has an incident stream, B has none.
		expect(existsSync(join(dir, "incidents-a.ndjson"))).toBe(true);
		expect(existsSync(join(dir, "incidents-b.ndjson"))).toBe(false);
		const incidentsA = readFileSync(join(dir, "incidents-a.ndjson"), "utf8").trim().split("\n");
		expect(incidentsA).toHaveLength(2);

		// a-AC-7 (isolation aspect): A's restart rung read A's OWN pidPath, never B's.
		expect(pidReads).toContain(join(dir, "a.pid"));
		expect(pidReads).not.toContain(join(dir, "b.pid"));
	});

	it("a-AC-7/8: cooldown gates only its own entry and each rung reads its own pidPath", async () => {
		const serverA = await startMockHealthServer(unhealthy);
		const serverB = await startMockHealthServer(unhealthy);
		servers.push(serverA, serverB);

		const pidReads: string[] = [];
		const restart = vi.fn(async () => true); // a successful restart engages the cooldown
		const doctor = createDoctor({
			config: { ...resolveConfig({}), workspaceDir: dir },
			deviceId: "test-device-id", // hermetic: never mint/read the real device.json
			daemons: [entry("a", serverA.url), entry("b", serverB.url)],
			logger: silentLogger,
			clock: createFakeClock(0), // time frozen at 0 -> every re-tick is inside the 5s cooldown
			restart,
			readDaemonPid: async (p) => {
				pidReads.push(p);
				return null;
			},
			statusPagePort: 0,
		});
		const [supA, supB] = doctor.supervisors;

		// Daemon A: first unhealthy tick restarts; the second (inside A's cooldown) is skipped.
		await supA?.tick();
		await supA?.tick();
		expect(restart).toHaveBeenCalledTimes(1); // a-AC-8: A's own cooldown gated A's second restart

		// Daemon B: its entry-local lastRestartAt is null, so A's cooldown does NOT gate B.
		await supB?.tick();
		expect(restart).toHaveBeenCalledTimes(2); // a-AC-8: B is not gated by A's cooldown

		// a-AC-7: each entry's restart rung read its OWN pidPath.
		expect(pidReads).toContain(join(dir, "a.pid"));
		expect(pidReads).toContain(join(dir, "b.pid"));
	});

	it("b-AC-2: status page reads each daemon health from its own isolated shard", async () => {
		const serverA = await startMockHealthServer(unhealthy);
		const serverB = await startMockHealthServer(okBody);
		const serverC = await startMockHealthServer(unhealthy);
		await serverC.close();
		servers.push(serverA, serverB);

		const doctor = createDoctor({
			config: { ...resolveConfig({}), workspaceDir: dir },
			deviceId: "test-device-id", // hermetic: never mint/read the real device.json
			daemons: [entry("honeycomb", serverA.url), entry("hive", serverB.url), entry("nectar", serverC.url)],
			logger: silentLogger,
			clock: createFakeClock(),
			statusPagePort: 0,
		});
		const [supA, supB, supC] = doctor.supervisors;
		await supA?.tick();
		await supB?.tick();
		await supC?.tick();

		doctor.statusPage.start();
		const response = await fetch(await statusJsonUrl(doctor));
		const body = (await response.json()) as StatusJson;

		expect(body.daemons).toEqual([
			expect.objectContaining({ name: "honeycomb", health: "degraded" }),
			expect.objectContaining({ name: "hive", health: "ok" }),
			expect.objectContaining({ name: "nectar", health: "unreachable" }),
		]);
		doctor.statusPage.stop();
		await doctor.stop();
	});

	it("escalation isolation: a non-primary daemon's escalate() never writes the shared needs-attention.json", async () => {
		const serverA = await startMockHealthServer(okBody);
		const serverB = await startMockHealthServer(unhealthy);
		servers.push(serverA, serverB);

		const hostedEscalation = vi.fn(async () => undefined);
		const doctor = createDoctor({
			config: { ...resolveConfig({}), workspaceDir: dir },
			deviceId: "test-device-id", // hermetic: never mint/read the real device.json
			daemons: [entry("honeycomb", serverA.url), entry("nectar", serverB.url)],
			logger: silentLogger,
			clock: createFakeClock(),
			hostedEscalation,
			statusPagePort: 0,
		});
		const [ladderHoneycomb, ladderNectar] = doctor.ladders;
		expect(doctor.ladder).toBe(ladderHoneycomb);

		// The NON-primary entry (nectar) escalates. Its escalation hook must still reach the
		// hosted telemetry sink (useful signal regardless of which daemon escalated), but must NOT
		// write honeycomb's shared needs-attention.json - that file is a dashboard read seam scoped
		// to the primary honeycomb daemon, and nectar's own escalation is already durably
		// recoverable from its own incidents-nectar.ndjson shard (b-AC-1/b-AC-2 isolation).
		const result = await ladderNectar?.escalate({
			diagnosis: "nectar ladder exhausted",
			steps: [],
			recommendedAction: "manual-intervention",
			at: new Date(0).toISOString(),
		});
		expect(result?.ok).toBe(true);
		expect(hostedEscalation).toHaveBeenCalledTimes(1);
		expect(existsSync(join(dir, "needs-attention.json"))).toBe(false);

		// The primary honeycomb entry's escalate() still writes the shared file (unchanged
		// backward-compatible behavior for the sole pre-existing dashboard consumer).
		const primaryResult = await ladderHoneycomb?.escalate({
			diagnosis: "honeycomb ladder exhausted",
			steps: [],
			recommendedAction: "manual-intervention",
			at: new Date(0).toISOString(),
		});
		expect(primaryResult?.ok).toBe(true);
		expect(hostedEscalation).toHaveBeenCalledTimes(2);
		expect(existsSync(join(dir, "needs-attention.json"))).toBe(true);
		const needsAttention = JSON.parse(readFileSync(join(dir, "needs-attention.json"), "utf8")) as Record<
			string,
			unknown
		>;
		expect((needsAttention.escalation as { diagnosis: string }).diagnosis).toBe("honeycomb ladder exhausted");
	});
});
