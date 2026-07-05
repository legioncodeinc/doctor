/**
 * doctor's OWN product-uninstall composition (PRD-003b b-AC-2/b-AC-3/b-AC-4/b-AC-6).
 *
 * `doctor uninstall` (src/cli/dispatch.ts) does three things: stop + deregister the OS
 * service (unchanged - that part IS {@link file://./service/index.js}'s `uninstall()`),
 * delete doctor's OWN entry from the fleet registry (this module, via the generic
 * {@link file://./registry.js}'s `deleteRegistryEntry`), and remove doctor's OWN state dir
 * under the fleet root (this module). It does NOT remove the npm package (that is
 * `doctor purge`'s job, PRD-003c) and never touches another product's dir, the registry
 * file wholesale, or `~/.deeplake` (parent AC-4 / AC-8).
 *
 * Both the pre-check (b-AC-6: "nothing to remove") and the actual removal are exposed as
 * separate, pure-ish, injectable functions so the CLI dispatcher can decide the friendly
 * no-op message BEFORE touching anything (never a partial, confusing removal attempt on
 * an already-clean machine).
 */

import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";

import { resolveApiaryRoot } from "./apiary-root.js";
import { deleteRegistryEntry, defaultRegistryPath, readRegistryFile } from "./registry.js";
import { isForbiddenWipeTarget, resolveInBase } from "./safe-path.js";

/** doctor's own registry/product name, matching {@link import("./service/platform.js").SERVICE_LABEL}'s short name. */
export const DOCTOR_PRODUCT_NAME = "doctor" as const;

/** Environment seams shared by every function in this module (tests inject a fixed home/env/platform). */
export interface ProductUninstallEnv {
	readonly home?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly platform?: NodeJS.Platform;
}

/** Filesystem seams for {@link removeProductState} (tests inject an in-memory fs). */
export interface ProductUninstallFsSeams {
	/** Does a path exist? Default: `existsSync`. */
	readonly exists?: (path: string) => boolean;
	/** Remove a directory recursively. Default: `rmSync(path, { recursive: true, force: true })`.
	 * Node's recursive `rm` never dereferences a symlink it encounters (it unlinks the link
	 * itself rather than entering its target), which is the "never follow a symlink out of
	 * the root" guarantee this module relies on (mirrors c-AC-5's stricter purge contract). */
	readonly removeDir?: (path: string) => void;
}

/** What currently exists for doctor, read-only (b-AC-6's pre-check). */
export interface ProductUninstallState {
	/** True iff a registry entry named {@link DOCTOR_PRODUCT_NAME} is present. */
	readonly registryEntryExists: boolean;
	/** True iff doctor's own state dir (`<fleetRoot>/doctor`) exists. */
	readonly stateDirExists: boolean;
}

/** doctor's own resolved state-dir path, asserted contained under the fleet root (defense in depth). */
function resolveOwnStateDir(env: ProductUninstallEnv): string {
	const home = env.home ?? homedir();
	const platform = env.platform ?? process.platform;
	const root = resolveApiaryRoot(env.env ?? process.env, home, platform);
	// "doctor" is a fixed literal segment (never attacker/env-controlled), so this can only
	// ever resolve to `<root>/doctor` - resolveInBase's containment check is defense in depth
	// consistent with the rest of the codebase's path-safety convention (safe-path.ts).
	return resolveInBase(root, "doctor");
}

/**
 * Read-only pre-check: does doctor have a registry entry, or a state dir, RIGHT NOW? Used
 * by the CLI to decide the b-AC-6 "nothing to remove" friendly no-op BEFORE calling
 * {@link removeProductState} or the service module's uninstall. Fail-soft: any read
 * failure (a malformed registry, an unreadable dir) resolves to "not present" rather than
 * throwing, since a pre-check must never block or crash the uninstall flow.
 */
export function readProductUninstallState(
	options: ProductUninstallEnv & Pick<ProductUninstallFsSeams, "exists"> = {},
): ProductUninstallState {
	const home = options.home ?? homedir();
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const exists = options.exists ?? existsSync;

	let registryEntryExists = false;
	try {
		const entries = readRegistryFile(defaultRegistryPath(home, env, platform), home, env, platform);
		registryEntryExists = (entries ?? []).some((entry) => entry.name === DOCTOR_PRODUCT_NAME);
	} catch {
		// A present-but-malformed registry is doctor's own boot-time concern (surfaced loudly
		// there, compose/index.ts). A pre-check here fails safe to "no entry" rather than
		// throwing mid-uninstall or misreporting "something to remove" from a file we cannot
		// actually parse to confirm.
		registryEntryExists = false;
	}

	let stateDirExists = false;
	try {
		stateDirExists = exists(resolveOwnStateDir({ home, env, platform }));
	} catch {
		stateDirExists = false;
	}
	return { registryEntryExists, stateDirExists };
}

/** What was actually removed (resolved, never thrown). */
export interface ProductUninstallResult {
	/** True iff a registry entry named {@link DOCTOR_PRODUCT_NAME} was present and removed. */
	readonly registryEntryRemoved: boolean;
	/** True iff doctor's own state dir existed and was removed. */
	readonly stateDirRemoved: boolean;
}

/**
 * Delete doctor's registry entry (if any) and remove doctor's own state dir (b-AC-3/b-AC-4).
 * Idempotent + fail-soft: calling this on an already-clean machine is a safe no-op on both
 * counts (`{ registryEntryRemoved: false, stateDirRemoved: false }`), never a throw.
 */
export function removeProductState(
	options: ProductUninstallEnv & ProductUninstallFsSeams = {},
): ProductUninstallResult {
	const home = options.home ?? homedir();
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const exists = options.exists ?? existsSync;
	const removeDir =
		options.removeDir ??
		((path: string): void => {
			rmSync(path, { recursive: true, force: true });
		});

	const { deleted: registryEntryRemoved } = deleteRegistryEntry(DOCTOR_PRODUCT_NAME, { home, env, platform });

	let stateDirRemoved = false;
	try {
		const target = resolveOwnStateDir({ home, env, platform });
		// Defense in depth (parent AC-8): even though the target is `<fleetRoot>/doctor`
		// (a fixed literal under the resolved root), refuse the recursive delete outright
		// if an env-overridden root made it the home dir, an ancestor of home, or a
		// filesystem root. Mirrors purge's fleet-root guard; see safe-path.ts.
		if (isForbiddenWipeTarget(target, home)) {
			return { registryEntryRemoved, stateDirRemoved: false };
		}
		if (exists(target)) {
			removeDir(target);
			stateDirRemoved = true;
		}
	} catch {
		// A containment violation or a failed removal must never crash `uninstall`; the CLI
		// reports "no state dir found/removed" either way, which is honest enough here (a
		// stuck removal is surfaced via the service-uninstall result, the more actionable line).
		stateDirRemoved = false;
	}
	return { registryEntryRemoved, stateDirRemoved };
}
