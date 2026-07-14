/**
 * `start` / `stop` / `uninstall` dispatcher tests (PRD-003b Lifecycle Command Parity).
 *
 * Each test drives the REAL dispatcher over a fully-faked context, exactly like
 * tests/cli/dispatch.ts's own PRD-064f suite - no process, no network, no npm, no daemon.
 */

import { describe, expect, it, vi } from "vitest";

import { dispatch, EXIT_ERROR, EXIT_OK } from "../../src/cli/dispatch.js";
import { SERVICE_NOT_AVAILABLE } from "../../src/cli/service-stub.js";
import type { LifecycleTelemetry } from "../../src/telemetry/capture.js";
import { buildCliHarness } from "./helpers/fake-cli.js";

describe("start (PRD-003b b-AC-1)", () => {
	it("delegates to serviceLifecycle.start() and prints its message", async () => {
		const start = vi.fn(async () => ({ ok: true, message: "Doctor service started (systemd, user scope)." }));
		const { ctx, out } = buildCliHarness({ serviceLifecycle: { start, stop: vi.fn() }, serviceStateAsync: async () => "running" });
		const code = await dispatch(["start"], ctx);
		expect(code).toBe(EXIT_OK);
		expect(start).toHaveBeenCalledTimes(1);
		expect(out.text()).toContain("Doctor service started");
	});

	it("maps a failed start to a non-zero exit", async () => {
		const start = vi.fn(async () => ({ ok: false, message: "Could not start the Doctor service: ENOENT." }));
		const { ctx } = buildCliHarness({ serviceLifecycle: { start, stop: vi.fn() } });
		const code = await dispatch(["start"], ctx);
		expect(code).toBe(EXIT_ERROR);
	});

	it("fails closed when serviceLifecycle is not wired", async () => {
		const { ctx, out } = buildCliHarness();
		const code = await dispatch(["start"], ctx);
		expect(code).toBe(EXIT_ERROR);
		expect(out.errText()).toContain(SERVICE_NOT_AVAILABLE);
	});
});

describe("stop (PRD-003b b-AC-1)", () => {
	it("delegates to serviceLifecycle.stop() and prints its message", async () => {
		const stop = vi.fn(async () => ({ ok: true, message: "Doctor service stopped (systemd, user scope)." }));
		const { ctx, out } = buildCliHarness({ serviceLifecycle: { start: vi.fn(), stop }, serviceStateAsync: async () => "not-running" });
		const code = await dispatch(["stop"], ctx);
		expect(code).toBe(EXIT_OK);
		expect(stop).toHaveBeenCalledTimes(1);
		expect(out.text()).toContain("Doctor service stopped");
	});

	it("maps a failed stop to a non-zero exit", async () => {
		const stop = vi.fn(async () => ({ ok: false, message: "Could not stop the Doctor service." }));
		const { ctx } = buildCliHarness({ serviceLifecycle: { start: vi.fn(), stop } });
		const code = await dispatch(["stop"], ctx);
		expect(code).toBe(EXIT_ERROR);
	});

	it("polls until stopped and fails after the bounded verification window", async () => {
		const stop = vi.fn(async () => ({ ok: true, message: "stop command accepted" }));
		const transitions: Array<"running" | "not-running"> = ["running", "running", "not-running"];
		const state = vi.fn(async () => transitions.shift() ?? "not-running");
		const success = buildCliHarness({ serviceLifecycle: { start: vi.fn(), stop }, serviceStateAsync: state });
		expect(await dispatch(["stop"], success.ctx)).toBe(EXIT_OK);
		expect(state).toHaveBeenCalledTimes(3);

		const stillRunning = vi.fn(async () => "running" as const);
		const timeout = buildCliHarness({ serviceLifecycle: { start: vi.fn(), stop }, serviceStateAsync: stillRunning });
		expect(await dispatch(["stop"], timeout.ctx)).toBe(EXIT_ERROR);
		expect(stillRunning).toHaveBeenCalledTimes(20);
		expect(timeout.out.errText()).toContain("did not reach stopped state");
	});

	it("fails closed when serviceLifecycle is not wired", async () => {
		const { ctx, out } = buildCliHarness();
		const code = await dispatch(["stop"], ctx);
		expect(code).toBe(EXIT_ERROR);
		expect(out.errText()).toContain(SERVICE_NOT_AVAILABLE);
	});
});

