#!/usr/bin/env node
/**
 * The `doctor` bin shebang entry (PRD-064f).
 *
 * The thinnest possible wrapper: parse argv (stripping `node` + the script path), run the
 * CLI, and exit with the returned code. ALL logic lives in {@link runCli} so it is unit
 * testable without spawning a process; this file is just the executable boundary the
 * later-wave esbuild bundle compiles to `bundle/cli.js` (the `bin` target in package.json).
 *
 * Crash-safe: runCli never throws (it catches and maps to exit 1), so this entry cannot
 * die with an unhandled stack trace. Built-ins only.
 *
 * ── Clean exit for ONE-SHOT commands (Windows `UV_HANDLE_CLOSING` fix) ───────────────────
 * A one-shot command (`status`, `diagnose`, `update --check`, `logs`, `self-update`) does
 * network work through the global `fetch`, which is undici-backed and leaves keep-alive
 * sockets + a pool timer open after the request. A bare `process.exit()` on the fast
 * read-only path runs while those handles are mid-lifecycle and trips a libuv assertion on
 * Windows. {@link finalizeOneShot} closes the fetch pool first, then exits deterministically.
 *
 * The long-running `run` watchdog is the SOLE exception: it must NOT force-exit through the
 * one-shot finalizer. It returns from {@link runCli} only after SIGTERM/SIGINT has already
 * driven its graceful `doctor.stop()`, so a plain exit with its code is correct there.
 */

import { runCli } from "./index.js";
import { isDirectInvocation } from "./direct-invocation.js";
import { finalizeOneShot, isOneShot } from "./shutdown.js";

// Programmatic conformance tests may import the packed artifact and inject a hermetic
// context into the real dispatcher. Importing the executable must never run production
// assembly as a side effect; direct bin execution remains the only path into runCli.
export { dispatch } from "./dispatch.js";

const invokedPath = process.argv[1];
const directlyInvoked = isDirectInvocation(invokedPath, import.meta.url);

if (directlyInvoked) {
	const argv = process.argv.slice(2);
	const code = await runCli(argv);

	if (!isOneShot(argv)) {
		// The `run` watchdog already stopped its own loops; exit plainly (do NOT run the one-shot
		// fetch-pool teardown - the service lifecycle owns this process's shutdown).
		process.exit(code);
	}

	// One-shot path: tear down the fetch connection pool, release lingering handles, set the exit
	// code, and let the process exit naturally (a bounded backstop force-exits only if the loop
	// refuses to drain). Calling process.exit() directly here is what trips the Windows
	// UV_HANDLE_CLOSING assertion, so the happy path never forces it.
	await finalizeOneShot(code);
}
