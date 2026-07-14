/**
 * `self-update`: THE ONLY path that updates Doctor's own package (PRD-064f AC-064f.5,
 * parent AC-6).
 *
 * "Never surprise-update itself" is sacred (PRD-064 design principle / parent AC-6):
 * Doctor is built NOT to need updating, and no autonomous code path - not the watch
 * loop, not rung 2, not the 064e auto-update engine - ever installs
 * `@legioncodeinc/doctor`. The auto-update engine's package is HARD-WIRED to the
 * PRIMARY daemon (`@legioncodeinc/honeycomb`); it cannot target Doctor. This module is
 * the single, deliberate exception, reachable only by the explicit `doctor self-update`
 * command.
 *
 * It runs `npm i -g @legioncodeinc/doctor@latest` through the SAME injected
 * {@link CommandRunner} the rungs use (no shell, argv array, never throws). Crash-safe: a
 * failed install is a returned message, never a thrown error. Built-ins only.
 */

import type { CommandRunner } from "../rungs/command-runner.js";
import type { Logger } from "../logger.js";
import { DOCTOR_PACKAGE } from "../version.js";
import { DOCTOR_VERSION } from "../version.js";

/** Construction deps for {@link createSelfUpdate}. */
export interface SelfUpdateDeps {
	/** The injected command runner (the only thing that touches npm). */
	readonly runner: CommandRunner;
	/** Logger for the self-update lifecycle. */
	readonly logger: Logger;
	/** The dist-tag / spec to install (default `latest`). */
	readonly tag?: string;
	/** Per-install timeout in ms (default: the runner's own default). */
	readonly installTimeoutMs?: number;
	/** Restart the installed Doctor service after replacement. Enables verified transaction mode. */
	readonly restartService?: () => Promise<boolean>;
	/** Verify the restarted Doctor service. Enables rollback when verification fails. */
	readonly verifyHealthy?: () => Promise<boolean>;
}

/** Stable action verb for logs. */
const ACTION = "self-update";
const EXACT_SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export function parseApprovedVersion(stdout: string): string | null {
	let candidate = stdout.trim();
	try {
		const parsed: unknown = JSON.parse(candidate);
		if (typeof parsed !== "string") return null;
		candidate = parsed.trim();
	} catch {
		// Older npm clients may emit plain text. It is still accepted only after exact validation.
	}
	return EXACT_SEMVER.test(candidate) ? candidate : null;
}

/**
 * Build the self-update action. Returns a human-readable result line (success or a
 * scrubbed failure detail); NEVER throws. Calling this is the ONLY way
 * `@legioncodeinc/doctor` is ever installed.
 */
export function createSelfUpdate(deps: SelfUpdateDeps): () => Promise<string> {
	const tag = deps.tag ?? "latest";
	return async (): Promise<string> => {
		if (tag !== "latest" && !EXACT_SEMVER.test(tag)) {
			return "Doctor update failed before install: invalid approved release channel.";
		}
		let target = tag;
		if (deps.verifyHealthy !== undefined) {
			const resolved = await deps.runner.run("npm", ["view", `${DOCTOR_PACKAGE}@${tag}`, "version", "--json"], {
				timeoutMs: 15_000,
			});
			if (!resolved.ok) return `Doctor update failed before install: ${resolved.detail ?? "release resolution failed"}.`;
			const approved = parseApprovedVersion(resolved.stdout);
			if (approved === null) return "Doctor update failed before install: invalid release metadata.";
			target = approved;
		}
		if (target === DOCTOR_VERSION) return `Doctor is already up to date (${DOCTOR_VERSION}).`;
		const spec = `${DOCTOR_PACKAGE}@${target}`;
		deps.logger.info(`${ACTION}.start`, { spec });
		const result = await deps.runner.run(
			"npm",
			["install", "-g", spec],
			deps.installTimeoutMs !== undefined ? { timeoutMs: deps.installTimeoutMs } : undefined,
		);
		if (result.ok) {
			if (deps.verifyHealthy !== undefined) {
				const restarted = await (deps.restartService?.() ?? Promise.resolve(false));
				const healthy = restarted && (await deps.verifyHealthy());
				if (!healthy) {
					const rollbackSpec = `${DOCTOR_PACKAGE}@${DOCTOR_VERSION}`;
					const rollback = await deps.runner.run("npm", ["install", "-g", rollbackSpec], deps.installTimeoutMs !== undefined ? { timeoutMs: deps.installTimeoutMs } : undefined);
					const rollbackRestarted = rollback.ok && (await (deps.restartService?.() ?? Promise.resolve(false)));
					const rollbackHealthy = rollbackRestarted && (await deps.verifyHealthy());
					return rollbackHealthy
						? `Doctor update failed health verification and rolled back: ${target} -> ${DOCTOR_VERSION}.`
						: `Doctor update failed health verification; rollback to ${DOCTOR_VERSION} did not recover Doctor and manual repair is required.`;
				}
			}
			deps.logger.info(`${ACTION}.ok`, { spec });
			return `Doctor updated: ${DOCTOR_VERSION} -> ${target}.`;
		}
		deps.logger.error(`${ACTION}.failed`, { code: result.code, detail: result.detail });
		return `Doctor self-update failed: ${result.detail ?? `npm exited ${result.code ?? "non-zero"}`}.`;
	};
}
