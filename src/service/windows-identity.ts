/**
 * Windows LogonTrigger/Principal identity resolution (Windows Scheduled Task fix).
 *
 * Windows 11 25H2 with Administrator Protection enabled refuses to register a per-user
 * Scheduled Task whose `<LogonTrigger>`/`<Principal>` carry NO `<UserId>`: an unscoped
 * "any user" logon trigger requires elevation, so `schtasks /Create /XML` fails with
 * "Access is denied." even for the operator's own per-user task. The proven fix is to
 * scope both elements to the CURRENT user's SID.
 *
 * SID resolution shells out to `whoami.exe` (never bare `whoami`, never a shell) via the
 * injected {@link CommandRunner}, matching the rest of Doctor's no-shell, never-throws
 * command discipline. `<SystemRoot>\System32\whoami.exe` is resolved explicitly (rather
 * than relying on PATH) so the exact binary Windows ships is the one that runs.
 *
 * Fallback ordering when the SID cannot be read/validated:
 *   1. `whoami /user /fo csv /nh` -> parse + validate the SID.
 *   2. `${USERDOMAIN}\${USERNAME}` (XML-escaped by the template) when both are set.
 *   3. Render with NO UserId (the pre-fix behavior) rather than guess.
 *
 * Built-ins only; the whoami exec goes through the injected CommandRunner so this module
 * never shells out itself and a test can script a fake result without touching the OS.
 */

import type { CommandRunner } from "../remediation.js";

/** A Windows SID: `S-1-<authority>(-<sub-authority>)+`. Anything else is not trusted. */
export const SID_PATTERN = /^S-1-\d+(-\d+)+$/;

/** Hard timeout for the whoami probe (a local, built-in command; this is generous). */
const WHOAMI_TIMEOUT_MS = 10_000;

/** The raw facts SID/fallback resolution needs, gathered from the environment at the edge. */
export interface WindowsIdentityFacts {
	/** `%SystemRoot%`, used to build the absolute whoami.exe path (never a bare `whoami`). */
	readonly systemRoot: string;
	/** `%USERDOMAIN%`, used for the domain\user fallback when the SID cannot be read. */
	readonly userDomain?: string;
	/** `%USERNAME%`, used for the domain\user fallback when the SID cannot be read. */
	readonly userName?: string;
}

/** Gather the real {@link WindowsIdentityFacts} from `process.env` (the impure edge). */
export function liveWindowsIdentityFacts(): WindowsIdentityFacts {
	const systemRoot = process.env["SystemRoot"];
	return {
		systemRoot: systemRoot !== undefined && systemRoot.trim() !== "" ? systemRoot : "C:\\Windows",
		userDomain: process.env["USERDOMAIN"],
		userName: process.env["USERNAME"],
	};
}

/**
 * Pull the SID out of `whoami /user /fo csv /nh` output. The line is `"User Name","SID"`
 * (no header row, `/nh`); take the LAST quoted field since the SID is always the final
 * column, so a domain\username containing a comma can never shift which field wins.
 * Returns null when no quoted field is present at all.
 */
function extractLastCsvField(stdout: string): string | null {
	const quoted = [...stdout.matchAll(/"([^"]*)"/g)];
	const last = quoted.length > 0 ? quoted[quoted.length - 1]?.[1] : undefined;
	const candidate = last?.trim();
	return candidate !== undefined && candidate !== "" ? candidate : null;
}

/**
 * Resolve the value to scope a Windows Scheduled Task's `<LogonTrigger>`/`<Principal>`
 * `<UserId>` to. Never throws (the runner never rejects; parsing is defensive).
 *
 * Resolution order: whoami SID (validated against {@link SID_PATTERN}) -> `domain\user`
 * fallback -> `undefined` (render with no UserId, the pre-fix behavior).
 */
export async function resolveWindowsUserId(
	runner: CommandRunner,
	facts: WindowsIdentityFacts,
): Promise<string | undefined> {
	try {
		// Absolute path, never a bare `whoami` (PATH-dependent) and never through a shell.
		const whoamiPath = `${facts.systemRoot}\\System32\\whoami.exe`;
		const result = await runner.run(whoamiPath, ["/user", "/fo", "csv", "/nh"], {
			timeoutMs: WHOAMI_TIMEOUT_MS,
		});
		if (result.ok) {
			const field = extractLastCsvField(result.stdout);
			if (field !== null && SID_PATTERN.test(field)) return field;
		}
	} catch {
		// whoami is best-effort here; fall through to the domain\user fallback below.
	}
	if (
		facts.userDomain !== undefined &&
		facts.userDomain !== "" &&
		facts.userName !== undefined &&
		facts.userName !== ""
	) {
		return `${facts.userDomain}\\${facts.userName}`;
	}
	return undefined;
}
