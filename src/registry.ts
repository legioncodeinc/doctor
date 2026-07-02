/**
 * HiveDoctor supervised-daemon registry (PRD-004a; extended by hivedoctor PRD-001a).
 *
 * hivedoctor no longer supervises a single hard-coded daemon: it reads a static JSON
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
 * hivedoctor is a "can't-crash" watchdog with ZERO runtime dependencies by design
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

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { DEFAULTS } from "./config.js";
import { assertWithinBase } from "./safe-path.js";

/** The three known workload daemons hivedoctor supervises. Names are parsed permissively (any filename-safe token) and narrowed against this list where useful. */
export const KNOWN_DAEMON_NAMES = ["honeycomb", "thehive", "hivenectar"] as const;

/** A known workload-daemon name. */
export type KnownDaemonName = (typeof KNOWN_DAEMON_NAMES)[number];

/**
 * One fully-resolved registry entry: the per-daemon supervision parameters that used to
 * live once on {@link import("./config.js").HiveDoctorConfig} for the single honeycomb
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
	/** Cooldown after a restart hivedoctor performed for this daemon, in ms. */
	readonly restartCooldownMs: number;
	/**
	 * Optional path to this service's runtime telemetry SQLite database (leading `~`
	 * already expanded and the value resolved to a validated ABSOLUTE path; a relative
	 * path is rejected at parse time). Absent means health-probe-only: no SQLite
	 * ingestion for this entry (PRD-001a a-AC-2). hivedoctor only ever opens this database
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
 * as "supervise nothing". hivedoctor's boot catches this at the top level and reports it.
 */
export class RegistryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RegistryError";
	}
}

/** A filename-safe daemon name: a leading alphanumeric then alphanumerics, dashes, underscores. */
const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/** The default registry file location, alongside the other `~/.honeycomb` artifacts. */
export function defaultRegistryPath(home: string = homedir()): string {
	return join(home, ".honeycomb", "hivedoctor.daemons.json");
}

/**
 * The honeycomb primary entry at BUILT-IN defaults, used as the a-AC-2 fallback when the
 * registry file is absent. Mirrors {@link DEFAULTS} + the default PID path from
 * `config.ts`.
 */
export function honeycombFallbackEntry(home: string = homedir()): DaemonEntry {
	return {
		name: "honeycomb",
		healthUrl: DEFAULTS.healthUrl,
		pidPath: join(home, ".honeycomb", "daemon.pid"),
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
 * Trusted loopback hostnames a probed `healthUrl` may resolve to. Mirrors thehive's
 * `isLoopbackBaseUrl` allow-list (`src/shared/daemon-routing.ts`) so both watchdog surfaces
 * share one loopback-trust model.
 */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Coerce a `/health` URL: must parse as an http/https URL whose host is loopback, else
 * fall back to the default.
 *
 * SECURITY (SSRF, PRD-004a): the registry file is an EXTERNAL input written by installers.
 * hivedoctor FETCHES this URL every probe interval and reflects the daemon's reachability on
 * the loopback status page. A tampered registry (or a malicious installer) with a NON-loopback
 * `healthUrl` would turn the watchdog into a server-side-request-forgery primitive: it would
 * fetch an attacker-controlled origin from the user's machine on a timer. Restricting the host
 * to loopback here is defense in depth, mirroring thehive's `isLoopbackBaseUrl` gate on its
 * daemon bases (thehive PRD-001 security fix). A non-loopback host silently falls back to the
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
 * registry entry with an unconstrained `telemetryDbPath` would let hivedoctor open ANY
 * user-readable SQLite file and, if it happens to carry Contract-B-shaped tables, poll
 * and forward its contents over the unauthenticated loopback SSE stream (`/events`).
 * Contract A pins telemetry databases under `~/.honeycomb/telemetry/`; this coercion
 * enforces that containment with {@link assertWithinBase} (the same defense-in-depth
 * helper `pidPath`'s composed paths already route through elsewhere in this codebase).
 * A path that escapes the trusted root degrades to `undefined` (health-probe-only),
 * mirroring `coerceHealthUrl`'s fallback-on-invalid-input posture -- never a crash, never
 * a silently-honored escape.
 */
function coerceTelemetryDbPath(value: unknown, home: string): string | undefined {
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const expanded = expandTilde(value.trim(), home);
	// A RELATIVE post-`~` path is rejected outright: it would anchor against whatever
	// process.cwd() happens to be, so a containment check at parse time could pass under
	// one cwd while the poll loop later reopens a DIFFERENT file under another. Only an
	// absolute path has one stable meaning to validate and later open.
	if (!isAbsolute(expanded)) return undefined;
	const trustedRoot = join(home, ".honeycomb", "telemetry");
	try {
		// Validate the EXACT value returned (the path the poll loop later opens): resolve
		// normalizes and, on Windows, pins the drive letter of a drive-letter-less absolute
		// path, and `assertWithinBase` returns the very candidate it checked, so no
		// differently-anchored reinterpretation can happen downstream.
		return assertWithinBase(trustedRoot, resolve(expanded));
	} catch {
		// Escapes the trusted telemetry root: treat exactly like an absent field rather
		// than honoring an out-of-bounds path.
		return undefined;
	}
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
function parseEntry(raw: unknown, index: number, home: string): DaemonEntry {
	if (raw === null || typeof raw !== "object") {
		throw new RegistryError(`registry daemon at index ${index} is not an object`);
	}
	const o = raw as Record<string, unknown>;
	const defaultPidPath = join(home, ".honeycomb", "daemon.pid");
	const telemetryDbPath = coerceTelemetryDbPath(o.telemetryDbPath, home);
	return {
		name: coerceName(o.name, index),
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
export function readRegistryFile(registryPath: string, home: string = homedir()): DaemonEntry[] | null {
	let contents: string;
	try {
		contents = readFileSync(registryPath, "utf8");
	} catch (error) {
		// ENOENT is the supported "no registry yet" case -> null (caller falls back). Any other
		// read error (permissions, a directory in the way) is a real problem: fail loud.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new RegistryError(
			`could not read registry file at ${registryPath}: ${error instanceof Error ? error.message : "unknown"}`,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(contents);
	} catch (error) {
		throw new RegistryError(
			`registry file at ${registryPath} is not valid JSON: ${error instanceof Error ? error.message : "unknown"}`,
		);
	}

	if (parsed === null || typeof parsed !== "object") {
		throw new RegistryError(`registry file at ${registryPath} must be a JSON object with a "daemons" array`);
	}
	const daemons = (parsed as Record<string, unknown>).daemons;
	if (!Array.isArray(daemons) || daemons.length === 0) {
		throw new RegistryError(`registry file at ${registryPath} must have a non-empty "daemons" array`);
	}

	return daemons.map((entry, index) => parseEntry(entry, index, home));
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
