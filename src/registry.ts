/**
 * Doctor supervised-daemon registry (PRD-004a; extended by doctor PRD-001a).
 *
 * doctor no longer supervises a single hard-coded daemon: it reads a static JSON
 * registry file on boot and spawns one supervisor per listed daemon. This module owns
 * the registry file's schema and its DEFENSIVE parse.
 *
 * PRD-001a adds ONE new OPTIONAL field, {@link DaemonEntry.telemetryDbPath}: the path to
 * the service's own runtime telemetry SQLite database (ADR-0002 decision 1). This is
 * purely additive -- every PRD-004a field, `coerceName`/`coerceHealthUrl`/`coercePidPath`,
 * and the interval coercions are UNCHANGED. An entry with no `telemetryDbPath` is
 * health-probe-only (a-AC-2): the poll loop (`ingestion/poll-loop.ts`) skips SQLite
 * ingestion for it, preserving every existing PRD-004a behavior exactly.
 *
 * The registry file is an EXTERNAL input, so it is validated at this boundary. It is
 * hand-validated with node built-ins ONLY, mirroring the defensive-parse posture of
 * `src/config.ts` (PRD-004a a-AC-3) rather than reaching for a runtime schema library:
 * doctor is a "can't-crash" watchdog with ZERO runtime dependencies by design
 * (design principle 1, documented in `src/config.ts` and `src/state.ts`), so zod is
 * deliberately not used here just as it is not used in `config.ts`/`state.ts`. The
 * parse is total: a missing OPTIONAL field on an otherwise-valid entry resolves to the
 * built-in default (a-AC-3), never a crash.
 *
 * Two failure postures, both deliberate:
 *   - file ABSENT       -> the registry is additive over the existing single-daemon
 *                          behavior, so a missing file must NOT wedge the watchdog. The
 *                          low-level {@link readRegistryFile} returns null; the boot-time
 *                          {@link loadRegistry} falls back to the honeycomb primary at its
 *                          built-in defaults (a-AC-2).
 *   - file MALFORMED    -> a present-but-broken file (unparseable JSON, wrong shape,
 *                          empty/garbage `daemons`, a bad entry `name`) fails LOUDLY with
 *                          a {@link RegistryError}. Silently supervising nothing would hide
 *                          a real misconfiguration.
 *
 * Built-ins only: node:fs + node:os + node:path.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
	apiaryProductDir,
	defaultHoneycombPidPath,
	legacyHoneycombRoot,
	legacyTelemetryRoot,
	productTelemetryRoot,
	resolveApiaryRoot,
} from "./apiary-root.js";
import { DEFAULTS } from "./config.js";
import { assertWithinBase } from "./safe-path.js";

/** The three known workload daemons doctor supervises. Names are parsed permissively (any filename-safe token) and narrowed against this list where useful. */
export const KNOWN_DAEMON_NAMES = ["honeycomb", "hive", "nectar"] as const;

/** A known workload-daemon name. */
export type KnownDaemonName = (typeof KNOWN_DAEMON_NAMES)[number];

/**
 * One fully-resolved registry entry: the per-daemon supervision parameters that used to
 * live once on {@link import("./config.js").DoctorConfig} for the single honeycomb
 * daemon. `pidPath` has had any leading `~` expanded to the home directory.
 */
export interface DaemonEntry {
	/** The daemon's registry name; a filename-safe token used to key its state/incident shards. */
	readonly name: string;
	/** The daemon's `/health` URL. */
	readonly healthUrl: string;
	/** The daemon's PID/lock file (leading `~` already expanded). */
	readonly pidPath: string;
	/** How often this daemon's supervisor probes `/health`, in ms. */
	readonly probeIntervalMs: number;
	/** Cold-boot / post-restart grace window for this daemon, in ms. */
	readonly startupGraceMs: number;
	/** Consecutive failed restarts before this daemon's ladder advances off rung 1. */
	readonly restartGiveUpThreshold: number;
	/** Cooldown after a restart doctor performed for this daemon, in ms. */
	readonly restartCooldownMs: number;
	/**
	 * Optional path to this service's runtime telemetry SQLite database (leading `~`
	 * already expanded and the value resolved to a validated ABSOLUTE path; a relative
	 * path is rejected at parse time). Absent means health-probe-only: no SQLite
	 * ingestion for this entry (PRD-001a a-AC-2). doctor only ever opens this database
	 * READ-ONLY (ADR-0001 decision 4, PRD-001b b-AC-3); it never creates or writes it.
	 */
	readonly telemetryDbPath?: string;
}

