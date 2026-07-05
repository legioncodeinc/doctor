/**
 * `doctor purge` engine tests (PRD-003c c-AC-2 .. c-AC-6).
 *
 * Drives the REAL {@link createPurgeEngine} over an injected {@link CommandRunner} (records
 * argv, never spawns) and an injected {@link PurgeFs} (in-memory, never touches real disk),
 * plus a fake doctor-own {@link ServiceModule}. Nothing here ever shells out or writes to
 * the real filesystem.
 */

import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { CommandResult, CommandRunner } from "../../src/rungs/command-runner.js";
import { createPurgeEngine, purgeSummaryLines, type PurgeFs } from "../../src/purge/engine.js";
import { DOCTOR_NPM_PACKAGE, systemScopeLaunchdPath, systemScopeSystemdPath } from "../../src/purge/inventory.js";
import { LEGACY_SERVICE_LABEL, LEGACY_SYSTEMD_UNIT_NAME, LEGACY_WINDOWS_TASK_NAME } from "../../src/service/platform.js";

const HOME = "/home/tester";
const APIARY_ROOT = join(HOME, ".apiary");

/** A recording runner whose response is decided by a per-test `respond` callback. */
function fakeRunner(respond: (command: string, args: readonly string[]) => CommandResult): {
	runner: CommandRunner;
	calls: Array<{ command: string; args: readonly string[] }>;
} {
	const calls: Array<{ command: string; args: readonly string[] }> = [];
	return {
		calls,
		runner: {
			async run(command, args): Promise<CommandResult> {
				calls.push({ command, args: [...args] });
				return respond(command, args);
			},
		},
	};
}

const OK: CommandResult = { ok: true, code: 0, stdout: "", stderr: "" };
const NOT_FOUND: CommandResult = { ok: false, code: 1, stdout: "", stderr: "not found" };

/** An in-memory {@link PurgeFs}: `existing` seeds present dirs; `failing` makes a removeDir throw. */
function fakeFs(existing: readonly string[], failing: readonly string[] = []): PurgeFs & { removed: string[] } {
	const present = new Set(existing);
	const removed: string[] = [];
	return {
		removed,
		exists: (path: string) => present.has(path),
		removeDir: (path: string) => {
			if (failing.includes(path)) throw new Error("EACCES: permission denied");
			present.delete(path);
			removed.push(path);
		},
	};
}

/** `npm ls -g <pkg>` responder: `ok:true` + stdout containing the pkg name iff `present`. */
function npmDetectResponse(pkg: string, present: boolean): CommandResult {
	return present ? { ok: true, code: 0, stdout: `/usr/lib\n└── ${pkg}@1.0.0\n`, stderr: "" } : NOT_FOUND;
}

const ALL_STATE_DIRS = [APIARY_ROOT, join(HOME, ".deeplake"), join(HOME, ".hivemind"), join(HOME, ".honeycomb")];

const OTHER_CURRENT_PKGS = ["@legioncodeinc/honeycomb", "@legioncodeinc/nectar", "@legioncodeinc/hive"];
const LEGACY_PKGS = ["@deeplake/hivemind"];

describe("purgeSummaryLines (c-AC-1)", () => {
	it("explicitly names ~/.deeplake and the standalone Hivemind install it is shared with", () => {
		const lines = purgeSummaryLines().join("\n");
		expect(lines).toContain("~/.deeplake");
		expect(lines.toLowerCase()).toContain("hivemind");
		expect(lines).toContain(DOCTOR_NPM_PACKAGE);
	});
});

