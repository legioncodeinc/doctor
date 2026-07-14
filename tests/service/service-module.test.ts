/**
 * Service-module behaviour tests (PRD-064b): the install/uninstall/status flow over the
 * injected runner + fs, asserting the unit file is written before the manager runs, the
 * uninstall removes the file (AC-064b.5), and every failure mode is a returned message
 * (never a throw, design principle 1).
 */

import { describe, expect, it } from "vitest";

import {
	createServiceModule,
	deregisterLegacyUnit,
	isServiceRegistered,
	serviceStart,
	serviceStatus,
	serviceStop,
} from "../../src/service/index.js";
import { encodeWindowsCleanupPath } from "../../src/service/argv.js";
import { SERVICE_LABEL } from "../../src/service/platform.js";
import { createMemoryFs, createRecordingRunner, fixedEnv } from "./helpers.js";

const TEST_MACOS_UID = 501;

describe("install - writes the unit file then runs the manager argv", () => {
	it("Linux: writes the systemd unit, then enables it (file before command)", async () => {
		const runner = createRecordingRunner();
		const fs = createMemoryFs();
		const module = createServiceModule({
			execPath: "/usr/bin/doctor",
			runner,
			fs,
			environment: fixedEnv({ platform: "linux", home: "/home/t" }),
		});

		const result = await module.install();

		// The unit file was written under ~/.config/systemd/user.
		const unitPath = "/home/t/.config/systemd/user/doctor.service";
		expect(fs.files.has(unitPath)).toBe(true);
		expect(fs.files.get(unitPath)).toContain("Restart=always");
		// Decision #32 migration: the legacy unit is deregistered first...
		expect(runner.calls[0]).toEqual({
			command: "systemctl",
			args: ["--user", "disable", "--now", "hivedoctor.service"],
		});
		expect(fs.removed).toContain("/home/t/.config/systemd/user/hivedoctor.service");
		// ...then systemctl --user enable --now ran.
		expect(runner.calls[1]).toEqual({
			command: "systemctl",
			args: ["--user", "enable", "--now", "doctor.service"],
		});
		// A successful install resolves ok:true (the CLI maps this to a zero exit, IRD-192 AC-6).
		expect(result.ok).toBe(true);
		expect(result.message).toContain("user scope");
	});

	it("macOS: writes the plist then bootstraps + kickstarts", async () => {
		const runner = createRecordingRunner();
		const fs = createMemoryFs();
		const module = createServiceModule({
			execPath: "/opt/doctor",
			runner,
			fs,
			uid: TEST_MACOS_UID,
			environment: fixedEnv({ platform: "darwin", home: "/Users/t" }),
		});

		const result = await module.install();

		const plistPath = `/Users/t/Library/LaunchAgents/${SERVICE_LABEL}.plist`;
		expect(fs.files.get(plistPath)).toContain("<key>KeepAlive</key>");
		// Decision #32 migration: the legacy label is booted out first, then bootstrap runs.
		expect(runner.calls[0]?.command).toBe("launchctl");
		expect(runner.calls[0]?.args[0]).toBe("bootout");
		expect(runner.calls[0]?.args[1]).toContain("com.legioncode.hivedoctor");
		// Current-label bootout reconciles an already-loaded job before the new plist is loaded.
		expect(runner.calls[1]?.args).toEqual(["bootout", `gui/${TEST_MACOS_UID}/${SERVICE_LABEL}`]);
		expect(runner.calls[2]?.args[0]).toBe("bootstrap");
		expect(result.ok).toBe(true);
	});

	it("Windows: stages the Scheduled Task XML beside the workspace, then schtasks /Create", async () => {
		const runner = createRecordingRunner();
		const fs = createMemoryFs();
		const module = createServiceModule({
			execPath: "C:\\bin\\doctor.cmd",
			runner,
			fs,
			environment: fixedEnv({ platform: "win32", home: "C:\\Users\\t", execPath: "C:\\bin\\doctor.cmd" }),
			// Deterministic identity resolution (no live process.env leakage into this assertion).
			windowsIdentity: { systemRoot: "C:\\Windows" },
		});

		const result = await module.install();

		const staged = "C:\\Users\\t/.apiary/doctor/doctor-task.xml";
		// IRD-192 AC-2: the staged XML carries the Task-Scheduler-valid PT1M interval.
		expect(fs.files.get(staged)).toContain("<Interval>PT1M</Interval>");
		expect(fs.files.get(staged)).toContain("<Task ");
		// Decision #32 migration runs first, then identity is probed. Reconciliation ends
		// the tracked task and kills only an exact orphaned Doctor child before /Create.
		expect(runner.calls[0]).toEqual({
			command: "schtasks",
			args: ["/Delete", "/TN", "HiveDoctor", "/F"],
		});
		expect(runner.calls[1]?.command).toBe("C:\\Windows\\System32\\whoami.exe");
		expect(runner.calls[2]).toEqual({ command: "schtasks", args: ["/End", "/TN", "doctor"] });
		expect(runner.calls[3]?.command).toContain("WindowsPowerShell");
		expect(runner.calls[3]?.args.slice(-2)).toEqual([
			encodeWindowsCleanupPath("C:\\bin\\doctor.cmd"), encodeWindowsCleanupPath(process.execPath),
		]);
		expect(runner.calls[4]).toEqual({
			command: "schtasks",
			args: ["/Create", "/XML", staged, "/TN", "doctor", "/F"],
		});
		expect(runner.calls[5]).toEqual({ command: "schtasks", args: ["/Run", "/TN", "doctor"] });
		expect(result.ok).toBe(true);
	});

	// Windows 11 25H2 (Administrator Protection) fix: install() resolves the SID/fallback
	// BEFORE rendering, so the staged XML actually carries the scoped UserId schtasks needs
	// to accept a per-user LogonTrigger without elevation.
	it("Windows: a resolved whoami SID is scoped onto the staged XML's LogonTrigger + Principal", async () => {
		const sid = "S-1-5-21-1-2-3-1001";
		const runner = createRecordingRunner((command, args) =>
			command === "C:\\Windows\\System32\\whoami.exe" && args[0] === "/user"
				? { ok: true, code: 0, stdout: `"CORP\\alice","${sid}"\r\n`, stderr: "" }
				: { ok: true, code: 0, stdout: "", stderr: "" },
		);
		const fs = createMemoryFs();
		const module = createServiceModule({
			execPath: "C:\\bin\\doctor.cmd",
			runner,
			fs,
			environment: fixedEnv({ platform: "win32", home: "C:\\Users\\t" }),
			windowsIdentity: { systemRoot: "C:\\Windows" },
		});

		const result = await module.install();

		const staged = "C:\\Users\\t/.apiary/doctor/doctor-task.xml";
		const xml = fs.files.get(staged);
		expect(xml).toContain(`<UserId>${sid}</UserId>`);
		// Scoped onto BOTH the LogonTrigger and the Principal (2 occurrences, no stray extra).
		expect((xml?.split("<UserId>").length ?? 1) - 1).toBe(2);
		expect(result.ok).toBe(true);
	});

	it("Windows: whoami failing AND no domain/user facts stages the XML with no UserId (pre-fix shape)", async () => {
		const runner = createRecordingRunner(() => ({ ok: false, code: 1, stdout: "", stderr: "access denied" }));
		const fs = createMemoryFs();
		const module = createServiceModule({
			execPath: "C:\\bin\\doctor.cmd",
			runner,
			fs,
			environment: fixedEnv({ platform: "win32", home: "C:\\Users\\t" }),
			windowsIdentity: { systemRoot: "C:\\Windows" },
		});

		await module.install();

		const staged = "C:\\Users\\t/.apiary/doctor/doctor-task.xml";
		expect(fs.files.get(staged)).not.toContain("<UserId>");
	});

	it("Windows: whoami failing falls back to the injected domain\\user facts on the staged XML", async () => {
		const runner = createRecordingRunner(() => ({ ok: false, code: 1, stdout: "", stderr: "access denied" }));
		const fs = createMemoryFs();
		const module = createServiceModule({
			execPath: "C:\\bin\\doctor.cmd",
			runner,
			fs,
			environment: fixedEnv({ platform: "win32", home: "C:\\Users\\t" }),
			windowsIdentity: { systemRoot: "C:\\Windows", userDomain: "CORP", userName: "alice" },
		});

		await module.install();

		const staged = "C:\\Users\\t/.apiary/doctor/doctor-task.xml";
		expect(fs.files.get(staged)).toContain("<UserId>CORP\\alice</UserId>");
	});

	it("Windows: the staged XML wraps the action in conhost.exe --headless (no popped console)", async () => {
		const runner = createRecordingRunner();
		const fs = createMemoryFs();
		const module = createServiceModule({
			execPath: "C:\\bin\\doctor.cmd",
			runner,
			fs,
			environment: fixedEnv({ platform: "win32", home: "C:\\Users\\t", execPath: "C:\\bin\\doctor.cmd" }),
			windowsIdentity: { systemRoot: "C:\\Windows" },
		});

		await module.install();

		const staged = "C:\\Users\\t/.apiary/doctor/doctor-task.xml";
		const xml = fs.files.get(staged);
		expect(xml).toContain("<Command>C:\\Windows\\System32\\conhost.exe</Command>");
		expect(xml).toContain('<Arguments>--headless "');
		expect(xml).toContain('"C:\\bin\\doctor.cmd" run</Arguments>');
	});

	it("a non-Windows install never probes whoami (schtasks-only step)", async () => {
		const runner = createRecordingRunner();
		const module = createServiceModule({
			execPath: "/usr/bin/doctor",
			runner,
			fs: createMemoryFs(),
			environment: fixedEnv({ platform: "linux" }),
		});
		await module.install();
		expect(runner.calls.some((c) => /whoami/i.test(c.command))).toBe(false);
	});

	it("a unit-write failure (EACCES) returns a message, never throws", async () => {
		const runner = createRecordingRunner();
		const fs = createMemoryFs(true); // writeFile throws
		const module = createServiceModule({
			execPath: "/usr/bin/doctor",
			runner,
			fs,
			environment: fixedEnv({ platform: "linux" }),
		});

		const result = await module.install();
		// A unit-write failure is ok:false (a non-successful install), still never a throw.
		expect(result.ok).toBe(false);
		expect(result.message).toContain("Could not write the Doctor unit file");
		// The manager's INSTALL argv was not run (we never got past the write); only the
		// best-effort decision-#32 legacy dereg preceded it.
		expect(runner.calls).toHaveLength(1);
		expect(runner.calls[0]?.args).toEqual(["--user", "disable", "--now", "hivedoctor.service"]);
	});

	it("a manager-command failure is reported but does not throw", async () => {
		const runner = createRecordingRunner((command) =>
			command === "systemctl" ? { ok: false, code: 1, stdout: "", stderr: "boom" } : { ok: true, code: 0, stdout: "", stderr: "" },
		);
		const fs = createMemoryFs();
		const module = createServiceModule({
			execPath: "/usr/bin/doctor",
			runner,
			fs,
			environment: fixedEnv({ platform: "linux" }),
		});

		// IRD-192 AC-6: a manager-command failure resolves ok:false so the CLI maps it to a
		// non-zero exit. The failure is still reported as a message, never a throw.
		const result = await module.install();
		expect(result.ok).toBe(false);
		expect(result.message).toContain("service-manager command failed");
		// The real stderr is surfaced too, not just "a command failed" with no reason (a prior
		// version of this message dropped the actual cause, which is what made the real-world
		// Windows schtasks "Access is denied" failure undiagnosable without a manual repro).
		expect(result.message).toContain("boom");
	});

	// IRD-192 AC-6 (Windows root-cause scenario): a failed `schtasks /Create` resolves ok:false so
	// the CLI exit code is non-zero and the installer does not claim the watchdog is watching. The
	// staged XML is still written (so `doctor install-service` re-run can inspect it), but the
	// install is honestly a failure.
	it("AC-6: Windows schtasks /Create failure -> ok:false (the IRD-192 root-cause scenario)", async () => {
		const runner = createRecordingRunner((command, args) =>
			command === "schtasks" && args[0] === "/Create"
				? { ok: false, code: 1, stdout: "", stderr: "ERROR: incorrectly formatted or out of range" }
				: { ok: true, code: 0, stdout: "", stderr: "" },
		);
		const fs = createMemoryFs();
		const module = createServiceModule({
			execPath: "C:\\bin\\doctor.cmd",
			runner,
			fs,
			environment: fixedEnv({ platform: "win32", home: "C:\\Users\\t" }),
		});

		const result = await module.install();
		expect(result.ok).toBe(false);
		expect(result.message).toContain("service-manager command failed");
		// The exact IRD-192 root-cause stderr is surfaced verbatim, so a future occurrence of
		// this failure mode is diagnosable from the CLI's own output alone.
		expect(result.message).toContain("incorrectly formatted or out of range");
		// The staged XML (now with PT1M) is still laid down for inspection.
		const staged = "C:\\Users\\t/.apiary/doctor/doctor-task.xml";
		expect(fs.files.get(staged)).toContain("<Interval>PT1M</Interval>");
	});

	it("a failure detail longer than the cap is truncated with an ellipsis, never silently dropped", async () => {
		const longLine = "x".repeat(500);
		const runner = createRecordingRunner(() => ({ ok: false, code: 1, stdout: "", stderr: longLine }));
		const module = createServiceModule({
			execPath: "/usr/bin/doctor",
			runner,
			fs: createMemoryFs(),
			environment: fixedEnv({ platform: "linux" }),
		});
		const result = await module.install();
		expect(result.ok).toBe(false);
		expect(result.message).toContain(`${"x".repeat(200)}...`);
		expect(result.message).not.toContain(longLine);
	});

	it("macOS: already-absent bootout is tolerated and fixed argv still reloads and starts", async () => {
		const runner = createRecordingRunner((command, args) =>
			command === "launchctl" && args[0] === "bootout" && String(args[1]).includes(SERVICE_LABEL)
				? { ok: false, code: 3, stdout: "", stderr: "Could not find service" }
				: { ok: true, code: 0, stdout: "", stderr: "" },
		);
		const module = createServiceModule({
			execPath: "/opt/doctor",
			runner,
			fs: createMemoryFs(),
			environment: fixedEnv({ platform: "darwin", home: "/Users/t" }),
		});
		expect((await module.install()).ok).toBe(true);
		expect(runner.calls.slice(-3).map(({ args }) => args[0])).toEqual(["bootout", "bootstrap", "kickstart"]);
	});

	it("Windows sc: already-existing and already-running results reconcile through config", async () => {
		const runner = createRecordingRunner((command, args) => {
			if (command === "sc" && args[0] === "create") return { ok: false, code: 1073, stdout: "", stderr: "service already exists" };
			if (command === "sc" && args[0] === "start") return { ok: false, code: 1056, stdout: "", stderr: "service already running" };
			return { ok: true, code: 0, stdout: "", stderr: "" };
		});
		const module = createServiceModule({
			execPath: "C:\\bin\\doctor.cmd",
			runner,
			fs: createMemoryFs(),
			environment: fixedEnv({ platform: "win32", privileged: true, preferSystemScope: true }),
		});
		expect((await module.install()).ok).toBe(true);
		expect(runner.calls.some(({ command, args }) => command === "sc" && args[0] === "config")).toBe(true);
	});

	it("Windows Scheduled Task: /F reconciles the definition and already-running is success", async () => {
		const runner = createRecordingRunner((command, args) =>
			command === "schtasks" && args[0] === "/Run"
				? { ok: false, code: 1, stdout: "", stderr: "The task is already running" }
				: { ok: true, code: 0, stdout: "", stderr: "" },
		);
		const module = createServiceModule({
			execPath: "C:\\bin\\doctor.cmd",
			runner,
			fs: createMemoryFs(),
			environment: fixedEnv({ platform: "win32", home: "C:\\Users\\t", execPath: "C:\\bin\\doctor.cmd" }),
			windowsIdentity: { systemRoot: "C:\\Windows" },
		});
		expect((await module.install()).ok).toBe(true);
		expect(runner.calls.some(({ command, args }) => command === "schtasks" && args.includes("/F"))).toBe(true);
	});

	it("an unsupported platform returns a clean message, never throws", async () => {
		const module = createServiceModule({
			execPath: "/x",
			runner: createRecordingRunner(),
			fs: createMemoryFs(),
			environment: fixedEnv({ platform: "sunos" }),
		});
		const result = await module.install();
		expect(result.ok).toBe(false);
		expect(result.message).toContain("unsupported platform");
	});
});

