/**
 * Doctor's lifecycle CAPTURE-EVENT emitter (PostHog events, not logs).
 *
 * The existing 064d chokepoint ({@link file://./emit.ts}) posts OTLP LOGS to
 * `{host}/i/v1/logs`. Logs are not events: the operator's install/update funnel
 * needs PostHog CAPTURE events on `{host}/i/v0/e/`, the same endpoint honeycomb's
 * own funnel uses (parent src/daemon/runtime/telemetry/emit.ts, PRD-050e). This
 * module is that second, event-shaped egress path for exactly three lifecycle
 * moments:
 *
 *   - `doctor_installed`   - the service-install verb completed (once per machine)
 *   - `doctor_updated`     - the update engine landed a new primary version (once per to_version)
 *   - `doctor_uninstalled` - the service-uninstall verb started (fire-and-forget)
 *
 * ── Gates, in order (IDENTICAL to emit.ts so opt-out is one contract) ────────
 *   1. Empty key (un-keyed dev build / no env fallback)  -> hard-disabled.
 *   2. DO_NOT_TRACK set                                  -> opted out.
 *   3. HONEYCOMB_TELEMETRY=0                             -> opted out.
 *   4. state.json `telemetryDisabled: true` (via deps)   -> opted out.
 * Any gate hit: nothing leaves the box. The key/host are the SAME build-injected
 * constants ({@link POSTHOG_KEY} / {@link POSTHOG_HOST}) the log chokepoint reads.
 *
 * ── Fire-and-forget, fail-soft ───────────────────────────────────────────────
 * The POST is one bounded AbortController-timed request (2s default) wrapped in a
 * try/catch that swallows everything. Every function here resolves a structured
 * {@link CaptureOutcome}; NOTHING throws and NOTHING blocks a host verb.
 *
 * ── Closed property allow-list ───────────────────────────────────────────────
 * The payload is BUILT from typed inputs by {@link buildCaptureProperties}; only
 * {@link CAPTURE_ALLOWED_PROPERTY_KEYS} can appear. NO paths, tokens, or hostnames
 * are representable: there is no free-form property input at all.
 *
 * ── distinct_id ──────────────────────────────────────────────────────────────
 * Prefer the shared installer id at `<root>/install-id` at the fleet root, falling back
 * to the legacy `~/.honeycomb/install-id` during the migration window (ADR-0003 /
 * PRD-004b; the writer is the installer), so doctor's lifecycle correlates with the
 * operator's install funnel. When neither file has a value, fall back to doctor's
 * stable per-install device id (PRD-033 UUID).
 *
 * Built-ins only: node:os, node:fs, node:path (zero runtime deps).
 */

import { readFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";

import { legacyHoneycombRoot, resolveApiaryRoot } from "../apiary-root.js";
import { resolveDeviceId } from "../device-id.js";
import type { StateStore } from "../state.js";
import { DOCTOR_VERSION } from "../version.js";
import {
	DEFAULT_EMIT_TIMEOUT_MS,
	POSTHOG_HOST,
	POSTHOG_KEY,
	isOptedOut,
	type TelemetryFetch,
} from "./emit.js";

// ────────────────────────────────────────────────────────────────────────────
// The capture endpoint (pinned, mirrors the parent's PRD-050e constant)
// ────────────────────────────────────────────────────────────────────────────

/**
 * The pinned PostHog capture path. The full ingest URL is `${host}${path}` and
 * the body is `{ api_key, event, properties, distinct_id }`, byte-compatible
 * with honeycomb's own capture chokepoint so both funnels land in one project.
 */
export const POSTHOG_CAPTURE_PATH = "/i/v0/e/" as const;

/** Build the full capture URL from a host string. */
export function captureUrl(host: string = POSTHOG_HOST): string {
	return `${host.replace(/\/+$/, "")}${POSTHOG_CAPTURE_PATH}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Event names + the closed property allow-list
// ────────────────────────────────────────────────────────────────────────────

/** The three lifecycle capture events doctor may ever emit. */
export type LifecycleEventName = "doctor_installed" | "doctor_updated" | "doctor_uninstalled";

/**
 * The CLOSED allow-list of capture property keys. The payload is built from
 * typed inputs ONLY ({@link buildCaptureProperties}); there is no free-form
 * property path, so nothing outside this list can ever leave the machine.
 *
 *   `package`      - always the literal "doctor"
 *   `version`      - doctor's own package version
 *   `os` / `arch` / `node` - coarse platform facts (never a hostname)
 *   `from_version` - the pre-update primary version (updated event only)
 *   `to_version`   - the post-update primary version (updated event only)
 *   `outcome`      - the update outcome label (updated event only)
 */
export const CAPTURE_ALLOWED_PROPERTY_KEYS = [
	"package",
	"version",
	"os",
	"arch",
	"node",
	"from_version",
	"to_version",
	"outcome",
] as const;

/** One allow-listed capture property key. */
export type CaptureAllowedPropertyKey = (typeof CAPTURE_ALLOWED_PROPERTY_KEYS)[number];

/** The allow-listed property bag: the EXACT shape that may leave the machine. */
export type CaptureProperties = Partial<Record<CaptureAllowedPropertyKey, string>>;

/**
 * Assemble the allow-listed capture payload from TYPED inputs. `package` is the
 * hardcoded literal; the platform facts are coarse (OS family, CPU arch, node
 * version, never a hostname); the from/to/outcome triple appears only when the
 * caller (the updated event) supplies it. There is deliberately NO `extra` bag:
 * a property not named here is structurally impossible.
 */
export function buildCaptureProperties(input: {
	readonly version: string;
	readonly fromVersion?: string;
	readonly toVersion?: string;
	readonly outcome?: string;
}): CaptureProperties {
	const out: CaptureProperties = {
		package: "doctor",
		version: input.version,
		os: platform(),
		arch: arch(),
		node: process.version,
	};
	if (input.fromVersion !== undefined && input.fromVersion !== "") out.from_version = input.fromVersion;
	if (input.toVersion !== undefined && input.toVersion !== "") out.to_version = input.toVersion;
	if (input.outcome !== undefined && input.outcome !== "") out.outcome = input.outcome;
	return out;
}

// ────────────────────────────────────────────────────────────────────────────
// distinct_id resolution (install-id preferred, device id fallback)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Where the shared install id lives: `<root>/install-id` at the fleet root (ADR-0003 /
 * PRD-004b), a bare UUID written by install.sh / install.ps1. doctor is a READER only; the
 * installer (superproject work) writes the new location. Env/platform are injectable so the
 * fleet-root chain is hermetic in tests.
 */
export function installIdFilePath(
	homeDir?: string,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string {
	return join(resolveApiaryRoot(env, homeDir, platform), "install-id");
}

/**
 * LEGACY-HONEYCOMB-WINDOW: the legacy shared install-id location `~/.honeycomb/install-id`
 * (PRD-004b). Read-side fallback only; removed when the window closes.
 */
export function legacyInstallIdFilePath(homeDir?: string): string {
	return join(legacyHoneycombRoot(homeDir), "install-id");
}

/** Injectable seams for {@link resolveDistinctId}. All optional. */
export interface DistinctIdDeps {
	/** The home dir the install-id file is rooted under (default real `~`). */
	readonly homeDir?: string;
	/** The env the fleet-root chain reads (default `process.env`). Injected for hermetic tests. */
	readonly env?: NodeJS.ProcessEnv;
	/** The platform the fleet-root chain reads (default `process.platform`). */
	readonly platform?: NodeJS.Platform;
	/** Read seam (default `node:fs` readFileSync). Tests inject a fixture reader. */
	readonly readFile?: (path: string) => string;
	/** A pre-resolved device id fallback. Default: {@link resolveDeviceId} (never throws). */
	readonly deviceId?: string;
}

/**
 * Resolve the capture `distinct_id`. Prefer the shared installer id: read `<root>/install-id`
 * first, then (LEGACY-HONEYCOMB-WINDOW) the legacy `~/.honeycomb/install-id`, when present and
 * non-empty -- this is what correlates doctor's lifecycle with the operator install funnel
 * across the ADR-0003 move (PRD-004b b-AC-7). Otherwise fall back to doctor's stable
 * per-install device id (PRD-033 UUID). NEVER throws and ALWAYS returns a non-empty id.
 */
export function resolveDistinctId(deps: DistinctIdDeps = {}): string {
	const readFile = deps.readFile ?? ((path: string): string => readFileSync(path, "utf-8"));
	const env = deps.env ?? process.env;
	const platform = deps.platform ?? process.platform;
	// New location first, then the legacy location for the migration window.
	const candidates = [installIdFilePath(deps.homeDir, env, platform), legacyInstallIdFilePath(deps.homeDir)];
	for (const candidate of candidates) {
		try {
			const raw = readFile(candidate).trim();
			if (raw !== "") return raw;
		} catch {
			// Missing file / unreadable dir: try the next candidate, then the device id.
		}
	}
	if (deps.deviceId !== undefined && deps.deviceId !== "") return deps.deviceId;
	try {
		return resolveDeviceId(deps.homeDir !== undefined ? { homeDir: deps.homeDir, env, platform } : { env, platform });
	} catch {
		// resolveDeviceId is itself defensive; this is the absolute last-resort net.
		return "unknown-device";
	}
}

// ────────────────────────────────────────────────────────────────────────────
// The capture emit (gates + one bounded POST, fail-soft)
// ────────────────────────────────────────────────────────────────────────────

/** The injectable deps for {@link emitCaptureEvent}. All default to production seams. */
export interface CaptureDeps {
	/** Network seam. Defaults to the global `fetch` (Node 22 built-in). */
	readonly fetch?: TelemetryFetch;
	/** The env the opt-out gate reads. Defaults to `process.env`. */
	readonly env?: NodeJS.ProcessEnv;
	/** Override the build-injected PostHog key (tests inject a fake non-secret value). */
	readonly posthogKey?: string;
	/** Override the PostHog host (tests use a fake URL so no real network is hit). */
	readonly posthogHost?: string;
	/** POST timeout in ms. Defaults to 2000 (2s), same bound as the log chokepoint. */
	readonly timeoutMs?: number;
	/** The state.json telemetry-disabled flag (same gate as emit.ts, OD-5). */
	readonly stateTelemetryDisabled?: boolean;
}

/** Why a capture emit did not send. Resolved, never thrown. */
export type CaptureSkipReason =
	| "disabled" // empty key (no build injection)
	| "opted_out" // DO_NOT_TRACK / HONEYCOMB_TELEMETRY=0 / state toggle
	| "already_reported" // lifecycle dedupe marker hit
	| "send_failed"; // network/sink error, swallowed

/** The outcome of a capture emit (resolved, never rejected). */
export interface CaptureOutcome {
	/** True iff the POST returned 2xx. */
	readonly sent: boolean;
	/** Present when `sent` is false. */
	readonly skipped?: CaptureSkipReason;
}

/**
 * Apply the shared gates (the SAME order and contract as emit.ts): empty key,
 * env opt-out, state toggle. Returns the skip reason, or null when clear to send.
 * Exposed so the lifecycle helpers can gate BEFORE touching the dedupe store.
 */
export function captureGate(deps: CaptureDeps): CaptureSkipReason | null {
	const key = deps.posthogKey ?? POSTHOG_KEY;
	if (key.length === 0) return "disabled";
	if (isOptedOut(deps.env ?? process.env)) return "opted_out";
	if (deps.stateTelemetryDisabled === true) return "opted_out";
	return null;
}

/**
 * Emit ONE lifecycle capture event: gates, then a single bounded POST of
 * `{ api_key, event, properties, distinct_id }` to `{host}/i/v0/e/`. Fail-soft
 * and fire-and-forget: NEVER throws, NEVER rejects, never hangs past the timeout.
 */
export async function emitCaptureEvent(
	event: LifecycleEventName,
	properties: CaptureProperties,
	distinctId: string,
	deps: CaptureDeps = {},
): Promise<CaptureOutcome> {
	const gate = captureGate(deps);
	if (gate !== null) return { sent: false, skipped: gate };

	const key = deps.posthogKey ?? POSTHOG_KEY;
	const host = deps.posthogHost ?? POSTHOG_HOST;
	const timeoutMs = deps.timeoutMs ?? DEFAULT_EMIT_TIMEOUT_MS;
	const doFetch = deps.fetch ?? (globalThis.fetch as unknown as TelemetryFetch);

	const body = JSON.stringify({ api_key: key, event, properties, distinct_id: distinctId });

	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort();
	}, timeoutMs);
	try {
		const resp = await doFetch(captureUrl(host), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
			signal: controller.signal,
		});
		return resp.ok ? { sent: true } : { sent: false, skipped: "send_failed" };
	} catch {
		// Timeout / network error / broken seam: a dropped lifecycle event is acceptable;
		// a blocked install/update/uninstall verb is not.
		return { sent: false, skipped: "send_failed" };
	} finally {
		clearTimeout(timer);
	}
}

// ────────────────────────────────────────────────────────────────────────────
// The lifecycle helpers (dedupe markers live in the existing state store)
// ────────────────────────────────────────────────────────────────────────────

/** Construction deps for {@link createLifecycleTelemetry}. */
export interface LifecycleTelemetryDeps {
	/**
	 * The existing doctor state store carrying the dedupe markers
	 * (`installedEventReported` / `updatedEventReportedVersion`). Read/write are
	 * both defensive (never throw) by the store's own contract.
	 */
	readonly stateStore: StateStore;
	/** doctor's own version stamped into every payload (default {@link DOCTOR_VERSION}). */
	readonly version?: string;
	/** distinct_id seams (install-id file location + device-id fallback). */
	readonly distinctId?: DistinctIdDeps;
	/** The capture emit seams (fetch / env / key / host / timeout / state toggle). */
	readonly capture?: CaptureDeps;
}

/** The lifecycle capture surface the CLI verbs + the update seam call. */
export interface LifecycleTelemetry {
	/**
	 * Emit `doctor_installed` ONCE per machine. A persisted marker in the state
	 * store means a re-install never re-fires. Resolves the outcome; never throws.
	 */
	installed(): Promise<CaptureOutcome>;
	/**
	 * Emit `doctor_updated` for a successful update outcome, deduped per
	 * `toVersion` (the same target version never reports twice). Never throws.
	 */
	updated(fromVersion: string, toVersion: string, outcome: "updated" | "updated_unverified"): Promise<CaptureOutcome>;
	/** Emit `doctor_uninstalled` (no dedupe; fire-and-forget). Never throws. */
	uninstalled(): Promise<CaptureOutcome>;
}

/**
 * Build the lifecycle capture surface over the existing state store. Every method
 * is total: gates first (no disk read when disabled/opted out), then the dedupe
 * marker, then ONE bounded fail-soft POST; the marker persists only on a 2xx so a
 * dropped send retries on the next trigger.
 */
export function createLifecycleTelemetry(deps: LifecycleTelemetryDeps): LifecycleTelemetry {
	const version = deps.version ?? DOCTOR_VERSION;
	const captureDeps = deps.capture ?? {};
	const distinctId = (): string => resolveDistinctId(deps.distinctId);

	return {
		async installed(): Promise<CaptureOutcome> {
			try {
				const gate = captureGate(captureDeps);
				if (gate !== null) return { sent: false, skipped: gate };
				const state = deps.stateStore.read();
				if (state.installedEventReported === true) return { sent: false, skipped: "already_reported" };
				const outcome = await emitCaptureEvent(
					"doctor_installed",
					buildCaptureProperties({ version }),
					distinctId(),
					captureDeps,
				);
				if (outcome.sent) deps.stateStore.write({ ...state, installedEventReported: true });
				return outcome;
			} catch {
				// Defensive net: no lifecycle emit may ever disturb the install verb.
				return { sent: false, skipped: "send_failed" };
			}
		},

		async updated(
			fromVersion: string,
			toVersion: string,
			outcome: "updated" | "updated_unverified",
		): Promise<CaptureOutcome> {
			try {
				const gate = captureGate(captureDeps);
				if (gate !== null) return { sent: false, skipped: gate };
				const state = deps.stateStore.read();
				if (state.updatedEventReportedVersion === toVersion) return { sent: false, skipped: "already_reported" };
				const result = await emitCaptureEvent(
					"doctor_updated",
					buildCaptureProperties({ version, fromVersion, toVersion, outcome }),
					distinctId(),
					captureDeps,
				);
				if (result.sent) deps.stateStore.write({ ...state, updatedEventReportedVersion: toVersion });
				return result;
			} catch {
				// Defensive net: no lifecycle emit may ever disturb the update transaction.
				return { sent: false, skipped: "send_failed" };
			}
		},

		async uninstalled(): Promise<CaptureOutcome> {
			try {
				const gate = captureGate(captureDeps);
				if (gate !== null) return { sent: false, skipped: gate };
				return await emitCaptureEvent(
					"doctor_uninstalled",
					buildCaptureProperties({ version }),
					distinctId(),
					captureDeps,
				);
			} catch {
				// Defensive net: no lifecycle emit may ever disturb the uninstall verb.
				return { sent: false, skipped: "send_failed" };
			}
		},
	};
}