describe("uninstall (PRD-003b b-AC-2/3/4/6/7)", () => {
	function harness(opts: {
		serviceStatus?: "running" | "not-running" | "unknown";
		/** REGISTRATION evidence (unit-file exists / a query succeeds), independent of activity. */
		serviceRegistered?: boolean;
		registryEntryExists?: boolean;
		stateDirExists?: boolean;
		serviceUninstallOk?: boolean;
		registryEntryRemoved?: boolean;
		stateDirRemoved?: boolean;
		lifecycle?: LifecycleTelemetry;
	}) {
		const serviceUninstall = vi.fn(async () => ({
			ok: opts.serviceUninstallOk ?? true,
			message: opts.serviceUninstallOk === false ? "Could not unregister Doctor service." : "Doctor service unregistered.",
		}));
		const removeState = vi.fn(() => ({
			registryEntryRemoved: opts.registryEntryRemoved ?? true,
			stateDirRemoved: opts.stateDirRemoved ?? true,
		}));
		const precheck = vi.fn(() => ({
			registryEntryExists: opts.registryEntryExists ?? true,
			stateDirExists: opts.stateDirExists ?? true,
		}));
		const serviceStatusAsync = vi.fn(async () => opts.serviceStatus ?? "running");
		// Default false: preserves every pre-existing test's intent (presence is signalled by
		// `serviceStatus`/registry/state alone unless a test explicitly opts into registration evidence).
		const isServiceRegistered = vi.fn(async () => opts.serviceRegistered ?? false);
		const h = buildCliHarness({
			productUninstall: { precheck, serviceStatusAsync, isServiceRegistered, serviceUninstall, removeState },
			...(opts.lifecycle !== undefined ? { lifecycle: opts.lifecycle } : {}),
		});
		return { ...h, serviceUninstall, removeState, precheck, serviceStatusAsync, isServiceRegistered };
	}

	it("b-AC-2: removes the OS service unit via serviceUninstall()", async () => {
		const h = harness({});
		const code = await dispatch(["uninstall"], h.ctx);
		expect(code).toBe(EXIT_OK);
		expect(h.serviceUninstall).toHaveBeenCalledTimes(1);
	});

	it("b-AC-3: removes the registry entry and reports it", async () => {
		const h = harness({ registryEntryRemoved: true });
		const code = await dispatch(["uninstall"], h.ctx);
		expect(code).toBe(EXIT_OK);
		expect(h.removeState).toHaveBeenCalledTimes(1);
		expect(h.out.text()).toContain("Removed Doctor's entry from the fleet registry.");
	});

	it("b-AC-3: reports honestly when there was no registry entry to remove", async () => {
		const h = harness({ registryEntryRemoved: false });
		await dispatch(["uninstall"], h.ctx);
		expect(h.out.text()).toContain("No fleet-registry entry for Doctor was found.");
	});

	it("b-AC-4: removes the state dir and reports it", async () => {
		const h = harness({ stateDirRemoved: true });
		await dispatch(["uninstall"], h.ctx);
		expect(h.out.text()).toContain("Removed Doctor's state directory.");
	});

	it("b-AC-4: reports honestly when there was no state dir to remove", async () => {
		const h = harness({ stateDirRemoved: false });
		await dispatch(["uninstall"], h.ctx);
		expect(h.out.text()).toContain("No Doctor state directory was found.");
	});

	it("b-AC-6: nothing installed exits 0 with a friendly no-op message and touches NOTHING", async () => {
		const h = harness({ serviceStatus: "not-running", registryEntryExists: false, stateDirExists: false });
		const code = await dispatch(["uninstall"], h.ctx);
		expect(code).toBe(EXIT_OK);
		expect(h.out.text()).toContain("Nothing to remove");
		// The pre-check is read-only: no destructive call is made on a clean machine.
		expect(h.serviceUninstall).not.toHaveBeenCalled();
		expect(h.removeState).not.toHaveBeenCalled();
	});

	it("b-AC-6: a live service alone (registry/state absent) is still 'something to remove'", async () => {
		const h = harness({ serviceStatus: "running", registryEntryExists: false, stateDirExists: false });
		const code = await dispatch(["uninstall"], h.ctx);
		expect(code).toBe(EXIT_OK);
		expect(h.serviceUninstall).toHaveBeenCalledTimes(1);
	});

	it("b-AC-6: an installed-but-INACTIVE unit (registered, no registry/state) is never a false no-op", async () => {
		// The exact scenario the verifier named: a systemd unit file is present (registration
		// evidence), but the service is inactive (`serviceStatus: "not-running"` - the same
		// value `systemctl is-active` reports for BOTH "inactive" and "never registered"), and
		// there is no registry entry and no state dir. The precheck must key on registration
		// evidence, not activity, so this is NOT a no-op.
		const h = harness({
			serviceStatus: "not-running",
			serviceRegistered: true,
			registryEntryExists: false,
			stateDirExists: false,
		});
		const code = await dispatch(["uninstall"], h.ctx);
		expect(code).toBe(EXIT_OK);
		expect(h.out.text()).not.toContain("Nothing to remove");
		expect(h.serviceUninstall).toHaveBeenCalledTimes(1);
	});

	it("b-AC-6: a probe error/ambiguity on isServiceRegistered biases toward 'present', never a false no-op", async () => {
		const serviceUninstall = vi.fn(async () => ({ ok: true, message: "Doctor service unregistered." }));
		const removeState = vi.fn(() => ({ registryEntryRemoved: false, stateDirRemoved: false }));
		const precheck = vi.fn(() => ({ registryEntryExists: false, stateDirExists: false }));
		const { ctx, out } = buildCliHarness({
			productUninstall: {
				precheck,
				serviceStatusAsync: async () => "not-running",
				isServiceRegistered: async () => {
					throw new Error("query failed unexpectedly");
				},
				serviceUninstall,
				removeState,
			},
		});
		const code = await dispatch(["uninstall"], ctx);
		expect(code).toBe(EXIT_OK);
		expect(out.text()).not.toContain("Nothing to remove");
		expect(serviceUninstall).toHaveBeenCalledTimes(1);
	});

	it("b-AC-6: nothing installed AND not registered is still the friendly no-op (registration evidence alone does not over-trigger)", async () => {
		const h = harness({
			serviceStatus: "not-running",
			serviceRegistered: false,
			registryEntryExists: false,
			stateDirExists: false,
		});
		const code = await dispatch(["uninstall"], h.ctx);
		expect(code).toBe(EXIT_OK);
		expect(h.out.text()).toContain("Nothing to remove");
		expect(h.serviceUninstall).not.toHaveBeenCalled();
	});

	it("a failed service uninstall maps to a non-zero exit", async () => {
		const h = harness({ serviceUninstallOk: false });
		const code = await dispatch(["uninstall"], h.ctx);
		expect(code).toBe(EXIT_ERROR);
	});

	it("a failed service uninstall on a REGISTERED unit still maps to a non-zero exit", async () => {
		const h = harness({ serviceStatus: "not-running", serviceRegistered: true, serviceUninstallOk: false });
		const code = await dispatch(["uninstall"], h.ctx);
		expect(code).toBe(EXIT_ERROR);
	});

	it("b-AC-6/AC-9: an already-absent unit (stale registry/state only) exits 0 even when the deregister command reports an error", async () => {
		// The partially-uninstalled shape: `doctor uninstall-service` already removed the unit,
		// leaving the registry entry and state dir behind. `doctor uninstall` proceeds (there IS
		// something to remove), the manager's deregister fails on the already-gone unit (the
		// "often because it was already gone" ok:false shape), the registry/state cleanup
		// succeeds - the verb must exit 0, not report failure for a successful cleanup.
		const h = harness({
			serviceStatus: "not-running",
			serviceRegistered: false,
			registryEntryExists: true,
			stateDirExists: true,
			serviceUninstallOk: false,
		});
		const code = await dispatch(["uninstall"], h.ctx);
		expect(code).toBe(EXIT_OK);
		expect(h.removeState).toHaveBeenCalledTimes(1);
		expect(h.out.text()).toContain("Removed Doctor's entry from the fleet registry.");
	});

	it("fires the doctor_uninstalled lifecycle event before teardown (same ordering as uninstall-service)", async () => {
		const order: string[] = [];
		const lifecycle: LifecycleTelemetry = {
			async installed() {
				return { sent: true };
			},
			async updated() {
				return { sent: true };
			},
			async uninstalled() {
				order.push("lifecycle.uninstalled");
				return { sent: true };
			},
		};
		const serviceUninstall = vi.fn(async () => {
			order.push("service.uninstall");
			return { ok: true, message: "unregistered" };
		});
		const { ctx } = buildCliHarness({
			lifecycle,
			productUninstall: {
				precheck: () => ({ registryEntryExists: true, stateDirExists: true }),
				serviceStatusAsync: async () => "running",
				isServiceRegistered: async () => true,
				serviceUninstall,
				removeState: () => ({ registryEntryRemoved: true, stateDirRemoved: true }),
			},
		});
		await dispatch(["uninstall"], ctx);
		expect(order).toEqual(["lifecycle.uninstalled", "service.uninstall"]);
	});

	it("does NOT fire the lifecycle event on the b-AC-6 nothing-to-remove path", async () => {
		const uninstalled = vi.fn(async () => ({ sent: true }));
		const lifecycle: LifecycleTelemetry = {
			installed: async () => ({ sent: true }),
			updated: async () => ({ sent: true }),
			uninstalled,
		};
		const { ctx } = buildCliHarness({
			lifecycle,
			productUninstall: {
				precheck: () => ({ registryEntryExists: false, stateDirExists: false }),
				serviceStatusAsync: async () => "not-running",
				isServiceRegistered: async () => false,
				serviceUninstall: vi.fn(),
				removeState: vi.fn(),
			},
		});
		await dispatch(["uninstall"], ctx);
		expect(uninstalled).not.toHaveBeenCalled();
	});

	it("fails closed when productUninstall is not wired", async () => {
		const { ctx, out } = buildCliHarness();
		const code = await dispatch(["uninstall"], ctx);
		expect(code).toBe(EXIT_ERROR);
		expect(out.errText()).toContain(SERVICE_NOT_AVAILABLE);
	});
});

