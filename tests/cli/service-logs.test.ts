import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import type { LogFileSystem } from "@legioncodeinc/cli-kit";

import { dispatch } from "../../src/cli/dispatch.js";
import { doctorServiceLogPath, tailDoctorServiceLog } from "../../src/cli/service-logs.js";
import { buildCliHarness } from "./helpers/fake-cli.js";

const root = resolve("virtual-apiary", "doctor");
const path = doctorServiceLogPath(root);

function memoryLogFs(content: string, onWatch?: () => void): LogFileSystem & { readonly reads: string[]; readonly closes: string[] } {
	const reads: string[] = [];
	const closes: string[] = [];
	return {
		reads,
		closes,
		readFile: async (candidate) => { reads.push(candidate); return content; },
		realpath: async (candidate) => candidate,
		watch: (_candidate, callback) => {
			onWatch?.();
			return { close() { closes.push("closed"); } };
		},
	};
}

describe("Doctor authoritative service logs", () => {
	it("defaults to the last 100 lines and redacts secrets", async () => {
		const content = Array.from({ length: 150 }, (_, index) =>
			`2026-07-13T10:${String(index).padStart(2, "0")}:00Z line-${index + 1}${index === 149 ? " api_key=supersecret" : ""}`,
		).join("\n");
		const fs = memoryLogFs(content);
		const output: string[] = [];
		expect(await tailDoctorServiceLog({ argv: ["--no-follow"], workspaceDir: root, write: (line) => output.push(line), fs })).toEqual({ ok: true });
		expect(output).toHaveLength(100);
		expect(output[0]).toContain("line-51");
		expect(output.at(-1)).toContain("api_key=[REDACTED]");
		expect(output.join("")).not.toContain("supersecret");
	});

	it("follows by default and aborts cleanly with watcher cleanup", async () => {
		const controller = new AbortController();
		const fs = memoryLogFs("2026-07-13T10:00:00Z started\n");
		const pending = tailDoctorServiceLog({ argv: [], workspaceDir: root, write() {}, signal: controller.signal, fs });
		await new Promise<void>((resolveReady) => setImmediate(resolveReady));
		controller.abort();
		expect(await pending).toEqual({ ok: true });
		expect(fs.closes).toEqual(["closed"]);
	});

	it("applies --since before the line limit", async () => {
		const fs = memoryLogFs([
			"2026-07-13T09:00:00Z old",
			"2026-07-13T10:00:00Z retained-one",
			"2026-07-13T11:00:00Z retained-two",
		].join("\n"));
		const output: string[] = [];
		const result = await tailDoctorServiceLog({
			argv: ["--since", "2026-07-13T09:30:00Z", "--no-follow"],
			workspaceDir: root,
			write: (line) => output.push(line),
			fs,
		});
		expect(result).toEqual({ ok: true });
		expect(output.join("")).toBe("2026-07-13T10:00:00Z retained-one\n2026-07-13T11:00:00Z retained-two\n");
	});

	it("returns runtime failure for missing and unreadable logs", async () => {
		for (const failure of ["ENOENT: missing", "EACCES: unreadable"]) {
			const fs: LogFileSystem = {
				readFile: async () => { throw new Error(failure); },
				realpath: async (candidate) => candidate,
				watch: () => ({ close() {} }),
			};
			const result = await tailDoctorServiceLog({ argv: ["--no-follow"], workspaceDir: root, write() {}, fs });
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toContain(failure);
		}
	});

	it("reads only Doctor and rejects Hive, Honeycomb, and Nectar source substitution", async () => {
		const poison = new Map([
			[doctorServiceLogPath(resolve("virtual-apiary", "hive")), "HIVE_POISON"],
			[doctorServiceLogPath(resolve("virtual-apiary", "honeycomb")), "HONEYCOMB_POISON"],
			[doctorServiceLogPath(resolve("virtual-apiary", "nectar")), "NECTAR_POISON"],
		]);
		const fs = memoryLogFs("DOCTOR_IDENTITY\n");
		const output: string[] = [];
		expect(await tailDoctorServiceLog({ argv: ["--no-follow"], workspaceDir: root, write: (line) => output.push(line), fs })).toEqual({ ok: true });
		expect(fs.reads).toEqual([path]);
		expect(output.join("")).toContain("DOCTOR_IDENTITY");
		for (const marker of poison.values()) expect(output.join("")).not.toContain(marker);
	});

	it("maps Ctrl+C abort to exit 0 and removes its process listener", async () => {
		const before = process.listenerCount("SIGINT");
		const h = buildCliHarness({
			tailServiceLogs: async (_args, _write, signal) => new Promise((resolveDone) => {
				signal?.addEventListener("abort", () => resolveDone({ ok: true }), { once: true });
			}),
		});
		const pending = dispatch(["logs"], h.ctx);
		await new Promise<void>((resolveReady) => setImmediate(resolveReady));
		process.emit("SIGINT");
		expect(await pending).toBe(0);
		expect(process.listenerCount("SIGINT")).toBe(before);
	});
});