describe("createPurgeEngine - full wipe (c-AC-2/c-AC-3)", () => {
	it("removes every other product's services (current+legacy), npm packages, state dirs, then doctor's own service+package LAST", async () => {
		const { runner, calls } = fakeRunner((command, args) => {
			if (command === "systemctl") return OK; // every deregister "found and removed"
			if (command === "npm" && args[0] === "ls") return npmDetectResponse(String(args[2]), true);
			if (command === "npm" && args[0] === "uninstall") return OK;
			return OK;
		});
		const fs = fakeFs(ALL_STATE_DIRS);
		const serviceModule = { uninstall: vi.fn(async () => ({ ok: true, message: "Doctor service unregistered." })) };

		const engine = createPurgeEngine({ runner, serviceModule, fs, home: HOME, env: {}, platform: "linux" });
		const report = await engine.run();

		expect(report.ok).toBe(true);
		expect(report.nothingToRemove).toBe(false);

		// (1) other products' CURRENT + LEGACY systemd units were all deregistered.
		const systemctlUnits = calls.filter((c) => c.command === "systemctl").map((c) => c.args.at(-1));
		expect(systemctlUnits).toEqual(
			expect.arrayContaining([
				"honeycomb.service",
				"ai.honeycomb.daemon.service",
				"nectar.service",
				"hivenectar.service",
				"hive.service",
				"thehive.service",
			]),
		);
		// doctor's OWN unit is never touched by the generic deregister loop (it goes through
		// serviceModule.uninstall() instead, step 4).
		expect(systemctlUnits).not.toContain("doctor.service");

		// (2) other products' npm packages + the legacy package were all removed.
		const npmUninstalled = calls.filter((c) => c.command === "npm" && c.args[0] === "uninstall").map((c) => c.args[2]);
		for (const pkg of [...OTHER_CURRENT_PKGS, ...LEGACY_PKGS, DOCTOR_NPM_PACKAGE]) {
			expect(npmUninstalled).toContain(pkg);
		}

		// (3) every state dir was removed.
		for (const dir of ALL_STATE_DIRS) expect(fs.removed).toContain(dir);

		// (4) doctor's OWN service was uninstalled.
		expect(serviceModule.uninstall).toHaveBeenCalledTimes(1);

		// (5) the success line for everything else prints BEFORE doctor's own package result.
		const successIdx = report.lines.findIndex((l) => l.includes("Purge succeeded"));
		const ownPkgIdx = report.lines.findIndex((l) => l.includes(DOCTOR_NPM_PACKAGE) && l.includes("removed"));
		expect(successIdx).toBeGreaterThanOrEqual(0);
		expect(ownPkgIdx).toBeGreaterThan(successIdx);
	});

	it("darwin: deregisters via launchctl bootout using the current then legacy labels", async () => {
		const { runner, calls } = fakeRunner((command, args) => {
			if (command === "launchctl") return OK;
			if (command === "npm" && args[0] === "ls") return NOT_FOUND;
			return OK;
		});
		const fs = fakeFs([]);
		const serviceModule = { uninstall: vi.fn(async () => ({ ok: true, message: "unregistered" })) };
		const engine = createPurgeEngine({ runner, serviceModule, fs, home: HOME, env: {}, platform: "darwin", uid: 501 });
		await engine.run();

		const labels = calls.filter((c) => c.command === "launchctl").map((c) => c.args[1]);
		expect(labels).toEqual(
			expect.arrayContaining([
				"gui/501/com.legioncode.honeycomb",
				"gui/501/ai.honeycomb.daemon",
				"gui/501/com.legioncode.nectar",
				"gui/501/com.hivenectar.daemon",
				"gui/501/com.legioncode.hive",
				"gui/501/thehive",
			]),
		);
	});

	it("win32: deregisters via schtasks /Delete using the current then legacy task names", async () => {
		const { runner, calls } = fakeRunner((command, args) => {
			if (command === "schtasks") return OK;
			if (command === "npm" && args[0] === "ls") return NOT_FOUND;
			return OK;
		});
		const fs = fakeFs([]);
		const serviceModule = { uninstall: vi.fn(async () => ({ ok: true, message: "unregistered" })) };
		const engine = createPurgeEngine({ runner, serviceModule, fs, home: HOME, env: {}, platform: "win32" });
		await engine.run();

		const taskNames = calls.filter((c) => c.command === "schtasks").map((c) => c.args[2]);
		expect(taskNames).toEqual(
			expect.arrayContaining(["honeycomb", "HoneycombDaemon", "nectar", "HivenectarDaemon", "hive", "thehive"]),
		);
	});
});

