/**
 * The fleet-shared coordination surface (PRD-004b): the registry two-location resolution,
 * the one-time idempotent migration, the both-locations merge/precedence rule, and the
 * device.json + install-id relocations with legacy-fallback reads.
 *
 * Every test uses a temp HOME + injected `env: {}` / `platform: "linux"` so the fleet root is
 * deterministically `<HOME>/.apiary` and the legacy root is `<HOME>/.honeycomb`, independent
 * of any host APIARY_HOME/XDG.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	defaultRegistryPath,
	legacyRegistryPath,
	migratedLegacyRegistryPath,
	migrateRegistry,
	RegistryError,
	resolveRegistryEntries,
} from "../src/registry.js";

const FLEET = { env: {}, platform: "linux" as const };

let home: string;
let newPath: string;
let legacyPath: string;
let migratedPath: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "doctor-fleet-reg-"));
	newPath = defaultRegistryPath(home, {}, "linux");
	legacyPath = legacyRegistryPath(home);
	migratedPath = migratedLegacyRegistryPath(home);
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

/** Write a registry JSON file to `path`, creating parent dirs. */
function writeFile(path: string, obj: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(obj), "utf8");
}

function entry(name: string, port: number): Record<string, unknown> {
	return { name, healthUrl: `http://127.0.0.1:${port}/health` };
}

