/**
 * argv-construction tests (PRD-064b): the EXACT launchctl / systemctl / schtasks / sc
 * command lines for install, uninstall, and status, per platform + scope.
 */

import { describe, expect, it } from "vitest";

import {
	installCommands,
	launchdServiceTarget,
	startCommands,
	statusCommand,
	stopCommands,
	uninstallCommands,
} from "../../src/service/argv.js";
import { resolveServicePlan, SERVICE_LABEL, SYSTEMD_UNIT_NAME, WINDOWS_TASK_NAME } from "../../src/service/platform.js";
import { fixedEnv } from "./helpers.js";

const UID = 501;

describe("launchd argv (macOS, user scope)", () => {
	const plan = resolveServicePlan(fixedEnv({ platform: "darwin", home: "/Users/t" }));

	it("install: bootstrap into gui/<uid> then kickstart the service", () => {
		const cmds = installCommands(plan, UID);
		expect(cmds[0]).toEqual({ command: "launchctl", args: ["bootstrap", `gui/${UID}`, plan.unitPath] });
		expect(cmds[1]).toEqual({ command: "launchctl", args: ["kickstart", "-k", `gui/${UID}/${SERVICE_LABEL}`] });
	});

	it("uninstall: bootout the service target", () => {
		const cmds = uninstallCommands(plan, UID);
		expect(cmds[0]).toEqual({ command: "launchctl", args: ["bootout", `gui/${UID}/${SERVICE_LABEL}`] });
	});

	it("status: print the service target", () => {
		expect(statusCommand(plan, UID)).toEqual({
			command: "launchctl",
			args: ["print", `gui/${UID}/${SERVICE_LABEL}`],
		});
	});

	it("b-AC-1: start kickstarts the existing service target", () => {
		expect(startCommands(plan, UID)).toEqual([
			{ command: "launchctl", args: ["kickstart", "-k", `gui/${UID}/${SERVICE_LABEL}`] },
		]);
	});

	it("b-AC-1: stop sends SIGTERM without unloading the unit (no bootout)", () => {
		expect(stopCommands(plan, UID)).toEqual([
			{ command: "launchctl", args: ["kill", "SIGTERM", `gui/${UID}/${SERVICE_LABEL}`] },
		]);
	});

	it("system scope targets the `system` domain, not gui/<uid>", () => {
		const sys = resolveServicePlan(fixedEnv({ platform: "darwin", privileged: true, preferSystemScope: true }));
		expect(launchdServiceTarget(sys, UID)).toBe(`system/${SERVICE_LABEL}`);
		expect(installCommands(sys, UID)[0]).toEqual({
			command: "launchctl",
			args: ["bootstrap", "system", sys.unitPath],
		});
	});
});

describe("systemd argv (Linux)", () => {
	const userPlan = resolveServicePlan(fixedEnv({ platform: "linux" }));
	const sysPlan = resolveServicePlan(fixedEnv({ platform: "linux", privileged: true, preferSystemScope: true }));

	it("user install: systemctl --user enable --now doctor.service", () => {
		expect(installCommands(userPlan, UID)[0]).toEqual({
			command: "systemctl",
			args: ["--user", "enable", "--now", SYSTEMD_UNIT_NAME],
		});
	});

	it("user uninstall: systemctl --user disable --now", () => {
		expect(uninstallCommands(userPlan, UID)[0]).toEqual({
			command: "systemctl",
			args: ["--user", "disable", "--now", SYSTEMD_UNIT_NAME],
		});
	});

	it("user status: systemctl --user is-active", () => {
		expect(statusCommand(userPlan, UID)).toEqual({
			command: "systemctl",
			args: ["--user", "is-active", SYSTEMD_UNIT_NAME],
		});
	});

	it("b-AC-1: user start: systemctl --user start doctor.service", () => {
		expect(startCommands(userPlan, UID)).toEqual([{ command: "systemctl", args: ["--user", "start", SYSTEMD_UNIT_NAME] }]);
	});

	it("b-AC-1: user stop: systemctl --user stop doctor.service", () => {
		expect(stopCommands(userPlan, UID)).toEqual([{ command: "systemctl", args: ["--user", "stop", SYSTEMD_UNIT_NAME] }]);
	});

	it("system scope drops the --user flag", () => {
		expect(installCommands(sysPlan, UID)[0]).toEqual({
			command: "systemctl",
			args: ["enable", "--now", SYSTEMD_UNIT_NAME],
		});
		expect(statusCommand(sysPlan, UID)).toEqual({
			command: "systemctl",
			args: ["is-active", SYSTEMD_UNIT_NAME],
		});
	});
});

