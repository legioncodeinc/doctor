/**
 * Doctor's shared device identity (PRD-064d / PRD-033 convergence; relocated by PRD-004b).
 *
 * Every telemetry record Doctor emits carries a `device_id` so installs can be
 * told apart on the PostHog side. The id MUST be the SAME stable per-machine UUID the
 * primary daemon already mints, so the daemon and Doctor correlate to one install
 * rather than two. The record lives at the fleet root, `<root>/device.json` (ADR-0003 /
 * PRD-004b), in the shape `{ device_id, label, createdAt }` (mirroring the daemon's
 * src/daemon/runtime/assets/device.ts, PRD-033a).
 *
 * `resolveDeviceId(deps)` is the convergence point:
 *   1. read `<root>/device.json`; if it carries a non-empty `device_id`, use it.
 *   2. LEGACY-HONEYCOMB-WINDOW: otherwise read the legacy `~/.honeycomb/device.json`; a
 *      valid legacy record is best-effort COPIED (not moved) to the new location and used.
 *   3. otherwise mint a fresh `randomUUID()` and persist it in the daemon's EXACT shape
 *      so the next daemon boot reads OUR file instead of minting a competing id.
 *   4. if the dir is unwritable (or any persist step fails), return the freshly minted
 *      id WITHOUT persisting -- a telemetry id is never worth crashing the watchdog for.
 *
 * Defensive by construction (design principle 1, "incapable of crashing"): every fs
 * call is wrapped; this function NEVER throws and ALWAYS returns a usable id. Built-ins
 * only: node:fs, node:os, node:path, node:crypto (zero runtime deps).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

import { legacyHoneycombRoot, resolveApiaryRoot } from "./apiary-root.js";

/**
 * The on-disk device record, byte-for-byte the daemon's shape (PRD-033a D-1). Doctor
 * writes the SAME three fields so the daemon's `loadOrCreateDevice` reads it back cleanly.
 */
export interface DeviceRecord {
	/** The stable per-machine UUIDv4 (generated once, then persisted). */
	readonly device_id: string;
	/** A human label (defaults to the OS hostname) so a device list reads clearly. */
	readonly label: string;
	/** ISO timestamp the record was first generated. */
	readonly createdAt: string;
}

/**
 * Where the shared device record lives -- `<root>/device.json` at the fleet root (ADR-0003 /
 * PRD-004b), was `~/.honeycomb/device.json`. The honeycomb daemon reads/writes the same file
 * in the same shape; its parallel PRD retires the legacy location. Env/platform are injectable
 * so the fleet-root chain (APIARY_HOME / XDG on Linux / `<home>/.apiary`) is hermetic in tests.
 */
