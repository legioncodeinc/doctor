import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type CanonicalizePath = (path: string) => string;

/**
 * Decide whether this module is the process entrypoint without trusting textual path equality.
 * macOS exposes `/var` through the `/private/var` symlink, and package-manager bins may also be
 * invoked through symlinks. Canonicalizing both existing files keeps those legitimate entrypoints
 * executable while imports from a different script remain side-effect free.
 */
export function isDirectInvocation(
	invokedPath: string | undefined,
	moduleUrl: string,
	canonicalize: CanonicalizePath = realpathSync,
): boolean {
	if (invokedPath === undefined) return false;
	const resolvedInvocation = resolve(invokedPath);
	try {
		return canonicalize(resolvedInvocation) === canonicalize(fileURLToPath(moduleUrl));
	} catch {
		// Preserve the previous safe behavior when either path disappears between lookup and use.
		return moduleUrl === pathToFileURL(resolvedInvocation).href;
	}
}
