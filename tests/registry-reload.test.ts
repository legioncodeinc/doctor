/**
 * Registry live-reload trigger tests (PRD-005a, a-AC-1..9).
 *
 * Drives {@link createRegistryReloadLoop} over fully-injected seams — a fake `statMtime`
 * and a fake `resolveEntries` — so every case is deterministic and hermetic (no real fs,
 * no real timer). The two registry paths the loop stats are computed with the SAME
 * `defaultRegistryPath` / `legacyRegistryPath` the loop uses, so path assertions match
 * exactly on every platform.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, it, expect, vi, afterEach } from "vitest";

import { createRegistryReloadLoop, type RegistryReloadLoopDeps } from "../src/registry-reload.js";
import { defaultRegistryPath, legacyRegistryPath, RegistryError, type DaemonEntry } from "../src/registry.js";
import { silentLogger } from "../src/logger.js";
import type { SupervisorClock } from "../src/supervisor.js";

const HOME = "/tmp/doctor-reload-home";
const ENV: NodeJS.ProcessEnv = {};
const PLATFORM: NodeJS.Platform = "linux";

const FLEET = defaultRegistryPath(HOME, ENV, PLATFORM);
const LEGACY = legacyRegistryPath(HOME);

/** A DaemonEntry with test-friendly defaults. */
function entry(name: string, over: Partial<DaemonEntry> = {}): DaemonEntry {
	return {
		name,
		healthUrl: "http://127.0.0.1:3850/health",
		pidPath: `/tmp/${name}.pid`,
		probeIntervalMs: 30_000,
		startupGraceMs: 60_000,
		restartGiveUpThreshold: 3,
		restartCooldownMs: 5_000,
		...over,
	};
}

/** A clock whose sleep resolves immediately (loops collapse; we mostly call tick() directly). */
const immediateClock: SupervisorClock = { now: () => 0, sleep: async () => undefined };