export function deviceFilePath(
	homeDir: string = homedir(),
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string {
	return join(resolveApiaryRoot(env, homeDir, platform), "device.json");
}

/**
 * LEGACY-HONEYCOMB-WINDOW: the legacy device record location `~/.honeycomb/device.json`
 * (PRD-004b). Read-side fallback only; removed when the window closes.
 */
export function legacyDeviceFilePath(homeDir: string = homedir()): string {
	return join(legacyHoneycombRoot(homeDir), "device.json");
}

/** A clock seam so a test pins `createdAt` deterministically. */
export type DeviceClock = () => Date;

/**
 * Injectable seams for {@link resolveDeviceId}. All optional; production defaults read the
 * real home dir and the real fs. Tests inject a temp home, a fixed clock, a fixed id, and
 * (optionally) a `readFile`/`writeFile` that throws to drive the unwritable-dir branch.
 */
export interface ResolveDeviceIdDeps {
	/** The home dir the record is rooted under (default real `~`). */
	readonly homeDir?: string;
	/** The env the fleet-root chain reads (default `process.env`). Injected for hermetic tests. */
	readonly env?: NodeJS.ProcessEnv;
	/** The platform the fleet-root chain reads (default `process.platform`). */
	readonly platform?: NodeJS.Platform;
	/** The clock for a freshly-minted `createdAt` (default real `Date`). */
	readonly clock?: DeviceClock;
	/** The label for a freshly-minted record (default the OS hostname). */
	readonly label?: () => string;
	/** The id generator (default `randomUUID`) -- injectable so a test pins the id. */
	readonly mintId?: () => string;
	/** Read seam (default `node:fs` readFileSync). Tests inject a throwing/fixture reader. */
	readonly readFile?: (path: string) => string;
	/** Make-dir seam (default `node:fs` mkdirSync). Tests inject a throwing writer. */
	readonly makeDir?: (path: string) => void;
	/** Write seam (default `node:fs` writeFileSync). Tests inject a throwing writer. */
	readonly writeFile?: (path: string, data: string) => void;
}

/** Default read seam: a plain `readFileSync` (errors propagate to the caller's try/catch). */
function defaultReadFile(path: string): string {
	return readFileSync(path, "utf-8");
}

/** Default make-dir seam: recursive `mkdirSync`. */
function defaultMakeDir(path: string): void {
	mkdirSync(path, { recursive: true });
}

/** Default write seam: a plain `writeFileSync`. */
function defaultWriteFile(path: string, data: string): void {
	writeFileSync(path, data, "utf-8");
}

/**
 * Read + validate the on-disk record, or `null` when absent/garbled. Never throws: a
 * missing file, an unreadable dir, or non-JSON content all degrade to `null` so the
 * caller mints a fresh id. A record with a missing/empty `device_id` is treated as
 * garbled (null), matching the daemon's `readDeviceRecord` discipline.
 */
function readDeviceRecord(filePath: string, readFile: (path: string) => string): DeviceRecord | null {
	try {
		const parsed = JSON.parse(readFile(filePath)) as unknown;
		if (typeof parsed !== "object" || parsed === null) return null;
		const r = parsed as Record<string, unknown>;
		if (typeof r.device_id !== "string" || r.device_id === "") return null;
		return {
			device_id: r.device_id,
			label: typeof r.label === "string" ? r.label : "",
			createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
		};
	} catch {
		// Missing file (first run), unreadable dir, or unparseable JSON: mint a fresh id.
		return null;
	}
}

/**
 * Resolve the shared device id, generating + persisting one on first run.
 *
 * Returns the persisted `device_id` when `<root>/device.json` already carries a valid one,
 * falling back to the legacy `~/.honeycomb/device.json` during the migration window (a valid
 * legacy record is best-effort copied to the new location, never moved); otherwise mints a
 * fresh `randomUUID()` and best-effort persists it in the daemon's exact
 * `{ device_id, label, createdAt }` shape so both processes converge on one id. NEVER throws
 * and ALWAYS returns a non-empty id: an unwritable dir (or any persist failure) returns the
 * freshly-minted id WITHOUT persisting -- a telemetry id is not worth crashing the
 * can't-crash watchdog for.
 */
export function resolveDeviceId(deps: ResolveDeviceIdDeps = {}): string {
	const homeDir = deps.homeDir ?? homedir();
	const env = deps.env ?? process.env;
	const platform = deps.platform ?? process.platform;
	const clock = deps.clock ?? ((): Date => new Date());
	const label = deps.label ?? ((): string => hostname());
	const mintId = deps.mintId ?? ((): string => randomUUID());
	const readFile = deps.readFile ?? defaultReadFile;
	const makeDir = deps.makeDir ?? defaultMakeDir;
	const writeFile = deps.writeFile ?? defaultWriteFile;
	const filePath = deviceFilePath(homeDir, env, platform);

	// 1. An existing, valid record at the NEW location wins -- this is the daemon-shared id.
	const existing = readDeviceRecord(filePath, readFile);
	if (existing !== null) return existing.device_id;

	// 2. LEGACY-HONEYCOMB-WINDOW: no new record yet -- fall back to the legacy
	//    `~/.honeycomb/device.json` (PRD-004b b-AC-6). A valid legacy record is best-effort
	//    COPIED (not moved) to the new location so the id stays stable across the move; the
	//    legacy file is left in place for a not-yet-migrated honeycomb daemon that still
	//    reads it. Never throws.
	const legacy = readDeviceRecord(legacyDeviceFilePath(homeDir), readFile);
	if (legacy !== null) {
		persistDeviceRecord(filePath, legacy, makeDir, writeFile);
		return legacy.device_id;
	}

	// 3. Neither location has a record: mint a fresh one in the daemon's exact shape.
	const record: DeviceRecord = {
		device_id: mintId(),
		label: label(),
		createdAt: clock().toISOString(),
	};

	// 4. Best-effort persist so the next daemon boot reads OUR file. A failure here is
	//    swallowed: we still return the freshly-minted id so telemetry has a stable value
	//    for the life of this process even when the dir is read-only.
	persistDeviceRecord(filePath, record, makeDir, writeFile);

	return record.device_id;
}

/**
 * Best-effort persist a device record to `filePath` in the daemon's exact shape. Swallows
 * every failure (unwritable dir / read-only fs): a telemetry id is never worth crashing the
 * can't-crash watchdog for.
 */
function persistDeviceRecord(
	filePath: string,
	record: DeviceRecord,
	makeDir: (path: string) => void,
	writeFile: (path: string, data: string) => void,
): void {
	try {
		makeDir(dirname(filePath));
		writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`);
	} catch {
		// Unwritable dir / wrong cwd / read-only fs: leave un-persisted. Never throw.
	}
}
