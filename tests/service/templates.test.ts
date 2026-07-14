/**
 * Template-generation tests (PRD-064b): the rendered plist / systemd unit / Scheduled
 * Task XML carry the correct label, exec path, restart-on-crash, and start-on-boot
 * directives per platform. Snapshot-style content assertions.
 */

import { describe, expect, it } from "vitest";

import { resolveServicePlan, SERVICE_LABEL } from "../../src/service/platform.js";
import {
	escapeXml,
	DOCTOR_RUN_COMMAND,
	RESTART_SEC,
	renderLaunchdPlist,
	renderScheduledTaskXml,
	renderSystemdUnit,
	renderUnit,
	WINDOWS_CONHOST_PATH,
	WINDOWS_RESTART_INTERVAL,
} from "../../src/service/templates.js";
import { fixedEnv } from "./helpers.js";

describe("renderLaunchdPlist (macOS)", () => {
	const plan = resolveServicePlan(fixedEnv({ platform: "darwin", home: "/Users/t", execPath: "/opt/doctor" }));
	const xml = renderLaunchdPlist(plan);

	it("declares the canonical Label", () => {
		expect(xml).toContain(`<key>Label</key>`);
		expect(xml).toContain(`<string>${SERVICE_LABEL}</string>`);
	});

	it("execs node + the bin + the run verb as an argv array (no shell)", () => {
		expect(xml).toContain(`<string>/opt/doctor</string>`);
		expect(xml).toContain(`<string>${DOCTOR_RUN_COMMAND}</string>`);
	});

	it("encodes start-on-boot (RunAtLoad) and restart-on-crash (KeepAlive)", () => {
		expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
		expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
	});

	// IRD-192 AC-10: launchd ThrottleInterval takes seconds; the POSIX value stays RESTART_SEC=5,
	// unchanged by the Windows-only restart-interval fix.
	it("AC-10: ThrottleInterval keeps the POSIX seconds value (RESTART_SEC=5)", () => {
		expect(RESTART_SEC).toBe(5);
		expect(xml).toContain(`<integer>${RESTART_SEC}</integer>`);
	});

	it("writes logs under the fleet root doctor state dir (no root required)", () => {
		// ADR-0003 (PRD-004a): doctor's state moved from ~/.honeycomb/doctor to <root>/doctor.
		expect(xml).toContain("/Users/t/.apiary/doctor/service.log");
	});
});

describe("renderSystemdUnit (Linux)", () => {
	const plan = resolveServicePlan(fixedEnv({ platform: "linux", execPath: "/usr/bin/doctor" }));
	const unit = renderSystemdUnit(plan);

	it("execs the bin + the run verb (exec path quoted)", () => {
		expect(unit).toContain(`ExecStart="/usr/bin/doctor" ${DOCTOR_RUN_COMMAND}`);
	});

	it("quotes a space-bearing exec path so it cannot mis-split", () => {
		const spacedPlan = resolveServicePlan(
			fixedEnv({ platform: "linux", execPath: "/opt/Program Files/doctor" }),
		);
		const spacedUnit = renderSystemdUnit(spacedPlan);
		expect(spacedUnit).toContain(`ExecStart="/opt/Program Files/doctor" ${DOCTOR_RUN_COMMAND}`);
	});

	it("encodes restart-on-crash (Restart=always + RestartSec)", () => {
		expect(unit).toContain("Restart=always");
		expect(unit).toMatch(/RestartSec=\d+/);
	});

	// IRD-192 AC-10: the POSIX restart value stays RESTART_SEC (seconds) and is NOT changed by the
	// Windows fix. systemd RestartSec takes seconds; 5s is correct here.
	it("AC-10: RestartSec keeps the POSIX seconds value (RESTART_SEC=5), unchanged by the Windows fix", () => {
		expect(RESTART_SEC).toBe(5);
		expect(unit).toContain(`RestartSec=${RESTART_SEC}`);
	});

	it("encodes start-on-boot via WantedBy=default.target (user unit)", () => {
		expect(unit).toContain("WantedBy=default.target");
	});

	it("is Type=simple (Doctor stays foreground in its own process)", () => {
		expect(unit).toContain("Type=simple");
	});
});

