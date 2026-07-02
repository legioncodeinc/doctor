/**
 * Tail the local incident log for the `logs` command (PRD-064f Scope).
 *
 * Reads the last N lines of `incidents.ndjson` from Doctor's workspace dir. The
 * file is append-only NDJSON written by src/incidents.ts; this reader is read-only and
 * defensive: a missing file (no incidents yet) resolves to an empty list, never a throw.
 *
 * It does NOT parse/validate each line - `logs` shows the raw NDJSON so an operator sees
 * exactly what was recorded. Built-ins only: node:fs + node:path. Fail-soft on file state
 * (a missing/unreadable shard yields an empty list). The ONE exception is an explicit
 * `--daemon <name>` that is not a registered daemon: that is invalid input, not a file state,
 * and is rejected loudly (see the registry-membership guard below) so a bad name can never
 * select an out-of-registry path. The dispatcher catches it and maps it to a non-zero exit.
 */

import { readFileSync } from "node:fs";

import { resolveInBase } from "../safe-path.js";
import type { TailIncidentsFn } from "./context.js";

interface PrefixedIncidentLine {
	readonly daemon: string;
	readonly line: string;
	readonly closedAtMs: number | null;
	readonly order: number;
}

function readTailLines(workspaceDir: string, fileName: string, limit: number): readonly string[] {
	try {
		const filePath = resolveInBase(workspaceDir, fileName);
		const raw = readFileSync(filePath, "utf8");
		const lines = raw.split("\n").filter((l) => l.trim() !== "");
		return lines.slice(-limit);
	} catch {
		// Missing file (no incidents) or unreadable dir: nothing to show.
		return [];
	}
}

function parseClosedAtMs(line: string): number | null {
	try {
		const parsed = JSON.parse(line) as unknown;
		if (parsed !== null && typeof parsed === "object") {
			const closedAt = (parsed as Record<string, unknown>).closedAt;
			if (typeof closedAt === "string" && closedAt !== "") {
				const ms = Date.parse(closedAt);
				return Number.isFinite(ms) ? ms : null;
			}
		}
	} catch {
		// Raw line may not be valid JSON; keep order-only fallback.
	}
	return null;
}

/** Build a {@link TailIncidentsFn} bound to a workspace dir. */
export function createIncidentsTail(workspaceDir: string, daemonNames: readonly string[]): TailIncidentsFn {
	const uniqueDaemonNames = [...new Set(daemonNames)];

	return async (limit: number, daemonName?: string): Promise<readonly string[]> => {
		const n = Number.isInteger(limit) && limit > 0 ? limit : 20;

		if (daemonName !== undefined) {
			// SECURITY (path selection, PRD-004a): `--daemon <name>` is arbitrary CLI input that is
			// interpolated into the `incidents-<name>.ndjson` filename below. Only names that exist in
			// the registry are accepted, so an unregistered or path-shaped value (e.g. `../../etc/foo`)
			// can never select a file outside the known per-daemon shards. This is defense in depth on
			// top of resolveInBase containment: an unknown name is rejected LOUDLY here rather than
			// silently reading a wrong (or empty) path. The registry names are themselves validated
			// filename-safe at parse time (src/registry.ts coerceName), so membership implies safety.
			if (!uniqueDaemonNames.includes(daemonName)) {
				throw new Error(
					`unknown daemon "${daemonName}"; known daemons: ${uniqueDaemonNames.join(", ") || "(none)"}`,
				);
			}
			return readTailLines(workspaceDir, `incidents-${daemonName}.ndjson`, n);
		}

		const prefixed: PrefixedIncidentLine[] = [];
		let order = 0;
		for (const name of uniqueDaemonNames) {
			const lines = readTailLines(workspaceDir, `incidents-${name}.ndjson`, n);
			for (const line of lines) {
				prefixed.push({
					daemon: name,
					line,
					closedAtMs: parseClosedAtMs(line),
					order,
				});
				order += 1;
			}
		}
		prefixed.sort((a, b) => {
			if (a.closedAtMs !== null && b.closedAtMs !== null && a.closedAtMs !== b.closedAtMs) {
				return a.closedAtMs - b.closedAtMs;
			}
			return a.order - b.order;
		});
		return prefixed.map((entry) => `[${entry.daemon}] ${entry.line}`);
	};
}
