/**
 * Supervisor-set reconciliation tests (PRD-005b, b-AC-1..10).
 *
 * Drives {@link reconcileSupervisors} over fake {@link BuiltDaemon}s whose supervisors
 * record arm/stop/armStartupGrace, so the diff (add / remove / update / no-op), the
 * primary invariant, and the telemetry entry-set update are asserted precisely — no real
 * supervisor, probe, or filesystem. Because reconcile performs ZERO filesystem I/O, the
 * "removal never deletes a shard / never signals the process" guarantee (b-AC-5) holds by
 * construction: there is no fs seam to call.
 */

import { describe, it, expect } from "vitest";

import { reconcileSupervisors, type BuiltDaemon, type ReconcileDeps } from "../src/registry-reconcile.js";
import type { DaemonEntry } from "../src/registry.js";
import type { HealthClassification } from "../src/health-probe.js";
import type { RemediationLadder } from "../src/remediation.js";
import type { StateStore } from "../src/state.js";
import type { Supervisor } from "../src/supervisor.js";
import { silentLogger } from "../src/logger.js";

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

/** Per-supervisor call counters. */
interface Calls {
	grace: number;
	stop: number;
	arm: number;
}

/** A fake supervisor recording the reconcile-relevant calls. */
function fakeSupervisor(calls: Calls): Supervisor {
	return {
		armStartupGrace: () => {
			calls.grace += 1;
		},
		start: async (): Promise<void> => {
			calls.arm += 1;
		},
		stop: () => {
			calls.stop += 1;
		},
		tick: async (): Promise<HealthClassification> => ({ kind: "ok" }),
	};
}

/** A fake BuiltDaemon (ladder/stateStore are never touched by reconcile). */
function makeBuilt(e: DaemonEntry): { built: BuiltDaemon; calls: Calls } {
	const calls: Calls = { grace: 0, stop: 0, arm: 0 };
	const built: BuiltDaemon = {
		entry: e,
		supervisor: fakeSupervisor(calls),
		ladder: {} as RemediationLadder,
		stateStore: {} as StateStore,
	};
	return { built, calls };
}

/** A test harness holding the current map + recording deps. */
interface Harness {
	current: Map<string, BuiltDaemon>;
	deps: ReconcileDeps;
	buildCalls: DaemonEntry[];
	armed: string[];
	telemetryUpdates: DaemonEntry[][];
	callsFor(name: string): Calls;
	getPrimary(): BuiltDaemon;
}

/** Seed a harness with an initial supervised set (first entry is the compose primary). */
function setup(initial: DaemonEntry[], opts: { failBuildFor?: Set<string> } = {}): Harness {
	const current = new Map<string, BuiltDaemon>();
	const callsByName = new Map<string, Calls>();
	const buildCalls: DaemonEntry[] = [];
	const armed: string[] = [];
	const telemetryUpdates: DaemonEntry[][] = [];

	const buildDaemon = (e: DaemonEntry): BuiltDaemon => {
		if (opts.failBuildFor?.has(e.name)) throw new Error(`build failed for ${e.name}`);
		buildCalls.push(e);
		const { built, calls } = makeBuilt(e);
		callsByName.set(e.name, calls); // latest wins (a rebuild replaces the tracked calls)
		return built;
	};

	for (const e of initial) current.set(e.name, buildDaemon(e));
	let primary: BuiltDaemon = current.get(initial[0]?.name ?? "")!;
	buildCalls.length = 0; // ignore the seeding builds

	const deps: ReconcileDeps = {
		buildDaemon,
		armDaemon: (b) => {
			armed.push(b.entry.name);
		},
		logger: silentLogger,
		updateTelemetryEntries: (entries) => telemetryUpdates.push([...entries]),
		primaryName: "honeycomb",
		getPrimary: () => primary,
		setPrimary: (b) => {
			primary = b;
		},
	};

	return {
		current,
		deps,
		buildCalls,
		armed,
		telemetryUpdates,
		callsFor: (name) => callsByName.get(name)!,
		getPrimary: () => primary,
	};
}