describe("renderScheduledTaskXml (Windows)", () => {
	const plan = resolveServicePlan(fixedEnv({ platform: "win32", home: "C:\\Users\\t", execPath: "C:\\bin\\doctor.cmd" }));
	const xml = renderScheduledTaskXml(plan);

	it("declares the Doctor task URI", () => {
		expect(xml).toContain("<URI>\\doctor</URI>");
	});

	it("starts at logon (start-on-boot equivalent, no admin)", () => {
		expect(xml).toContain("<LogonTrigger>");
		expect(xml).toMatch(/<LogonTrigger>\s*<Enabled>true<\/Enabled>/);
	});

	it("runs at LeastPrivilege with an InteractiveToken (no UAC)", () => {
		expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
		expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
	});

	it("encodes restart-on-crash (RestartOnFailure)", () => {
		expect(xml).toContain("<RestartOnFailure>");
	});

	// IRD-192 AC-2: Task Scheduler rejects sub-minute intervals. The rendered <Interval> MUST be
	// the exact WINDOWS_RESTART_INTERVAL literal (PT1M), the minimum Task Scheduler accepts.
	it("AC-2: the RestartOnFailure interval is exactly PT1M (Task Scheduler minimum)", () => {
		expect(WINDOWS_RESTART_INTERVAL).toBe("PT1M");
		expect(xml).toContain(`<Interval>${WINDOWS_RESTART_INTERVAL}</Interval>`);
		expect(xml).toContain("<Interval>PT1M</Interval>");
	});

	// IRD-192 regression: the XML MUST NOT emit PT5S anywhere. Windows rejected PT5S with
	// "(29,24):Interval:PT5S ... incorrectly formatted or out of range".
	it("AC-2 regression: the rendered XML does NOT contain PT5S (the rejected value)", () => {
		expect(xml).not.toContain("PT5S");
	});

	it("keeps a single instance (IgnoreNew)", () => {
		expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
	});

	// Windows 11 25H2 (Administrator Protection) fix #2: the action runs under conhost.exe
	// --headless so InteractiveToken does not pop a visible console at logon/run, with node
	// and the original argv passed through as quoted arguments (no shell parse).
	it("wraps the action in conhost.exe --headless, passing node + the exec path + run as quoted arguments", () => {
		expect(xml).toContain(`<Command>${WINDOWS_CONHOST_PATH}</Command>`);
		expect(xml).toContain(
			`<Arguments>--headless "${escapeXml(process.execPath)}" "C:\\bin\\doctor.cmd" ${DOCTOR_RUN_COMMAND}</Arguments>`,
		);
	});

	// Windows 11 25H2 (Administrator Protection) fix #1: with no windowsUserId resolved, the
	// pre-fix shape is preserved - no <UserId> anywhere in the document.
	it("with no windowsUserId resolved, renders no <UserId> at all (pre-fix shape)", () => {
		expect(xml).not.toContain("<UserId>");
	});
});

describe("renderScheduledTaskXml - windowsUserId (Windows 11 25H2 Administrator Protection fix)", () => {
	const basePlan = resolveServicePlan(
		fixedEnv({ platform: "win32", home: "C:\\Users\\t", execPath: "C:\\bin\\doctor.cmd" }),
	);

	it("a resolved SID is scoped onto BOTH the LogonTrigger and the Principal", () => {
		const sid = "S-1-5-21-111111111-222222222-333333333-1001";
		const xml = renderScheduledTaskXml({ ...basePlan, windowsUserId: sid });
		expect(xml).toMatch(/<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>S-1-5-21-111111111-222222222-333333333-1001<\/UserId>/);
		expect(xml).toMatch(/<Principal id="Author">\s*<UserId>S-1-5-21-111111111-222222222-333333333-1001<\/UserId>/);
		// Exactly two occurrences: LogonTrigger + Principal, no stray extra.
		expect(xml.split("<UserId>").length - 1).toBe(2);
	});

	it("a domain\\user fallback UserId is XML-escaped", () => {
		const xml = renderScheduledTaskXml({ ...basePlan, windowsUserId: `A&B\\us"er` });
		expect(xml).toContain("<UserId>A&amp;B\\us&quot;er</UserId>");
		expect(xml).not.toContain(`A&B\\us"er`);
	});

	it("an empty-string windowsUserId is treated the same as absent (no <UserId>)", () => {
		const xml = renderScheduledTaskXml({ ...basePlan, windowsUserId: "" });
		expect(xml).not.toContain("<UserId>");
	});
});

describe("escapeXml + renderUnit dispatch", () => {
	it("escapes the five XML predefined entities", () => {
		expect(escapeXml(`a&b<c>d"e'f`)).toBe("a&amp;b&lt;c&gt;d&quot;e&apos;f");
	});

	it("renderUnit dispatches to the plan's manager template", () => {
		const mac = resolveServicePlan(fixedEnv({ platform: "darwin" }));
		const linux = resolveServicePlan(fixedEnv({ platform: "linux" }));
		const win = resolveServicePlan(fixedEnv({ platform: "win32" }));
		expect(renderUnit(mac)).toContain("<plist");
		expect(renderUnit(linux)).toContain("[Service]");
		expect(renderUnit(win)).toContain("<Task ");
	});

	it("an exec path with an ampersand is escaped in the plist (no broken XML)", () => {
		const plan = resolveServicePlan(fixedEnv({ platform: "darwin", execPath: "/opt/a&b/doctor" }));
		expect(renderLaunchdPlist(plan)).toContain("/opt/a&amp;b/doctor");
	});
});