describe("b-AC-5: existing verb spellings keep working", () => {
	it("install-service and uninstall-service are still known commands alongside the new verbs", async () => {
		const { ctx: installCtx, out: installOut } = buildCliHarness({
			serviceModule: { install: async () => ({ ok: true, message: "installed" }), uninstall: async () => ({ ok: true, message: "removed" }) },
		});
		expect(await dispatch(["install-service"], installCtx)).toBe(EXIT_OK);
		expect(installOut.text()).toContain("installed");

		const { ctx: uninstallCtx, out: uninstallOut } = buildCliHarness({
			serviceModule: { install: async () => ({ ok: true, message: "installed" }), uninstall: async () => ({ ok: true, message: "removed" }) },
		});
		expect(await dispatch(["uninstall-service"], uninstallCtx)).toBe(EXIT_OK);
		expect(uninstallOut.text()).toContain("removed");
	});

	it("uninstall-service stays service-unit-only: it never calls the fuller productUninstall seam", async () => {
		const productUninstallSpy = vi.fn();
		const { ctx } = buildCliHarness({
			serviceModule: { install: async () => ({ ok: true, message: "installed" }), uninstall: async () => ({ ok: true, message: "removed" }) },
			productUninstall: {
				precheck: productUninstallSpy,
				serviceStatusAsync: async () => "running",
				isServiceRegistered: productUninstallSpy,
				serviceUninstall: productUninstallSpy,
				removeState: productUninstallSpy,
			},
		});
		await dispatch(["uninstall-service"], ctx);
		expect(productUninstallSpy).not.toHaveBeenCalled();
	});
});