describe("createPurgeEngine - c-AC-3: doctor's OWN legacy unit + system-scope survivors", () => {
	it("c-AC-3: doctor's OWN legacy systemd label is deregistered during purge (linux)", async () => {
		const { runner, calls } = fakeRunner((command, args) => {
			if (command === "npm" && args[0] === "ls") return NOT_FOUND;
			return OK;
		});
		const fs = fakeFs([]);
		const serviceModule = { uninstall: vi.fn(async () => ({ ok: true, message: "Doctor service unregistered." })) };
		const engine = createPurgeEngine({ runner, serviceModule, fs, home: HOME, env: {}, platform: "linux" });
		await engine.run();

		const systemctlUnits = calls.filter((c) => c.command === "systemctl").map((c) => c.args.at(-1));
		expect(systemctlUnits).toContain(LEGACY_SYSTEMD_UNIT_NAME);
		// doctor's CURRENT label is never deregistered directly by this engine (it goes
		// through the mocked serviceModule.uninstall() instead).
		expect(systemctlUnits).not.toContain("doctor.service");
	});

	it("c-AC-3: doctor's OWN legacy launchd label is deregistered during purge (darwin)", async () => {
		const { runner, calls } = fakeRunner((command, args) => {
			if (command === "npm" && args[0] === "ls") return NOT_FOUND;
			return OK;
		});
		const fs = fakeFs([]);
		const serviceModule = { uninstall: vi.fn(async () => ({ ok: true, message: "unregistered" })) };
		const engine = createPurgeEngine({ runner, serviceModule, fs, home: HOME, env: {}, platform: "darwin", uid: 501 });
		await engine.run();

		const labels = calls.filter((c) => c.command === "launchctl").map((c) => c.args[1]);
		expect(labels).toContain(`gui/501/${LEGACY_SERVICE_LABEL}`);
	});

	it("c-AC-3: a surviving system-scope launchd unit file is reported with the exact removal command (darwin)", async () => {
		const { runner } = fakeRunner((command, args) => {
			if (command === "npm" && args[0] === "ls") return NOT_FOUND;
			return OK;
		});
		const survivorPath = systemScopeLaunchdPath("com.legioncode.honeycomb");
		const fs = fakeFs([survivorPath]);
		const serviceModule = { uninstall: vi.fn(async () => ({ ok: true, message: "unregistered" })) };
		const engine = createPurgeEngine({ runner, serviceModule, fs, home: HOME, env: {}, platform: "darwin" });
		const report = await engine.run();

		const survivorLine = report.lines.find((l) => l.includes(survivorPath));
		expect(survivorLine).toBeDefined();
		expect(survivorLine).toContain("sudo launchctl bootout system/com.legioncode.honeycomb");
		expect(survivorLine).toContain(`sudo rm ${survivorPath}`);
		// Report-only: purge never attempts to remove the file itself (no escalation).
		expect(fs.removed).not.toContain(survivorPath);
	});

	it("c-AC-3: a surviving system-scope systemd unit file is reported with the exact removal command (linux)", async () => {
		const { runner } = fakeRunner((command, args) => {
			if (command === "npm" && args[0] === "ls") return NOT_FOUND;
			return OK;
		});
		const survivorPath = systemScopeSystemdPath("nectar.service");
		const fs = fakeFs([survivorPath]);
		const serviceModule = { uninstall: vi.fn(async () => ({ ok: true, message: "unregistered" })) };
		const engine = createPurgeEngine({ runner, serviceModule, fs, home: HOME, env: {}, platform: "linux" });
		const report = await engine.run();

		const survivorLine = report.lines.find((l) => l.includes(survivorPath));
		expect(survivorLine).toBeDefined();
		expect(survivorLine).toContain("sudo systemctl disable --now nectar.service");
		expect(survivorLine).toContain(`sudo rm ${survivorPath}`);
		expect(fs.removed).not.toContain(survivorPath);
	});

	it("c-AC-3: a system-scope survivor is not falsely reported as 'nothing to remove' when it is the only asset present", async () => {
		const { runner } = fakeRunner(() => NOT_FOUND);
		const survivorPath = systemScopeSystemdPath(LEGACY_SYSTEMD_UNIT_NAME);
		const fs = fakeFs([survivorPath]);
		const serviceModule = { uninstall: vi.fn(async () => ({ ok: false, message: "was already gone" })) };
		const engine = createPurgeEngine({ runner, serviceModule, fs, home: HOME, env: {}, platform: "linux" });
		const report = await engine.run();

		expect(report.nothingToRemove).toBe(false);
		expect(report.lines.some((l) => l.includes(survivorPath))).toBe(true);
	});

	it("c-AC-3: Windows sc-scope stop+delete is attempted for every enumerated task name (current+legacy, other products and doctor's own)", async () => {
		const { runner, calls } = fakeRunner((command, args) => {
			if (command === "npm" && args[0] === "ls") return NOT_FOUND;
			return OK;
		});
		const fs = fakeFs([]);
		const serviceModule = { uninstall: vi.fn(async () => ({ ok: true, message: "unregistered" })) };
		const engine = createPurgeEngine({ runner, serviceModule, fs, home: HOME, env: {}, platform: "win32" });
		const report = await engine.run();

		const scNames = calls.filter((c) => c.command === "sc").map((c) => c.args[1]);
		for (const name of ["honeycomb", "HoneycombDaemon", "nectar", "HivenectarDaemon", "hive", "thehive", LEGACY_WINDOWS_TASK_NAME]) {
			expect(scNames, `sc should be attempted for "${name}"`).toContain(name);
		}
		// Both stop AND delete are attempted per name.
		const scStops = calls.filter((c) => c.command === "sc" && c.args[0] === "stop");
		const scDeletes = calls.filter((c) => c.command === "sc" && c.args[0] === "delete");
		expect(scStops.length).toBeGreaterThan(0);
		expect(scDeletes.length).toBeGreaterThan(0);
		// A failed/unprivileged sc attempt never fails the purge (best-effort, non-fatal).
		expect(report.ok).toBe(true);
	});

	it("c-AC-3: a failed sc-scope attempt (unprivileged) is tolerated and never fails the purge", async () => {
		const { runner } = fakeRunner((command, args) => {
			if (command === "sc") return { ok: false, code: 5, stdout: "", stderr: "Access is denied." };
			if (command === "npm" && args[0] === "ls") return NOT_FOUND;
			return OK;
		});
		const fs = fakeFs([]);
		const serviceModule = { uninstall: vi.fn(async () => ({ ok: true, message: "unregistered" })) };
		const engine = createPurgeEngine({ runner, serviceModule, fs, home: HOME, env: {}, platform: "win32" });
		const report = await engine.run();
		expect(report.ok).toBe(true);
	});
});