describe("uninstall - deregisters then removes the unit file (AC-064b.5)", () => {
	it("Linux: disables the unit, then deletes the unit file so it cannot resurrect", async () => {
		const runner = createRecordingRunner();
		const fs = createMemoryFs();
		const unitPath = "/home/t/.config/systemd/user/doctor.service";
		fs.files.set(unitPath, "stale unit");
		const module = createServiceModule({
			execPath: "/usr/bin/doctor",
			runner,
			fs,
			environment: fixedEnv({ platform: "linux", home: "/home/t" }),
		});

		const result = await module.uninstall();

		expect(runner.calls[0]).toEqual({
			command: "systemctl",
			args: ["--user", "disable", "--now", "doctor.service"],
		});
		expect(fs.removed).toContain(unitPath);
		expect(fs.files.has(unitPath)).toBe(false);
		expect(result.ok).toBe(true);
		expect(result.message).toContain("will not start on next boot");
	});

	it("Windows: deletes the task and removes the staged XML", async () => {
		const runner = createRecordingRunner();
		const fs = createMemoryFs();
		const module = createServiceModule({
			execPath: "C:\\bin\\doctor.cmd",
			runner,
			fs,
			environment: fixedEnv({ platform: "win32", home: "C:\\Users\\t", execPath: "C:\\bin\\doctor.cmd" }),
		});

		await module.uninstall();

		expect(runner.calls[0]).toEqual({ command: "schtasks", args: ["/End", "/TN", "doctor"] });
		expect(runner.calls[1]?.command).toContain("WindowsPowerShell");
		expect(runner.calls[1]?.args.slice(-2)).toEqual([
			encodeWindowsCleanupPath("C:\\bin\\doctor.cmd"), encodeWindowsCleanupPath(process.execPath),
		]);
		expect(runner.calls[2]).toEqual({ command: "schtasks", args: ["/Delete", "/TN", "doctor", "/F"] });
		expect(fs.removed).toContain("C:\\Users\\t/.apiary/doctor/doctor-task.xml");
	});

	it("a missing unit during uninstall is tolerated (idempotent), still reports cleanly", async () => {
		// disable --now fails (unit already gone); the module still removes the file + reports.
		const runner = createRecordingRunner(() => ({ ok: false, code: 1, stdout: "", stderr: "not loaded" }));
		const fs = createMemoryFs();
		const module = createServiceModule({
			execPath: "/usr/bin/doctor",
			runner,
			fs,
			environment: fixedEnv({ platform: "linux" }),
		});
		const result = await module.uninstall();
		// A deregister failure is reported (the file is still removed + the command's error surfaced).
		expect(result.message).toContain("already gone");
		expect(result.message).toContain("not loaded");
	});
});