describe("schtasks argv (Windows per-user, the default)", () => {
	// Stage a unit path the way the module does for the schtasks /XML path.
	const plan = {
		...resolveServicePlan(fixedEnv({ platform: "win32", home: "C:\\Users\\t" })),
		unitPath: "C:\\Users\\t\\.honeycomb\\doctor\\doctor-task.xml",
	};

	it("install: /Create /XML <file> /TN Doctor /F then /Run", () => {
		const cmds = installCommands(plan, UID);
		expect(cmds[0]).toEqual({
			command: "schtasks",
			args: ["/Create", "/XML", plan.unitPath, "/TN", WINDOWS_TASK_NAME, "/F"],
		});
		expect(cmds[1]).toEqual({ command: "schtasks", args: ["/Run", "/TN", WINDOWS_TASK_NAME] });
	});

	it("uninstall: /Delete /TN Doctor /F", () => {
		expect(uninstallCommands(plan, UID)[0]).toEqual({
			command: "schtasks",
			args: ["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"],
		});
	});

	it("status: /Query /TN Doctor", () => {
		expect(statusCommand(plan, UID)).toEqual({
			command: "schtasks",
			args: ["/Query", "/TN", WINDOWS_TASK_NAME],
		});
	});

	it("b-AC-1: start: /Run /TN Doctor", () => {
		expect(startCommands(plan, UID)).toEqual([{ command: "schtasks", args: ["/Run", "/TN", WINDOWS_TASK_NAME] }]);
	});

	it("b-AC-1: stop: /End /TN Doctor", () => {
		expect(stopCommands(plan, UID)).toEqual([{ command: "schtasks", args: ["/End", "/TN", WINDOWS_TASK_NAME] }]);
	});
});

describe("sc.exe argv (Windows Service, enterprise opt-in)", () => {
	const plan = resolveServicePlan(fixedEnv({ platform: "win32", privileged: true, preferSystemScope: true }));

	it("install: sc create ... start= auto, then sc start", () => {
		const cmds = installCommands(plan, UID);
		const create = cmds[0];
		expect(create).toBeDefined();
		expect(create?.command).toBe("sc");
		expect(create?.args.slice(0, 2)).toEqual(["create", WINDOWS_TASK_NAME]);
		expect(create?.args).toContain("start=");
		expect(create?.args).toContain("auto");
		expect(cmds[1]).toEqual({ command: "sc", args: ["start", WINDOWS_TASK_NAME] });
	});

	it("uninstall: sc stop then sc delete", () => {
		const cmds = uninstallCommands(plan, UID);
		expect(cmds[0]).toEqual({ command: "sc", args: ["stop", WINDOWS_TASK_NAME] });
		expect(cmds[1]).toEqual({ command: "sc", args: ["delete", WINDOWS_TASK_NAME] });
	});

	it("status: sc query", () => {
		expect(statusCommand(plan, UID)).toEqual({ command: "sc", args: ["query", WINDOWS_TASK_NAME] });
	});

	it("b-AC-1: start: sc start", () => {
		expect(startCommands(plan, UID)).toEqual([{ command: "sc", args: ["start", WINDOWS_TASK_NAME] }]);
	});

	it("b-AC-1: stop: sc stop", () => {
		expect(stopCommands(plan, UID)).toEqual([{ command: "sc", args: ["stop", WINDOWS_TASK_NAME] }]);
	});
});