describe("createPurgeEngine - c-AC-4: a failed earlier step blocks doctor's own removal", () => {
	it("skips doctor's own service AND package when a state-dir removal fails, and reports the failure", async () => {
		const { runner } = fakeRunner((command, args) => {
			if (command === "systemctl") return NOT_FOUND; // tolerated: "nothing registered"
			if (command === "npm" && args[0] === "ls") return NOT_FOUND;
			return OK;
		});
		const deeplakeDir = join(HOME, ".deeplake");
		const fs = fakeFs(ALL_STATE_DIRS, [deeplakeDir]); // this one throws on removal
		const serviceModule = { uninstall: vi.fn(async () => ({ ok: true, message: "unregistered" })) };

		const engine = createPurgeEngine({ runner, serviceModule, fs, home: HOME, env: {}, platform: "linux" });
		const report = await engine.run();

		expect(report.ok).toBe(false);
		expect(report.nothingToRemove).toBe(false);
		expect(report.lines.some((l) => l.includes("~/.deeplake") && l.includes("FAILED"))).toBe(true);
		expect(report.lines.some((l) => l.toLowerCase().includes("re-run"))).toBe(true);

		// c-AC-4: doctor survives - its own service and package are NEVER touched.
		expect(serviceModule.uninstall).not.toHaveBeenCalled();
	});

	it("a re-run after the fix resumes and finishes (already-removed items are skipped)", async () => {
		const deeplakeDir = join(HOME, ".deeplake");
		// First run: ~/.deeplake fails; everything else (already absent) is a no-op.
		const failingFs = fakeFs([deeplakeDir], [deeplakeDir]);
		const { runner: runner1 } = fakeRunner((command, args) => {
			if (command === "npm" && args[0] === "ls") return NOT_FOUND;
			return NOT_FOUND;
		});
		const serviceModule = { uninstall: vi.fn(async () => ({ ok: true, message: "unregistered" })) };
		const firstReport = await createPurgeEngine({
			runner: runner1,
			serviceModule,
			fs: failingFs,
			home: HOME,
			env: {},
			platform: "linux",
		}).run();
		expect(firstReport.ok).toBe(false);
		expect(serviceModule.uninstall).not.toHaveBeenCalled();

		// Second run: the operator fixed the permission issue; ~/.deeplake now removes cleanly,
		// and everything else is already gone (still tolerated as "not present").
		const fixedFs = fakeFs([deeplakeDir]); // no `failing` list this time
		const { runner: runner2 } = fakeRunner((command, args) => {
			if (command === "npm" && args[0] === "ls" && String(args[2]) === DOCTOR_NPM_PACKAGE) return NOT_FOUND;
			if (command === "npm" && args[0] === "ls") return NOT_FOUND;
			return NOT_FOUND;
		});
		const secondReport = await createPurgeEngine({
			runner: runner2,
			serviceModule,
			fs: fixedFs,
			home: HOME,
			env: {},
			platform: "linux",
		}).run();
		expect(secondReport.ok).toBe(true);
		expect(fixedFs.removed).toContain(deeplakeDir);
		expect(serviceModule.uninstall).toHaveBeenCalledTimes(1);
	});
});

