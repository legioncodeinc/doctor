/**
 * Tests for the lifecycle capture-event emitter (src/telemetry/capture.ts).
 *
 * All tests use an injected fetch recorder (never hits the network), an in-memory
 * state store (never touches disk), and injected distinct-id seams (a fake HOME +
 * read seam, consistent with the device-id tests). Coverage:
 *
 *   - gates: empty key disabled, DO_NOT_TRACK, HONEYCOMB_TELEMETRY=0, state toggle
 *   - payload shape: {api_key, event, properties, distinct_id} to {host}/i/v0/e/
 *   - closed allow-list: no paths / tokens / hostnames representable
 *   - dedupe: installed once per machine; updated once per to_version;
 *     a failed send does NOT persist the marker (retries next trigger)
 *   - distinct_id preference: install-id file present vs absent (device-id fallback)
 *   - fail-soft: a throwing fetch resolves send_failed, never rejects
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_STATE, type DoctorState, type StateStore } from "../../src/state.js";
import {
	CAPTURE_ALLOWED_PROPERTY_KEYS,
	POSTHOG_CAPTURE_PATH,
	buildCaptureProperties,
	captureUrl,
	createLifecycleTelemetry,
	emitCaptureEvent,
	installIdFilePath,
	resolveDistinctId,
	type CaptureDeps,
} from "../../src/telemetry/capture.js";
import type { TelemetryFetch, TelemetryFetchInit } from "../../src/telemetry/emit.js";

// ────────────────────────────────────────────────────────────────────────────
// Shared test fixtures
// ────────────────────────────────────────────────────────────────────────────

const FAKE_KEY = "test-fake-key-not-real";
const FAKE_HOST = "https://test.posthog.example";
const FAKE_HOME = "/home/test";
const FAKE_DEVICE_ID = "a1b2c3d4-0000-0000-0000-000000000001";
const FAKE_INSTALL_ID = "11111111-2222-3333-4444-555555555555";
const FAKE_VERSION = "0.1.0-test";

/** Build a mock fetch that records calls and returns a fixed status. */
function makeMockFetch(status = 200) {
	const calls: Array<{ url: string; init: TelemetryFetchInit }> = [];
	const mock: TelemetryFetch = async (url, init) => {
		calls.push({ url, init });
		return { ok: status >= 200 && status < 300, status };
	};
	return { mock, calls };
}

/** The minimal capture deps (key set so the "disabled" gate is not hit). */
function testCaptureDeps(overrides: Partial<CaptureDeps> = {}): CaptureDeps {
	const { mock } = makeMockFetch();
	return {
		posthogKey: FAKE_KEY,
		posthogHost: FAKE_HOST,
		fetch: mock,
		env: {},
		...overrides,
	};
}

/** An in-memory StateStore fake recording every write (no disk). */
function memoryStateStore(initial: Partial<DoctorState> = {}) {
	let state: DoctorState = { ...DEFAULT_STATE, ...initial };
	const writes: DoctorState[] = [];
	const store: StateStore = {
		read: () => state,
		write: (next: DoctorState) => {
			state = next;
			writes.push(next);
		},
	};
	return {
		store,
		writes,
		get state() {
			return state;
		},
	};
}

/** Distinct-id seams where the install-id file is ABSENT (read throws ENOENT). */
function distinctIdAbsent() {
	return {
		homeDir: FAKE_HOME,
		readFile: (): string => {
			throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		},
		deviceId: FAKE_DEVICE_ID,
	};
}

/** Distinct-id seams where the install-id file is PRESENT with the shared id. */
function distinctIdPresent() {
	return {
		homeDir: FAKE_HOME,
		readFile: (): string => `${FAKE_INSTALL_ID}\n`,
		deviceId: FAKE_DEVICE_ID,
	};
}

/** Build a lifecycle emitter over the fakes. Returns the recorder handles too. */
function buildLifecycle(options: {
	readonly initialState?: Partial<DoctorState>;
	readonly captureOverrides?: Partial<CaptureDeps>;
	readonly installIdPresent?: boolean;
} = {}) {
	const { mock, calls } = makeMockFetch();
	const memory = memoryStateStore(options.initialState ?? {});
	const lifecycle = createLifecycleTelemetry({
		stateStore: memory.store,
		version: FAKE_VERSION,
		distinctId: options.installIdPresent === true ? distinctIdPresent() : distinctIdAbsent(),
		capture: testCaptureDeps({ fetch: mock, ...options.captureOverrides }),
	});
	return { lifecycle, calls, memory };
}

