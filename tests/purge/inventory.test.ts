/**
 * Purge coverage inventory tests (PRD-003c c-AC-3/c-AC-5): the FROZEN allow-list matches
 * `library/ledger/EXECUTION_LEDGER-fleet-lifecycle.md`'s coverage table verbatim, and
 * doctor's OWN identifiers are mirrored from `service/platform.ts` (never re-declared).
 */

import { describe, expect, it } from "vitest";

import {
	LEGACY_SERVICE_LABEL,
	LEGACY_SYSTEMD_UNIT_NAME,
	LEGACY_WINDOWS_TASK_NAME,
	SERVICE_LABEL,
	SYSTEMD_UNIT_NAME,
	WINDOWS_TASK_NAME,
} from "../../src/service/platform.js";
import {
	DOCTOR_NPM_PACKAGE,
	DOCTOR_UNIT_NAMES,
	LEGACY_NPM_PACKAGES,
	OTHER_PRODUCTS,
	STATE_DIR_NAMES,
	systemScopeLaunchdPath,
	systemScopeSystemdPath,
} from "../../src/purge/inventory.js";

describe("OTHER_PRODUCTS (ledger-frozen 2026-07-04 22:35)", () => {
	it("covers exactly honeycomb, nectar, and hive", () => {
		expect(OTHER_PRODUCTS.map((p) => p.product)).toEqual(["honeycomb", "nectar", "hive"]);
	});

	it("every product's current npm package is under the @legioncodeinc scope", () => {
		for (const product of OTHER_PRODUCTS) {
			expect(product.npmPackage).toBe(`@legioncodeinc/${product.product}`);
		}
	});

	it("matches the frozen launchd/systemd/windows current + legacy names verbatim", () => {
		const honeycomb = OTHER_PRODUCTS.find((p) => p.product === "honeycomb");
		expect(honeycomb?.launchdLabel).toEqual({ current: "com.legioncode.honeycomb", legacy: ["ai.honeycomb.daemon"] });
		expect(honeycomb?.systemdUnit).toEqual({ current: "honeycomb.service", legacy: ["ai.honeycomb.daemon.service"] });
		expect(honeycomb?.windowsTask).toEqual({ current: "honeycomb", legacy: ["HoneycombDaemon"] });

		const nectar = OTHER_PRODUCTS.find((p) => p.product === "nectar");
		expect(nectar?.launchdLabel).toEqual({ current: "com.legioncode.nectar", legacy: ["com.hivenectar.daemon"] });
		expect(nectar?.systemdUnit).toEqual({ current: "nectar.service", legacy: ["hivenectar.service"] });
		expect(nectar?.windowsTask).toEqual({ current: "nectar", legacy: ["HivenectarDaemon"] });

		const hive = OTHER_PRODUCTS.find((p) => p.product === "hive");
		expect(hive?.launchdLabel).toEqual({ current: "com.legioncode.hive", legacy: ["thehive"] });
		expect(hive?.systemdUnit).toEqual({ current: "hive.service", legacy: ["thehive.service"] });
		expect(hive?.windowsTask).toEqual({ current: "hive", legacy: ["thehive"] });
	});
});

describe("DOCTOR_UNIT_NAMES (mirrored from service/platform.ts, never re-declared)", () => {
	it("mirrors SERVICE_LABEL/SYSTEMD_UNIT_NAME/WINDOWS_TASK_NAME and their legacy counterparts exactly", () => {
		expect(DOCTOR_UNIT_NAMES.launchdLabel).toEqual({ current: SERVICE_LABEL, legacy: [LEGACY_SERVICE_LABEL] });
		expect(DOCTOR_UNIT_NAMES.systemdUnit).toEqual({ current: SYSTEMD_UNIT_NAME, legacy: [LEGACY_SYSTEMD_UNIT_NAME] });
		expect(DOCTOR_UNIT_NAMES.windowsTask).toEqual({ current: WINDOWS_TASK_NAME, legacy: [LEGACY_WINDOWS_TASK_NAME] });
	});
});

describe("npm package + state-dir inventory", () => {
	it("doctor's own package is @legioncodeinc/doctor, tracked separately from OTHER_PRODUCTS", () => {
		expect(DOCTOR_NPM_PACKAGE).toBe("@legioncodeinc/doctor");
		expect(OTHER_PRODUCTS.some((p) => p.npmPackage === DOCTOR_NPM_PACKAGE)).toBe(false);
	});

	it("the only legacy npm package is @deeplake/hivemind (no unscoped legacy packages ever shipped)", () => {
		expect(LEGACY_NPM_PACKAGES).toEqual(["@deeplake/hivemind"]);
	});

	it("the frozen legacy state-dir names are .deeplake, .hivemind, and .honeycomb", () => {
		expect(STATE_DIR_NAMES).toEqual({
			deeplake: ".deeplake",
			legacyHivemind: ".hivemind",
			legacyHoneycomb: ".honeycomb",
		});
	});
});

describe("system-scope unit paths (report-only, c-AC-3 / decision 13)", () => {
	it("builds the exact macOS system-scope LaunchDaemon plist path for a label", () => {
		expect(systemScopeLaunchdPath("com.legioncode.doctor")).toBe("/Library/LaunchDaemons/com.legioncode.doctor.plist");
	});

	it("builds the exact Linux system-scope systemd unit path for a unit name", () => {
		expect(systemScopeSystemdPath("doctor.service")).toBe("/etc/systemd/system/doctor.service");
	});
});
