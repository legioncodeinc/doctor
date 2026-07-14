import {
	composeProductManifest,
	resolveCommand as resolveManifestCommand,
	type CommandSpec,
	type ProductManifest,
} from "@legioncodeinc/cli-kit";

export type CommandName =
	| "start"
	| "stop"
	| "restart"
	| "status"
	| "logs"
	| "install"
	| "uninstall"
	| "service-install"
	| "service-uninstall"
	| "update"
	| "telemetry"
	| "run"
	| "diagnose"
	| "heal"
	| "reinstall"
	| "uninstall-hivemind"
	| "daemon-update"
	| "self-update"
	| "purge"
	| "incidents"
	| "help";

type ProductCommand = Omit<CommandSpec, "group">;

const productCommand = (
	name: CommandName,
	summary: string,
	destructive = false,
): ProductCommand => ({ name, summary, destructive, idempotent: !destructive, json: true });

const PRODUCT_COMMANDS: readonly ProductCommand[] = [
	productCommand("run", "Run the watchdog service entry"),
	productCommand("diagnose", "Classify supervised-service health without changing it"),
	productCommand("heal", "Run the remediation ladder once"),
	productCommand("reinstall", "Reinstall the supervised primary daemon", true),
	productCommand("uninstall-hivemind", "Remove a conflicting Hivemind package", true),
	productCommand("daemon-update", "Update the supervised primary daemon"),
	productCommand("self-update", "Deprecated alias for the canonical update command"),
	productCommand("purge", "Remove all Apiary products and state", true),
	productCommand("incidents", "Read Doctor's fleet incident records"),
	productCommand("help", "Show this help"),
];

/** Shared baseline plus Doctor-only commands. Doctor intentionally omits register. */
export const DOCTOR_MANIFEST: ProductManifest = composeProductManifest("doctor", PRODUCT_COMMANDS);

export interface CommandMenuEntry {
	readonly invocation: CommandName;
	readonly summary: string;
}

/** Compatibility export retained for callers which inspect the old menu constant. */
export const COMMAND_MENU: readonly CommandMenuEntry[] = DOCTOR_MANIFEST.commands.map((entry) => ({
	invocation: entry.name as CommandName,
	summary: entry.summary,
}));

export const KNOWN_COMMANDS: ReadonlySet<string> = new Set([
	...DOCTOR_MANIFEST.commands.flatMap((entry) => [entry.name, ...(entry.aliases?.map(({ name }) => name) ?? [])]),
	"help",
]);

export interface ResolvedDoctorCommand {
	readonly command: CommandName;
	readonly deprecatedAlias?: string;
}

export function resolveCommandDetailed(token: string | undefined): ResolvedDoctorCommand | null {
	if (token === undefined || token.trim() === "") return null;
	if (token === "help") return { command: "help" };
	const resolution = resolveManifestCommand(DOCTOR_MANIFEST, token.trim());
	if (!resolution.ok) return null;
	return {
		command: resolution.canonicalName as CommandName,
		...(resolution.deprecatedAlias === undefined ? {} : { deprecatedAlias: resolution.deprecatedAlias }),
	};
}

/** Legacy lookup shape retained for existing Doctor integrations. */
export function resolveCommand(token: string | undefined): CommandName | null {
	return resolveCommandDetailed(token)?.command ?? null;
}