/** Options for {@link loadRegistry}. */
export interface LoadRegistryOptions {
	/** Override the registry file path (default: {@link defaultRegistryPath}). */
	readonly registryPath?: string;
	/** Override the home directory used for `~` expansion + the default path (default: `homedir()`). */
	readonly home?: string;
}

/**
 * Thrown when a PRESENT registry file is malformed. Fails loudly on purpose: an absent
 * file is a supported fallback (a-AC-2), but a broken file must not be silently treated
 * as "supervise nothing". doctor's boot catches this at the top level and reports it.
 */
export class RegistryError extends Error {
	/**
	 * The registry file the error is about, when known. Set by {@link readRegistryFile} so a
	 * caller surfacing the failure (the compose needs-attention banner) can name the file that
	 * is ACTUALLY malformed, which mid-window may be the legacy file rather than the new one.
	 */
	registryPath?: string;

	constructor(message: string, registryPath?: string) {
		super(message);
		this.name = "RegistryError";
		if (registryPath !== undefined) this.registryPath = registryPath;
	}
}

/** A filename-safe daemon name: a leading alphanumeric then alphanumerics, dashes, underscores. */
const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/**
 * The default registry file location: the fleet-shared `<root>/registry.json` (ADR-0003 /
 * PRD-004b), where `<root>` is the neutral fleet root resolved by {@link resolveApiaryRoot}.
 * Was `~/.honeycomb/doctor.daemons.json`; the shape is unchanged, only the location moves.
 */
