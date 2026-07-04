/**
 * Supervision continuity through the migration window (PRD-004c): the honeycomb fallback
 * entry + default pid paths (c-AC-1/2/3), the telemetry-path trusted-root extension
 * (c-AC-4/5/6/8, the security boundary), and mid-window continuity for entries carrying
 * explicit legacy paths (c-AC-7).
 *
 * Uses a temp HOME + injected env {} / platform "linux" so the fleet root is deterministically
 * `<HOME>/.apiary` and the legacy root is `<HOME>/.honeycomb`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { legacyTelemetryRoot, productTelemetryRoot, resolveApiaryRoot } from "../src/apiary-root.js";
import { resolveConfig } from "../src/config.js";
import { honeycombFallbackEntry, readRegistryFile } from "../src/registry.js";

const FLEET = { env: {} as NodeJS.ProcessEnv, platform: "linux" as const };

let home: string;
let root: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "doctor-supervision-"));
	root = resolveApiaryRoot({}, home, "linux");
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

/** Write a registry file to a path under the temp home and return the path. */
function writeRegistry(obj: unknown): string {
	const path = join(home, "reg.json");
	writeFileSync(path, JSON.stringify(obj), "utf8");
	return path;
}

/** Touch a file, creating parent dirs. */
function touch(path: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, "1", "utf8");
}

// ────────────────────────────────────────────────────────────────────────────
// Pid-path defaults (c-AC-1/2/3)
// ────────────────────────────────────────────────────────────────────────────

