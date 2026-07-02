/**
 * Tests for the lifecycle capture-event FIRING POINTS in the CLI dispatcher
 * (src/cli/dispatch.ts runService):
 *
 *   - `hivedoctor_installed` fires exactly once, AFTER a SUCCESSFUL install-service;
 *     a failed install fires nothing.
 *   - `hivedoctor_uninstalled` fires at uninstall-service BEFORE the service module's
 *     teardown, fire-and-forget: a hung emit never blocks or fails the uninstall.
 *   - An absent lifecycle dep leaves both verbs exactly as before.
 *
 * The lifecycle emitter itself (gates, dedupe, payload) is covered in
 * tests/telemetry/capture.test.ts; here a recorder stub asserts the wiring only.
 */

import { describe, expect, it } from "vitest";

import { EXIT_ERROR, EXIT_OK, dispatch } from "../../src/cli/dispatch.js";
import type { ServiceModule } from "../../src/cli/service-stub.js";
import type { LifecycleTelemetry } from "../../src/telemetry/capture.js";
import { buildCliHarness } from "./helpers/fake-cli.js";

/** An event-order recorder shared by the lifecycle stub and the service module stub. */
function makeRecorder() {
	const order: string[] = [];
	const lifecycle: LifecycleTelemetry = {
		async installed() {
			order.push("lifecycle.installed");
			return { sent: true };
		},
		async updated() {
			order.push("lifecycle.updated");
			return { sent: true };
		},
		async uninstalled() {
			order.push("lifecycle.uninstalled");
			return { sent: true };
		},
	};
	const serviceModule = (ok: boolean): ServiceModule => ({
		async install() {
			order.push("service.install");
			return { ok, message: ok ? "installed" : "install failed" };
		},
		async uninstall() {
			order.push("service.uninstall");
			return { ok, message: ok ? "uninstalled" : "uninstall failed" };
		},
	});
	return { order, lifecycle, serviceModule };
}

describe("hivedoctor_installed firing point (install-service)", () => {
	it("fires lifecycle.installed AFTER a successful install", async () => {
		const rec = makeRecorder();
		const { ctx } = buildCliHarness({ serviceModule: rec.serviceModule(true), lifecycle: rec.lifecycle });

		const code = await dispatch(["install-service"], ctx);

		expect(code).toBe(EXIT_OK);
		expect(rec.order).toEqual(["service.install", "lifecycle.installed"]);
	});

	it("does NOT fire on a FAILED install", async () => {
		const rec = makeRecorder();
		const { ctx } = buildCliHarness({ serviceModule: rec.serviceModule(false), lifecycle: rec.lifecycle });

		const code = await dispatch(["install-service"], ctx);

		expect(code).toBe(EXIT_ERROR);
		expect(rec.order).toEqual(["service.install"]);
	});

	it("install-service works unchanged when no lifecycle is wired", async () => {
		const rec = makeRecorder();
		const { ctx, out } = buildCliHarness({ serviceModule: rec.serviceModule(true) });

		const code = await dispatch(["install-service"], ctx);

		expect(code).toBe(EXIT_OK);
		expect(out.text()).toContain("installed");
		expect(rec.order).toEqual(["service.install"]);
	});
});

describe("hivedoctor_uninstalled firing point (uninstall-service)", () => {
	it("fires lifecycle.uninstalled BEFORE the service module's teardown", async () => {
		const rec = makeRecorder();
		const { ctx } = buildCliHarness({ serviceModule: rec.serviceModule(true), lifecycle: rec.lifecycle });

		const code = await dispatch(["uninstall-service"], ctx);

		expect(code).toBe(EXIT_OK);
		expect(rec.order).toEqual(["lifecycle.uninstalled", "service.uninstall"]);
	});

	it("is fire-and-forget: a NEVER-RESOLVING emit does not block the uninstall", async () => {
		const order: string[] = [];
		const hangingLifecycle: LifecycleTelemetry = {
			async installed() {
				return { sent: true };
			},
			async updated() {
				return { sent: true };
			},
			uninstalled() {
				order.push("lifecycle.uninstalled");
				// A promise that never settles: dispatch must still complete the uninstall.
				return new Promise(() => undefined);
			},
		};
		const serviceModule: ServiceModule = {
			async install() {
				return { ok: true, message: "installed" };
			},
			async uninstall() {
				order.push("service.uninstall");
				return { ok: true, message: "uninstalled" };
			},
		};
		const { ctx } = buildCliHarness({ serviceModule, lifecycle: hangingLifecycle });

		const code = await dispatch(["uninstall-service"], ctx);

		expect(code).toBe(EXIT_OK);
		expect(order).toEqual(["lifecycle.uninstalled", "service.uninstall"]);
	});

	it("still fires (and the uninstall still reports honestly) when teardown fails", async () => {
		const rec = makeRecorder();
		const { ctx } = buildCliHarness({ serviceModule: rec.serviceModule(false), lifecycle: rec.lifecycle });

		const code = await dispatch(["uninstall-service"], ctx);

		expect(code).toBe(EXIT_ERROR);
		expect(rec.order).toEqual(["lifecycle.uninstalled", "service.uninstall"]);
	});

	it("uninstall-service works unchanged when no lifecycle is wired", async () => {
		const rec = makeRecorder();
		const { ctx, out } = buildCliHarness({ serviceModule: rec.serviceModule(true) });

		const code = await dispatch(["uninstall-service"], ctx);

		expect(code).toBe(EXIT_OK);
		expect(out.text()).toContain("uninstalled");
		expect(rec.order).toEqual(["service.uninstall"]);
	});
});
