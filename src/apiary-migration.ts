/**
 * The one-time, boot-time Apiary state migrations (PRD-004a workspace move + PRD-004b
 * coordination-surface move), implementing fleet ADR-0003's "on first boot after upgrade,
 * each product performs a one-time migration ... move (or copy then mark) the legacy files
 * into the new layout".
 *
 * doctor migrates TWO things on boot:
 *   1. its OWN workspace `~/.honeycomb/doctor/` -> `<root>/doctor/` (this module), and
 *   2. the fleet-shared registry `~/.honeycomb/doctor.daemons.json` -> `<root>/registry.json`
 *      ({@link migrateRegistry} in `registry.ts`, orchestrated here).
 *
 * The device.json and install-id relocations are copy-on-read (a legacy record is copied to
 * the new location the first time it is read; see `device-id.ts` / `telemetry/capture.ts`),
 * so they need no separate boot step.
 *
 * Every migration is idempotent, additive, and BEST-EFFORT: it never deletes a legacy file it
 * did not successfully migrate, and it never throws (design principle 1, "incapable of
 * crashing"). A partially-migrated fleet keeps working because readers fall back to the legacy
 * location until the new path exists.
 *
 * Built-ins only: node:fs + node:path (via the injected seams / the helpers).
 */

import { cpSync, existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { doctorStateDir, legacyHoneycombRoot, resolveApiaryRoot } from "./apiary-root.js";
import type { Logger } from "./logger.js";
import { silentLogger } from "./logger.js";
import { migrateRegistry, type RegistryMigrationResult } from "./registry.js";

/**
 * The install lock is deliberately NOT migrated as a live file (PRD-004a): a lock present in
 * the legacy dir is left in place, and new acquisitions happen only at the new workspace path
 * (`install-lock.ts` already receives the workspace dir injected, so it follows the new dir).
 */
const NOT_MIGRATED = new Set(["install.lock"]);

/** The filesystem seams the workspace migration uses (injected so tests are hermetic). */
export interface WorkspaceMigrationSeams {
	/** Does a path exist? Default: `existsSync`. */
	readonly exists?: (path: string) => boolean;
	/** List a directory's entry names. Default: `readdirSync`. */
	readonly readdir?: (path: string) => string[];
	/** Create a directory (recursive). Default: `mkdirSync(path, { recursive: true })`. */
	readonly mkdir?: (path: string) => void;
	/** Move one entry (rename). Default: `renameSync`. Tests inject a throwing move. */
	readonly move?: (src: string, dst: string) => void;
	/** Copy one entry (recursive, cross-device fallback). Default: `cpSync(..., { recursive: true })`. */
	readonly copy?: (src: string, dst: string) => void;
}

/** Options for {@link migrateDoctorWorkspace}. */
export interface WorkspaceMigrationOptions extends WorkspaceMigrationSeams {
	/** The home dir the roots are anchored under (default real `~`). */
	readonly home?: string;
	/** The env the fleet-root chain + the workspace-override guard read (default `process.env`). */
	readonly env?: NodeJS.ProcessEnv;
	/** The platform the fleet-root chain reads (default `process.platform`). */
	readonly platform?: NodeJS.Platform;
	/** Logger for migration outcomes (default silent; the boot path injects the real logger). */
	readonly logger?: Logger;
}

/** The outcome of {@link migrateDoctorWorkspace} (resolved, never thrown). */
export interface WorkspaceMigrationResult {
	/** True iff at least one workspace entry was moved this run. */
	readonly migrated: boolean;
	/** Why the migration did or did not run (audit trail). */
	readonly reason: "no-legacy" | "new-present" | "legacy-unreadable" | "workspace-overridden" | "error" | "migrated";
	/** The entry names moved into the new workspace this run. */
	readonly moved: string[];
	/** The entry names that failed to migrate and were LEFT in the legacy workspace (a-AC-6). */
	readonly failed: string[];
}

/**
 * Migrate doctor's own workspace files from `~/.honeycomb/doctor/` to `<root>/doctor/`
 * (PRD-004a a-AC-4/5/6), one time, idempotently, additively:
 *
 *   - `DOCTOR_WORKSPACE_DIR` set and non-blank -> SKIPPED entirely. The operator pinned the
 *     workspace explicitly (a-AC-7 honors it for every read/write), so moving files out of
 *     `~/.honeycomb/doctor/` would displace live state from under the configured workspace
 *     (for example an operator who pinned the legacy location on purpose). The skip is logged.
 *   - no legacy workspace          -> nothing to do.
 *   - new workspace already has artifacts -> no-op (idempotent, a-AC-5).
 *   - otherwise move each legacy entry (rename, cross-device copy fallback) into the new dir;
 *     an entry that fails BOTH is LEFT in the legacy dir and recorded in `failed` (a-AC-6),
 *     never deleted, and doctor continues (the coordination-surface readers fall back to the
 *     legacy location; see registry/device-id/capture).
 *
 * The install lock is not migrated as a live file (see {@link NOT_MIGRATED}). TOTAL: any
 * unexpected failure resolves to `{ reason: "error" }` rather than throwing.
 */
export function migrateDoctorWorkspace(options: WorkspaceMigrationOptions = {}): WorkspaceMigrationResult {
	const home = options.home ?? homedir();
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const logger = options.logger ?? silentLogger;

	// Workspace-override guard (QA Warning 2): when the operator pinned the workspace via
	// DOCTOR_WORKSPACE_DIR, every read/write already honors that dir (config.ts, a-AC-7), so
	// the default-location migration must not move state around behind the operator's back.
	const workspaceOverride = env.DOCTOR_WORKSPACE_DIR;
	if (workspaceOverride !== undefined && workspaceOverride.trim() !== "") {
		logger.info("apiary_migration.workspace_skipped_override", { workspaceDir: workspaceOverride.trim() });
		return { migrated: false, reason: "workspace-overridden", moved: [], failed: [] };
	}
	const exists = options.exists ?? existsSync;
	const readdir = options.readdir ?? ((path: string): string[] => readdirSync(path));
	const mkdir =
		options.mkdir ??
		((path: string): void => {
			mkdirSync(path, { recursive: true });
		});
	const move = options.move ?? renameSync;
	const copy = options.copy ?? ((src: string, dst: string): void => cpSync(src, dst, { recursive: true }));

	const newDir = doctorStateDir(resolveApiaryRoot(env, home, platform));
	// LEGACY-HONEYCOMB-WINDOW: the legacy workspace, removed when the window closes.
	const legacyDir = join(legacyHoneycombRoot(home), "doctor");
	const moved: string[] = [];
	const failed: string[] = [];

	try {
		if (!exists(legacyDir)) return { migrated: false, reason: "no-legacy", moved, failed };
		// Idempotent: the new workspace already carrying artifacts means the migration ran.
		if (exists(newDir) && readdir(newDir).length > 0) {
			return { migrated: false, reason: "new-present", moved, failed };
		}

		let names: string[];
		try {
			names = readdir(legacyDir);
		} catch {
			return { migrated: false, reason: "legacy-unreadable", moved, failed };
		}

		mkdir(newDir);
		for (const name of names) {
			if (NOT_MIGRATED.has(name)) continue;
			const src = join(legacyDir, name);
			const dst = join(newDir, name);
			try {
				move(src, dst);
				moved.push(name);
			} catch {
				// A rename can fail across devices or on a locked file: try a recursive copy,
				// leaving the legacy file in place (never delete what was not migrated).
				try {
					copy(src, dst);
					moved.push(name);
				} catch {
					// Left in place; doctor reads it via the legacy fallback (a-AC-6). No throw.
					failed.push(name);
				}
			}
		}
		return { migrated: moved.length > 0, reason: "migrated", moved, failed };
	} catch {
		// TOTAL: any unexpected fs failure must never take the watchdog down.
		return { migrated: false, reason: "error", moved, failed };
	}
}

/** Options for {@link runApiaryMigrations}: the fleet-root seams shared by both migrations. */
export interface ApiaryMigrationOptions {
	/** The home dir the roots are anchored under (default real `~`). */
	readonly home?: string;
	/** The env the fleet-root chain reads (default `process.env`). */
	readonly env?: NodeJS.ProcessEnv;
	/** The platform the fleet-root chain reads (default `process.platform`). */
	readonly platform?: NodeJS.Platform;
	/** Logger for migration outcomes (default silent; the boot path injects the real logger). */
	readonly logger?: Logger;
}

/** The combined outcome of {@link runApiaryMigrations}. */
export interface ApiaryMigrationsResult {
	/** doctor's own workspace migration result (PRD-004a). */
	readonly workspace: WorkspaceMigrationResult;
	/** The fleet-shared registry migration result (PRD-004b). */
	readonly registry: RegistryMigrationResult;
}

/**
 * Run every one-time boot migration doctor owns (PRD-004): its own workspace (004a) and the
 * fleet-shared registry (004b). Both are best-effort and TOTAL; a failure in either is
 * captured in the returned result rather than thrown, so wiring this into boot can never
 * destabilize the watchdog. device.json and install-id are copy-on-read and need no step here.
 */
export function runApiaryMigrations(options: ApiaryMigrationOptions = {}): ApiaryMigrationsResult {
	const workspace = migrateDoctorWorkspace(options);
	let registry: RegistryMigrationResult;
	try {
		registry = migrateRegistry(options);
	} catch {
		// migrateRegistry is itself total; this is defense in depth so boot never throws.
		registry = { migrated: false, reason: "copy-failed" };
	}
	return { workspace, registry };
}
