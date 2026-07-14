/**
 * Executable native-adapter fixture for CI. This drives the real launchd/systemd/
 * Task Scheduler/sc adapter transactions with an in-memory manager boundary. It proves
 * platform argv, reconciliation, state classification, and retained-definition stop/start
 * without claiming that GitHub-hosted runners provide reboot-capable live-service proof.
 */
import { describe, expect, it } from "vitest";

import { createServiceModule, serviceStatus } from "../../src/service/index.js";
import { SERVICE_LABEL } from "../../src/service/platform.js";
import { createMemoryFs, createRecordingRunner, fixedEnv } from "./helpers.js";

describe("native service adapter transaction fixture", () => {
	for (const target of [
		{ name: "launchd", environment: fixedEnv({ platform: "darwin", home: "/Users/fixture" }) },
		{ name: "systemd", environment: fixedEnv({ platform: "linux", home: "/home/fixture" }) },
		{ name: "schtasks", environment: fixedEnv({ platform: "win32", home: "C:\\Users\\fixture" }) },
		{ name: "sc", environment: fixedEnv({ platform: "win32", privileged: true, preferSystemScope: true }) },
	] as const) {
		it(`${target.name}: install -> stop -> start -> uninstall`, async () => {
			let registered = false;
			let running = false;
			const runner = createRecordingRunner((command, args) => {
				const joined = args.join(" ");
				if (joined.includes("hivedoctor") || joined.includes("HiveDoctor")) return { ok: false, code: 3, stdout: "", stderr: "not found" };
				if (command.toLowerCase().includes("whoami")) return { ok: false, code: 1, stdout: "", stderr: "fixture identity unavailable" };
				if (command === "launchctl") {
					if (args[0] === "bootstrap") registered = true;
					if (args[0] === "kickstart") running = true;
					if (args[0] === "bootout" && joined.includes(SERVICE_LABEL)) running = false;
					if (args[0] === "print") return running ? { ok: true, code: 0, stdout: "pid = 123", stderr: "" } : { ok: false, code: 3, stdout: "", stderr: "not loaded" };
				}
				if (command === "systemctl") {
					if (args.includes("enable") || args.includes("start")) { registered = true; running = true; }
					if (args.includes("stop")) running = false;
					if (args.includes("disable")) { registered = false; running = false; }
					if (args.includes("is-active")) return running ? { ok: true, code: 0, stdout: "active\n", stderr: "" } : { ok: false, code: 3, stdout: "inactive\n", stderr: "" };
				}
				if (command === "schtasks") {
					if (args[0]?.toLowerCase() === "/create") registered = true;
					if (args[0]?.toLowerCase() === "/run") running = true;
					if (args[0]?.toLowerCase() === "/end") running = false;
					if (args[0]?.toLowerCase() === "/delete") { registered = false; running = false; }
					if (args[0]?.toLowerCase() === "/query") return registered
						? { ok: true, code: 0, stdout: `Status: ${running ? "Running" : "Ready"}\n`, stderr: "" }
						: { ok: false, code: 1, stdout: "", stderr: "not found" };
				}
				if (command === "sc") {
					if (args[0] === "create" || args[0] === "config") registered = true;
					if (args[0] === "start") running = true;
					if (args[0] === "stop") running = false;
					if (args[0] === "delete") { registered = false; running = false; }
					if (args[0] === "query") return registered
						? { ok: true, code: 0, stdout: `STATE : ${running ? "4 RUNNING" : "1 STOPPED"}\n`, stderr: "" }
						: { ok: false, code: 1060, stdout: "", stderr: "not found" };
				}
				return { ok: true, code: 0, stdout: "", stderr: "" };
			});
			const deps = { execPath: target.name === "sc" ? "C:\\bin\\doctor.cmd" : "/opt/doctor", runner, fs: createMemoryFs(), environment: target.environment };
			const module = createServiceModule(deps);
			expect((await module.install()).ok).toBe(true);
			expect(await serviceStatus(deps)).toBe("running");
			expect((await module.stop()).ok).toBe(true);
			expect(await serviceStatus(deps)).toBe("not-running");
			expect((await module.start()).ok).toBe(true);
			expect(await serviceStatus(deps)).toBe("running");
			expect((await module.uninstall()).ok).toBe(true);
			expect(runner.calls.length).toBeGreaterThan(4);
		});
	}
});
