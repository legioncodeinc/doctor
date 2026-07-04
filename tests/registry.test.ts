/**
 * Registry loader tests (PRD-004a US-1): defensive parse of the supervised-daemon file,
 * absent-file fallback (a-AC-2), missing-optional-field defaults (a-AC-3), and loud
 * failure on a present-but-malformed file.
 *
 * Also covers the PRD-001a extension: the optional `telemetryDbPath` field on
 * `DaemonEntry` (see the "registry: PRD-001a telemetryDbPath extension" describe block
 * below). That extension is purely additive; every test above it is UNCHANGED from the
 * pre-PRD-001a baseline and still exercises the exact same PRD-004a behavior.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULTS } from "../src/config.js";
import {
	defaultRegistryPath,
	honeycombFallbackEntry,
	loadRegistry,
	readRegistryFile,
	RegistryError,
} from "../src/registry.js";

const HOME = "/home/test";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "doctor-registry-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Write a registry file into the temp dir and return its path. */
function writeRegistry(contents: string): string {
	const path = join(dir, "doctor.daemons.json");
	writeFileSync(path, contents, "utf8");
	return path;
}

const THREE_DAEMONS = {
	daemons: [
		{
			name: "honeycomb",
			healthUrl: "http://127.0.0.1:3850/health",
			pidPath: "~/.honeycomb/daemon.pid",
			probeIntervalMs: 30000,
			startupGraceMs: 60000,
			restartGiveUpThreshold: 3,
			restartCooldownMs: 5000,
		},
		{
			name: "hive",
			healthUrl: "http://127.0.0.1:3853/health",
			pidPath: "~/.honeycomb/hive.pid",
			probeIntervalMs: 15000,
			startupGraceMs: 45000,
			restartGiveUpThreshold: 5,
			restartCooldownMs: 2000,
		},
		{
			name: "nectar",
			healthUrl: "http://127.0.0.1:3854/health",
			pidPath: "~/.honeycomb/nectar.pid",
			probeIntervalMs: 30000,
			startupGraceMs: 60000,
			restartGiveUpThreshold: 3,
			restartCooldownMs: 5000,
		},
	],
};

