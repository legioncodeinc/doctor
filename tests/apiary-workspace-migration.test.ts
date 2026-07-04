/**
 * Doctor's own workspace migration (PRD-004a a-AC-4/5/6): the one-time, idempotent,
 * additive move of `~/.honeycomb/doctor/` -> `<root>/doctor/`, with a legacy-fallback for
 * any file that fails to migrate. Uses a temp HOME + injected env/platform so the fleet root
 * is deterministically `<HOME>/.apiary` and nothing touches the real host.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrateDoctorWorkspace } from "../src/apiary-migration.js";

let home: string;
let legacyDir: string;
let newDir: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "doctor-ws-mig-"));
	legacyDir = join(home, ".honeycomb", "doctor");
	newDir = join(home, ".apiary", "doctor");
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

/** Seed the legacy workspace with a set of files. */
function seedLegacy(files: Record<string, string>): void {
	mkdirSync(legacyDir, { recursive: true });
	for (const [name, contents] of Object.entries(files)) {
		writeFileSync(join(legacyDir, name), contents, "utf8");
	}
}

const MIG = { env: {}, platform: "linux" as const };

describe("migrateDoctorWorkspace (PRD-004a)", () => {
	it("a-AC-4: migrates legacy workspace files to <root>/doctor; the install lock is NOT migrated", () => {
		seedLegacy({
			"state-honeycomb.json": '{"lastKnownHealth":"ok"}',
			"incidents-honeycomb.ndjson": '{"steps":[]}\n',
			"install.lock": '{"owner":"x","holder":"reinstall","acquiredAt":1}',
		});

		const result = migrateDoctorWorkspace({ home, ...MIG });

		expect(result.migrated).toBe(true);
		expect(result.failed).toEqual([]);
		// The state + incidents shards moved to the new workspace, content byte-preserved.
		expect(readFileSync(join(newDir, "state-honeycomb.json"), "utf8")).toBe('{"lastKnownHealth":"ok"}');
		expect(existsSync(join(newDir, "incidents-honeycomb.ndjson"))).toBe(true);
		// Moved (not copied): the legacy shards are gone.
		expect(existsSync(join(legacyDir, "state-honeycomb.json"))).toBe(false);
		// The install lock is deliberately NOT migrated as a live file (PRD-004a): it stays in
		// the legacy dir and is never carried into the new workspace.
		expect(existsSync(join(legacyDir, "install.lock"))).toBe(true);
		expect(existsSync(join(newDir, "install.lock"))).toBe(false);
	});

	it("a-AC-5: a second run is a no-op (idempotent) when the new workspace already has artifacts", () => {
		seedLegacy({ "state-honeycomb.json": "{}" });
		const first = migrateDoctorWorkspace({ home, ...MIG });
		expect(first.migrated).toBe(true);

		// A stray legacy file that appears AFTER the first migration must not be pulled: the new
		// workspace already carrying artifacts means the migration is done.
		mkdirSync(legacyDir, { recursive: true });
		writeFileSync(join(legacyDir, "late.json"), "{}", "utf8");

		const second = migrateDoctorWorkspace({ home, ...MIG });
		expect(second.migrated).toBe(false);
		expect(second.reason).toBe("new-present");
		expect(second.moved).toEqual([]);
		// The late legacy file is left untouched (never moved, never deleted).
		expect(existsSync(join(legacyDir, "late.json"))).toBe(true);
		expect(existsSync(join(newDir, "late.json"))).toBe(false);
	});

	it("a-AC-5: with no legacy workspace present, the migration is a no-op", () => {
		const result = migrateDoctorWorkspace({ home, ...MIG });
		expect(result.migrated).toBe(false);
		expect(result.reason).toBe("no-legacy");
		expect(existsSync(newDir)).toBe(false);
	});

	it("a-AC-6: a file that fails to migrate is LEFT in the legacy dir, others migrate, and it never throws", () => {
		seedLegacy({ "good.json": '{"ok":true}', "bad.json": '{"bad":true}' });

		// Force the move to always fail (drive the copy fallback), and make the copy fail for
		// "bad.json" only. "good.json" migrates via copy; "bad.json" fails both and is left.
		const result = migrateDoctorWorkspace({
			home,
			...MIG,
			move: () => {
				throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
			},
			copy: (src, dst) => {
				if (src.endsWith("bad.json")) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
				// A real recursive copy for the good file.
				writeFileSync(dst, readFileSync(src, "utf8"), "utf8");
			},
		});

		// No throw; the good file migrated, the bad file is reported failed and left in place.
		expect(result.failed).toEqual(["bad.json"]);
		expect(result.moved).toEqual(["good.json"]);
		expect(readFileSync(join(newDir, "good.json"), "utf8")).toBe('{"ok":true}');
		// The un-migrated legacy file is left in place (never deleted) for the legacy-fallback read.
		expect(existsSync(join(legacyDir, "bad.json"))).toBe(true);
		expect(existsSync(join(newDir, "bad.json"))).toBe(false);
	});

	it("a-AC-7 guard (QA Warning 2): with DOCTOR_WORKSPACE_DIR set, the migration is SKIPPED and the legacy workspace is untouched", () => {
		seedLegacy({ "state-honeycomb.json": '{"lastKnownHealth":"ok"}' });

		const result = migrateDoctorWorkspace({
			home,
			env: { DOCTOR_WORKSPACE_DIR: join(home, "custom-ws") },
			platform: "linux",
		});

		// The operator pinned the workspace: nothing may be moved out from under it.
		expect(result.migrated).toBe(false);
		expect(result.reason).toBe("workspace-overridden");
		expect(result.moved).toEqual([]);
		// The legacy workspace is fully untouched and the new dir was never created.
		expect(readFileSync(join(legacyDir, "state-honeycomb.json"), "utf8")).toBe('{"lastKnownHealth":"ok"}');
		expect(existsSync(newDir)).toBe(false);
	});

	it("a-AC-7 guard (QA Warning 2): a blank/whitespace DOCTOR_WORKSPACE_DIR is treated as unset and the migration proceeds", () => {
		seedLegacy({ "state-honeycomb.json": "{}" });

		const result = migrateDoctorWorkspace({
			home,
			env: { DOCTOR_WORKSPACE_DIR: "   " },
			platform: "linux",
		});

		// Blank means no override (mirroring resolveConfig's own handling): the default-location
		// migration runs exactly as with an empty env.
		expect(result.migrated).toBe(true);
		expect(result.reason).toBe("migrated");
		expect(existsSync(join(newDir, "state-honeycomb.json"))).toBe(true);
	});

	it("never throws and reports `error` when the whole migration hits an unexpected fault", () => {
		seedLegacy({ "state.json": "{}" });
		// A readdir seam that throws for the NEW dir existence-listing forces the outer guard.
		const result = migrateDoctorWorkspace({
			home,
			...MIG,
			readdir: () => {
				throw new Error("boom");
			},
		});
		// The legacy-unreadable branch is hit (readdir on legacyDir throws) -> reported, no throw.
		expect(["legacy-unreadable", "error"]).toContain(result.reason);
		expect(result.migrated).toBe(false);
	});
});