describe("start/stop (PRD-003b b-AC-1)", () => {
	it("Linux: start runs systemctl --user start", async () => {
		const runner = createRecordingRunner();
		const module = createServiceModule({
			execPath: "/usr/bin/doctor",
			runner,
			fs: createMemoryFs(),
			environment: fixedEnv({ platform: "linux" }),
		});
		const result = await module.start();
		expect(runner.calls[0]).toEqual({ command: "systemctl", args: ["--user", "start", "doctor.service"] });
		expect(result.ok).toBe(true);
		expect(result.message).toContain("started");
	});

	it("Linux: stop runs systemctl --user stop (the unit stays registered)", async () => {
		const runner = createRecordingRunner();
		const module = createServiceModule({
			execPath: "/usr/bin/doctor",
			runner,
			fs: createMemoryFs(),
			environment: fixedEnv({ platform: "linux" }),
		});
		const result = await module.stop();
		expect(runner.calls[0]).toEqual({ command: "systemctl", args: ["--user", "stop", "doctor.service"] });
		expect(result.ok).toBe(true);
		expect(result.message).toContain("remains registered");
	});

	it("macOS: start bootstraps the retained plist and stop bootouts KeepAlive", async () => {
		const runner = createRecordingRunner();
		const unitPath = `/Users/t/Library/LaunchAgents/${SERVICE_LABEL}.plist`;
		const fs = createMemoryFs(false, [unitPath]);
		const module = createServiceModule({
			execPath: "/opt/doctor",
			runner,
			fs,
			uid: TEST_MACOS_UID,
			environment: fixedEnv({ platform: "darwin", home: "/Users/t" }),
		});
		await module.start();
		expect(runner.calls[0]?.args[0]).toBe("bootstrap");
		expect(runner.calls[1]?.args[0]).toBe("kickstart");
		await module.stop();
		expect(runner.calls[2]?.args).toEqual(["bootout", `gui/${TEST_MACOS_UID}/${SERVICE_LABEL}`]);
		expect(fs.files.has(unitPath)).toBe(true);
	});

	it("Windows: start reaps an exact stale child before /Run; stop ends the task and reaps again", async () => {
		const runner = createRecordingRunner();
		const module = createServiceModule({
			execPath: "C:\\bin\\doctor.cmd",
			runner,
			fs: createMemoryFs(),
			environment: fixedEnv({ platform: "win32", execPath: "C:\\bin\\doctor.cmd" }),
		});
		await module.start();
		expect(runner.calls[0]?.command).toContain("WindowsPowerShell");
		expect(runner.calls[1]).toEqual({ command: "schtasks", args: ["/Run", "/TN", "doctor"] });
		await module.stop();
		expect(runner.calls[2]).toEqual({ command: "schtasks", args: ["/End", "/TN", "doctor"] });
		expect(runner.calls[3]?.command).toContain("WindowsPowerShell");
		expect(runner.calls[3]?.args.slice(-2)).toEqual([
			encodeWindowsCleanupPath("C:\\bin\\doctor.cmd"), encodeWindowsCleanupPath(process.execPath),
		]);
	});

	it("a manager-command failure on start/stop resolves ok:false, never throws", async () => {
		const runner = createRecordingRunner(() => ({ ok: false, code: 1, stdout: "", stderr: "not found" }));
		const module = createServiceModule({
			execPath: "/usr/bin/doctor",
			runner,
			fs: createMemoryFs(),
			environment: fixedEnv({ platform: "linux" }),
		});
		const startResult = await module.start();
		expect(startResult.ok).toBe(false);
		expect(startResult.message).toContain("not found");
		const stopResult = await module.stop();
		expect(stopResult.ok).toBe(false);
		expect(stopResult.message).toContain("not found");
	});

	it("an unsupported platform returns a clean message for start/stop, never throws", async () => {
		const module = createServiceModule({
			execPath: "/x",
			runner: createRecordingRunner(),
			fs: createMemoryFs(),
			environment: fixedEnv({ platform: "sunos" }),
		});
		expect((await module.start()).ok).toBe(false);
		expect((await module.stop()).ok).toBe(false);
	});
});

