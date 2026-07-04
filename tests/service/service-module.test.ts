/**
 * Service-module behaviour tests (PRD-064b): the install/uninstall/status flow over the
 * injected runner + fs, asserting the unit file is written before the manager runs, the
 * uninstall removes the file (AC-064b.5), and every failure mode is a returned message
 * (never a throw, design principle 1).
 */

import { describe, expect, it } from "vitest";

import { createServiceModule, serviceStatus } from "../../src/service/index.js";
import { SERVICE_LABEL } from "../../src/service/platform.js";
import { createMemoryFs, createRecordingRunner, fixedEnv } from "./helpers.js";

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
			environment: fixedEnv({ platform: "darwin", home: "/Users/t" }),
		});

		const result = await module.install();

		const plistPath = `/Users/t/Library/LaunchAgents/${SERVICE_LABEL}.plist`;
		expect(fs.files.get(plistPath)).toContain("<key>KeepAlive</key>");
		// Decision #32 migration: the legacy label is booted out first, then bootstrap runs.
		expect(runner.calls[0]?.command).toBe("launchctl");
		expect(runner.calls[0]?.args[0]).toBe("bootout");
		expect(runner.calls[0]?.args[1]).toContain("com.legioncode.hivedoctor");
		expect(runner.calls[1]?.args[0]).toBe("bootstrap");
		expect(result.ok).toBe(true);
	});

	it("Windows: stages the Scheduled Task XML beside the workspace, then schtasks /Create", async () => {
		const runner = createRecordingRunner();
		const fs = createMemoryFs();
		const module = createServiceModule({
			execPath: "C:\\bin\\doctor.cmd",
			runner,
			fs,
			environment: fixedEnv({ platform: "win32", home: "C:\\Users\\t" }),
		});

		const result = await module.install();

		const staged = "C:\\Users\\t/.apiary/doctor/doctor-task.xml";
		// IRD-192 AC-2: the staged XML carries the Task-Scheduler-valid PT1M interval.
		expect(fs.files.get(staged)).toContain("<Interval>PT1M</Interval>");
		expect(fs.files.get(staged)).toContain("<Task ");
		// Decision #32 migration: the legacy task name is deleted first, then /Create runs.
		expect(runner.calls[0]).toEqual({
			command: "schtasks",
			args: ["/Delete", "/TN", "HiveDoctor", "/F"],
		});
		expect(runner.calls[1]).toEqual({
			command: "schtasks",
			args: ["/Create", "/XML", staged, "/TN", "doctor", "/F"],
		});
		expect(result.ok).toBe(true);
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
			environment: fixedEnv({ platform: "win32", home: "C:\\Users\\t" }),
		});

		await module.uninstall();

		expect(runner.calls[0]).toEqual({ command: "schtasks", args: ["/Delete", "/TN", "doctor", "/F"] });
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
});
