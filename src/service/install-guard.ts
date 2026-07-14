/**
 * The `--no-doctor` install-time opt-out guard (PRD-064b, OD-5 / parent AC-10).
 *
 * `--no-doctor` is the ONLY install-time switch. When it is passed (as a flag) OR set
 * via the env equivalent (`HONEYCOMB_NO_DOCTOR=1`), the bootstrap installer must NOT
 * install the `@legioncodeinc/doctor` package and must NOT register its OS service - so
 * NO Doctor process ever runs (parent AC-10).
 *
 * The pre-rename spellings (`--no-hivedoctor` / `HONEYCOMB_NO_HIVEDOCTOR`) stay accepted
 * as aliases: the flag shipped in public installer documentation before the July 2026
 * repository renames, so an older documented invocation must keep opting out.
 *
 * This pure decision lives here so it is the single source of truth the two shell installers
 * (`scripts/install/install.sh`, `install.ps1`) mirror, and so it is unit-testable without a
 * shell. The shell scripts implement EXACTLY this contract: skip the bootstrap when the flag
 * or the env opt-out is present. Finer toggles (telemetry off, auto-update off, observe-only)
 * live in the dashboard, never as install flags (OD-5).
 *
 * Built-ins only; pure function.
 */

/** The single install-time opt-out flag (OD-5). */
export const NO_DOCTOR_FLAG = "--no-doctor" as const;

/** The pre-rename spelling of the opt-out flag, accepted as an alias. */
export const NO_HIVEDOCTOR_FLAG = "--no-hivedoctor" as const;

/** The env equivalent the shell installers also honor. */
export const NO_DOCTOR_ENV = "HONEYCOMB_NO_DOCTOR" as const;

/** The pre-rename spelling of the env opt-out, accepted as an alias. */
export const NO_HIVEDOCTOR_ENV = "HONEYCOMB_NO_HIVEDOCTOR" as const;

/** Inputs to the guard: the install argv tail + the process env. */
export interface InstallGuardInput {
	/** The argv passed to the installer (e.g. `["--ref", "mario", "--no-doctor"]`). */
	readonly argv: readonly string[];
	/** The process env (the `HONEYCOMB_NO_DOCTOR` opt-out is read here). */
	readonly env: NodeJS.ProcessEnv;
}

/** True when the raw env value spells an opt-out: "1" or "true" (case-insensitive). */
function isEnvOptOut(raw: string | undefined): boolean {
	if (raw === undefined) return false;
	const v = raw.trim().toLowerCase();
	return v === "1" || v === "true";
}

/**
 * Decide whether the Doctor bootstrap (npm install + `doctor service-install`) should
 * run. Returns `false` when the user opted out via the flag or the env equivalent (canonical
 * or pre-rename spelling); `true` (the default) otherwise. The env value is treated as opt-out
 * when it is "1" or "true" (case-insensitive), matching the daemon's other env-boolean
 * conventions.
 */
export function shouldBootstrapDoctor(input: InstallGuardInput): boolean {
	// Flag form: `--no-doctor` (or the pre-rename `--no-hivedoctor`) anywhere in the argv.
	if (input.argv.includes(NO_DOCTOR_FLAG)) return false;
	if (input.argv.includes(NO_HIVEDOCTOR_FLAG)) return false;

	// Env form: HONEYCOMB_NO_DOCTOR=1 / true (case-insensitive), or the pre-rename spelling.
	if (isEnvOptOut(input.env[NO_DOCTOR_ENV])) return false;
	if (isEnvOptOut(input.env[NO_HIVEDOCTOR_ENV])) return false;

	return true;
}