describe("standalone serviceStart/serviceStop (mirror serviceStatus's shape)", () => {
	it("serviceStart runs the same argv as module.start() without building install/uninstall", async () => {
		const runner = createRecordingRunner();
		const result = await serviceStart({
			execPath: "/usr/bin/doctor",
			runner,
			environment: fixedEnv({ platform: "linux" }),
		});
		expect(runner.calls[0]).toEqual({ command: "systemctl", args: ["--user", "start", "doctor.service"] });
		expect(result.ok).toBe(true);
	});

	it("serviceStop runs the same argv as module.stop()", async () => {
		const runner = createRecordingRunner();
		const result = await serviceStop({
			execPath: "/usr/bin/doctor",
			runner,
			environment: fixedEnv({ platform: "linux" }),
		});
		expect(runner.calls[0]).toEqual({ command: "systemctl", args: ["--user", "stop", "doctor.service"] });
		expect(result.ok).toBe(true);
	});
});

describe("deregisterLegacyUnit (PRD-003b b-AC-2: uninstall also clears the legacy label)", () => {
	it("Linux: disables the legacy systemd unit and removes its unit file", async () => {
		const runner = createRecordingRunner();
		const fs = createMemoryFs();
		const legacyPath = "/home/t/.config/systemd/user/hivedoctor.service";
		fs.files.set(legacyPath, "stale legacy unit");
		await deregisterLegacyUnit({
			execPath: "/usr/bin/doctor",
			runner,
			fs,
			environment: fixedEnv({ platform: "linux", home: "/home/t" }),
		});
		expect(runner.calls[0]).toEqual({
			command: "systemctl",
			args: ["--user", "disable", "--now", "hivedoctor.service"],
		});
		expect(fs.removed).toContain(legacyPath);
	});

	it("macOS: boots out the legacy launchd label and removes the legacy plist", async () => {
		const runner = createRecordingRunner();
		const fs = createMemoryFs();
		const legacyPath = "/Users/t/Library/LaunchAgents/com.legioncode.hivedoctor.plist";
		fs.files.set(legacyPath, "stale");
		await deregisterLegacyUnit({
			execPath: "/opt/doctor",
			runner,
			fs,
			environment: fixedEnv({ platform: "darwin", home: "/Users/t" }),
		});
		expect(runner.calls[0]?.command).toBe("launchctl");
		expect(runner.calls[0]?.args[0]).toBe("bootout");
		expect(runner.calls[0]?.args[1]).toContain("com.legioncode.hivedoctor");
		expect(fs.removed).toContain(legacyPath);
	});

	it("Windows: deletes the legacy scheduled task (no unit file to remove)", async () => {
		const runner = createRecordingRunner();
		await deregisterLegacyUnit({
			execPath: "C:\\bin\\doctor.cmd",
			runner,
			fs: createMemoryFs(),
			environment: fixedEnv({ platform: "win32" }),
		});
		expect(runner.calls[0]).toEqual({ command: "schtasks", args: ["/Delete", "/TN", "HiveDoctor", "/F"] });
	});

	it("a missing legacy unit (the common case) is tolerated - never throws", async () => {
		const runner = createRecordingRunner(() => ({ ok: false, code: 1, stdout: "", stderr: "not loaded" }));
		await expect(
			deregisterLegacyUnit({
				execPath: "/usr/bin/doctor",
				runner,
				fs: createMemoryFs(),
				environment: fixedEnv({ platform: "linux" }),
			}),
		).resolves.toBeUndefined();
	});

	it("an unsupported platform is a silent no-op, never throws", async () => {
		await expect(
			deregisterLegacyUnit({
				execPath: "/x",
				runner: createRecordingRunner(),
				fs: createMemoryFs(),
				environment: fixedEnv({ platform: "sunos" }),
			}),
		).resolves.toBeUndefined();
	});
});

