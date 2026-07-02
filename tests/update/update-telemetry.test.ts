/**
 * The update/rollback telemetry seam (PRD-064e AC-064e.5). The default seam adapts onto
 * the 064d chokepoint; this test injects a fake fetch (no network) and asserts the
 * from/to/outcome triple reaches the OTLP body through the existing allow-list.
 */

import { describe, expect, it } from "vitest";

import type { LifecycleTelemetry } from "../../src/telemetry/capture.js";
import type { TelemetryFetchInit, TelemetryFetchResponse } from "../../src/telemetry/emit.js";
import { createDefaultUpdateEmit } from "../../src/update/update-telemetry.js";

/** A fake telemetry fetch recording the POST body so we can assert what left the box. */
function recordingFetch(): {
	fetch: (url: string, init: TelemetryFetchInit) => Promise<TelemetryFetchResponse>;
	bodies: string[];
} {
	const bodies: string[] = [];
	return {
		bodies,
		fetch: async (_url, init) => {
			bodies.push(init.body);
			return { ok: true, status: 200 };
		},
	};
}

describe("createDefaultUpdateEmit (AC-064e.5)", () => {
	it("routes an update event through the 064d chokepoint with from/to/outcome encoded", async () => {
		const rec = recordingFetch();
		// Inject a fake key + host + fetch so the chokepoint's gates pass and no network is hit.
		const emit = createDefaultUpdateEmit({
			fetch: rec.fetch,
			posthogKey: "test-key",
			posthogHost: "https://telemetry.test",
			env: {}, // no opt-out env
		});

		await emit({
			kind: "update",
			fromVersion: "0.1.7",
			toVersion: "0.1.9",
			outcome: "updated",
			deviceId: "device-abc",
			timestampMs: 1_700_000_000_000,
		});

		expect(rec.bodies).toHaveLength(1);
		const body = rec.bodies[0] ?? "";
		// The from/to/outcome fact string survived into the OTLP payload.
		expect(body).toContain("from=0.1.7;to=0.1.9;outcome=updated");
		expect(body).toContain("auto_update_updated");
	});

	it("is fail-soft: an opted-out env drops the event without throwing", async () => {
		const rec = recordingFetch();
		const emit = createDefaultUpdateEmit({
			fetch: rec.fetch,
			posthogKey: "test-key",
			env: { HONEYCOMB_TELEMETRY: "0" }, // opted out
		});
		await expect(
			emit({
				kind: "rollback",
				fromVersion: "0.1.9",
				toVersion: "0.1.7",
				outcome: "rolled_back",
				deviceId: "device-abc",
				timestampMs: 1,
			}),
		).resolves.toBeUndefined();
		// Nothing left the box.
		expect(rec.bodies).toHaveLength(0);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// The ADDITIVE hivedoctor_updated capture leg (lifecycle telemetry)
// ────────────────────────────────────────────────────────────────────────────

/** A lifecycle recorder stub capturing every updated() call. */
function lifecycleRecorder(options: { throwOnUpdated?: boolean } = {}): {
	lifecycle: LifecycleTelemetry;
	updatedCalls: Array<{ from: string; to: string; outcome: string }>;
} {
	const updatedCalls: Array<{ from: string; to: string; outcome: string }> = [];
	return {
		updatedCalls,
		lifecycle: {
			async installed() {
				return { sent: true };
			},
			async updated(from, to, outcome) {
				if (options.throwOnUpdated === true) throw new Error("broken lifecycle stub");
				updatedCalls.push({ from, to, outcome });
				return { sent: true };
			},
			async uninstalled() {
				return { sent: true };
			},
		},
	};
}

describe("createDefaultUpdateEmit: additive hivedoctor_updated capture leg", () => {
	const emitDeps = { posthogKey: "test-key", posthogHost: "https://telemetry.test", env: {} };

	it("fires lifecycle.updated on a successful 'updated' outcome AND keeps the OTLP log", async () => {
		const rec = recordingFetch();
		const lc = lifecycleRecorder();
		const emit = createDefaultUpdateEmit({ ...emitDeps, fetch: rec.fetch }, lc.lifecycle);

		await emit({
			kind: "update",
			fromVersion: "0.1.7",
			toVersion: "0.1.9",
			outcome: "updated",
			deviceId: "device-abc",
			timestampMs: 1,
		});

		// The pre-existing OTLP log leg is untouched (still exactly one log POST).
		expect(rec.bodies).toHaveLength(1);
		expect(rec.bodies[0] ?? "").toContain("from=0.1.7;to=0.1.9;outcome=updated");
		// The additive capture leg fired with the from/to/outcome triple.
		expect(lc.updatedCalls).toEqual([{ from: "0.1.7", to: "0.1.9", outcome: "updated" }]);
	});

	it("fires lifecycle.updated on 'updated_unverified' too", async () => {
		const rec = recordingFetch();
		const lc = lifecycleRecorder();
		const emit = createDefaultUpdateEmit({ ...emitDeps, fetch: rec.fetch }, lc.lifecycle);

		await emit({
			kind: "update",
			fromVersion: "0.1.7",
			toVersion: "0.1.9",
			outcome: "updated_unverified",
			deviceId: "device-abc",
			timestampMs: 1,
		});

		expect(lc.updatedCalls).toEqual([{ from: "0.1.7", to: "0.1.9", outcome: "updated_unverified" }]);
	});

	it("does NOT fire on a failed install", async () => {
		const rec = recordingFetch();
		const lc = lifecycleRecorder();
		const emit = createDefaultUpdateEmit({ ...emitDeps, fetch: rec.fetch }, lc.lifecycle);

		await emit({
			kind: "update",
			fromVersion: "0.1.7",
			toVersion: "0.1.9",
			outcome: "install_failed",
			deviceId: "device-abc",
			timestampMs: 1,
		});

		expect(lc.updatedCalls).toHaveLength(0);
		// The OTLP log leg still records the failure fact.
		expect(rec.bodies).toHaveLength(1);
	});

	it("does NOT fire on a rollback event", async () => {
		const rec = recordingFetch();
		const lc = lifecycleRecorder();
		const emit = createDefaultUpdateEmit({ ...emitDeps, fetch: rec.fetch }, lc.lifecycle);

		await emit({
			kind: "rollback",
			fromVersion: "0.1.9",
			toVersion: "0.1.7",
			outcome: "rolled_back",
			deviceId: "device-abc",
			timestampMs: 1,
		});

		expect(lc.updatedCalls).toHaveLength(0);
	});

	it("a THROWING lifecycle stub never rejects the emit seam", async () => {
		const rec = recordingFetch();
		const lc = lifecycleRecorder({ throwOnUpdated: true });
		const emit = createDefaultUpdateEmit({ ...emitDeps, fetch: rec.fetch }, lc.lifecycle);

		await expect(
			emit({
				kind: "update",
				fromVersion: "0.1.7",
				toVersion: "0.1.9",
				outcome: "updated",
				deviceId: "device-abc",
				timestampMs: 1,
			}),
		).resolves.toBeUndefined();
		// The OTLP log still went out despite the broken capture leg.
		expect(rec.bodies).toHaveLength(1);
	});
});
