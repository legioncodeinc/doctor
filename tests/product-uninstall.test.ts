/**
 * doctor's own product-uninstall composition tests (PRD-003b b-AC-2/3/4/6).
 *
 * `readProductUninstallState` (the read-only b-AC-6 pre-check) and `removeProductState`
 * (the actual registry-entry + state-dir removal) are driven over a real temp dir + a real
 * registry file so the containment/atomicity guarantees are exercised end to end, without
 * ever touching the real home (mirrors the suite-wide hermetic-home guard, tests/setup.ts).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultRegistryPath } from "../src/registry.js";
import { readProductUninstallState, removeProductState } from "../src/product-uninstall.js";

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "doctor-product-uninstall-"));
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

const ENV = {}; // an empty env keeps the ADR-0003 fleet root deterministically `<home>/.apiary`
const PLATFORM = "linux" as const;

function writeRegistryWithDoctorEntry(): void {
	const path = defaultRegistryPath(home, ENV, PLATFORM);
	mkdirSync(join(home, ".apiary"), { recursive: true });
	writeFileSync(
		path,
		JSON.stringify({ daemons: [{ name: "honeycomb", healthUrl: "http://127.0.0.1:3850/health" }, { name: "doctor" }] }),
	);
}

describe("readProductUninstallState (b-AC-6 pre-check)", () => {
	it("reports nothing present on a clean machine", () => {
		const state = readProductUninstallState({ home, env: ENV, platform: PLATFORM });
		expect(state).toEqual({ registryEntryExists: false, stateDirExists: false });
	});

	it("detects a registry entry named doctor", () => {
		writeRegistryWithDoctorEntry();
		const state = readProductUninstallState({ home, env: ENV, platform: PLATFORM });
		expect(state.registryEntryExists).toBe(true);
	});

	it("detects doctor's own state dir", () => {
		mkdirSync(join(home, ".apiary", "doctor"), { recursive: true });
		const state = readProductUninstallState({ home, env: ENV, platform: PLATFORM });
		expect(state.stateDirExists).toBe(true);
	});

	it("a malformed registry file fails safe to 'no entry' rather than throwing", () => {
		mkdirSync(join(home, ".apiary"), { recursive: true });
		writeFileSync(defaultRegistryPath(home, ENV, PLATFORM), "{ not valid json");
		expect(() => readProductUninstallState({ home, env: ENV, platform: PLATFORM })).not.toThrow();
		expect(readProductUninstallState({ home, env: ENV, platform: PLATFORM }).registryEntryExists).toBe(false);
	});
});

describe("removeProductState (b-AC-2/3/4)", () => {
	it("b-AC-3: deletes doctor's own registry entry, leaving other entries intact", () => {
		writeRegistryWithDoctorEntry();
		const result = removeProductState({ home, env: ENV, platform: PLATFORM });
		expect(result.registryEntryRemoved).toBe(true);

		const raw = JSON.parse(readFileSync(defaultRegistryPath(home, ENV, PLATFORM), "utf8")) as {
			daemons: Array<{ name: string }>;
		};
		expect(raw.daemons.map((d) => d.name)).toEqual(["honeycomb"]);
	});

	it("b-AC-4: removes doctor's own state dir and nothing else under the fleet root", () => {
		mkdirSync(join(home, ".apiary", "doctor"), { recursive: true });
		writeFileSync(join(home, ".apiary", "doctor", "state.json"), "{}");
		mkdirSync(join(home, ".apiary", "honeycomb"), { recursive: true });
		writeFileSync(join(home, ".apiary", "honeycomb", "daemon.pid"), "123");
		writeFileSync(join(home, ".apiary", "registry.json"), JSON.stringify({ daemons: [{ name: "honeycomb" }] }));

		const result = removeProductState({ home, env: ENV, platform: PLATFORM });
		expect(result.stateDirRemoved).toBe(true);
		expect(existsSync(join(home, ".apiary", "doctor"))).toBe(false);
		// Another product's dir and the registry FILE ITSELF (not deleted wholesale) survive.
		expect(existsSync(join(home, ".apiary", "honeycomb"))).toBe(true);
		expect(existsSync(join(home, ".apiary", "registry.json"))).toBe(true);
	});

	it("b-AC-6: is idempotent - calling it on an already-clean machine is a safe no-op", () => {
		const result = removeProductState({ home, env: ENV, platform: PLATFORM });
		expect(result).toEqual({ registryEntryRemoved: false, stateDirRemoved: false });
	});

	it("AC-8 guard: refuses to remove a state dir that resolved to the home directory itself", () => {
		// Craft the degenerate shape: home's basename is "doctor" and APIARY_HOME points at
		// home's parent, so `<root>/doctor` resolves to home itself. The wipe guard
		// (safe-path.ts isForbiddenWipeTarget) must refuse rather than delete home.
		const parent = home;
		const doctorHome = join(parent, "doctor");
		mkdirSync(doctorHome, { recursive: true });
		writeFileSync(join(doctorHome, "precious.txt"), "user data");

		const result = removeProductState({ home: doctorHome, env: { APIARY_HOME: parent }, platform: PLATFORM });

		expect(result.stateDirRemoved).toBe(false);
		expect(existsSync(join(doctorHome, "precious.txt"))).toBe(true);
	});

	it("never touches ~/.deeplake or a legacy ~/.honeycomb dir (parent AC-4/AC-8)", () => {
		mkdirSync(join(home, ".deeplake"), { recursive: true });
		writeFileSync(join(home, ".deeplake", "credentials.json"), "{}");
		mkdirSync(join(home, ".honeycomb"), { recursive: true });
		writeFileSync(join(home, ".honeycomb", "device.json"), "{}");
		mkdirSync(join(home, ".apiary", "doctor"), { recursive: true });

		removeProductState({ home, env: ENV, platform: PLATFORM });

		expect(existsSync(join(home, ".deeplake", "credentials.json"))).toBe(true);
		expect(existsSync(join(home, ".honeycomb", "device.json"))).toBe(true);
	});
});