describe("serviceStatus classification", () => {
	it("systemd is-active 'active' -> running", async () => {
		const runner = createRecordingRunner(() => ({ ok: true, code: 0, stdout: "active\n", stderr: "" }));
		const status = await serviceStatus({
			execPath: "/usr/bin/doctor",
			runner,
			environment: fixedEnv({ platform: "linux" }),
		});
		expect(status).toBe("running");
	});

	it("systemd is-active non-zero (inactive) -> not-running", async () => {
		const runner = createRecordingRunner(() => ({ ok: false, code: 3, stdout: "inactive\n", stderr: "" }));
		const status = await serviceStatus({
			execPath: "/usr/bin/doctor",
			runner,
			environment: fixedEnv({ platform: "linux" }),
		});
		expect(status).toBe("not-running");
	});

	it("a spawn error (manager binary missing) -> unknown", async () => {
		const runner = createRecordingRunner(() => ({ ok: false, code: null, stdout: "", stderr: "", detail: "ENOENT" }));
		const status = await serviceStatus({
			execPath: "/usr/bin/doctor",
			runner,
			environment: fixedEnv({ platform: "linux" }),
		});
		expect(status).toBe("unknown");
	});

	it("schtasks query ok -> running", async () => {
		const runner = createRecordingRunner(() => ({ ok: true, code: 0, stdout: "TaskName Running", stderr: "" }));
		const status = await serviceStatus({
			execPath: "C:\\bin\\doctor.cmd",
			runner,
			environment: fixedEnv({ platform: "win32" }),
		});
		expect(status).toBe("running");
	});

	it("schtasks Ready and sc STOPPED query output -> not-running", async () => {
		const task = await serviceStatus({
			execPath: "C:\\doctor.cmd",
			runner: createRecordingRunner(() => ({ ok: true, code: 0, stdout: "Status: Ready\r\n", stderr: "" })),
			environment: fixedEnv({ platform: "win32", execPath: "C:\\bin\\doctor.cmd" }),
		});
		const service = await serviceStatus({
			execPath: "C:\\doctor.cmd",
			runner: createRecordingRunner(() => ({ ok: true, code: 0, stdout: "STATE : 1 STOPPED\r\n", stderr: "" })),
			environment: fixedEnv({ platform: "win32", privileged: true, preferSystemScope: true }),
		});
		expect(task).toBe("not-running");
		expect(service).toBe("not-running");
	});
});

