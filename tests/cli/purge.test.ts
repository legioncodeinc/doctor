/**
 * `purge` dispatcher tests (PRD-003c c-AC-1/c-AC-2): the confirmation gate, the `--yes`
 * bypass, and the non-interactive refusal. The actual wipe (c-AC-3..c-AC-6) is the purge
 * ENGINE's own concern, covered in tests/purge/engine.test.ts; here `deps.purge.run()` is
 * a spy so these tests isolate the gate itself.
 */

import { describe, expect, it, vi } from "vitest";

import { dispatch, EXIT_DECLINED, EXIT_ERROR, EXIT_OK } from "../../src/cli/dispatch.js";
import { SERVICE_NOT_AVAILABLE } from "../../src/cli/service-stub.js";
import { buildCliHarness } from "./helpers/fake-cli.js";

function purgeHarness(opts: {
	interactive?: boolean;
	confirmToken?: boolean;
	runResult?: { ok: boolean; nothingToRemove: boolean; lines: readonly string[] };
}) {
	const run = vi.fn(async () => opts.runResult ?? { ok: true, nothingToRemove: false, lines: ["  - honeycomb service: removed."] });
	const summaryLines = vi.fn(() => ["~/.deeplake - shared Deeplake credentials, also used by a standalone Hivemind install."]);
	const h = buildCliHarness({
		purge: { summaryLines, run },
		interactive: opts.interactive ?? true,
		confirmToken: opts.confirmToken ?? true,
	});
	return { ...h, run, summaryLines };
}

describe("purge confirmation gate (c-AC-1)", () => {
	it("prints the destruction summary (naming ~/.deeplake) before prompting", async () => {
		const h = purgeHarness({});
		await dispatch(["purge"], h.ctx);
		expect(h.out.text()).toContain("~/.deeplake");
		expect(h.summaryLines).toHaveBeenCalledTimes(1);
	});

	it("proceeds and runs the wipe when the operator types the exact token", async () => {
		const h = purgeHarness({ confirmToken: true });
		const code = await dispatch(["purge"], h.ctx);
		expect(h.confirmTokenSpy).toHaveBeenCalledTimes(1);
		expect(h.confirmTokenSpy.mock.calls[0]?.[1]).toBe("purge");
		expect(h.run).toHaveBeenCalledTimes(1);
		expect(code).toBe(EXIT_OK);
	});

	it("any other input aborts with EXIT_DECLINED and makes NO changes", async () => {
		const h = purgeHarness({ confirmToken: false });
		const code = await dispatch(["purge"], h.ctx);
		expect(code).toBe(EXIT_DECLINED);
		expect(h.run).not.toHaveBeenCalled();
		expect(h.out.text()).toContain("Aborted");
	});

	it("non-TTY stdin without --yes refuses with instructions, never hangs, never proceeds", async () => {
		const h = purgeHarness({ interactive: false });
		const code = await dispatch(["purge"], h.ctx);
		expect(code).toBe(EXIT_DECLINED);
		expect(h.run).not.toHaveBeenCalled();
		// The confirm-token prompt is never even opened on a non-interactive stdin.
		expect(h.confirmTokenSpy).not.toHaveBeenCalled();
		expect(h.out.text().toLowerCase()).toContain("--yes");
	});
});

describe("purge --yes (c-AC-2)", () => {
	it("runs the same wipe non-interactively, without any confirmation prompt", async () => {
		const h = purgeHarness({ interactive: false });
		const code = await dispatch(["purge", "--yes"], h.ctx);
		expect(code).toBe(EXIT_OK);
		expect(h.run).toHaveBeenCalledTimes(1);
		expect(h.confirmTokenSpy).not.toHaveBeenCalled();
	});

	it("--yes still works when stdin IS interactive (power-user bypass)", async () => {
		const h = purgeHarness({ interactive: true });
		const code = await dispatch(["purge", "--yes"], h.ctx);
		expect(code).toBe(EXIT_OK);
		expect(h.confirmTokenSpy).not.toHaveBeenCalled();
		expect(h.run).toHaveBeenCalledTimes(1);
	});
});

describe("purge result reporting", () => {
	it("prints every report line and maps ok:true to EXIT_OK", async () => {
		const h = purgeHarness({ runResult: { ok: true, nothingToRemove: false, lines: ["  - a: removed.", "  - b: removed."] } });
		const code = await dispatch(["purge", "--yes"], h.ctx);
		expect(code).toBe(EXIT_OK);
		expect(h.out.text()).toContain("a: removed.");
		expect(h.out.text()).toContain("b: removed.");
	});

	it("c-AC-6: a clean machine's 'nothing to remove' report still exits 0", async () => {
		const h = purgeHarness({
			runResult: { ok: true, nothingToRemove: true, lines: ["Nothing to remove: no Apiary services, packages, or state directories were found on this machine."] },
		});
		const code = await dispatch(["purge", "--yes"], h.ctx);
		expect(code).toBe(EXIT_OK);
		expect(h.out.text()).toContain("Nothing to remove");
	});

	it("maps ok:false (a failed step) to a non-zero exit", async () => {
		const h = purgeHarness({ runResult: { ok: false, nothingToRemove: false, lines: ["  - a: FAILED (EACCES)."] } });
		const code = await dispatch(["purge", "--yes"], h.ctx);
		expect(code).toBe(EXIT_ERROR);
	});

	it("prints the 'not yet available' stub when the purge engine is not wired", async () => {
		const { ctx, out } = buildCliHarness();
		const code = await dispatch(["purge"], ctx);
		expect(code).toBe(EXIT_OK);
		expect(out.text()).toContain(SERVICE_NOT_AVAILABLE);
	});
});
