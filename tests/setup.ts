/**
 * Suite-wide hermetic-home guard (test-isolation fix).
 *
 * Several production entry points the tests drive (`createDoctor`, `buildCliContext`,
 * `runCli(["run"])`) resolve their default seams from the REAL user home via
 * `os.homedir()`: the device-id mint/persist (`resolveDeviceId`), the two-location
 * registry resolution, and the boot-time Apiary migrations. Without isolation, running
 * the suite would read the operator's real `~/.apiary` / `~/.honeycomb` (so a machine
 * that has actually used the product changes test outcomes) and WRITE artifacts there
 * (a minted `~/.apiary/device.json`).
 *
 * `os.homedir()` reads `$HOME` (POSIX) / `%USERPROFILE%` (Windows) at CALL time, so
 * swapping those env vars to a per-file temp dir BEFORE any test module loads gives every
 * default-`homedir()` seam a disposable fake home. The fleet-root env overrides
 * (`APIARY_HOME`, `XDG_STATE_HOME`) are cleared too so the ADR-0003 resolution chain is
 * deterministic regardless of the host's environment.
 *
 * This file runs once per test file (vitest `setupFiles`), before the test module is
 * imported. Tests that need a specific home keep injecting their own seams as before;
 * this net only guarantees that anything left on a default seam can never touch the real
 * home. The temp home is removed best-effort after the file's tests complete.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll } from "vitest";

const fakeHome = mkdtempSync(join(tmpdir(), "doctor-test-home-"));

// Swap the home BEFORE any test module (or the code under test) loads. os.homedir()
// re-reads these on every call, so every default seam now anchors on the fake home.
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;

// Make the ADR-0003 fleet-root chain deterministic: no host-level pin or XDG override
// may leak into a test that reads the default `process.env`.
delete process.env.APIARY_HOME;
delete process.env.XDG_STATE_HOME;

afterAll(() => {
	try {
		rmSync(fakeHome, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup: a locked temp file is the OS temp-reaper's problem, never a failure.
	}
});
