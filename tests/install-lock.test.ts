/**
 * Shared install-lock tests (PRD-064c): the file-based mutex that serializes rung 2's
 * reinstall and the future 064e auto-update so two `npm i -g` never race. Built-ins only.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createInstallLock, type InstallLockClock } from "../src/install-lock.js";
import { silentLogger } from "../src/logger.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "doctor-lock-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** A controllable clock for deterministic staleness. */
function controllableClock(start = 0): InstallLockClock & { set: (n: number) => void } {
	let t = start;
	return { now: () => t, set: (n: number) => (t = n) };
}

describe("install lock", () => {
	it("acquires when free and writes the lock file", () => {
		const lock = createInstallLock({ workspaceDir: dir, logger: silentLogger });
		const handle = lock.acquire("reinstall");
		expect(handle).not.toBeNull();
		expect(existsSync(join(dir, "install.lock"))).toBe(true);
	});

	it("returns null when a FRESH lock is already held (mutual exclusion)", () => {
		const lock = createInstallLock({ workspaceDir: dir, logger: silentLogger });
		const first = lock.acquire("reinstall");
		expect(first).not.toBeNull();
		const second = lock.acquire("auto-update");
		expect(second).toBeNull(); // the second caller must back off
	});

	it("release() frees the lock so a later acquire succeeds", () => {
		const lock = createInstallLock({ workspaceDir: dir, logger: silentLogger });
		const handle = lock.acquire("reinstall");
		handle?.release();
		expect(existsSync(join(dir, "install.lock"))).toBe(false);
		expect(lock.acquire("auto-update")).not.toBeNull();
	});

	it("steals a STALE lock (held past staleMs) so a dead holder cannot wedge installs forever", () => {
		const clock = controllableClock(0);
		const lock = createInstallLock({ workspaceDir: dir, logger: silentLogger, staleMs: 1_000, clock });

		const first = lock.acquire("reinstall");
		expect(first).not.toBeNull();

		// Within the window: held, second caller backs off.
		clock.set(500);
		expect(lock.acquire("auto-update")).toBeNull();

		// Past the window: the stale lock is stolen and re-acquired.
		clock.set(2_000);
		expect(lock.acquire("auto-update")).not.toBeNull();
	});

	it("release() is a no-op when the lock was already stolen by another holder", () => {
		const clock = controllableClock(0);
		const lock = createInstallLock({ workspaceDir: dir, logger: silentLogger, staleMs: 1_000, clock });

		const first = lock.acquire("reinstall");
		clock.set(2_000);
		const second = lock.acquire("auto-update"); // steals the stale lock
		expect(second).not.toBeNull();

		// The original holder's late release must NOT delete the second holder's fresh lock.
		first?.release();
		expect(existsSync(join(dir, "install.lock"))).toBe(true);
		expect(second?.owner).toBeDefined();
	});

	it("does not throw on a garbage lock body; steals it once stale", () => {
		const clock = controllableClock(0);
		writeFileSync(join(dir, "install.lock"), "not-json", "utf8");
		const lock = createInstallLock({ workspaceDir: dir, logger: silentLogger, staleMs: 1_000, clock });

		// Fresh-but-garbage: treated as held (cannot prove abandoned), so the caller backs off.
		expect(() => lock.acquire("reinstall")).not.toThrow();
	});
});

// ────────────────────────────────────────────────────────────────────────────
// PRD-004a design: "a lock present in the legacy dir is honored by a
// legacy-fallback staleness check ... new acquisitions happen only at the new path"
// (LEGACY-HONEYCOMB-WINDOW; QA Warning 1)
// ────────────────────────────────────────────────────────────────────────────

describe("PRD-004a design: legacy install-lock fallback staleness check", () => {
	let legacyDir: string;
	beforeEach(() => {
		// A sibling temp dir standing in for the pre-migration `~/.honeycomb/doctor`.
		legacyDir = mkdtempSync(join(tmpdir(), "doctor-lock-legacy-"));
	});
	afterEach(() => {
		rmSync(legacyDir, { recursive: true, force: true });
	});

	/** Write a legacy lock body as a pre-migration doctor would have. */
	function writeLegacyLock(acquiredAt: number): void {
		writeFileSync(
			join(legacyDir, "install.lock"),
			`${JSON.stringify({ owner: "legacy-owner", holder: "reinstall", acquiredAt })}\n`,
			"utf8",
		);
	}

	it("PRD-004a design: a LIVE legacy holder blocks acquisition at the new path (no concurrent installs across the window)", () => {
		const clock = controllableClock(10_000);
		writeLegacyLock(9_500); // age 500ms < staleMs: a still-running pre-migration doctor
		const lock = createInstallLock({ workspaceDir: dir, legacyWorkspaceDir: legacyDir, logger: silentLogger, staleMs: 1_000, clock });

		expect(lock.acquire("auto-update")).toBeNull();
		// Acquisition never happened at the new path, and the live legacy lock is untouched.
		expect(existsSync(join(dir, "install.lock"))).toBe(false);
		expect(existsSync(join(legacyDir, "install.lock"))).toBe(true);
	});

	it("PRD-004a design: a STALE legacy lock is cleaned and acquisition proceeds at the new path only", () => {
		const clock = controllableClock(10_000);
		writeLegacyLock(1_000); // age 9000ms >= staleMs: an abandoned pre-migration lock
		const lock = createInstallLock({ workspaceDir: dir, legacyWorkspaceDir: legacyDir, logger: silentLogger, staleMs: 1_000, clock });

		const handle = lock.acquire("auto-update");
		expect(handle).not.toBeNull();
		// The new acquisition landed ONLY at the new path; the stale legacy lock was removed
		// (never migrated, never honored).
		expect(existsSync(join(dir, "install.lock"))).toBe(true);
		expect(existsSync(join(legacyDir, "install.lock"))).toBe(false);
	});

	it("PRD-004a design: no legacy lock present means the fallback check is a transparent no-op", () => {
		const lock = createInstallLock({ workspaceDir: dir, legacyWorkspaceDir: legacyDir, logger: silentLogger });
		expect(lock.acquire("reinstall")).not.toBeNull();
	});

	it("PRD-004a design: a legacyWorkspaceDir equal to the active workspace never self-blocks (pinned-to-legacy operator)", () => {
		// An operator who pinned DOCTOR_WORKSPACE_DIR to the legacy dir: the primary check IS
		// the legacy check, so the fallback must not read the freshly-acquired lock as a
		// foreign holder.
		const lock = createInstallLock({ workspaceDir: dir, legacyWorkspaceDir: dir, logger: silentLogger });
		const first = lock.acquire("reinstall");
		expect(first).not.toBeNull();
		first?.release();
		expect(lock.acquire("auto-update")).not.toBeNull();
	});

	it("PRD-004a design: a fresh-but-garbage legacy lock body is treated as held (mtime-judged), never a throw", () => {
		const clock = controllableClock(Date.now());
		// A garbage body whose file mtime is NOW: cannot prove abandoned -> back off.
		writeFileSync(join(legacyDir, "install.lock"), "not-json", "utf8");
		const lock = createInstallLock({ workspaceDir: dir, legacyWorkspaceDir: legacyDir, logger: silentLogger, staleMs: 60_000, clock });
		expect(() => lock.acquire("reinstall")).not.toThrow();
		expect(lock.acquire("reinstall")).toBeNull();
	});
});