/** Flush all pending microtasks (drives the async loop between manual clock releases). */
function flushMicrotasks(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/** Build a loop with sensible defaults; the caller overrides the seams under test. */
function makeLoop(over: Partial<RegistryReloadLoopDeps>): ReturnType<typeof createRegistryReloadLoop> {
	return createRegistryReloadLoop({
		home: HOME,
		env: ENV,
		platform: PLATFORM,
		clock: immediateClock,
		logger: silentLogger,
		intervalMs: 2_000,
		onEntries: () => {},
		onProblem: () => {},
		...over,
	});
}

describe("createRegistryReloadLoop (PRD-005a)", () => {
	it("a-AC-1: each tick stats BOTH registry locations", async () => {
		const statted: string[] = [];
		const loop = makeLoop({
			statMtime: (p) => {
				statted.push(p);
				return null;
			},
			resolveEntries: () => null,
		});
		await loop.tick();
		expect(statted).toContain(FLEET);
		expect(statted).toContain(LEGACY);
	});

	it("a-AC-2: neither location changed => strict no-op (no resolve, no onEntries)", async () => {
		const resolveEntries = vi.fn((): DaemonEntry[] => [entry("honeycomb")]);
		const onEntries = vi.fn();
		// FLEET present at a fixed mtime; LEGACY absent.
		const loop = makeLoop({ statMtime: (p) => (p === FLEET ? 100 : null), resolveEntries, onEntries });

		// First tick: baseline was absent -> FLEET now present -> a change -> resolve + onEntries.
		await loop.tick();
		expect(resolveEntries).toHaveBeenCalledTimes(1);
		expect(onEntries).toHaveBeenCalledTimes(1);

		// Second tick: identical mtime + existence -> nothing further (no re-parse, no onEntries).
		await loop.tick();
		expect(resolveEntries).toHaveBeenCalledTimes(1);
		expect(onEntries).toHaveBeenCalledTimes(1);
	});

	it("a-AC-3: a changed file re-resolves and passes the resolved entries to the reconcile callback", async () => {
		let fleetMtime = 100;
		let legacyMtime: number | null = null;
		const entries = [entry("honeycomb"), entry("hive")];
		const resolveEntries = vi.fn((): DaemonEntry[] => entries);
		const onEntries = vi.fn();
		const loop = makeLoop({
			statMtime: (p) => (p === FLEET ? fleetMtime : legacyMtime),
			resolveEntries,
			onEntries,
		});

		await loop.tick(); // absent -> present: change
		expect(onEntries).toHaveBeenCalledWith(entries);
		expect(onEntries).toHaveBeenCalledTimes(1);

		// The FLEET mtime advances -> another change -> re-resolve.
		fleetMtime = 200;
		await loop.tick();
		expect(resolveEntries).toHaveBeenCalledTimes(2);
		expect(onEntries).toHaveBeenCalledTimes(2);

		// A change in the LEGACY location ALSO triggers a re-resolve (both locations are gated).
		legacyMtime = 50;
		await loop.tick();
		expect(resolveEntries).toHaveBeenCalledTimes(3);
		expect(onEntries).toHaveBeenCalledTimes(3);
	});

	it("a-AC-4: a changed-but-unparseable file preserves the set (no onEntries), does not advance mtimes, records the problem once", async () => {
		let fail = true;
		const parseError = new RegistryError("registry file is not valid JSON", FLEET);
		const resolveEntries = vi.fn((): DaemonEntry[] => {
			if (fail) throw parseError;
			return [entry("honeycomb")];
		});
		const onEntries = vi.fn();
		const onProblem = vi.fn();
		const loop = makeLoop({ statMtime: (p) => (p === FLEET ? 100 : null), resolveEntries, onEntries, onProblem });

		await loop.tick(); // changed -> resolve throws
		expect(onEntries).not.toHaveBeenCalled(); // the live set is NEVER torn down
		expect(onProblem).toHaveBeenCalledWith("registry file is not valid JSON", FLEET);
		expect(resolveEntries).toHaveBeenCalledTimes(1);

		// mtimes were NOT advanced, so the next tick re-attempts the SAME (still-changed) file.
		await loop.tick();
		expect(resolveEntries).toHaveBeenCalledTimes(2);
		// ...but the problem is logged + recorded ONCE per distinct failure, not every tick.
		expect(onProblem).toHaveBeenCalledTimes(1);
		expect(onEntries).not.toHaveBeenCalled();
	});

	it("a-AC-5: a previously-malformed file that parses again resolves normally and signals recovery", async () => {
		let fail = true;
		const resolveEntries = vi.fn((): DaemonEntry[] => {
			if (fail) throw new RegistryError("bad", FLEET);
			return [entry("honeycomb")];
		});
		const onEntries = vi.fn();
		const onProblem = vi.fn();
		const onRecovered = vi.fn();
		const loop = makeLoop({
			statMtime: (p) => (p === FLEET ? 100 : null),
			resolveEntries,
			onEntries,
			onProblem,
			onRecovered,
		});

		await loop.tick(); // fails
		expect(onProblem).toHaveBeenCalledTimes(1);
		expect(onRecovered).not.toHaveBeenCalled();

		// The file is fixed: the same still-changed mtime is re-attempted and now parses.
		fail = false;
		await loop.tick();
		expect(onEntries).toHaveBeenCalledTimes(1);
		expect(onRecovered).toHaveBeenCalledTimes(1); // banner clears
	});

	it("a-AC-6: on reload it NEVER falls back to the honeycomb primary (unlike boot) — the live set is preserved", async () => {
		// The ONLY registry present is malformed. Boot would fall back to a honeycomb-primary
		// entry; reload must NOT — it calls onEntries with nothing, preserving whatever the
		// caller is already supervising.
		const onEntries = vi.fn();
		const loop = makeLoop({
			statMtime: (p) => (p === FLEET ? 100 : null),
			resolveEntries: () => {
				throw new RegistryError("malformed", FLEET);
			},
			onEntries,
		});
		await loop.tick();
		expect(onEntries).not.toHaveBeenCalled(); // no honeycomb-primary fallback list ever produced
	});

	it("a-AC-7: the loop sleeps for the injected interval (the config knob is honored)", async () => {
		const slept: number[] = [];
		let loopHandle: ReturnType<typeof createRegistryReloadLoop>;
		const clock: SupervisorClock = {
			now: () => 0,
			sleep: async (ms: number) => {
				slept.push(ms);
				loopHandle.stop(); // stop after the first interval so the spin ends
			},
		};
		loopHandle = makeLoop({ clock, intervalMs: 4_321, statMtime: () => null, resolveEntries: () => null });
		loopHandle.arm();
		await flushMicrotasks();
		expect(slept[0]).toBe(4_321);
	});

	it("a-AC-8: stop() disarms the loop (idempotent) and it stops ticking; the loop is driven by the injected clock", async () => {
		const pending: Array<() => void> = [];
		const clock: SupervisorClock = {
			now: () => 0,
			sleep: () => new Promise<void>((resolve) => pending.push(resolve)),
		};
		let statCalls = 0;
		const loop = makeLoop({
			clock,
			statMtime: () => {
				statCalls += 1;
				return null;
			},
			resolveEntries: () => null,
		});

		loop.arm(); // seeds the baseline: 2 stats (fleet + legacy), then parks on the first sleep
		await flushMicrotasks();
		expect(statCalls).toBe(2);

		// Release the first interval -> one tick runs (2 more stats), then parks again.
		pending.shift()?.();
		await flushMicrotasks();
		expect(statCalls).toBe(4);

		// Disarm (idempotent) then release the pending sleep: the loop breaks WITHOUT ticking.
		loop.stop();
		loop.stop();
		pending.shift()?.();
		await flushMicrotasks();
		expect(statCalls).toBe(4); // no further tick after stop()
	});

	it("a-AC-9: any exception in the stat/read path is swallowed and the loop continues on the next tick", async () => {
		let boom = true;
		const onEntries = vi.fn();
		const loop = makeLoop({
			statMtime: (p) => {
				if (boom && p === FLEET) throw new Error("stat exploded");
				return p === FLEET ? 100 : null;
			},
			resolveEntries: () => [entry("honeycomb")],
			onEntries,
		});

		await expect(loop.tick()).resolves.toBeUndefined(); // swallowed: never throws out
		expect(onEntries).not.toHaveBeenCalled();

		// A later healthy tick recovers cleanly.
		boom = false;
		await loop.tick();
		expect(onEntries).toHaveBeenCalledTimes(1);
	});
});

/**
 * SECURITY (PRD-005 threat model #1 — the registry is an EXTERNAL input written by installers,
 * and doctor now RE-READS it at runtime): prove the reload path re-runs the SAME defensive
 * input coercions boot runs, so a field a boot-time read would have neutralized is neutralized
 * identically on a POST-BOOT registry write. This drives the loop through its REAL production
 * resolver (no injected `resolveEntries`/`statMtime` seams) over a real on-disk registry, so a
 * future change that lets reload bypass `resolveRegistryEntries` -> `parseEntry` -> the coercions
 * (turning the watchdog into an SSRF or arbitrary-file-read primitive via a tampered registry)
 * fails this test loudly.
 */
describe("createRegistryReloadLoop (PRD-005) — reload re-runs the boot input coercions", () => {
	const secTmp: string[] = [];
	afterEach(() => {
		for (const d of secTmp.splice(0)) rmSync(d, { recursive: true, force: true });
	});
	function secHome(): string {
		const d = mkdtempSync(join(tmpdir(), "doctor-reload-sec-"));
		secTmp.push(d);
		return d;
	}

	it("coerces a NON-loopback healthUrl (SSRF gate) and DROPS a containment-escaping telemetryDbPath on the reload path", async () => {
		const home = secHome();
		const env: NodeJS.ProcessEnv = {};
		const platform = process.platform;
		const registryPath = defaultRegistryPath(home, env, platform);

		// A registry written AFTER boot that a malicious installer / tampering could produce: a
		// non-loopback (cloud link-local metadata) healthUrl doctor would otherwise probe on a
		// timer, and an absolute telemetryDbPath that escapes every trusted telemetry root (it is
		// under $HOME but NOT under `<root>/<name>/telemetry` nor the legacy honeycomb root), which
		// would otherwise let the poll loop open an arbitrary user-readable SQLite file.
		const poisonedTelemetry = join(home, "outside", "secret.db");
		mkdirSync(dirname(registryPath), { recursive: true });
		writeFileSync(
			registryPath,
			JSON.stringify({
				daemons: [
					{
						name: "nectar",
						healthUrl: "http://169.254.169.254/health", // off-loopback SSRF target
						telemetryDbPath: poisonedTelemetry, // escapes the trusted telemetry roots
					},
				],
			}),
			"utf8",
		);

		let received: DaemonEntry[] | null = null;
		// NOTE: no `statMtime` / `resolveEntries` seams -> the loop uses the REAL node:fs stat and
		// the REAL `resolveRegistryEntries` (the exact production reload path).
		const loop = createRegistryReloadLoop({
			home,
			env,
			platform,
			clock: immediateClock,
			logger: silentLogger,
			intervalMs: 2_000,
			onEntries: (entries) => {
				received = entries;
			},
			onProblem: () => {},
		});

		await loop.tick(); // baseline was absent -> file now present -> real resolve + coerce

		expect(received).not.toBeNull();
		const entries = received as unknown as DaemonEntry[];
		const nectar = entries.find((e) => e.name === "nectar");
		expect(nectar).toBeDefined();
		// SSRF gate held on reload: the off-loopback host was replaced with the safe loopback default,
		// so doctor never probes 169.254.169.254 from a post-boot registry write.
		expect(nectar?.healthUrl).toBe("http://127.0.0.1:3850/health");
		expect(nectar?.healthUrl).not.toContain("169.254.169.254");
		// Path-containment held on reload: an out-of-bounds telemetryDbPath degrades to "no telemetry"
		// (undefined), so the poll loop never opens the arbitrary file.
		expect(nectar?.telemetryDbPath).toBeUndefined();
	});
});