describe("honeycomb pid-path defaults (PRD-004c)", () => {
	it("c-AC-1: with a migrated pid at <root>/honeycomb/daemon.pid, the fallback entry uses the NEW location", () => {
		const newPid = join(root, "honeycomb", "daemon.pid");
		touch(newPid);
		const entry = honeycombFallbackEntry(home, {}, "linux");
		expect(entry.pidPath).toBe(newPid);
	});

	it("c-AC-2: with no new pid but a legacy ~/.honeycomb/daemon.pid, the fallback entry uses the LEGACY location", () => {
		const legacyPid = join(home, ".honeycomb", "daemon.pid");
		touch(legacyPid);
		const entry = honeycombFallbackEntry(home, {}, "linux");
		expect(entry.pidPath).toBe(legacyPid);
	});

	it("c-AC-2: with neither present, the fallback entry uses the new-location default", () => {
		const entry = honeycombFallbackEntry(home, {}, "linux");
		expect(entry.pidPath).toBe(join(root, "honeycomb", "daemon.pid"));
	});

	it("c-AC-3: HONEYCOMB_DAEMON_PID_PATH wins over both defaults, unchanged", () => {
		const cfg = resolveConfig({ HONEYCOMB_DAEMON_PID_PATH: "/custom/daemon.pid" }, home, "linux");
		expect(cfg.daemonPidPath).toBe("/custom/daemon.pid");
	});

	it("the resolveConfig default pid path is new-first under the fleet root when nothing exists", () => {
		const cfg = resolveConfig({}, home, "linux");
		expect(cfg.daemonPidPath).toBe(join(root, "honeycomb", "daemon.pid"));
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Telemetry trusted roots (c-AC-4/5/6/8) - the security boundary
// ────────────────────────────────────────────────────────────────────────────

describe("telemetry trusted-root extension (PRD-004c, security boundary)", () => {
	it("c-AC-4 / AC-7: a telemetryDbPath under <root>/<its-own-name>/telemetry/ is accepted and retained (resolved)", () => {
		const dbPath = join(productTelemetryRoot(root, "nectar"), "nectar.sqlite");
		const path = writeRegistry({
			daemons: [{ name: "nectar", healthUrl: "http://127.0.0.1:3854/health", telemetryDbPath: dbPath }],
		});
		const entries = readRegistryFile(path, home, FLEET.env, FLEET.platform) ?? [];
		expect(entries[0]?.telemetryDbPath).toBe(resolve(dbPath));
	});

	it("c-AC-5: a telemetryDbPath under the LEGACY ~/.honeycomb/telemetry/ is accepted during the window", () => {
		const dbPath = join(legacyTelemetryRoot(home), "honeycomb.sqlite");
		const path = writeRegistry({
			daemons: [{ name: "honeycomb", healthUrl: "http://127.0.0.1:3850/health", telemetryDbPath: dbPath }],
		});
		const entries = readRegistryFile(path, home, FLEET.env, FLEET.platform) ?? [];
		expect(entries[0]?.telemetryDbPath).toBe(resolve(dbPath));
	});

	it("c-AC-6: a telemetryDbPath under ANOTHER product's subdir (per-own-name binding) degrades to health-probe-only", () => {
		// Entry name is "honeycomb" but the DB path is under nectar's telemetry dir: rejected,
		// because the new-location root is bound to the entry's OWN name (the tight default).
		const dbPath = join(productTelemetryRoot(root, "nectar"), "stolen.sqlite");
		const path = writeRegistry({
			daemons: [{ name: "honeycomb", healthUrl: "http://127.0.0.1:3850/health", telemetryDbPath: dbPath }],
		});
		const entries = readRegistryFile(path, home, FLEET.env, FLEET.platform) ?? [];
		expect(entries[0]?.telemetryDbPath).toBeUndefined();
	});

	it("c-AC-6 / c-AC-8: a `..` traversal escaping the trusted roots degrades to undefined (containment enforced)", () => {
		const dbPath = `${join(productTelemetryRoot(root, "honeycomb"))}/../../../etc/passwd`;
		const path = writeRegistry({
			daemons: [{ name: "honeycomb", healthUrl: "http://127.0.0.1:3850/health", telemetryDbPath: dbPath }],
		});
		const entries = readRegistryFile(path, home, FLEET.env, FLEET.platform) ?? [];
		expect(entries[0]?.telemetryDbPath).toBeUndefined();
	});

	it("c-AC-6: a relative telemetryDbPath (cwd-anchored) and an absolute path outside every root both degrade to undefined", () => {
		const path = writeRegistry({
			daemons: [
				{ name: "honeycomb", healthUrl: "http://127.0.0.1:3850/health", telemetryDbPath: "relative/x.sqlite" },
				{ name: "nectar", healthUrl: "http://127.0.0.1:3854/health", telemetryDbPath: join(home, "outside", "x.sqlite") },
			],
		});
		const entries = readRegistryFile(path, home, FLEET.env, FLEET.platform) ?? [];
		expect(entries[0]?.telemetryDbPath).toBeUndefined();
		expect(entries[1]?.telemetryDbPath).toBeUndefined();
	});

	it("c-AC-8: containment is per-root - a nested subdirectory under the entry's own telemetry root is still accepted", () => {
		const dbPath = join(productTelemetryRoot(root, "hive"), "nested", "hive.sqlite");
		const path = writeRegistry({
			daemons: [{ name: "hive", healthUrl: "http://127.0.0.1:3853/health", telemetryDbPath: dbPath }],
		});
		const entries = readRegistryFile(path, home, FLEET.env, FLEET.platform) ?? [];
		expect(entries[0]?.telemetryDbPath).toBe(resolve(dbPath));
	});

	// ── c-AC-8 Windows path shapes (QA Warning 3): drive-letter re-anchoring, drive-relative,
	// and UNC forms must all be rejected against a C:-rooted trust set. These shapes are only
	// meaningful to the win32 path dialect, so they run on win32 hosts (where the temp HOME,
	// and therefore every trusted root, is C:-rooted).
	const onWindows = process.platform === "win32";

	it.runIf(onWindows)("c-AC-8 (win32): a DIFFERENT-DRIVE absolute telemetryDbPath (D:\\evil\\...) is rejected against a C:-rooted trust set", () => {
		const path = writeRegistry({
			daemons: [
				{ name: "honeycomb", healthUrl: "http://127.0.0.1:3850/health", telemetryDbPath: "D:\\evil\\telemetry\\x.sqlite" },
			],
		});
		const entries = readRegistryFile(path, home, FLEET.env, FLEET.platform) ?? [];
		expect(entries[0]?.telemetryDbPath).toBeUndefined();
	});

	it.runIf(onWindows)("c-AC-8 (win32): a DRIVE-RELATIVE telemetryDbPath (C:evil\\...) is rejected (cwd-on-drive anchored, not absolute)", () => {
		// `C:evil\x.sqlite` is relative to the current directory ON drive C: -- its meaning
		// depends on process state, so the absolute-only gate must reject it outright.
		const path = writeRegistry({
			daemons: [
				{ name: "honeycomb", healthUrl: "http://127.0.0.1:3850/health", telemetryDbPath: "C:evil\\telemetry\\x.sqlite" },
			],
		});
		const entries = readRegistryFile(path, home, FLEET.env, FLEET.platform) ?? [];
		expect(entries[0]?.telemetryDbPath).toBeUndefined();
	});

	it.runIf(onWindows)("c-AC-8 (win32): a UNC telemetryDbPath (\\\\evil\\share\\...) is rejected (network re-anchoring)", () => {
		const path = writeRegistry({
			daemons: [
				{ name: "nectar", healthUrl: "http://127.0.0.1:3854/health", telemetryDbPath: "\\\\evil\\share\\telemetry\\x.sqlite" },
			],
		});
		const entries = readRegistryFile(path, home, FLEET.env, FLEET.platform) ?? [];
		expect(entries[0]?.telemetryDbPath).toBeUndefined();
	});

	it("c-AC-8 (both dialects): an absolute path on a DIFFERENT top-level root than every trusted root is rejected", () => {
		// The dialect-neutral analogue of drive re-anchoring: an absolute path anchored at a
		// root no trusted root lives under. On win32 the temp home is C:-rooted and this path
		// resolves onto the current drive at \evil-root; on POSIX it is /evil-root. Both are
		// outside every trusted root and must degrade to health-probe-only.
		const foreign = resolve("/evil-root/telemetry/x.sqlite");
		const path = writeRegistry({
			daemons: [{ name: "honeycomb", healthUrl: "http://127.0.0.1:3850/health", telemetryDbPath: foreign }],
		});
		const entries = readRegistryFile(path, home, FLEET.env, FLEET.platform) ?? [];
		expect(entries[0]?.telemetryDbPath).toBeUndefined();
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Mid-window continuity for explicit legacy paths (c-AC-7 / module AC-6)
// ────────────────────────────────────────────────────────────────────────────

describe("mid-window continuity for not-yet-migrated entries (PRD-004c c-AC-7)", () => {
	it("c-AC-7 / AC-6: an entry carrying explicit legacy pid + legacy-root telemetry paths parses identically", () => {
		const legacyDb = join(legacyTelemetryRoot(home), "nectar.sqlite");
		const path = writeRegistry({
			daemons: [
				{
					name: "nectar",
					healthUrl: "http://127.0.0.1:3854/health",
					pidPath: "~/.honeycomb/nectar.pid",
					telemetryDbPath: legacyDb,
				},
			],
		});
		const entries = readRegistryFile(path, home, FLEET.env, FLEET.platform) ?? [];
		// The explicit legacy pid path is expanded exactly as before the migration.
		expect(entries[0]?.pidPath).toBe(join(home, ".honeycomb", "nectar.pid"));
		// The legacy-root telemetry DB is still accepted (ingestion continuity).
		expect(entries[0]?.telemetryDbPath).toBe(resolve(legacyDb));
	});
});