describe("createPurgeEngine - c-AC-5: closed allow-list only", () => {
	it("only ever removes the four named state dirs, never a wildcard or an unrelated path", async () => {
		const { runner } = fakeRunner(() => NOT_FOUND);
		const fs = fakeFs(ALL_STATE_DIRS);
		const serviceModule = { uninstall: vi.fn(async () => ({ ok: true, message: "unregistered" })) };
		await createPurgeEngine({ runner, serviceModule, fs, home: HOME, env: {}, platform: "linux" }).run();
		expect(fs.removed.sort()).toEqual([...ALL_STATE_DIRS].sort());
	});

	it("only ever shells out with the enumerated unit/task names and package names, never a made-up one", async () => {
		const { runner, calls } = fakeRunner(() => OK);
		const fs = fakeFs([]);
		const serviceModule = { uninstall: vi.fn(async () => ({ ok: true, message: "unregistered" })) };
		await createPurgeEngine({ runner, serviceModule, fs, home: HOME, env: {}, platform: "linux" }).run();

		const ALLOWED_UNITS = new Set([
			"honeycomb.service",
			"ai.honeycomb.daemon.service",
			"nectar.service",
			"hivenectar.service",
			"hive.service",
			"thehive.service",
			// c-AC-3: doctor's OWN legacy unit is also best-effort deregistered during purge
			// (step 4); its CURRENT label goes through the mocked serviceModule.uninstall()
			// instead, never a direct systemctl call from this engine.
			"hivedoctor.service",
		]);
		const ALLOWED_PACKAGES = new Set([...OTHER_CURRENT_PKGS, ...LEGACY_PKGS, DOCTOR_NPM_PACKAGE]);
		for (const call of calls) {
			if (call.command === "systemctl") expect(ALLOWED_UNITS.has(String(call.args.at(-1)))).toBe(true);
			if (call.command === "npm") expect(ALLOWED_PACKAGES.has(String(call.args[2]))).toBe(true);
		}
	});
});