/** Parse the recorded capture body. */
function parseBody(init: TelemetryFetchInit): {
	api_key: string;
	event: string;
	properties: Record<string, string>;
	distinct_id: string;
} {
	return JSON.parse(init.body) as {
		api_key: string;
		event: string;
		properties: Record<string, string>;
		distinct_id: string;
	};
}

// ────────────────────────────────────────────────────────────────────────────
// Gates (the SAME contract as the log chokepoint)
// ────────────────────────────────────────────────────────────────────────────

describe("capture gates", () => {
	it("empty PostHog key -> disabled, nothing sent, no store touched", async () => {
		const { mock, calls } = makeMockFetch();
		const memory = memoryStateStore();
		const lifecycle = createLifecycleTelemetry({
			stateStore: memory.store,
			version: FAKE_VERSION,
			distinctId: distinctIdAbsent(),
			capture: { posthogKey: "", fetch: mock, env: {} },
		});
		const outcome = await lifecycle.installed();
		expect(outcome.sent).toBe(false);
		expect(outcome.skipped).toBe("disabled");
		expect(calls).toHaveLength(0);
		expect(memory.writes).toHaveLength(0);
	});

	it("DO_NOT_TRACK=1 -> opted_out, nothing sent", async () => {
		const { lifecycle, calls } = buildLifecycle({ captureOverrides: { env: { DO_NOT_TRACK: "1" } } });
		const outcome = await lifecycle.installed();
		expect(outcome.sent).toBe(false);
		expect(outcome.skipped).toBe("opted_out");
		expect(calls).toHaveLength(0);
	});

	it("HONEYCOMB_TELEMETRY=0 -> opted_out, nothing sent", async () => {
		const { lifecycle, calls } = buildLifecycle({ captureOverrides: { env: { HONEYCOMB_TELEMETRY: "0" } } });
		const outcome = await lifecycle.updated("0.1.7", "0.1.9", "updated");
		expect(outcome.sent).toBe(false);
		expect(outcome.skipped).toBe("opted_out");
		expect(calls).toHaveLength(0);
	});

	it("stateTelemetryDisabled=true -> opted_out, nothing sent", async () => {
		const { lifecycle, calls } = buildLifecycle({ captureOverrides: { stateTelemetryDisabled: true } });
		const outcome = await lifecycle.uninstalled();
		expect(outcome.sent).toBe(false);
		expect(outcome.skipped).toBe("opted_out");
		expect(calls).toHaveLength(0);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Payload shape + endpoint
// ────────────────────────────────────────────────────────────────────────────

describe("capture payload shape", () => {
	it("posts {api_key, event, properties, distinct_id} to {host}/i/v0/e/", async () => {
		const { lifecycle, calls } = buildLifecycle();
		const outcome = await lifecycle.installed();
		expect(outcome.sent).toBe(true);
		expect(calls).toHaveLength(1);
		const call = calls[0];
		if (!call) throw new Error("no call");
		expect(call.url).toBe(`${FAKE_HOST}${POSTHOG_CAPTURE_PATH}`);
		expect(call.init.method).toBe("POST");
		expect(call.init.headers["Content-Type"]).toBe("application/json");
		const body = parseBody(call.init);
		expect(body.api_key).toBe(FAKE_KEY);
		expect(body.event).toBe("doctor_installed");
		expect(body.distinct_id).toBe(FAKE_DEVICE_ID);
		expect(body.properties["package"]).toBe("doctor");
		expect(body.properties["version"]).toBe(FAKE_VERSION);
		expect(typeof body.properties["os"]).toBe("string");
		expect(typeof body.properties["arch"]).toBe("string");
		expect(typeof body.properties["node"]).toBe("string");
	});

	it("only allow-listed property keys ever appear (closed set)", async () => {
		const { lifecycle, calls } = buildLifecycle();
		await lifecycle.updated("0.1.7", "0.1.9", "updated");
		const call = calls[0];
		if (!call) throw new Error("no call");
		const body = parseBody(call.init);
		const allowed: readonly string[] = CAPTURE_ALLOWED_PROPERTY_KEYS;
		for (const key of Object.keys(body.properties)) {
			expect(allowed, `unexpected property key "${key}"`).toContain(key);
		}
	});

	it("no banned key/value shapes (paths, tokens, hostnames) appear in the payload", async () => {
		const { lifecycle, calls } = buildLifecycle();
		await lifecycle.installed();
		await lifecycle.updated("0.1.7", "0.1.9", "updated_unverified");
		await lifecycle.uninstalled();
		const all = calls.map((c) => c.init.body).join("\n");
		for (const banned of ["token", "bearer", "authorization", "path", "cwd", "hostname", "secret", "password"]) {
			expect(all, `banned key "${banned}" found in payload`).not.toContain(`"${banned}"`);
		}
	});

	it("doctor_updated carries from_version/to_version/outcome", async () => {
		const { lifecycle, calls } = buildLifecycle();
		await lifecycle.updated("0.1.7", "0.1.9", "updated");
		const call = calls[0];
		if (!call) throw new Error("no call");
		const body = parseBody(call.init);
		expect(body.event).toBe("doctor_updated");
		expect(body.properties["from_version"]).toBe("0.1.7");
		expect(body.properties["to_version"]).toBe("0.1.9");
		expect(body.properties["outcome"]).toBe("updated");
	});

	it("captureUrl strips trailing slashes before appending the pinned path", () => {
		expect(captureUrl("https://x.example//")).toBe("https://x.example/i/v0/e/");
	});

	it("buildCaptureProperties never emits empty-string from/to/outcome", () => {
		const props = buildCaptureProperties({ version: FAKE_VERSION, fromVersion: "", toVersion: "", outcome: "" });
		expect(props.from_version).toBeUndefined();
		expect(props.to_version).toBeUndefined();
		expect(props.outcome).toBeUndefined();
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Dedupe semantics
// ────────────────────────────────────────────────────────────────────────────

describe("dedupe semantics", () => {
	it("installed fires once per machine: the second call is already_reported", async () => {
		const { lifecycle, calls, memory } = buildLifecycle();
		const first = await lifecycle.installed();
		expect(first.sent).toBe(true);
		expect(memory.state.installedEventReported).toBe(true);

		const second = await lifecycle.installed();
		expect(second.sent).toBe(false);
		expect(second.skipped).toBe("already_reported");
		expect(calls).toHaveLength(1);
	});

	it("a pre-persisted installed marker suppresses the event (re-install no-op)", async () => {
		const { lifecycle, calls } = buildLifecycle({ initialState: { installedEventReported: true } });
		const outcome = await lifecycle.installed();
		expect(outcome.sent).toBe(false);
		expect(outcome.skipped).toBe("already_reported");
		expect(calls).toHaveLength(0);
	});

	it("a FAILED installed send does NOT persist the marker (retries next trigger)", async () => {
		const { mock, calls } = makeMockFetch(500);
		const memory = memoryStateStore();
		const lifecycle = createLifecycleTelemetry({
			stateStore: memory.store,
			version: FAKE_VERSION,
			distinctId: distinctIdAbsent(),
			capture: testCaptureDeps({ fetch: mock }),
		});
		const outcome = await lifecycle.installed();
		expect(outcome.sent).toBe(false);
		expect(outcome.skipped).toBe("send_failed");
		expect(memory.writes).toHaveLength(0);
		expect(memory.state.installedEventReported).toBeUndefined();
		expect(calls).toHaveLength(1);
	});

	it("updated dedupes per to_version: the same target never reports twice", async () => {
		const { lifecycle, calls, memory } = buildLifecycle();
		const first = await lifecycle.updated("0.1.7", "0.1.9", "updated");
		expect(first.sent).toBe(true);
		expect(memory.state.updatedEventReportedVersion).toBe("0.1.9");

		const repeat = await lifecycle.updated("0.1.7", "0.1.9", "updated");
		expect(repeat.sent).toBe(false);
		expect(repeat.skipped).toBe("already_reported");
		expect(calls).toHaveLength(1);
	});

	it("updated fires again for a DIFFERENT to_version", async () => {
		const { lifecycle, calls } = buildLifecycle({ initialState: { updatedEventReportedVersion: "0.1.9" } });
		const outcome = await lifecycle.updated("0.1.9", "0.2.0", "updated_unverified");
		expect(outcome.sent).toBe(true);
		expect(calls).toHaveLength(1);
		const call = calls[0];
		if (!call) throw new Error("no call");
		expect(parseBody(call.init).properties["to_version"]).toBe("0.2.0");
	});

	it("uninstalled has no dedupe: every call fires", async () => {
		const { lifecycle, calls } = buildLifecycle();
		await lifecycle.uninstalled();
		await lifecycle.uninstalled();
		expect(calls).toHaveLength(2);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// distinct_id preference (install-id file vs device-id fallback)
// ────────────────────────────────────────────────────────────────────────────

describe("distinct_id preference", () => {
	it("prefers the shared installer id when ~/.honeycomb/install-id exists", async () => {
		const { lifecycle, calls } = buildLifecycle({ installIdPresent: true });
		await lifecycle.installed();
		const call = calls[0];
		if (!call) throw new Error("no call");
		expect(parseBody(call.init).distinct_id).toBe(FAKE_INSTALL_ID);
	});

	it("falls back to the device id when the install-id file is absent", async () => {
		const { lifecycle, calls } = buildLifecycle({ installIdPresent: false });
		await lifecycle.installed();
		const call = calls[0];
		if (!call) throw new Error("no call");
		expect(parseBody(call.init).distinct_id).toBe(FAKE_DEVICE_ID);
	});

	it("resolveDistinctId reads the install-id file under the injected HOME", () => {
		const readPaths: string[] = [];
		const id = resolveDistinctId({
			homeDir: FAKE_HOME,
			readFile: (path: string): string => {
				readPaths.push(path);
				return FAKE_INSTALL_ID;
			},
			deviceId: FAKE_DEVICE_ID,
		});
		expect(id).toBe(FAKE_INSTALL_ID);
		expect(readPaths).toEqual([installIdFilePath(FAKE_HOME)]);
	});

	it("an empty/whitespace install-id file falls back to the device id", () => {
		const id = resolveDistinctId({
			homeDir: FAKE_HOME,
			readFile: (): string => "  \n",
			deviceId: FAKE_DEVICE_ID,
		});
		expect(id).toBe(FAKE_DEVICE_ID);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Fail-soft posture
// ────────────────────────────────────────────────────────────────────────────

describe("fail-soft posture", () => {
	it("a throwing fetch resolves send_failed, never rejects", async () => {
		const throwingFetch: TelemetryFetch = async () => {
			throw new Error("ECONNREFUSED");
		};
		const outcome = await emitCaptureEvent(
			"doctor_uninstalled",
			buildCaptureProperties({ version: FAKE_VERSION }),
			FAKE_DEVICE_ID,
			testCaptureDeps({ fetch: throwingFetch }),
		);
		expect(outcome.sent).toBe(false);
		expect(outcome.skipped).toBe("send_failed");
	});

	it("a broken (synchronously-throwing) fetch seam is swallowed too", async () => {
		const brokenFetch: TelemetryFetch = () => {
			throw new TypeError("fetch is not a function");
		};
		const outcome = await emitCaptureEvent(
			"doctor_installed",
			buildCaptureProperties({ version: FAKE_VERSION }),
			FAKE_DEVICE_ID,
			testCaptureDeps({ fetch: brokenFetch }),
		);
		expect(outcome.sent).toBe(false);
		expect(outcome.skipped).toBe("send_failed");
	});

	it("a throwing state store never propagates out of the lifecycle helpers", async () => {
		const { mock } = makeMockFetch();
		const brokenStore: StateStore = {
			read: () => {
				throw new Error("EACCES");
			},
			write: () => {
				throw new Error("EACCES");
			},
		};
		const lifecycle = createLifecycleTelemetry({
			stateStore: brokenStore,
			version: FAKE_VERSION,
			distinctId: distinctIdAbsent(),
			capture: testCaptureDeps({ fetch: mock }),
		});
		await expect(lifecycle.installed()).resolves.toEqual({ sent: false, skipped: "send_failed" });
		await expect(lifecycle.updated("1", "2", "updated")).resolves.toEqual({ sent: false, skipped: "send_failed" });
	});
});
