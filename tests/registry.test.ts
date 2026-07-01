/**
 * Registry loader tests (PRD-004a US-1): defensive parse of the supervised-daemon file,
 * absent-file fallback (a-AC-2), missing-optional-field defaults (a-AC-3), and loud
 * failure on a present-but-malformed file.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
	dir = mkdtempSync(join(tmpdir(), "hivedoctor-registry-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Write a registry file into the temp dir and return its path. */
function writeRegistry(contents: string): string {
	const path = join(dir, "hivedoctor.daemons.json");
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
			name: "thehive",
			healthUrl: "http://127.0.0.1:3853/health",
			pidPath: "~/.honeycomb/thehive.pid",
			probeIntervalMs: 15000,
			startupGraceMs: 45000,
			restartGiveUpThreshold: 5,
			restartCooldownMs: 2000,
		},
		{
			name: "hivenectar",
			healthUrl: "http://127.0.0.1:3854/health",
			pidPath: "~/.honeycomb/hivenectar.pid",
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
		const [honeycomb, thehive, hivenectar] = entries ?? [];
		expect(honeycomb).toMatchObject({
			name: "honeycomb",
			healthUrl: "http://127.0.0.1:3850/health",
			probeIntervalMs: 30000,
			startupGraceMs: 60000,
			restartGiveUpThreshold: 3,
			restartCooldownMs: 5000,
		});
		// The distinct per-entry values are preserved, not collapsed to one shared config.
		expect(thehive).toMatchObject({
			name: "thehive",
			healthUrl: "http://127.0.0.1:3853/health",
			probeIntervalMs: 15000,
			startupGraceMs: 45000,
			restartGiveUpThreshold: 5,
			restartCooldownMs: 2000,
		});
		expect(hivenectar?.name).toBe("hivenectar");
		expect(hivenectar?.healthUrl).toBe("http://127.0.0.1:3854/health");
	});

	it("expands a leading ~ in pidPath to the home directory", () => {
		const path = writeRegistry(JSON.stringify(THREE_DAEMONS));
		const entries = readRegistryFile(path, HOME) ?? [];
		expect(entries[0]?.pidPath).toBe(join(HOME, ".honeycomb", "daemon.pid"));
		expect(entries[1]?.pidPath).toBe(join(HOME, ".honeycomb", "thehive.pid"));
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
			pidPath: join(HOME, ".honeycomb", "daemon.pid"),
			probeIntervalMs: DEFAULTS.probeIntervalMs,
			startupGraceMs: DEFAULTS.startupGraceMs,
			restartGiveUpThreshold: DEFAULTS.restartGiveUpThreshold,
			restartCooldownMs: DEFAULTS.restartCooldownMs,
		});
	});

	it("a-AC-3: a registry entry missing optional fields resolves them to built-in defaults", () => {
		const path = writeRegistry(
			JSON.stringify({ daemons: [{ name: "hivenectar", healthUrl: "http://127.0.0.1:3854/health" }] }),
		);
		const entries = readRegistryFile(path, HOME) ?? [];
		expect(entries).toHaveLength(1);
		expect(entries[0]).toEqual({
			name: "hivenectar",
			healthUrl: "http://127.0.0.1:3854/health",
			pidPath: join(HOME, ".honeycomb", "daemon.pid"),
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
						name: "thehive",
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
			name: "thehive",
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

	it("defaultRegistryPath points under ~/.honeycomb", () => {
		expect(defaultRegistryPath(HOME)).toBe(join(HOME, ".honeycomb", "hivedoctor.daemons.json"));
	});

	it("security (SSRF): a non-loopback healthUrl falls back to the safe loopback default", () => {
		// A tampered registry pointing healthUrl at an attacker-controlled host must NEVER become the
		// probed origin: hivedoctor fetches healthUrl every interval, so an off-loopback value would
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
			JSON.stringify({ daemons: [{ name: "thehive", healthUrl: "https://evil.example.com/health" }] }),
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