describe("reconcileSupervisors (PRD-005b)", () => {
	it("b-AC-1: a new name is built, its startup grace is armed, and its watch loop is armed", () => {
		const h = setup([entry("honeycomb")]);
		reconcileSupervisors(h.current, [entry("honeycomb"), entry("nectar")], h.deps);

		expect(h.buildCalls.map((e) => e.name)).toEqual(["nectar"]); // only the new one is built
		expect(h.armed).toEqual(["nectar"]); // its loop is armed
		expect(h.callsFor("nectar").grace).toBe(1); // startup grace armed (not immediately escalated)
		expect(h.current.has("nectar")).toBe(true);
	});

	it("b-AC-2: an added entry is reflected in the reconciled set fed to the telemetry poll loop", () => {
		const h = setup([entry("honeycomb")]);
		reconcileSupervisors(h.current, [entry("honeycomb"), entry("nectar", { telemetryDbPath: "/tmp/x/nectar/telemetry/db" })], h.deps);

		const latest = h.telemetryUpdates.at(-1) ?? [];
		expect(latest.map((e) => e.name).sort()).toEqual(["honeycomb", "nectar"]);
	});

	it("b-AC-3: successive reloads converge to the full onboarding set [hive, honeycomb, nectar]", () => {
		const h = setup([entry("hive")]);
		reconcileSupervisors(h.current, [entry("hive"), entry("honeycomb")], h.deps);
		reconcileSupervisors(h.current, [entry("hive"), entry("honeycomb"), entry("nectar")], h.deps);
		expect([...h.current.keys()].sort()).toEqual(["hive", "honeycomb", "nectar"]);
	});

	it("b-AC-4/b-AC-5: a removed non-primary name is stopped + dropped (stop-watching only, never killed)", () => {
		const h = setup([entry("honeycomb"), entry("nectar")]);
		const nectarCalls = h.callsFor("nectar");
		reconcileSupervisors(h.current, [entry("honeycomb")], h.deps);

		expect(nectarCalls.stop).toBe(1); // supervisor stopped
		expect(h.current.has("nectar")).toBe(false); // dropped from the live set
		// "stop watching, not kill": only stop() was invoked — no restart/probe, and reconcile has
		// no filesystem access, so state-nectar.json / incidents-nectar.ndjson are left untouched.
		expect(nectarCalls.arm).toBe(0);
		expect(nectarCalls.grace).toBe(0);
	});

	it("b-AC-6: a primary field change rebuilds honeycomb in place and re-points the primary reference", () => {
		const h = setup([entry("honeycomb"), entry("hive")]);
		const oldPrimary = h.getPrimary();
		const oldPrimaryCalls = h.callsFor("honeycomb");

		reconcileSupervisors(
			h.current,
			[entry("honeycomb", { healthUrl: "http://127.0.0.1:9999/health" }), entry("hive")],
			h.deps,
		);

		const rebuilt = h.current.get("honeycomb")!;
		expect(rebuilt).not.toBe(oldPrimary); // rebuilt in place
		expect(oldPrimaryCalls.stop).toBe(1); // old primary supervisor stopped
		expect(h.getPrimary()).toBe(rebuilt); // process-global surfaces re-pointed, never dangling
		expect(h.buildCalls.map((e) => e.name)).toEqual(["honeycomb"]); // ONLY honeycomb rebuilt
	});

	it("b-AC-7: a transient omission of honeycomb keeps the primary slot; it is re-adopted on reappearance", () => {
		const h = setup([entry("honeycomb"), entry("hive")]);
		const honeycombCalls = h.callsFor("honeycomb");
		const telemetryBefore = h.telemetryUpdates.length;

		// A reload that transiently omits honeycomb (another writer mid-update).
		reconcileSupervisors(h.current, [entry("hive")], h.deps);
		expect(h.current.has("honeycomb")).toBe(true); // NOT torn down
		expect(honeycombCalls.stop).toBe(0);
		expect(h.getPrimary().entry.name).toBe("honeycomb"); // still bound
		// Nothing was added/removed/updated, so the telemetry set is not churned (honeycomb keeps
		// being polled, hive unchanged).
		expect(h.telemetryUpdates.length).toBe(telemetryBefore);

		// honeycomb reappears with identical fields -> re-adopted as a no-op.
		reconcileSupervisors(h.current, [entry("honeycomb"), entry("hive")], h.deps);
		expect(h.current.has("honeycomb")).toBe(true);
		expect(honeycombCalls.stop).toBe(0);
	});

	it("b-AC-8: an identical entry (name + every field) leaves its supervisor exactly as-is", () => {
		const h = setup([entry("honeycomb"), entry("hive")]);
		const honeycombCalls = h.callsFor("honeycomb");
		const hiveCalls = h.callsFor("hive");

		reconcileSupervisors(h.current, [entry("honeycomb"), entry("hive")], h.deps);

		expect(h.buildCalls).toEqual([]); // no rebuild
		expect(h.armed).toEqual([]); // no re-arm
		expect(honeycombCalls.stop + honeycombCalls.grace + honeycombCalls.arm).toBe(0); // untouched
		expect(hiveCalls.stop + hiveCalls.grace + hiveCalls.arm).toBe(0);
		expect(h.telemetryUpdates).toEqual([]); // no churn on an unchanged reconcile
	});

	it("b-AC-9: a changed field rebuilds ONLY that supervisor; the shard persists by name; every other is untouched", () => {
		const h = setup([entry("honeycomb"), entry("hive"), entry("nectar")]);
		const honeycombCalls = h.callsFor("honeycomb");
		const hiveOldCalls = h.callsFor("hive");
		const nectarCalls = h.callsFor("nectar");
		const oldHive = h.current.get("hive")!;

		reconcileSupervisors(
			h.current,
			[entry("honeycomb"), entry("hive", { probeIntervalMs: 12_345 }), entry("nectar")],
			h.deps,
		);

		// Only hive was rebuilt (stop old -> build new -> arm). buildDaemon was called with name
		// "hive", so the real factory reads state-hive.json by name — the shard persists across the
		// rebuild (no remediation history lost).
		expect(h.buildCalls.map((e) => e.name)).toEqual(["hive"]);
		expect(hiveOldCalls.stop).toBe(1);
		const newHive = h.current.get("hive")!;
		expect(newHive).not.toBe(oldHive);
		expect(h.callsFor("hive").grace).toBe(1); // new hive's grace armed
		expect(h.armed).toEqual(["hive"]);
		// Every OTHER supervisor is untouched.
		expect(honeycombCalls.stop + honeycombCalls.arm + honeycombCalls.grace).toBe(0);
		expect(nectarCalls.stop + nectarCalls.arm + nectarCalls.grace).toBe(0);
	});

	it("b-AC-10: a failing build for ONE entry is isolated; the rest of the reconcile still applies and it never throws", () => {
		const h = setup([entry("honeycomb")], { failBuildFor: new Set(["bad"]) });

		expect(() =>
			reconcileSupervisors(h.current, [entry("honeycomb"), entry("bad"), entry("nectar")], h.deps),
		).not.toThrow();

		// The throwing entry is skipped; honeycomb (no-op) and nectar (added) are unaffected.
		expect(h.current.has("bad")).toBe(false);
		expect(h.current.has("nectar")).toBe(true);
		expect(h.armed).toContain("nectar");
	});

	it("b-AC-10: a throwing supervisor.stop during a removal is isolated; the rest still applies", () => {
		const h = setup([entry("honeycomb"), entry("boom"), entry("nectar")]);
		// Make the boom supervisor's stop throw.
		const boom = h.current.get("boom")!;
		(boom.supervisor as { stop: () => void }).stop = () => {
			throw new Error("stop exploded");
		};

		expect(() => reconcileSupervisors(h.current, [entry("honeycomb"), entry("nectar")], h.deps)).not.toThrow();
		// Despite the throwing stop, boom is still dropped and the rest is intact.
		expect(h.current.has("boom")).toBe(false);
		expect(h.current.has("honeycomb")).toBe(true);
		expect(h.current.has("nectar")).toBe(true);
	});
	it("b-AC-10: a throwing buildDaemon on an UPDATE builds BEFORE stopping — the old supervisor is kept, never stopped (CodeRabbit review)", () => {
		const failSet = new Set<string>();
		const h = setup([entry("honeycomb"), entry("hive")], { failBuildFor: failSet });
		const oldHive = h.current.get("hive")!;
		const oldHiveCalls = h.callsFor("hive");
		// From here on, rebuilding hive throws — so the UPDATE below hits the build failure.
		failSet.add("hive");

		// A CHANGED hive entry (different healthUrl) => UPDATE path => buildDaemon("hive") throws.
		expect(() =>
			reconcileSupervisors(
				h.current,
				[entry("honeycomb"), entry("hive", { healthUrl: "http://127.0.0.1:9999/health" })],
				h.deps,
			),
		).not.toThrow();

		// Build-before-stop: the failed rebuild leaves the OLD hive supervisor running (never
		// stopped) and still in the map — no dead-but-referenced daemon.
		expect(oldHiveCalls.stop).toBe(0);
		expect(h.current.get("hive")).toBe(oldHive);
	});
	it("b-AC-10 / b-AC-6: a throwing buildDaemon on the PRIMARY update keeps the old primary (never a dangling stopped ref)", () => {
		const failSet = new Set<string>();
		const h = setup([entry("honeycomb"), entry("nectar")], { failBuildFor: failSet });
		const oldPrimary = h.getPrimary();
		const oldPrimaryCalls = h.callsFor("honeycomb");
		failSet.add("honeycomb");

		expect(() =>
			reconcileSupervisors(
				h.current,
				[entry("honeycomb", { healthUrl: "http://127.0.0.1:9999/health" }), entry("nectar")],
				h.deps,
			),
		).not.toThrow();

		// The old primary supervisor is untouched: not stopped, still the primary, still in the map.
		expect(oldPrimaryCalls.stop).toBe(0);
		expect(h.getPrimary()).toBe(oldPrimary);
		expect(h.current.get("honeycomb")).toBe(oldPrimary);
	});
});