describe("registry loader", () => {
	it("a-AC-1: loads a three-entry file with correct per-entry values", () => {
		const path = writeRegistry(JSON.stringify(THREE_DAEMONS));
		const entries = readRegistryFile(path, HOME);
		expect(entries).not.toBeNull();
		expect(entries).toHaveLength(3);
		const [honeycomb, hive, nectar] = entries ?? [];
		expect(honeycomb).toMatchObject({
			name: "honeycomb",
			healthUrl: "http://127.0.0.1:3850/health",
			probeIntervalMs: 30000,
			startupGraceMs: 60000,
			restartGiveUpThreshold: 3,
			restartCooldownMs: 5000,
		});
		// The distinct per-entry values are preserved, not collapsed to one shared config.
		expect(hive).toMatchObject({
			name: "hive",
			healthUrl: "http://127.0.0.1:3853/health",
			probeIntervalMs: 15000,
			startupGraceMs: 45000,
			restartGiveUpThreshold: 5,
			restartCooldownMs: 2000,
		});
		expect(nectar?.name).toBe("nectar");
		expect(nectar?.healthUrl).toBe("http://127.0.0.1:3854/health");
	});

	it("expands a leading ~ in pidPath to the home directory", () => {
		const path = writeRegistry(JSON.stringify(THREE_DAEMONS));
		const entries = readRegistryFile(path, HOME) ?? [];
		expect(entries[0]?.pidPath).toBe(join(HOME, ".honeycomb", "daemon.pid"));
		expect(entries[1]?.pidPath).toBe(join(HOME, ".honeycomb", "hive.pid"));
	});

	it("a-AC-2: an absent registry file falls back to the honeycomb primary at defaults", () => {
		const missing = join(dir, "does-not-exist.json");
		// The low-level read signals "absent" with null (no throw).
		expect(readRegistryFile(missing, HOME)).toBeNull();
		// The boot-time loader falls back to the single honeycomb entry at built-in defaults.
		const entries = loadRegistry({ registryPath: missing, home: HOME });
		expect(entries).toHaveLength(1);
		expect(entries[0]).toEqual(honeycombFallbackEntry(HOME));
		expect(entries[0]).toMatchObject({
			name: "honeycomb",
			healthUrl: DEFAULTS.healthUrl,
			// PRD-004c: the pid default now resolves under the fleet root, new-first with a
			// legacy-fallback existence check. Assert consistency with the fallback builder.
			pidPath: honeycombFallbackEntry(HOME).pidPath,
			probeIntervalMs: DEFAULTS.probeIntervalMs,
			startupGraceMs: DEFAULTS.startupGraceMs,
			restartGiveUpThreshold: DEFAULTS.restartGiveUpThreshold,
			restartCooldownMs: DEFAULTS.restartCooldownMs,
		});
	});

	it("a-AC-3: a registry entry missing optional fields resolves them to built-in defaults", () => {
		const path = writeRegistry(
			JSON.stringify({ daemons: [{ name: "nectar", healthUrl: "http://127.0.0.1:3854/health" }] }),
		);
		// Inject an empty env + fixed platform so the fleet root is deterministically
		// `<HOME>/.apiary` (independent of any host APIARY_HOME/XDG).
		const entries = readRegistryFile(path, HOME, {}, "linux") ?? [];
		expect(entries).toHaveLength(1);
		expect(entries[0]).toEqual({
			name: "nectar",
			healthUrl: "http://127.0.0.1:3854/health",
			// PRD-004c: the pid default is `<root>/honeycomb/daemon.pid` (neither file exists in
			// this hermetic HOME, so the new-first branch wins).
			pidPath: join(HOME, ".apiary", "honeycomb", "daemon.pid"),
			probeIntervalMs: DEFAULTS.probeIntervalMs,
			startupGraceMs: DEFAULTS.startupGraceMs,
			restartGiveUpThreshold: DEFAULTS.restartGiveUpThreshold,
			restartCooldownMs: DEFAULTS.restartCooldownMs,
		});
	});

	it("a-AC-3: wrong-typed optional fields degrade to defaults, never a crash", () => {
		const path = writeRegistry(
			JSON.stringify({
				daemons: [
					{
						name: "hive",
						healthUrl: "ftp://nope",
						probeIntervalMs: "soon",
						startupGraceMs: -1,
						restartGiveUpThreshold: 0,
						restartCooldownMs: "later",
					},
				],
			}),
		);
		const entries = readRegistryFile(path, HOME) ?? [];
		expect(entries[0]).toMatchObject({
			name: "hive",
			healthUrl: DEFAULTS.healthUrl, // non-http scheme rejected
			probeIntervalMs: DEFAULTS.probeIntervalMs,
			startupGraceMs: DEFAULTS.startupGraceMs, // negative rejected
			restartGiveUpThreshold: DEFAULTS.restartGiveUpThreshold, // 0 rejected (must be > 0)
			restartCooldownMs: DEFAULTS.restartCooldownMs, // non-number rejected
		});
	});

	it("allows a zero restartCooldownMs (cooldown may legitimately be 0)", () => {
		const path = writeRegistry(
			JSON.stringify({ daemons: [{ name: "honeycomb", restartCooldownMs: 0 }] }),
		);
		const entries = readRegistryFile(path, HOME) ?? [];
		expect(entries[0]?.restartCooldownMs).toBe(0);
	});

	it("fails loudly on unparseable JSON (does not silently supervise nothing)", () => {
		const path = writeRegistry("{ not valid json");
		expect(() => readRegistryFile(path, HOME)).toThrow(RegistryError);
	});

	it("fails loudly on an empty daemons array", () => {
		const path = writeRegistry(JSON.stringify({ daemons: [] }));
		expect(() => readRegistryFile(path, HOME)).toThrow(RegistryError);
	});

	it("fails loudly on a missing daemons array", () => {
		const path = writeRegistry(JSON.stringify({ notDaemons: true }));
		expect(() => readRegistryFile(path, HOME)).toThrow(RegistryError);
	});

	it("fails loudly on an entry with a missing or non-safe name", () => {
		const missingName = writeRegistry(JSON.stringify({ daemons: [{ healthUrl: "http://127.0.0.1:3850/health" }] }));
		expect(() => readRegistryFile(missingName, HOME)).toThrow(RegistryError);
		const unsafeName = writeRegistry(JSON.stringify({ daemons: [{ name: "../escape" }] }));
		expect(() => readRegistryFile(unsafeName, HOME)).toThrow(RegistryError);
	});

	it("defaultRegistryPath points to <root>/registry.json under the fleet root (ADR-0003 / PRD-004b)", () => {
		// Inject an empty env + fixed platform so the fleet root is deterministically `<HOME>/.apiary`.
		expect(defaultRegistryPath(HOME, {}, "linux")).toBe(join(HOME, ".apiary", "registry.json"));
	});

	it("security (SSRF): a non-loopback healthUrl falls back to the safe loopback default", () => {
		// A tampered registry pointing healthUrl at an attacker-controlled host must NEVER become the
		// probed origin: doctor fetches healthUrl every interval, so an off-loopback value would
		// be an SSRF primitive. It degrades to the loopback default instead of trusting the host.
		const path = writeRegistry(
			JSON.stringify({
				daemons: [{ name: "honeycomb", healthUrl: "http://169.254.169.254/latest/meta-data" }],
			}),
		);
		const entries = readRegistryFile(path, HOME) ?? [];
		expect(entries[0]?.healthUrl).toBe(DEFAULTS.healthUrl);
	});

	it("security (SSRF): an external hostname healthUrl is rejected in favor of the default", () => {
		const path = writeRegistry(
			JSON.stringify({ daemons: [{ name: "hive", healthUrl: "https://evil.example.com/health" }] }),
		);
		const entries = readRegistryFile(path, HOME) ?? [];
		expect(entries[0]?.healthUrl).toBe(DEFAULTS.healthUrl);
	});

	it("security (SSRF): loopback healthUrls (127.0.0.1, localhost, ::1) are accepted", () => {
		const path = writeRegistry(
			JSON.stringify({
				daemons: [
					{ name: "a", healthUrl: "http://127.0.0.1:3850/health" },
					{ name: "b", healthUrl: "http://localhost:3853/health" },
					{ name: "c", healthUrl: "http://[::1]:3854/health" },
				],
			}),
		);
		const entries = readRegistryFile(path, HOME) ?? [];
		expect(entries[0]?.healthUrl).toBe("http://127.0.0.1:3850/health");
		expect(entries[1]?.healthUrl).toBe("http://localhost:3853/health");
		expect(entries[2]?.healthUrl).toBe("http://[::1]:3854/health");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// PRD-001a: the optional `telemetryDbPath` field extension
// ────────────────────────────────────────────────────────────────────────────

/**
 * Tests for the static registry parser's PRD-001a extension: the optional
 * `telemetryDbPath` field on {@link DaemonEntry}.
 *
 * Coverage:
 *   a-AC-1 - an entry with `telemetryDbPath` records it (with `~` expansion).
 *   a-AC-2 - a legacy entry with no `telemetryDbPath` loads fine, health-probe-only
 *            (the field is simply absent from the parsed entry).
 *   a-AC-4 - a malformed registry still falls back / fails loud exactly as before
 *            (PRD-004a fail-soft posture unchanged by this additive extension).
 *   a-AC-5 - every existing PRD-004a field is preserved with identical semantics
 *            whether or not `telemetryDbPath` is present.
 *
 * a-AC-3 (a LIST of database paths) is NOT implemented: the pinned Wave-0 "Contract A"
 * in the-apiary's `library/ledger/EXECUTION_LEDGER.md` fixes `telemetryDbPath` as a
 * single OPTIONAL string (not a string-or-array), specifically so the other Wave-1
 * repos (honeycomb/nectar/hive) can conform to one literal shape without
 * waiting on doctor's code to exist. See the ledger note left on that AC row.
 */
describe("registry: PRD-001a telemetryDbPath extension", () => {
	// Reuses the outer `dir` (fresh per test via the module-level beforeEach/afterEach
	// above) for where the registry FILE lives, and the same `HOME` constant the
	// pre-existing PRD-004a tests use for `~`-expansion assertions -- no separate tmp
	// dir needed, matching the file's existing convention exactly.

	it("a-AC-1: an entry with telemetryDbPath records the path with ~ expanded", () => {
		const path = writeRegistry(
			JSON.stringify({
				daemons: [
					{
						name: "honeycomb",
						healthUrl: "http://127.0.0.1:3850/health",
						pidPath: "~/.honeycomb/daemon.pid",
						telemetryDbPath: "~/.honeycomb/telemetry/honeycomb.sqlite",
					},
				],
			}),
		);

		const entries = readRegistryFile(path, HOME);
		expect(entries).not.toBeNull();
		// The parsed value is the RESOLVED absolute path (the exact path the containment
		// guard validated); `resolve` is an identity on POSIX and pins the drive letter of
		// a drive-letter-less absolute path on Windows.
		expect(entries?.[0]?.telemetryDbPath).toBe(resolve(join(HOME, ".honeycomb", "telemetry", "honeycomb.sqlite")));
	});

	it("a-AC-1: an absolute telemetryDbPath already under the trusted telemetry root is preserved (in resolved form)", () => {
		const absolutePath = join(HOME, ".honeycomb", "telemetry", "nectar.sqlite");
		const path = writeRegistry(
			JSON.stringify({ daemons: [{ name: "nectar", healthUrl: "http://127.0.0.1:3854/health", telemetryDbPath: absolutePath }] }),
		);

		const entries = readRegistryFile(path, HOME);
		expect(entries?.[0]?.telemetryDbPath).toBe(resolve(absolutePath));
	});

	it("security: a telemetryDbPath OUTSIDE ~/.honeycomb/telemetry/ falls back to undefined (health-probe-only), never opened verbatim", () => {
		// A registry entry pointing anywhere outside the trusted telemetry root -- another
		// app's data file, an arbitrary absolute path -- must never be honored: doctor
		// would otherwise open ANY user-readable SQLite file and, if it has Contract-B-shaped
		// tables, broadcast its contents on the unauthenticated loopback SSE stream.
		const outsidePath = join(HOME, "abs", "svc.sqlite");
		const path = writeRegistry(
			JSON.stringify({ daemons: [{ name: "nectar", healthUrl: "http://127.0.0.1:3854/health", telemetryDbPath: outsidePath }] }),
		);

		const entries = readRegistryFile(path, HOME);
		expect(entries?.[0]?.telemetryDbPath).toBeUndefined();
	});

	it("security: a `..`-traversal telemetryDbPath escaping the trusted telemetry root falls back to undefined", () => {
		const traversalPath = "~/.honeycomb/telemetry/../../../etc/passwd";
		const path = writeRegistry(
			JSON.stringify({ daemons: [{ name: "honeycomb", healthUrl: "http://127.0.0.1:3850/health", telemetryDbPath: traversalPath }] }),
		);

		const entries = readRegistryFile(path, HOME);
		expect(entries?.[0]?.telemetryDbPath).toBeUndefined();
	});

	it("security: a telemetryDbPath nested inside the trusted telemetry root (a subdirectory) is preserved", () => {
		const nestedPath = "~/.honeycomb/telemetry/nested/honeycomb.sqlite";
		const path = writeRegistry(
			JSON.stringify({ daemons: [{ name: "honeycomb", healthUrl: "http://127.0.0.1:3850/health", telemetryDbPath: nestedPath }] }),
		);

		const entries = readRegistryFile(path, HOME);
		expect(entries?.[0]?.telemetryDbPath).toBe(resolve(join(HOME, ".honeycomb", "telemetry", "nested", "honeycomb.sqlite")));
	});

	it("security: a RELATIVE telemetryDbPath is rejected outright (its meaning would depend on process.cwd()), falling back to undefined", () => {
		const path = writeRegistry(
			JSON.stringify({
				daemons: [{ name: "honeycomb", healthUrl: "http://127.0.0.1:3850/health", telemetryDbPath: "relative/telemetry/honeycomb.sqlite" }],
			}),
		);

		const entries = readRegistryFile(path, HOME);
		expect(entries?.[0]?.telemetryDbPath).toBeUndefined();
	});

	it("a-AC-2: a legacy entry with no telemetryDbPath field loads without error, health-probe-only", () => {
		const path = writeRegistry(
			JSON.stringify({ daemons: [{ name: "honeycomb", healthUrl: "http://127.0.0.1:3850/health", pidPath: "~/.honeycomb/daemon.pid" }] }),
		);

		const entries = readRegistryFile(path, HOME);
		expect(entries).not.toBeNull();
		expect(entries).toHaveLength(1);
		// Health-probe-only: the optional field is simply absent, never a placeholder/empty string.
		expect(entries?.[0]?.telemetryDbPath).toBeUndefined();
		expect("telemetryDbPath" in (entries?.[0] ?? {})).toBe(false);
	});

	it("a-AC-2: an empty-string or non-string telemetryDbPath is treated as absent (health-probe-only), not an error", () => {
		const path = writeRegistry(
			JSON.stringify({
				daemons: [
					{ name: "honeycomb", healthUrl: "http://127.0.0.1:3850/health", telemetryDbPath: "" },
					{ name: "nectar", healthUrl: "http://127.0.0.1:3854/health", telemetryDbPath: 42 },
					{ name: "hive", healthUrl: "http://127.0.0.1:3853/health", telemetryDbPath: null },
				],
			}),
		);

		const entries = readRegistryFile(path, HOME);
		expect(entries).toHaveLength(3);
		for (const entry of entries ?? []) expect(entry.telemetryDbPath).toBeUndefined();
	});

	it("a-AC-2/honeycombFallbackEntry: the a-AC-2 fallback entry has no telemetryDbPath (unchanged floor behavior)", () => {
		const entry = honeycombFallbackEntry(HOME);
		expect(entry.telemetryDbPath).toBeUndefined();
	});

	it("a-AC-4: a malformed registry still throws RegistryError (fail-soft posture unaffected by the additive field)", () => {
		const path = writeRegistry("{ not valid json");
		expect(() => readRegistryFile(path, HOME)).toThrow(RegistryError);
	});

	it("a-AC-4: an absent registry file still falls back to the honeycomb primary via loadRegistry", () => {
		const missing = join(dir, "does-not-exist.json");
		const entries = loadRegistry({ registryPath: missing, home: HOME });
		expect(entries).toHaveLength(1);
		expect(entries[0]?.name).toBe("honeycomb");
		expect(entries[0]?.telemetryDbPath).toBeUndefined();
	});

	it("a-AC-5: every existing PRD-004a field is preserved with identical semantics alongside telemetryDbPath", () => {
		const path = writeRegistry(
			JSON.stringify({
				daemons: [
					{
						name: "nectar",
						healthUrl: "http://127.0.0.1:3854/health",
						pidPath: "~/.honeycomb/nectar.pid",
						probeIntervalMs: 15_000,
						startupGraceMs: 45_000,
						restartGiveUpThreshold: 5,
						restartCooldownMs: 2_500,
						telemetryDbPath: "~/.honeycomb/telemetry/nectar.sqlite",
					},
				],
			}),
		);

		const entries = readRegistryFile(path, HOME);
		const entry = entries?.[0];
		expect(entry).toEqual({
			name: "nectar",
			healthUrl: "http://127.0.0.1:3854/health",
			pidPath: join(HOME, ".honeycomb", "nectar.pid"),
			probeIntervalMs: 15_000,
			startupGraceMs: 45_000,
			restartGiveUpThreshold: 5,
			restartCooldownMs: 2_500,
			telemetryDbPath: resolve(join(HOME, ".honeycomb", "telemetry", "nectar.sqlite")),
		});
	});

	it("a-AC-5: an entry without telemetryDbPath parses every other field identically to pre-PRD-001a behavior", () => {
		const path = writeRegistry(
			JSON.stringify({
				daemons: [
					{
						name: "hive",
						healthUrl: "http://127.0.0.1:3853/health",
						pidPath: "~/.honeycomb/hive.pid",
						probeIntervalMs: 20_000,
					},
				],
			}),
		);

		const entries = readRegistryFile(path, HOME);
		expect(entries?.[0]).toEqual({
			name: "hive",
			healthUrl: "http://127.0.0.1:3853/health",
			pidPath: join(HOME, ".honeycomb", "hive.pid"),
			probeIntervalMs: 20_000,
			startupGraceMs: 60_000,
			restartGiveUpThreshold: 3,
			restartCooldownMs: 5_000,
		});
	});
});
