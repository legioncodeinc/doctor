import { describe, expect, it, vi } from "vitest";
import { validateManifest } from "@legioncodeinc/cli-kit";

import { DOCTOR_MANIFEST } from "../../src/cli/command-table.js";
import { renderBannerWithMenu } from "../../src/cli/banner.js";
import { createColors } from "../../src/cli/colors.js";
import { dispatch } from "../../src/cli/dispatch.js";
import { DOCTOR_VERSION } from "../../src/version.js";
import { buildCliHarness } from "./helpers/fake-cli.js";

describe("PRD-003 Doctor CLI conformance", () => {
	it("uses the shared manifest with only Doctor's register exemption", () => {
		expect(validateManifest(DOCTOR_MANIFEST)).toEqual([]);
		const names = DOCTOR_MANIFEST.commands.map(({ name }) => name);
		expect(names).toEqual(expect.arrayContaining([
			"start", "stop", "restart", "install", "uninstall", "service-install",
			"service-uninstall", "update", "status", "logs", "telemetry",
		]));
		expect(names).not.toContain("register");
	});

	it("renders Doctor art, uppercase identity, exact credit, version, groups, and globals", () => {
		const text = renderBannerWithMenu(createColors({ env: {}, isTty: false }));
		expect(text).toContain("DOCTOR");
		expect(text).toContain("Legion Code Inc. x Activeloop");
		expect(text).toContain("Service lifecycle");
		expect(text).toContain("Product commands");
		expect(text).toContain("--json");
	});

	it("returns usage exit 2 for register and emits a clean JSON error", async () => {
		const h = buildCliHarness();
		expect(await dispatch(["register", "--json"], h.ctx)).toBe(2);
		const payload = JSON.parse(h.out.text()) as Record<string, unknown>;
		expect(payload).toMatchObject({ product: "doctor", command: "register", ok: false });
		expect(h.out.text()).not.toContain("Legion Code Inc.");
		expect(h.out.text()).not.toContain("\u001b");
		const withHelp = buildCliHarness();
		expect(await dispatch(["register", "--help"], withHelp.ctx)).toBe(2);
		expect(withHelp.out.errText()).toContain("Unknown command: register");
	});

	it("emits one stable JSON envelope for every Doctor baseline command", async () => {
		for (const command of ["start", "stop", "restart", "install", "uninstall", "service-install", "service-uninstall", "update", "status", "logs", "telemetry"]) {
			let state: "running" | "not-running" = command === "start" ? "not-running" : "running";
			let registered = true;
			const serviceModule = {
				install: async () => { registered = true; state = "running"; return { ok: true, message: "installed" }; },
				uninstall: async () => { registered = false; state = "not-running"; return { ok: true, message: "removed" }; },
			};
			const h = buildCliHarness({
				serviceModule,
				serviceLifecycle: {
					start: async () => { state = "running"; return { ok: true, message: "started" }; },
					stop: async () => { state = "not-running"; return { ok: true, message: "stopped" }; },
				},
				productUninstall: {
					precheck: () => ({ registryEntryExists: true, stateDirExists: true }),
					serviceStatusAsync: async () => state,
					isServiceRegistered: async () => registered,
					serviceUninstall: serviceModule.uninstall,
					removeState: () => ({ registryEntryRemoved: true, stateDirRemoved: true }),
				},
				tailServiceLogs: async (_args, write) => { write("Doctor log\n"); return { ok: true }; },
				telemetrySummary: () => ({ state: "enabled", controllingSetting: "default", destination: "hosted", optOutInstruction: "Set DO_NOT_TRACK=1" }),
			});
			const args = [command, ...(command === "uninstall" ? ["--yes"] : []), ...(command === "logs" ? ["--no-follow"] : []), "--json"];
			await dispatch(args, h.ctx);
			expect(h.out.stdout).toHaveLength(1);
			expect(JSON.parse(h.out.stdout[0] ?? "{}")).toMatchObject({ product: "doctor", command, ok: true });
		}
	});

	it("makes bare invocation byte-equivalent to help and renders exact human/JSON versions", async () => {
		const bare = buildCliHarness();
		const help = buildCliHarness();
		expect(await dispatch([], bare.ctx)).toBe(0);
		expect(await dispatch(["--help"], help.ctx)).toBe(0);
		expect(bare.out.text()).toBe(help.out.text());
		const humanVersion = buildCliHarness();
		expect(await dispatch(["--version"], humanVersion.ctx)).toBe(0);
		expect(humanVersion.out.text()).toBe(`doctor v${DOCTOR_VERSION}`);
		const jsonVersion = buildCliHarness();
		expect(await dispatch(["--version", "--json"], jsonVersion.ctx)).toBe(0);
		expect(JSON.parse(jsonVersion.out.text())).toEqual({ product: "doctor", command: "version", ok: true, message: "version", version: DOCTOR_VERSION });
	});

	it("rejects unknown options, values on booleans, positionals, and malformed logs as usage 2", async () => {
		for (const args of [
			["start", "--bogus"], ["telemetry", "--bogus"], ["status", "extra"],
			["update", "--check=yes"], ["logs", "--lines", "0", "--no-follow"],
			["incidents", "--daemon"], ["--bogus"],
		]) {
			for (const json of [false, true]) {
				const h = buildCliHarness();
				const code = await dispatch([...args, ...(json ? ["--json"] : [])], h.ctx);
				expect(code, args.join(" ")).toBe(2);
				if (json) expect(JSON.parse(h.out.text())).toMatchObject({ product: "doctor", ok: false });
			}
		}
	});

	it("preserves supported Doctor product options", async () => {
		const h = buildCliHarness({ incidentsByDaemon: { honeycomb: ["incident"] } });
		expect(await dispatch(["incidents", "--daemon", "honeycomb", "--lines", "1"], h.ctx)).toBe(0);
		const update = buildCliHarness();
		expect(await dispatch(["daemon-update", "--check"], update.ctx)).toBe(0);
	});

	it("goldens running, stopped, not-installed, and unhealthy status in human and JSON", async () => {
		const cases = [
			{ name: "running", state: "running" as const, registered: true, classification: { kind: "ok" as const } },
			{ name: "stopped", state: "not-running" as const, registered: true, classification: { kind: "ok" as const } },
			{ name: "not-installed", state: "unknown" as const, registered: false, classification: { kind: "ok" as const } },
			{ name: "unhealthy", state: "running" as const, registered: true, classification: { kind: "unreachable-timeout" as const } },
		];
		for (const item of cases) {
			const productUninstall = {
				precheck: () => ({ registryEntryExists: false, stateDirExists: false }),
				serviceStatusAsync: async () => item.state,
				isServiceRegistered: async () => item.registered,
				serviceUninstall: async () => ({ ok: true, message: "removed" }),
				removeState: () => ({ registryEntryRemoved: false, stateDirRemoved: false }),
			};
			const human = buildCliHarness({ serviceStateAsync: async () => item.state, productUninstall, classification: item.classification, paths: { config: "/apiary/doctor", logs: "/apiary/doctor/service.log" } });
			expect(await dispatch(["status"], human.ctx)).toBe(0);
			expect(human.out.text()).toMatchSnapshot(`${item.name} status human`);
			const json = buildCliHarness({ serviceStateAsync: async () => item.state, productUninstall, classification: item.classification, paths: { config: "/apiary/doctor", logs: "/apiary/doctor/service.log" } });
			expect(await dispatch(["status", "--json"], json.ctx)).toBe(0);
			expect(JSON.parse(json.out.text())).toMatchSnapshot(`${item.name} status JSON`);
		}
	});

	it("goldens enabled and opted-out telemetry in human and JSON", async () => {
		for (const telemetry of [
			{ state: "enabled" as const, controllingSetting: "default", destination: "hosted" as const, optOutInstruction: "Set DO_NOT_TRACK=1" },
			{ state: "opted-out" as const, controllingSetting: "DO_NOT_TRACK", destination: "disabled" as const, optOutInstruction: "Unset DO_NOT_TRACK" },
		]) {
			const human = buildCliHarness({ telemetrySummary: () => telemetry });
			expect(await dispatch(["telemetry"], human.ctx)).toBe(0);
			expect(human.out.text()).toMatchSnapshot(`${telemetry.state} telemetry human`);
			const json = buildCliHarness({ telemetrySummary: () => telemetry });
			expect(await dispatch(["telemetry", "--json"], json.ctx)).toBe(0);
			expect(JSON.parse(json.out.text())).toMatchSnapshot(`${telemetry.state} telemetry JSON`);
		}
	});

	it("telemetry is read-only and structured in JSON mode", async () => {
		const h = buildCliHarness();
		const probe = vi.fn(() => ({
			state: "opted-out" as const,
			controllingSetting: "DO_NOT_TRACK",
			destination: "disabled" as const,
			optOutInstruction: "unset DO_NOT_TRACK",
		}));
		const ctx = { ...h.ctx, deps: { ...h.ctx.deps, telemetrySummary: probe } };
		expect(await dispatch(["telemetry", "--json"], ctx)).toBe(0);
		expect(JSON.parse(h.out.text())).toMatchObject({ telemetry: { state: "opted-out", destination: "disabled" } });
		expect(probe).toHaveBeenCalledTimes(1);
	});
});