describe("registry migration (PRD-004b)", () => {
	it("b-AC-1 / AC-3: only a legacy registry present -> migrated to <root>/registry.json, legacy preserved, same fleet", () => {
		writeFile(legacyPath, { daemons: [entry("honeycomb", 3850), entry("nectar", 3854)] });

		const result = migrateRegistry({ home, ...FLEET });

		expect(result.migrated).toBe(true);
		expect(result.reason).toBe("migrated");
		// New file created with the legacy content (shape unchanged).
		expect(existsSync(newPath)).toBe(true);
		expect(JSON.parse(readFileSync(newPath, "utf8"))).toEqual({
			daemons: [entry("honeycomb", 3850), entry("nectar", 3854)],
		});
		// Legacy preserved (renamed, NOT deleted).
		expect(existsSync(legacyPath)).toBe(false);
		expect(existsSync(migratedPath)).toBe(true);
		expect(result.legacyRenamed).toBe(true);
		// The supervised fleet is identical before and after.
		const entries = resolveRegistryEntries({ home, ...FLEET }) ?? [];
		expect(entries.map((e) => e.name)).toEqual(["honeycomb", "nectar"]);
	});

	it("b-AC-2 / AC-4: a second boot is a no-op (idempotent); no file is modified", () => {
		writeFile(legacyPath, { daemons: [entry("honeycomb", 3850)] });
		migrateRegistry({ home, ...FLEET });
		const newContentAfterFirst = readFileSync(newPath, "utf8");

		const second = migrateRegistry({ home, ...FLEET });
		expect(second.migrated).toBe(false);
		expect(second.reason).toBe("new-present");
		// Nothing changed on the second run.
		expect(readFileSync(newPath, "utf8")).toBe(newContentAfterFirst);
		expect(existsSync(migratedPath)).toBe(true);
	});

	it("b-AC-3 / AC-5: both files exist with a colliding name -> new wins, legacy-only entries merge additively", () => {
		// New (migrated, doctor-managed): honeycomb (the winning copy) + nectar.
		writeFile(newPath, {
			daemons: [
				{ name: "honeycomb", healthUrl: "http://127.0.0.1:9999/health" },
				entry("nectar", 3854),
			],
		});
		// Legacy (a not-yet-updated installer): a STALE honeycomb + a legacy-only hive.
		writeFile(legacyPath, {
			daemons: [
				{ name: "honeycomb", healthUrl: "http://127.0.0.1:3850/health" },
				entry("hive", 3853),
			],
		});

		const entries = resolveRegistryEntries({ home, ...FLEET }) ?? [];
		const byName = new Map(entries.map((e) => [e.name, e]));
		// New-location honeycomb wins wholesale (its healthUrl, not the legacy one).
		expect(byName.get("honeycomb")?.healthUrl).toBe("http://127.0.0.1:9999/health");
		// nectar (new-only) and hive (legacy-only) are both supervised.
		expect([...byName.keys()].sort()).toEqual(["hive", "honeycomb", "nectar"]);
		// doctor never writes the merged result back to the legacy file.
		expect(JSON.parse(readFileSync(legacyPath, "utf8")).daemons).toHaveLength(2);
	});

	it("b-AC-4: a legacy-only entry appearing mid-window is picked up on the next resolution (reload)", () => {
		// Boot: migrate the legacy file (new created, legacy renamed).
		writeFile(legacyPath, { daemons: [entry("honeycomb", 3850)] });
		migrateRegistry({ home, ...FLEET });
		expect((resolveRegistryEntries({ home, ...FLEET }) ?? []).map((e) => e.name)).toEqual(["honeycomb"]);

		// Mid-window: an old installer writes the LEGACY file again with a new daemon.
		writeFile(legacyPath, { daemons: [entry("nectar", 3854)] });

		// A registry reload trigger re-runs the same two-location resolution and picks it up.
		const entries = resolveRegistryEntries({ home, ...FLEET }) ?? [];
		expect(entries.map((e) => e.name).sort()).toEqual(["honeycomb", "nectar"]);
	});

	it("b-AC-5: a malformed file at EITHER location throws RegistryError (fail-loud posture preserved)", () => {
		// Malformed NEW file.
		mkdirSync(join(newPath, ".."), { recursive: true });
		writeFileSync(newPath, "{ not json", "utf8");
		expect(() => resolveRegistryEntries({ home, ...FLEET })).toThrow(RegistryError);
		rmSync(newPath);

		// Malformed LEGACY file.
		mkdirSync(join(legacyPath, ".."), { recursive: true });
		writeFileSync(legacyPath, "{ not json", "utf8");
		expect(() => resolveRegistryEntries({ home, ...FLEET })).toThrow(RegistryError);
	});

	it("b-AC-5: a malformed legacy file is NOT migrated (left untouched, no new file written)", () => {
		mkdirSync(join(legacyPath, ".."), { recursive: true });
		writeFileSync(legacyPath, "{ not json", "utf8");

		const result = migrateRegistry({ home, ...FLEET });
		expect(result.migrated).toBe(false);
		expect(result.reason).toBe("legacy-malformed");
		expect(existsSync(newPath)).toBe(false);
		// The malformed legacy file is left exactly in place (never renamed, never deleted).
		expect(existsSync(legacyPath)).toBe(true);
		expect(existsSync(migratedPath)).toBe(false);
	});

	it("b-AC-8: a registry copy failure leaves the legacy file untouched and authoritative via the fallback read", () => {
		writeFile(legacyPath, { daemons: [entry("honeycomb", 3850)] });

		// Inject a copy that throws (a full disk / permission error at copy time).
		const result = migrateRegistry(
			{ home, ...FLEET },
			{
				copyFile: () => {
					throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
				},
			},
		);

		expect(result.migrated).toBe(false);
		expect(result.reason).toBe("copy-failed");
		// New file was NOT created; the legacy file is untouched (never renamed / deleted).
		expect(existsSync(newPath)).toBe(false);
		expect(existsSync(legacyPath)).toBe(true);
		expect(existsSync(migratedPath)).toBe(false);
		// doctor supervises from the legacy file via the fallback read.
		const entries = resolveRegistryEntries({ home, ...FLEET }) ?? [];
		expect(entries.map((e) => e.name)).toEqual(["honeycomb"]);
	});

	it("a rename failure after a good copy is tolerated (new authoritative, merge dedupes the still-present legacy)", () => {
		writeFile(legacyPath, { daemons: [entry("honeycomb", 3850)] });

		const result = migrateRegistry(
			{ home, ...FLEET },
			{
				rename: () => {
					throw Object.assign(new Error("EPERM"), { code: "EPERM" });
				},
			},
		);

		expect(result.migrated).toBe(true);
		expect(result.legacyRenamed).toBe(false);
		expect(existsSync(newPath)).toBe(true);
		expect(existsSync(legacyPath)).toBe(true);
		// The merge dedupes by name: the still-present legacy honeycomb is not duplicated.
		const entries = resolveRegistryEntries({ home, ...FLEET }) ?? [];
		expect(entries.map((e) => e.name)).toEqual(["honeycomb"]);
	});

	it("neither file present -> resolution is null (caller applies the honeycomb-primary fallback)", () => {
		expect(resolveRegistryEntries({ home, ...FLEET })).toBeNull();
	});
});