describe("createPurgeEngine - c-AC-6: a clean machine is a no-op", () => {
	it("reports nothing found anywhere and exits ok with a single friendly line", async () => {
		const { runner } = fakeRunner(() => NOT_FOUND);
		const fs = fakeFs([]); // no state dirs exist
		const serviceModule = { uninstall: vi.fn(async () => ({ ok: false, message: "was already gone" })) };
		const report = await createPurgeEngine({ runner, serviceModule, fs, home: HOME, env: {}, platform: "linux" }).run();

		expect(report.ok).toBe(true);
		expect(report.nothingToRemove).toBe(true);
		expect(report.lines).toHaveLength(1);
		expect(report.lines[0]).toMatch(/nothing to remove/i);
	});

	it("summaryLines names the RESOLVED fleet root so an env override is visible before confirmation", () => {
		const customRoot = "/mnt/custom-apiary";
		const { runner } = fakeRunner(() => NOT_FOUND);
		const serviceModule = { uninstall: vi.fn(async () => ({ ok: true, message: "unregistered" })) };
		const engine = createPurgeEngine({
			runner,
			serviceModule,
			fs: fakeFs([]),
			home: HOME,
			env: { APIARY_HOME: customRoot },
			platform: "linux",
		});
		expect(engine.summaryLines().join("\n")).toContain(customRoot);
	});

	it("honors the RESOLVED fleet root (APIARY_HOME override), not a hardcoded ~/.apiary", async () => {
		const customRoot = "/mnt/custom-apiary";
		const { runner } = fakeRunner(() => NOT_FOUND);
		const fs = fakeFs([customRoot]);
		const serviceModule = { uninstall: vi.fn(async () => ({ ok: false, message: "gone" })) };
		const report = await createPurgeEngine({
			runner,
			serviceModule,
			fs,
			home: HOME,
			env: { APIARY_HOME: customRoot },
			platform: "linux",
		}).run();

		expect(fs.removed).toContain(customRoot);
		expect(report.ok).toBe(true);
	});
});

describe("createPurgeEngine - c-AC-5/AC-8 security guard: forbidden fleet-root targets", () => {
	/** Build an engine whose env pins APIARY_HOME to `root`; every unit/npm probe reports absent. */
	function guardEngine(root: string, fs: PurgeFs & { removed: string[] }) {
		const { runner } = fakeRunner((command, args) => {
			if (command === "npm" && args[0] === "ls") return NOT_FOUND;
			return NOT_FOUND;
		});
		const serviceModule = { uninstall: vi.fn(async () => ({ ok: true, message: "unregistered" })) };
		return {
			serviceModule,
			engine: createPurgeEngine({
				runner,
				serviceModule,
				fs,
				home: HOME,
				env: { APIARY_HOME: root },
				platform: "linux",
			}),
		};
	}

	it("REFUSES a fleet root that resolved to the home directory itself (APIARY_HOME=$HOME)", async () => {
		const fs = fakeFs([HOME]);
		const { engine, serviceModule } = guardEngine(HOME, fs);
		const report = await engine.run();

		expect(fs.removed).not.toContain(HOME);
		expect(report.ok).toBe(false);
		expect(report.lines.some((l) => l.includes("REFUSED") && l.includes("APIARY_HOME"))).toBe(true);
		// The refusal is a hard failure: doctor's own service/package are never touched.
		expect(serviceModule.uninstall).not.toHaveBeenCalled();
	});

	it("REFUSES a fleet root that resolved to a filesystem root (APIARY_HOME=/)", async () => {
		const fs = fakeFs(["/"]);
		const { engine } = guardEngine("/", fs);
		const report = await engine.run();

		expect(fs.removed).not.toContain("/");
		expect(report.ok).toBe(false);
		expect(report.lines.some((l) => l.includes("REFUSED"))).toBe(true);
	});

	it("REFUSES a fleet root that is an ANCESTOR of home (APIARY_HOME=/home when home is /home/tester)", async () => {
		const ancestor = "/home";
		const fs = fakeFs([ancestor]);
		const { engine } = guardEngine(ancestor, fs);
		const report = await engine.run();

		expect(fs.removed).not.toContain(ancestor);
		expect(report.ok).toBe(false);
		expect(report.lines.some((l) => l.includes("REFUSED"))).toBe(true);
	});

	it("still allows a legitimate dedicated custom root (a sibling of home, not an ancestor)", async () => {
		const customRoot = "/srv/apiary-state";
		const fs = fakeFs([customRoot]);
		const { engine } = guardEngine(customRoot, fs);
		const report = await engine.run();

		expect(fs.removed).toContain(customRoot);
		expect(report.ok).toBe(true);
	});
});