export function defaultRegistryPath(
	home: string = homedir(),
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string {
	return join(resolveApiaryRoot(env, home, platform), "registry.json");
}

/**
 * LEGACY-HONEYCOMB-WINDOW: the pre-migration registry location
 * `~/.honeycomb/doctor.daemons.json` (PRD-004b). Read-side fallback + one-time-migration
 * source only; removed when ADR-0003's window closes.
 */
export function legacyRegistryPath(home: string = homedir()): string {
	return join(legacyHoneycombRoot(home), "doctor.daemons.json");
}

/**
 * LEGACY-HONEYCOMB-WINDOW: the name the legacy registry is renamed to after a successful
 * one-time migration (PRD-004b default, confirmed). Kept (never deleted) so nothing
 * unrecovered is ever destroyed, and it stops the merge rule from re-reading a stale copy.
 */
export function migratedLegacyRegistryPath(home: string = homedir()): string {
	return `${legacyRegistryPath(home)}.migrated`;
}

/**
 * The honeycomb primary entry at BUILT-IN defaults, used as the a-AC-2 fallback when the
 * registry file is absent. Mirrors {@link DEFAULTS} + the default PID path from
 * `config.ts`.
 */
export function honeycombFallbackEntry(
	home: string = homedir(),
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): DaemonEntry {
	return {
		name: "honeycomb",
		healthUrl: DEFAULTS.healthUrl,
		// PRD-004c: new-first `<root>/honeycomb/daemon.pid`, legacy-fallback aware.
		pidPath: defaultHoneycombPidPath(resolveApiaryRoot(env, home, platform), home),
		probeIntervalMs: DEFAULTS.probeIntervalMs,
		startupGraceMs: DEFAULTS.startupGraceMs,
		restartGiveUpThreshold: DEFAULTS.restartGiveUpThreshold,
		restartCooldownMs: DEFAULTS.restartCooldownMs,
	};
}

/** Expand a leading `~` (or `~/` / `~\`) to the home directory; leave any other path unchanged. */
function expandTilde(path: string, home: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
	return path;
}

/** Coerce a positive-integer field, falling back on anything that is not a finite integer > 0. */
function coercePositiveInt(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Coerce a non-negative-integer field (cooldown may legitimately be 0), falling back otherwise. */
function coerceNonNegativeInt(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

/**
 * Trusted loopback hostnames a probed `healthUrl` may resolve to. Mirrors hive's
 * `isLoopbackBaseUrl` allow-list (`src/shared/daemon-routing.ts`) so both watchdog surfaces
 * share one loopback-trust model.
 */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Coerce a `/health` URL: must parse as an http/https URL whose host is loopback, else
 * fall back to the default.
 *
 * SECURITY (SSRF, PRD-004a): the registry file is an EXTERNAL input written by installers.
 * doctor FETCHES this URL every probe interval and reflects the daemon's reachability on
 * the loopback status page. A tampered registry (or a malicious installer) with a NON-loopback
 * `healthUrl` would turn the watchdog into a server-side-request-forgery primitive: it would
 * fetch an attacker-controlled origin from the user's machine on a timer. Restricting the host
 * to loopback here is defense in depth, mirroring hive's `isLoopbackBaseUrl` gate on its
 * daemon bases (hive PRD-001 security fix). A non-loopback host silently falls back to the
 * safe loopback default rather than ever probing it, matching this module's defensive posture.
 */
function coerceHealthUrl(value: unknown, fallback: string): string {
	if (typeof value !== "string" || value.trim() === "") return fallback;
	try {
		const url = new URL(value.trim());
		if (url.protocol !== "http:" && url.protocol !== "https:") return fallback;
		// Loopback-only: never probe (and never reflect) an off-loopback origin from the registry.
		if (!LOOPBACK_HOSTNAMES.has(url.hostname)) return fallback;
		return url.toString();
	} catch {
		// Unparseable URL: keep the safe default rather than probing junk (mirrors config.ts).
		return fallback;
	}
}

/** Coerce a PID path: a non-empty string with `~` expanded, else the default. */
function coercePidPath(value: unknown, home: string, fallback: string): string {
	if (typeof value !== "string" || value.trim() === "") return fallback;
	return expandTilde(value.trim(), home);
}

/**
 * Coerce the OPTIONAL `telemetryDbPath` field (PRD-001a): a non-empty string with `~`
 * expanded, or `undefined` when absent/garbage. Unlike the other fields there is no
 * built-in default to fall back to -- an absent or invalid value means "no SQLite
 * telemetry for this service; probe `/health` only" (a-AC-2), which is a valid, common
 * state (every legacy PRD-004a entry has no such field) rather than an error.
 *
 * SECURITY (arbitrary-file-read via a poisoned registry, security-review finding): a
 * registry entry with an unconstrained `telemetryDbPath` would let doctor open ANY
 * user-readable SQLite file and, if it happens to carry Contract-B-shaped tables, poll
 * and forward its contents over the unauthenticated loopback SSE stream (`/events`).
 * The path must live under a TRUSTED telemetry root; this coercion enforces that
 * containment with {@link assertWithinBase} (the same defense-in-depth helper `pidPath`'s
 * composed paths already route through elsewhere in this codebase). A path that escapes
 * every trusted root degrades to `undefined` (health-probe-only), mirroring
 * `coerceHealthUrl`'s fallback-on-invalid-input posture -- never a crash, never a
 * silently-honored escape.
 *
 * PRD-004c (ADR-0003 migration): the single legacy root `~/.honeycomb/telemetry/` is
 * replaced by an ORDERED set of trusted roots, WITHOUT weakening containment:
 *   - `<root>/<entry-name>/telemetry` bound to THIS entry's OWN validated product name
 *     (the tight per-own-name default, PRD-004c); an entry may not point at another
 *     product's telemetry dir, matching "no product writes into another product's subdir".
 *   - LEGACY-HONEYCOMB-WINDOW: the legacy `~/.honeycomb/telemetry` root, accepted for the
 *     duration of the migration window only, so a not-yet-migrated service keeps ingesting.
 * The value must satisfy `assertWithinBase` against AT LEAST ONE root; traversal (`..`),
 * relative paths, and (on Windows) drive-letter re-anchoring are all still rejected.
 */
function coerceTelemetryDbPath(
	value: unknown,
	home: string,
	root: string,
	entryName: string,
): string | undefined {
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const expanded = expandTilde(value.trim(), home);
	// A RELATIVE post-`~` path is rejected outright: it would anchor against whatever
	// process.cwd() happens to be, so a containment check at parse time could pass under
	// one cwd while the poll loop later reopens a DIFFERENT file under another. Only an
	// absolute path has one stable meaning to validate and later open.
	if (!isAbsolute(expanded)) return undefined;
	// The ordered trusted roots: the entry's OWN per-product telemetry dir under the fleet
	// root first (the tight default), then the legacy honeycomb root for the window.
	const trustedRoots = [
		productTelemetryRoot(root, entryName),
		// LEGACY-HONEYCOMB-WINDOW: drop this entry when the migration window closes.
		legacyTelemetryRoot(home),
	];
	// Resolve ONCE so the exact value validated is the exact value the poll loop later opens
	// (resolve normalizes and, on Windows, pins the drive letter of a drive-letter-less
	// absolute path). `assertWithinBase` returns the very candidate it checked.
	const candidate = resolve(expanded);
	for (const trustedRoot of trustedRoots) {
		try {
			return assertWithinBase(trustedRoot, candidate);
		} catch {
			// Not under this root: try the next. Falling through all of them means reject.
		}
	}
	// Escapes every trusted telemetry root: treat exactly like an absent field rather than
	// honoring an out-of-bounds path.
	return undefined;
}

/**
 * Coerce and validate a required entry `name`. A registry entry with no filename-safe
 * name cannot key a per-daemon shard, so a missing/garbage name is a MALFORMED registry
 * (fail loud), not a defaulted optional field.
 */
function coerceName(value: unknown, index: number): string {
	if (typeof value !== "string" || !NAME_PATTERN.test(value.trim())) {
		throw new RegistryError(
			`registry daemon at index ${index} has a missing or invalid "name" (must be a filename-safe token)`,
		);
	}
	return value.trim();
}

/** Parse one raw entry into a fully-defaulted {@link DaemonEntry}. Missing optionals resolve to defaults (a-AC-3). */
function parseEntry(raw: unknown, index: number, home: string, root: string): DaemonEntry {
	if (raw === null || typeof raw !== "object") {
		throw new RegistryError(`registry daemon at index ${index} is not an object`);
	}
	const o = raw as Record<string, unknown>;
	// Validate the name FIRST: the telemetry trusted-root binding is per-own-name (PRD-004c),
	// so it needs the already-validated, filename-safe name before it can build the root set.
	const name = coerceName(o.name, index);
	// PRD-004c: the honeycomb primary pid default is new-first with a legacy-fallback check.
	const defaultPidPath = defaultHoneycombPidPath(root, home);
	const telemetryDbPath = coerceTelemetryDbPath(o.telemetryDbPath, home, root, name);
	return {
		name,
		healthUrl: coerceHealthUrl(o.healthUrl, DEFAULTS.healthUrl),
		pidPath: coercePidPath(o.pidPath, home, defaultPidPath),
		probeIntervalMs: coercePositiveInt(o.probeIntervalMs, DEFAULTS.probeIntervalMs),
		startupGraceMs: coercePositiveInt(o.startupGraceMs, DEFAULTS.startupGraceMs),
		restartGiveUpThreshold: coercePositiveInt(o.restartGiveUpThreshold, DEFAULTS.restartGiveUpThreshold),
		restartCooldownMs: coerceNonNegativeInt(o.restartCooldownMs, DEFAULTS.restartCooldownMs),
		...(telemetryDbPath !== undefined ? { telemetryDbPath } : {}),
	};
}

/**
 * Read + parse the registry file at `registryPath`. Returns the parsed entries when the
 * file is present and well-formed, or `null` when the file is ABSENT (the a-AC-2 fallback
 * is the caller's job). Throws {@link RegistryError} when the file is present but
 * malformed (unparseable JSON, not an object, missing/empty `daemons` array, or a bad
 * entry) so a real misconfiguration fails loudly instead of silently supervising nothing.
 */
export function readRegistryFile(
	registryPath: string,
	home: string = homedir(),
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): DaemonEntry[] | null {
	// Resolve the fleet root ONCE per read so every entry's telemetry trusted-root binding
	// and pid default share one deterministic root (PRD-004c).
	const root = resolveApiaryRoot(env, home, platform);
	let contents: string;
	try {
		contents = readFileSync(registryPath, "utf8");
	} catch (error) {
		// ENOENT is the supported "no registry yet" case -> null (caller falls back). Any other
		// read error (permissions, a directory in the way) is a real problem: fail loud.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new RegistryError(
			`could not read registry file at ${registryPath}: ${error instanceof Error ? error.message : "unknown"}`,
			registryPath,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(contents);
	} catch (error) {
		throw new RegistryError(
			`registry file at ${registryPath} is not valid JSON: ${error instanceof Error ? error.message : "unknown"}`,
			registryPath,
		);
	}

	if (parsed === null || typeof parsed !== "object") {
		throw new RegistryError(
			`registry file at ${registryPath} must be a JSON object with a "daemons" array`,
			registryPath,
		);
	}
	const daemons = (parsed as Record<string, unknown>).daemons;
	if (!Array.isArray(daemons) || daemons.length === 0) {
		throw new RegistryError(
			`registry file at ${registryPath} must have a non-empty "daemons" array`,
			registryPath,
		);
	}

	try {
		return daemons.map((entry, index) => parseEntry(entry, index, home, root));
	} catch (error) {
		// A per-entry failure (bad name / shape) is a malformed FILE: tag the error with the
		// file it came from so a two-location caller can name the actually-broken file.
		if (error instanceof RegistryError && error.registryPath === undefined) {
			error.registryPath = registryPath;
		}
		throw error;
	}
}

/**
 * Boot-time convenience: read the registry from `options.registryPath` (default
 * {@link defaultRegistryPath}) and, when the file is ABSENT, fall back to the single
 * honeycomb primary entry at its built-in defaults (a-AC-2). A present-but-malformed file
 * still throws {@link RegistryError}.
 */
export function loadRegistry(options: LoadRegistryOptions = {}): DaemonEntry[] {
	const home = options.home ?? homedir();
	const registryPath = options.registryPath ?? defaultRegistryPath(home);
	const fromFile = readRegistryFile(registryPath, home);
	return fromFile ?? [honeycombFallbackEntry(home)];
}

// ────────────────────────────────────────────────────────────────────────────
// PRD-004b: the fleet-shared coordination surface (two-location resolution + migration)
// ────────────────────────────────────────────────────────────────────────────

/** Seams for the two-location registry resolution + one-time migration (PRD-004b). */
export interface FleetRegistryOptions {
	/** The home dir the fleet root + legacy root are anchored under (default real `~`). */
	readonly home?: string;
	/** The env the fleet-root chain reads (default `process.env`). */
	readonly env?: NodeJS.ProcessEnv;
	/** The platform the fleet-root chain reads (default `process.platform`). */
	readonly platform?: NodeJS.Platform;
}

/** Filesystem seams for {@link migrateRegistry} (injected so failure paths are hermetic). */
export interface RegistryMigrationSeams {
	/** Does a path exist? Default: `existsSync`. */
	readonly exists?: (path: string) => boolean;
	/** Create a directory (recursive). Default: `mkdirSync(path, { recursive: true })`. */
	readonly makeDir?: (path: string) => void;
	/** Copy a file. Default: `copyFileSync`. Tests inject a throwing copy for the b-AC-8 path. */
	readonly copyFile?: (src: string, dst: string) => void;
	/** Rename a file. Default: `renameSync`. Tests inject a throwing rename to prove tolerance. */
	readonly rename?: (src: string, dst: string) => void;
}

/** The outcome of {@link migrateRegistry} (resolved, never thrown). */
export interface RegistryMigrationResult {
	/** True iff the legacy content was copied to the new location this run. */
	readonly migrated: boolean;
	/** Why the migration did or did not run (audit trail; never a credential). */
	readonly reason:
		| "new-present" // the new file already exists: idempotent no-op (b-AC-2)
		| "no-legacy" // no legacy file to migrate
		| "legacy-malformed" // legacy present but unparseable: NOT migrated (left in place)
		| "copy-failed" // the copy to the new location failed: legacy left authoritative (b-AC-8)
		| "migrated"; // the copy succeeded (rename may or may not have)
	/** True iff the legacy file was renamed to the `.migrated` marker (best-effort). */
	readonly legacyRenamed?: boolean;
}

/**
 * Resolve the supervised-daemon entries across BOTH the new and legacy registry locations
 * (PRD-004b), read-only (no migration, no writes). New-first with a legacy-additive merge:
 *
 *   1. read `<root>/registry.json`,
 *   2. read the legacy `~/.honeycomb/doctor.daemons.json`,
 *   3. start from the new file's entries, then additively merge each legacy entry whose
 *      `name` is not already present. On a `name` collision the new-location entry wins
 *      wholesale (ADR-0003 registry compatibility window contract, confirmed 2026-07-04).
 *
 * Returns `null` only when NEITHER file exists (the caller applies the honeycomb-primary
 * fallback). A present-but-malformed file at EITHER location throws {@link RegistryError}
 * (the unchanged fail-loud posture). doctor never writes merged results back to the legacy
 * file. Re-running this (a registry reload trigger, PRD-001 AC-7) re-reads both locations,
 * so a mid-window write to either file is picked up (b-AC-4).
 */
export function resolveRegistryEntries(options: FleetRegistryOptions = {}): DaemonEntry[] | null {
	const home = options.home ?? homedir();
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const newEntries = readRegistryFile(defaultRegistryPath(home, env, platform), home, env, platform);
	// LEGACY-HONEYCOMB-WINDOW: the legacy-location read, removed when the window closes.
	const legacyEntries = readRegistryFile(legacyRegistryPath(home), home, env, platform);

	if (newEntries === null && legacyEntries === null) return null;

	const merged: DaemonEntry[] = [...(newEntries ?? [])];
	const seen = new Set(merged.map((entry) => entry.name));
	for (const entry of legacyEntries ?? []) {
		// New wins per name; a legacy-only entry is merged additively so a not-yet-updated
		// installer's daemon is never silently unsupervised.
		if (!seen.has(entry.name)) {
			merged.push(entry);
			seen.add(entry.name);
		}
	}
	return merged;
}

/**
 * The one-time, idempotent, additive registry migration (PRD-004b). When the new
 * `<root>/registry.json` is absent and the legacy `~/.honeycomb/doctor.daemons.json` exists
 * and parses, copy it to the new location, then rename the legacy file to
 * `doctor.daemons.json.migrated` (kept, never deleted). Postures, all preserved:
 *
 *   - new file already present  -> no-op (idempotent, b-AC-2).
 *   - no legacy file            -> nothing to do.
 *   - legacy present but malformed -> NOT migrated (left untouched); resolution fails loud later.
 *   - copy fails                -> legacy left untouched + authoritative via the fallback read (b-AC-8).
 *   - rename fails after a good copy -> tolerated; the merge rule handles the still-present legacy.
 *
 * Best-effort and TOTAL: every fs operation is wrapped so the migration can never take the
 * watchdog down (design principle 1). Returns a structured {@link RegistryMigrationResult}.
 */
export function migrateRegistry(
	options: FleetRegistryOptions = {},
	seams: RegistryMigrationSeams = {},
): RegistryMigrationResult {
	const home = options.home ?? homedir();
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const exists = seams.exists ?? existsSync;
	const makeDir =
		seams.makeDir ??
		((path: string): void => {
			mkdirSync(path, { recursive: true });
		});
	const copyFile = seams.copyFile ?? copyFileSync;
	const rename = seams.rename ?? renameSync;
	const newPath = defaultRegistryPath(home, env, platform);
	const legacyPath = legacyRegistryPath(home);

	// Idempotent: once the new file exists the migration has run (or been superseded); never
	// re-copy or re-rename (b-AC-2).
	try {
		if (exists(newPath)) return { migrated: false, reason: "new-present" };
	} catch {
		// A failing existence probe must not wedge boot; fall through and let the copy guard decide.
	}

	// Validate the legacy file parses before touching anything. A malformed legacy file is
	// NOT migrated (unchanged fail-loud-on-read posture); it is left in place.
	let legacyEntries: DaemonEntry[] | null;
	try {
		legacyEntries = readRegistryFile(legacyPath, home, env, platform);
	} catch {
		return { migrated: false, reason: "legacy-malformed" };
	}
	if (legacyEntries === null) return { migrated: false, reason: "no-legacy" };

	// Copy the legacy bytes verbatim to the new location (shape is unchanged). A copy failure
	// leaves the legacy file untouched and authoritative via the fallback read (b-AC-8).
	try {
		makeDir(dirname(newPath));
		copyFile(legacyPath, newPath);
	} catch {
		return { migrated: false, reason: "copy-failed" };
	}

	// Rename the legacy file to the `.migrated` marker so it is kept (never deleted) yet no
	// longer parses as the live legacy registry. A rename failure is tolerated: the merge rule
	// tolerates the still-present legacy file.
	let legacyRenamed = false;
	try {
		rename(legacyPath, migratedLegacyRegistryPath(home));
		legacyRenamed = true;
	} catch {
		// Tolerated: the merge rule handles the still-present legacy file.
	}

	return { migrated: true, reason: "migrated", legacyRenamed };
}