describe("isServiceRegistered (PRD-003b b-AC-6 fix): registration evidence, not activity", () => {
	it("b-AC-6: Linux - the exact verifier scenario: unit file present, service INACTIVE -> registered", async () => {
		// systemd `is-active` fails identically for "inactive" and "never registered" (see the
		// serviceStatus test above), so this must key off the unit FILE, not the status call.
		const runner = createRecordingRunner(() => ({ ok: false, code: 3, stdout: "inactive\n", stderr: "" }));
		const fs = createMemoryFs(false, ["/home/t/.config/systemd/user/doctor.service"]);
		const registered = await isServiceRegistered({
			execPath: "/usr/bin/doctor",
			runner,
			fs,
			environment: fixedEnv({ platform: "linux", home: "/home/t" }),
		});
		expect(registered).toBe(true);
	});

	it("Linux: unit file absent -> not registered", async () => {
		const runner = createRecordingRunner(() => ({ ok: false, code: 3, stdout: "inactive\n", stderr: "" }));
		const fs = createMemoryFs();
		const registered = await isServiceRegistered({
			execPath: "/usr/bin/doctor",
			runner,
			fs,
			environment: fixedEnv({ platform: "linux", home: "/home/t" }),
		});
		expect(registered).toBe(false);
	});

	it("macOS: plist present -> registered, regardless of launchctl print result", async () => {
		const runner = createRecordingRunner(() => ({ ok: false, code: 1, stdout: "", stderr: "" }));
		const plistPath = `/Users/t/Library/LaunchAgents/${SERVICE_LABEL}.plist`;
		const fs = createMemoryFs(false, [plistPath]);
		const registered = await isServiceRegistered({
			execPath: "/opt/doctor",
			runner,
			fs,
			environment: fixedEnv({ platform: "darwin", home: "/Users/t" }),
		});
		expect(registered).toBe(true);
	});

	it("macOS: plist absent -> not registered", async () => {
		const runner = createRecordingRunner();
		const registered = await isServiceRegistered({
			execPath: "/opt/doctor",
			runner,
			fs: createMemoryFs(),
			environment: fixedEnv({ platform: "darwin", home: "/Users/t" }),
		});
		expect(registered).toBe(false);
	});

	it("Windows schtasks: a successful /Query means registered even when the task is not running", async () => {
		const runner = createRecordingRunner(() => ({ ok: true, code: 0, stdout: "TaskName Ready", stderr: "" }));
		const registered = await isServiceRegistered({
			execPath: "C:\\bin\\doctor.cmd",
			runner,
			fs: createMemoryFs(),
			environment: fixedEnv({ platform: "win32" }),
		});
		expect(registered).toBe(true);
	});

	it("Windows schtasks: a clean 'not found' query means not registered", async () => {
		const runner = createRecordingRunner(() => ({ ok: false, code: 1, stdout: "", stderr: "ERROR: not found" }));
		const registered = await isServiceRegistered({
			execPath: "C:\\bin\\doctor.cmd",
			runner,
			fs: createMemoryFs(),
			environment: fixedEnv({ platform: "win32" }),
		});
		expect(registered).toBe(false);
	});

	it("a spawn error (ambiguous) biases toward registered=true, never a false no-op", async () => {
		const runner = createRecordingRunner(() => ({ ok: false, code: null, stdout: "", stderr: "", detail: "ENOENT" }));
		const registered = await isServiceRegistered({
			execPath: "C:\\bin\\doctor.cmd",
			runner,
			fs: createMemoryFs(),
			environment: fixedEnv({ platform: "win32" }),
		});
		expect(registered).toBe(true);
	});

	it("an unsupported platform (unresolved plan) biases toward registered=true", async () => {
		const registered = await isServiceRegistered({
			execPath: "/x",
			runner: createRecordingRunner(),
			fs: createMemoryFs(),
			environment: fixedEnv({ platform: "sunos" }),
		});
		expect(registered).toBe(true);
	});

	it("a filesystem read error on the file-based managers biases toward registered=true", async () => {
		const runner = createRecordingRunner();
		const throwingFs = {
			...createMemoryFs(),
			exists(): boolean {
				throw new Error("EACCES");
			},
		};
		const registered = await isServiceRegistered({
			execPath: "/usr/bin/doctor",
			runner,
			fs: throwingFs,
			environment: fixedEnv({ platform: "linux" }),
		});
		expect(registered).toBe(true);
	});
});
