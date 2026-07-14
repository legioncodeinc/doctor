/**
 * The hand-rolled command dispatcher (PRD-064f Scope command table; AC-064f.1 .. .6).
 *
 * One `dispatch(argv, ctx)` maps the parsed command to its handler. There is NO CLI
 * framework (technical consideration: built-ins only), just a switch over the
 * single-sourced {@link CommandName} set. Every handler runs against the injected
 * {@link CliContext} so the whole surface is hermetic and testable: output is captured,
 * the confirm prompt is scripted, and every external action is an injected dep.
 *
 * The dispatcher itself is crash-safe (parent AC-8 spirit, carried into the CLI): a
 * handler that throws is caught, reported on stderr, and mapped to a non-zero exit code,
 * never a stack-trace crash. It returns an exit code rather than calling `process.exit`,
 * so a test asserts the code without the process dying.
 *
 * Binding rulings enforced here:
 *   - AC-064f.3 `diagnose` takes NO action: it only reads the classification + decides the
 *     rung; it NEVER calls `ladder.run`.
 *   - AC-064f.4 `uninstall-hivemind` confirms before acting; there is NO `clear-credentials`
 *     command anywhere in this switch (deferred, OD-4).
 *   - AC-064f.5 `self-update` is the ONLY case that calls `deps.update.selfUpdate`.
 */

import { parseArgs, hasFlag, type ParsedArgs } from "./arg-parse.js";
import { renderBannerWithMenu } from "./banner.js";
import { resolveCommandDetailed, type CommandName } from "./command-table.js";
import { DOCTOR_VERSION } from "../version.js";
import type { CliContext, ServiceState } from "./context.js";
import { SERVICE_NOT_AVAILABLE } from "./service-stub.js";
import type { HealthClassification } from "../health-probe.js";
import {
	formatStatus,
	formatTelemetrySummary,
	parseLogTailOptions,
	redactLogSecrets,
	renderVersion,
	renderVersionJson,
	type ServiceStatus,
} from "@legioncodeinc/cli-kit";

/** Exit codes the dispatcher returns. 0 = ok; 1 = handler error; 2 = user declined a gate. */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_DECLINED = 2;

type OptionKind = "boolean" | "value";

const GLOBAL_OPTIONS: Readonly<Record<string, OptionKind>> = Object.freeze({
	help: "boolean",
	version: "boolean",
	json: "boolean",
	"no-color": "boolean",
});

const COMMAND_OPTIONS: Readonly<Record<CommandName, Readonly<Record<string, OptionKind>>>> = Object.freeze({
	start: {}, stop: {}, restart: {}, status: {}, install: {}, "service-install": {},
	"service-uninstall": {}, telemetry: {}, run: {}, diagnose: {}, "self-update": {}, help: {},
	logs: { lines: "value", since: "value", "no-follow": "boolean" },
	uninstall: { yes: "boolean" },
	update: { check: "boolean" },
	heal: { yes: "boolean" },
	reinstall: { yes: "boolean" },
	"uninstall-hivemind": { yes: "boolean" },
	"daemon-update": { check: "boolean" },
	purge: { yes: "boolean" },
	incidents: { lines: "value", daemon: "value" },
});

function optionArgv(parsed: ParsedArgs, ignored: ReadonlySet<string> = new Set()): string[] {
	const result: string[] = [];
	for (const [name, value] of Object.entries(parsed.flags)) {
		if (ignored.has(name)) continue;
		result.push(`--${name}`);
		if (typeof value === "string") result.push(value);
	}
	result.push(...parsed.positionals);
	return result;
}

function validateInvocation(command: CommandName, parsed: ParsedArgs): string | null {
	if (parsed.positionals.length > 0) {
		return `${command} does not accept positional arguments: ${parsed.positionals.join(" ")}`;
	}
	const commandOptions = COMMAND_OPTIONS[command];
	for (const [name, value] of Object.entries(parsed.flags)) {
		const kind = commandOptions[name] ?? GLOBAL_OPTIONS[name];
		if (kind === undefined) return `Unknown option for ${command}: --${name}`;
		if (kind === "boolean" && value !== true) return `Option --${name} does not accept a value.`;
		if (kind === "value" && (typeof value !== "string" || value.trim() === "")) {
			return `Option --${name} requires a value.`;
		}
	}
	if (command === "logs") {
		const result = parseLogTailOptions(optionArgv(parsed, new Set(Object.keys(GLOBAL_OPTIONS))));
		if (!result.ok) return result.error;
	}
	if (command === "incidents") {
		const lines = parsed.flags["lines"];
		if (lines !== undefined && (typeof lines !== "string" || !/^\d+$/u.test(lines) || Number(lines) < 1)) {
			return "--lines must be a positive integer.";
		}
	}
	return null;
}

function validateBareInvocation(parsed: ParsedArgs): string | null {
	for (const [name, value] of Object.entries(parsed.flags)) {
		const kind = GLOBAL_OPTIONS[name];
		if (kind === undefined) return `Unknown global option: --${name}`;
		if (kind === "boolean" && value !== true) return `Option --${name} does not accept a value.`;
	}
	return null;
}

function usageFailure(ctx: CliContext, command: string, message: string, json: boolean): number {
	const full = `${message} Run 'doctor ${command || "--help"} --help' for usage.`;
	if (json) ctx.io.out(JSON.stringify({ product: "doctor", command, ok: false, message: full }));
	else ctx.io.err(ctx.colors.red(full));
	return EXIT_DECLINED;
}

interface DoctorStatusResult {
	readonly status: ServiceStatus;
	readonly daemonDetails: readonly string[];
}

/** Map a classification to a short human label for `status` / `diagnose`. */
function healthLabel(c: HealthClassification): string {
	switch (c.kind) {
		case "ok":
			return "ok";
		case "degraded":
			return "degraded";
		case "unreachable-refused":
			return "unreachable (connection refused)";
		case "unreachable-timeout":
			return "unreachable (timed out / wedged)";
		default:
			return "unknown";
	}
}

/** Map a classification to the coarse health used for the recommended-rung explanation. */
function isUnhealthy(c: HealthClassification): boolean {
	return c.kind !== "ok";
}

/** `status` (AC-064f.2 / AC-064f.6): health, service state, both versions, last heal, opt-out. */
async function inspectStatus(ctx: CliContext): Promise<DoctorStatusResult> {
	const { deps } = ctx;
	const daemonSources = deps.statusDaemons();
	// The service state prefers the bounded ASYNC probe (wired to serviceStatus in the composition
	// root, IRD-192 AC-5) so a registered task reports its real state, never a hardcoded "unknown".
	// The probe is bounded by SERVICE_COMMAND_TIMEOUT_MS in the wiring; it never blocks indefinitely.
	// The sync serviceState() seam is the test-harness fallback when the async probe is not injected.
	const serviceState = deps.serviceStateAsync !== undefined ? await deps.serviceStateAsync() : deps.serviceState();

	let installed = serviceState !== "unknown";
	try {
		if (deps.productUninstall !== undefined) installed = await deps.productUninstall.isServiceRegistered();
	} catch {
		installed = serviceState !== "unknown";
	}
	const daemonDetails: string[] = [];
	for (const daemon of daemonSources) {
		let classification: HealthClassification = { kind: "unreachable-timeout" };
		try {
			classification = await daemon.probe();
		} catch {
			// A wedged daemon must not abort reporting for other daemons.
		}

		let daemonVersion: string | null = null;
		try {
			daemonVersion = await daemon.readDaemonVersion();
		} catch {
			daemonVersion = null;
		}

		let state: { lastHealAt: string | null; lastKnownHealth: string } = {
			lastHealAt: null,
			lastKnownHealth: "unknown",
		};
		try {
			state = daemon.readStatusState();
		} catch {
			state = { lastHealAt: null, lastKnownHealth: "unknown" };
		}

		daemonDetails.push(
			`Daemon: ${daemon.name}\n  Daemon health: ${healthLabel(classification)}\n  Daemon version: ${daemonVersion ?? "unknown (daemon unreachable)"}\n  Last heal: ${state.lastHealAt ?? "never"}`,
		);
	}

	// Opt-out flags - honest about which layer disabled auto-update (OD-5 / AC-064e.4).
	const autoUpdate = deps.optOut.autoUpdateDisabled ? `disabled (${deps.optOut.source})` : "enabled";
	daemonDetails.push(`Auto-update: ${autoUpdate}`);
	if (deps.optOut.pinnedVersion !== undefined) {
		daemonDetails.push(`Pinned version: ${deps.optOut.pinnedVersion}`);
	}
	return {
		status: {
			product: "DOCTOR",
			version: deps.doctorVersion,
			installation: installed ? "installed" : "not-installed",
			process: { state: serviceState === "running" ? "running" : serviceState === "not-running" ? "stopped" : "unknown" },
			health: { state: "not-applicable", result: "Doctor is the health observer" },
			registration: "not-applicable",
			paths: deps.paths ?? { config: "unknown", logs: "unknown" },
			details: Object.fromEntries(daemonDetails.map((line, index) => [`detail${index + 1}`, line])),
		},
		daemonDetails,
	};
}

async function runStatus(ctx: CliContext): Promise<number> {
	const result = await inspectStatus(ctx);
	ctx.io.out(formatStatus(result.status).trimEnd());
	return EXIT_OK;
}

/** `diagnose` (AC-064f.3): classify + recommend a rung, take NO action. */
async function runDiagnose(ctx: CliContext): Promise<number> {
	const { io, colors, deps } = ctx;
	const classification = await deps.probe();

	io.out(colors.bold("Doctor diagnosis"));
	io.out(`  Health: ${colors.cyan(healthLabel(classification))}`);

	if (!isUnhealthy(classification)) {
		io.out(colors.green("  The daemon is healthy. No remediation recommended."));
		return EXIT_OK;
	}

	// Decide the rung WITHOUT running it (AC-064f.3: takes no action). This consults the
	// pure decision only - ladder.run is never called here.
	const failures = deps.readConsecutiveFailures();
	const decision = deps.decideRung(failures);
	const rungLabel = decision.advanced
		? `rung ${decision.rung} (escalated after ${failures} failed restarts)`
		: `rung ${decision.rung}`;
	io.out(`  Recommended fix: ${colors.yellow(rungLabel)}`);
	io.out(colors.dim("  (diagnose takes no action - run `doctor heal` to apply the ladder.)"));
	return EXIT_OK;
}

/** `heal`: run the ladder once for the current classification, confirming gated rungs. */
async function runHeal(ctx: CliContext, parsed: ParsedArgs): Promise<number> {
	const { io, colors, deps } = ctx;
	const classification = await deps.probe();
	if (!isUnhealthy(classification)) {
		io.out(colors.green("Daemon is healthy; nothing to heal."));
		return EXIT_OK;
	}

	const failures = deps.readConsecutiveFailures();
	const decision = deps.decideRung(failures);

	// A rung >= 2 (reinstall / uninstall-hivemind) is gated: confirm unless --yes was passed.
	const autoYes = hasFlag(parsed, "yes");
	if (decision.rung >= 2 && !autoYes) {
		const ok = await ctx.confirm(
			`Heal will run rung ${decision.rung} (a reinstall/uninstall-class repair). Proceed?`,
		);
		if (!ok) {
			io.out(colors.dim("Aborted; no action taken."));
			return EXIT_DECLINED;
		}
	}

	const result = await deps.ladder.run(decision.rung, deps.rungContextFor(classification));
	const outcome = result.skipped === true ? "skipped" : result.ok ? "succeeded" : "failed";
	io.out(`Ran ${colors.cyan(redactLogSecrets(result.action))} -> ${outcome}${result.detail ? ` (${redactLogSecrets(result.detail)})` : ""}`);
	return result.ok || result.skipped === true ? EXIT_OK : EXIT_ERROR;
}

/** Run a single named rung directly (restart=1, reinstall=2), optionally gated. */
async function runRung(ctx: CliContext, rung: number, gated: boolean, parsed: ParsedArgs): Promise<number> {
	const { io, colors, deps } = ctx;
	if (gated && !hasFlag(parsed, "yes")) {
		const ok = await ctx.confirm(`This runs rung ${rung}, a potentially disruptive repair. Proceed?`);
		if (!ok) {
			io.out(colors.dim("Aborted; no action taken."));
			return EXIT_DECLINED;
		}
	}
	const classification = await deps.probe();
	const result = await deps.ladder.run(rung, deps.rungContextFor(classification));
	const outcome = result.skipped === true ? "skipped" : result.ok ? "succeeded" : "failed";
	io.out(`Ran ${colors.cyan(redactLogSecrets(result.action))} -> ${outcome}${result.detail ? ` (${redactLogSecrets(result.detail)})` : ""}`);
	return result.ok || result.skipped === true ? EXIT_OK : EXIT_ERROR;
}

/** `uninstall-hivemind` (AC-064f.4): rung 3, ALWAYS confirms before acting. */
async function runUninstallHivemind(ctx: CliContext, parsed: ParsedArgs): Promise<number> {
	const { io, colors } = ctx;
	io.out(
		colors.dim(
			"This removes a conflicting @deeplake/hivemind global. It NEVER touches shared ~/.deeplake/ state.",
		),
	);
	// Always gated (rung 3 is destructive); --yes still bypasses for power users.
	return runRung(ctx, 3, true, parsed);
}

/** Canonical `update`: Doctor's own package. The supervised-daemon updater is `daemon-update`. */
async function runUpdate(ctx: CliContext, parsed: ParsedArgs): Promise<number> {
	const { io, deps } = ctx;
	if (hasFlag(parsed, "check")) {
		io.out(redactLogSecrets(
			deps.update.checkSelfUpdate === undefined
				? `Doctor installed version: ${deps.doctorVersion}; run 'doctor update' to resolve the approved latest release.`
				: await deps.update.checkSelfUpdate(),
		));
		return EXIT_OK;
	}
	const message = await deps.update.selfUpdate();
	io.out(redactLogSecrets(message));
	return /failed/iu.test(message) ? EXIT_ERROR : EXIT_OK;
}

/** Compatibility alias for canonical update. */
async function runSelfUpdate(ctx: CliContext): Promise<number> {
	ctx.io.out("Warning: 'self-update' is deprecated; use 'update'.");
	return runUpdate(ctx, { command: "update", flags: {}, positionals: [] });
}

/** Preserve the pre-standard primary-daemon update under an explicit product command. */
async function runDaemonUpdate(ctx: CliContext, parsed: ParsedArgs): Promise<number> {
	const message = hasFlag(parsed, "check")
		? await ctx.deps.update.checkPrimaryUpdate()
		: await ctx.deps.update.applyPrimaryUpdate();
	ctx.io.out(redactLogSecrets(message));
	return /failed|rolled_back/iu.test(message) ? EXIT_ERROR : EXIT_OK;
}

/**
 * `install-service` / `uninstall-service`: delegate to 064b if wired, else print stub. The module
 * returns a structured {@link ServiceResult}; a manager-command failure (ok:false) maps to
 * {@link EXIT_ERROR} so callers (the installers) see an honest non-zero exit (IRD-192 AC-6).
 *
 * Lifecycle capture events (additive, both legs gated + fail-soft inside the emitter):
 *   - `doctor_uninstalled` fires BEFORE the uninstall's state teardown, fire-and-forget
 *     (never awaited, so it can never block or fail the uninstall).
 *   - `doctor_installed` fires AFTER the install verb completes successfully; awaited
 *     (bounded 2s, never throws) so the once-per-machine dedupe marker persists before exit.
 */
async function runService(ctx: CliContext, kind: "install" | "uninstall"): Promise<number> {
	const { io, deps } = ctx;
	if (deps.serviceModule === undefined) {
		io.err(SERVICE_NOT_AVAILABLE);
		return EXIT_ERROR;
	}
	if (kind === "uninstall" && deps.lifecycle !== undefined) {
		// Fire-and-forget BEFORE teardown: the emitter never throws/rejects, and the POST
		// (bounded 2s) races the manager commands below rather than delaying them.
		void deps.lifecycle.uninstalled();
	}
	const result = kind === "install" ? await deps.serviceModule.install() : await deps.serviceModule.uninstall();
	io.out(redactLogSecrets(result.message));
	if (kind === "install" && result.ok && deps.lifecycle !== undefined) {
		// Once per machine: the emitter checks + persists the state-store marker itself.
		await deps.lifecycle.installed();
	}
	return result.ok ? EXIT_OK : EXIT_ERROR;
}

async function waitForServiceState(ctx: CliContext, expected: "running" | "not-running"): Promise<boolean> {
	const probe = ctx.deps.productUninstall?.serviceStatusAsync ?? ctx.deps.serviceStateAsync;
	if (probe === undefined) return false;
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if ((await probe()) === expected) return true;
		if (attempt < 19) {
			await (ctx.deps.lifecycleSleep?.(100) ?? new Promise<void>((resolve) => setTimeout(resolve, 100)));
		}
	}
	return false;
}

/** `start` / `stop` (PRD-003b b-AC-1): front doctor's OWN OS service, when 003b is wired. */
async function runStartStop(ctx: CliContext, kind: "start" | "stop"): Promise<number> {
	const { io, deps } = ctx;
	if (deps.serviceLifecycle === undefined) {
		io.err(SERVICE_NOT_AVAILABLE);
		return EXIT_ERROR;
	}
	if (deps.productUninstall !== undefined) {
		const registered = await deps.productUninstall.isServiceRegistered();
		if (!registered) {
			if (kind === "stop") {
				io.out("Doctor service is already stopped (not installed).");
				return EXIT_OK;
			}
			io.err("Doctor service is not installed; run 'doctor service-install' first.");
			return EXIT_ERROR;
		}
		const state = await deps.productUninstall.serviceStatusAsync();
		if (kind === "start" && state === "running") {
			io.out("Doctor service is already running.");
			return EXIT_OK;
		}
		// Do not return early for an apparently stopped Windows task. Task Scheduler can
		// report Ready after `/End` while its headless Node child remains alive. The real
		// stop adapter is idempotent and also reaps only that exact Doctor child.
	}
	const result = kind === "start" ? await deps.serviceLifecycle.start() : await deps.serviceLifecycle.stop();
	io.out(redactLogSecrets(result.message));
	if (!result.ok) return EXIT_ERROR;
	const expected = kind === "start" ? "running" : "not-running";
	if (!(await waitForServiceState(ctx, expected))) {
		io.err(`Doctor service ${kind} command completed but the service did not reach ${expected === "running" ? "running" : "stopped"} state before the timeout.`);
		return EXIT_ERROR;
	}
	io.out(`Doctor service is confirmed ${expected === "running" ? "running" : "stopped"}.`);
	return EXIT_OK;
}

/** Restart Doctor's installed service and prove the manager reports it running. */
async function runRestart(ctx: CliContext): Promise<number> {
	const lifecycle = ctx.deps.serviceLifecycle;
	if (lifecycle === undefined || ctx.deps.productUninstall === undefined) {
		ctx.io.err("Doctor service lifecycle is unavailable; restart was not attempted.");
		return EXIT_ERROR;
	}
	if (!(await ctx.deps.productUninstall.isServiceRegistered())) {
		ctx.io.err("Doctor service is not installed; run 'doctor service-install' first.");
		return EXIT_ERROR;
	}
	const stopped = await lifecycle.stop();
	ctx.io.out(redactLogSecrets(stopped.message));
	if (!stopped.ok || !(await waitForServiceState(ctx, "not-running"))) {
		ctx.io.err("Doctor service did not reach stopped state before restart timed out.");
		return EXIT_ERROR;
	}
	const started = await lifecycle.start();
	ctx.io.out(redactLogSecrets(started.message));
	if (!started.ok) return EXIT_ERROR;
	if (await waitForServiceState(ctx, "running")) {
		ctx.io.out("Doctor service restarted and is running.");
		return EXIT_OK;
	}
	ctx.io.err("Doctor service restarted but did not reach running state before the timeout.");
	return EXIT_ERROR;
}

/** Doctor onboarding: reconcile its service definition and report the phase explicitly. */
async function runInstall(ctx: CliContext): Promise<number> {
	ctx.io.out("Onboarding: Doctor requires no login or fleet self-registration.");
	const code = await runService(ctx, "install");
	if (code === EXIT_OK) ctx.io.out("Onboarding complete: Doctor service is installed.");
	return code;
}

/**
 * `uninstall` (PRD-003b b-AC-2/3/4/6): remove doctor's OWN service unit, doctor's OWN
 * fleet-registry entry, and doctor's OWN state dir. It never touches the npm package
 * (that is `purge`'s job) or anything belonging to another product. Distinct from the
 * legacy `uninstall-service` verb (which stays exactly as it was: service-unit-only).
 */
async function runUninstall(ctx: CliContext): Promise<number> {
	const { io, colors, deps } = ctx;
	if (deps.productUninstall === undefined) {
		io.err(SERVICE_NOT_AVAILABLE);
		return EXIT_ERROR;
	}
	const u = deps.productUninstall;

	// b-AC-6: a "nothing installed" machine exits 0 with a friendly no-op message, and
	// touches NOTHING (no lifecycle event, no service call) - the pre-check is read-only.
	//
	// The "service present" signal is REGISTRATION evidence, never merely activity: an
	// installed-but-inactive unit (e.g. a stopped systemd unit, where `systemctl is-active`
	// fails identically for "inactive" and "never registered") must still count as present,
	// so uninstall runs and actually deregisters it - never a false no-op. `isServiceRegistered`
	// probe errors/ambiguity bias toward "present" (proceed with uninstall) rather than a
	// false no-op, since every uninstall step below is individually idempotent/best-effort.
	const pre = u.precheck();
	let serviceStatus: ServiceState = "unknown";
	try {
		serviceStatus = await u.serviceStatusAsync();
	} catch {
		serviceStatus = "unknown";
	}
	let isRegistered = true;
	try {
		isRegistered = await u.isServiceRegistered();
	} catch {
		isRegistered = true;
	}
	const servicePresent = serviceStatus === "running" || isRegistered;
	if (!servicePresent && !pre.registryEntryExists && !pre.stateDirExists) {
		io.out(colors.dim("Nothing to remove: no Doctor service, registry entry, or state dir was found."));
		return EXIT_OK;
	}

	// Fire-and-forget BEFORE teardown, matching the existing uninstall-service ordering
	// (dispatch's runService): the emitter never throws/rejects and never delays teardown.
	if (deps.lifecycle !== undefined) void deps.lifecycle.uninstalled();

	const serviceResult = await u.serviceUninstall();
	io.out(redactLogSecrets(serviceResult.message));

	const { registryEntryRemoved, stateDirRemoved } = u.removeState();
	io.out(
		registryEntryRemoved
			? "Removed Doctor's entry from the fleet registry."
			: "No fleet-registry entry for Doctor was found.",
	);
	io.out(stateDirRemoved ? "Removed Doctor's state directory." : "No Doctor state directory was found.");

	// Exit-code honesty (b-AC-6 / parent AC-9, mirroring nectar's and hive's already-absent
	// classification): when the probe above CONFIDENTLY reported the service unregistered
	// (and not running), the uninstall only proceeded because a registry entry or state dir
	// remained - the manager's deregister failure is then the expected "was already gone"
	// shape, not a real failure, and must not flip a successful cleanup to exit 1. A genuine
	// deregister failure on a REGISTERED (or running/ambiguous) unit still exits non-zero.
	return serviceResult.ok || !servicePresent ? EXIT_OK : EXIT_ERROR;
}

/**
 * `purge` (PRD-003c): the destructive, confirmation-gated full-machine wipe. Requires
 * typing the literal word "purge" (orchestrator decision: typed-token, not y/N) unless
 * `--yes` was passed; a non-interactive stdin WITHOUT `--yes` refuses with instructions
 * rather than hanging or defaulting to a silent no (c-AC-1).
 */
async function runPurge(ctx: CliContext, parsed: ParsedArgs): Promise<number> {
	const { io, colors, deps } = ctx;
	if (deps.purge === undefined) {
		io.out(SERVICE_NOT_AVAILABLE);
		return EXIT_OK;
	}
	const p = deps.purge;
	const autoYes = hasFlag(parsed, "yes");

	if (!autoYes) {
		io.out(colors.bold("`doctor purge` will PERMANENTLY remove:"));
		for (const line of p.summaryLines()) io.out(redactLogSecrets(`  - ${line}`));
		io.out("");

		const interactive = ctx.isInteractive?.() ?? false;
		if (!interactive) {
			io.out(colors.red("Refusing to purge non-interactively without --yes."));
			io.out(colors.dim("Re-run as `doctor purge --yes`, or run this in an interactive terminal."));
			return EXIT_DECLINED;
		}

		const confirmToken = ctx.confirmToken;
		const confirmed =
			confirmToken !== undefined &&
			(await confirmToken('This action cannot be undone. Type "purge" to confirm, or anything else to abort.', "purge"));
		if (!confirmed) {
			io.out(colors.dim("Aborted; no changes were made."));
			return EXIT_DECLINED;
		}
	}

	const report = await p.run();
	for (const line of report.lines) io.out(redactLogSecrets(line));
	return report.ok ? EXIT_OK : EXIT_ERROR;
}

/** `incidents`: Doctor's product-specific fleet incident records (legacy `logs --daemon`). */
async function runLogs(ctx: CliContext, parsed: ParsedArgs): Promise<number> {
	const { io, colors, deps } = ctx;
	const limitRaw = parsed.flags["lines"];
	const limit = typeof limitRaw === "string" && /^\d+$/.test(limitRaw) ? Number.parseInt(limitRaw, 10) : 20;
	const daemonRaw = parsed.flags["daemon"];
	if (daemonRaw === true) {
		io.err(colors.red("Flag --daemon requires a daemon name value."));
		return EXIT_ERROR;
	}
	const daemonName = typeof daemonRaw === "string" && daemonRaw.trim() !== "" ? daemonRaw.trim() : undefined;

	const lines = await deps.tailIncidents(limit, daemonName);
	if (lines.length === 0) {
		if (daemonName !== undefined) {
			io.out(colors.dim(`No incidents recorded yet for daemon "${redactLogSecrets(daemonName)}".`));
		} else {
			io.out(colors.dim("No incidents recorded yet."));
		}
		return EXIT_OK;
	}
	for (const line of lines) io.out(redactLogSecrets(line));
	return EXIT_OK;
}

/** Canonical logs: hard-bound to Doctor's own authoritative service log. */
async function runServiceLogs(ctx: CliContext, parsed: ParsedArgs): Promise<number> {
	if (ctx.deps.tailServiceLogs === undefined) {
		ctx.io.err("Doctor service log source is unavailable; no other product log was read.");
		return EXIT_ERROR;
	}
	const args = optionArgv(parsed, new Set(Object.keys(GLOBAL_OPTIONS)));
	const controller = new AbortController();
	const stop = (): void => controller.abort();
	process.once("SIGINT", stop);
	try {
		const result = await ctx.deps.tailServiceLogs(args, (line) => ctx.io.out(line.trimEnd()), controller.signal);
		if (!result.ok) {
			ctx.io.err(redactLogSecrets(result.error));
			return EXIT_ERROR;
		}
		return EXIT_OK;
	} finally {
		process.removeListener("SIGINT", stop);
	}
}

async function runTelemetry(ctx: CliContext): Promise<number> {
	if (ctx.deps.telemetrySummary === undefined) {
		ctx.io.err("Doctor telemetry state is unavailable.");
		return EXIT_ERROR;
	}
	ctx.io.out(formatTelemetrySummary(ctx.deps.telemetrySummary()).trimEnd());
	return EXIT_OK;
}

/** Render the banner + menu (bare invocation / `help`). */
function runHelp(ctx: CliContext): number {
	ctx.io.out(renderBannerWithMenu(ctx.colors));
	return EXIT_OK;
}

/** Route a resolved command to its handler. */
async function route(command: CommandName, ctx: CliContext, parsed: ParsedArgs): Promise<number> {
	switch (command) {
		case "run":
			// `run` is the long-running OS-service entry; it is intercepted in runCli BEFORE the
			// dispatcher (it never returns an exit code mid-loop). Reaching here means it was routed
			// without that interception, so print an honest note rather than silently no-op.
			ctx.io.out("`run` is the OS-service entry and is started by the service manager, not dispatched here.");
			return EXIT_OK;
		case "status":
			return runStatus(ctx);
		case "diagnose":
			return runDiagnose(ctx);
		case "heal":
			return runHeal(ctx, parsed);
		case "restart":
			return runRestart(ctx);
		case "reinstall":
			return runRung(ctx, 2, true, parsed);
		case "uninstall-hivemind":
			return runUninstallHivemind(ctx, parsed);
		case "update":
			return runUpdate(ctx, parsed);
		case "daemon-update":
			return runDaemonUpdate(ctx, parsed);
		case "self-update":
			return runSelfUpdate(ctx);
		case "install":
			return runInstall(ctx);
		case "service-install":
			return runService(ctx, "install");
		case "service-uninstall":
			return runService(ctx, "uninstall");
		case "start":
			return runStartStop(ctx, "start");
		case "stop":
			return runStartStop(ctx, "stop");
		case "uninstall":
			return runUninstall(ctx);
		case "purge":
			return runPurge(ctx, parsed);
		case "logs":
			return runServiceLogs(ctx, parsed);
		case "incidents":
			return runLogs(ctx, parsed);
		case "telemetry":
			return runTelemetry(ctx);
		case "help":
			return runHelp(ctx);
		default: {
			// Exhaustiveness guard: a new CommandName must add a case above.
			const _exhaustive: never = command;
			return _exhaustive;
		}
	}
}

/**
 * Dispatch one CLI invocation. `argv` is the slice after `node <script>` (the caller
 * strips those). Returns the exit code; never throws (a handler error is caught and
 * mapped to {@link EXIT_ERROR}).
 */
export async function dispatch(argv: readonly string[], ctx: CliContext): Promise<number> {
	let parsed = parseArgs(argv);
	const resolution = resolveCommandDetailed(parsed.command);
	const json = hasFlag(parsed, "json");
	const invocationError = resolution === null
		? (parsed.command === undefined ? validateBareInvocation(parsed) : null)
		: validateInvocation(resolution.command, parsed);
	if (invocationError !== null) return usageFailure(ctx, resolution?.command ?? "", invocationError, json);

	const shortVersionOnly = (parsed.command === "-v" || parsed.command === "-V") && parsed.positionals.length === 0;
	if ((resolution !== null && hasFlag(parsed, "version")) || (parsed.command === undefined && hasFlag(parsed, "version")) || shortVersionOnly) {
		ctx.io.out((json ? renderVersionJson("doctor", DOCTOR_VERSION) : renderVersion("doctor", DOCTOR_VERSION)).trimEnd());
		return EXIT_OK;
	}

	const shortHelpOnly = parsed.command === "-h" && parsed.positionals.length === 0;
	if (resolution === null && (parsed.command === undefined || shortHelpOnly)) {
		if (json) ctx.io.out(JSON.stringify({ product: "doctor", command: "help", ok: true, message: "help" }));
		else return runHelp(ctx);
		return EXIT_OK;
	}
	if (resolution !== null && (resolution.command === "help" || argv.includes("--help") || argv.includes("-h"))) {
		if (json) ctx.io.out(JSON.stringify({ product: "doctor", command: "help", ok: true, message: "help" }));
		else return runHelp(ctx);
		return EXIT_OK;
	}

	if (resolution === null) {
		const name = parsed.command ?? "";
		const message = `Unknown command: ${name}. Run 'doctor --help' for usage.`;
		if (json) ctx.io.out(JSON.stringify({ product: "doctor", command: name, ok: false, message }));
		else ctx.io.err(ctx.colors.red(message));
		return 2;
	}

	if (resolution.deprecatedAlias !== undefined && !json) {
		ctx.io.err(`Warning: '${resolution.deprecatedAlias}' is deprecated; use '${resolution.command}'.`);
	}

	const command = resolution.command;
	if (command === "uninstall" && !hasFlag(parsed, "yes")) {
		const message = "Doctor uninstall requires confirmation; re-run with --yes in non-interactive use.";
		if (json || !(ctx.isInteractive?.() ?? false)) {
			if (json) ctx.io.out(JSON.stringify({ product: "doctor", command, ok: false, message }));
			else ctx.io.err(message);
			return 2;
		}
		if (!(await ctx.confirm("Remove Doctor's service and Doctor-owned state?"))) {
			ctx.io.out("Doctor uninstall cancelled; no changes were made.");
			return EXIT_OK;
		}
	}
	if (!json) {
		try {
			return await route(command, ctx, parsed);
		} catch (error) {
			ctx.io.err(ctx.colors.red(redactLogSecrets(`Command failed: ${error instanceof Error ? error.message : "unknown error"}`)));
			return EXIT_ERROR;
		}
	}

	if (command === "logs" && !hasFlag(parsed, "no-follow")) {
		parsed = { ...parsed, flags: { ...parsed.flags, "no-follow": true } };
	}
	if (command === "status") {
		try {
			const status = (await inspectStatus(ctx)).status;
			ctx.io.out(JSON.stringify({ product: "doctor", command, ok: true, message: "Doctor status", status }));
			return EXIT_OK;
		} catch (error) {
			const message = redactLogSecrets(error instanceof Error ? error.message : "Doctor status failed");
			ctx.io.out(JSON.stringify({ product: "doctor", command, ok: false, message }));
			return EXIT_ERROR;
		}
	}
	if (command === "telemetry") {
		try {
			if (ctx.deps.telemetrySummary === undefined) throw new Error("Doctor telemetry state is unavailable.");
			ctx.io.out(JSON.stringify({ product: "doctor", command, ok: true, message: "Doctor telemetry status", telemetry: ctx.deps.telemetrySummary() }));
			return EXIT_OK;
		} catch (error) {
			const message = redactLogSecrets(error instanceof Error ? error.message : "Doctor telemetry status failed");
			ctx.io.out(JSON.stringify({ product: "doctor", command, ok: false, message }));
			return EXIT_ERROR;
		}
	}

	const stdout: string[] = [];
	const stderr: string[] = [];
	const capturedCtx: CliContext = {
		...ctx,
		io: {
			out: (text) => stdout.push(text),
			err: (text) => stderr.push(text),
		},
		confirm: async () => false,
		isInteractive: () => false,
	};
	try {
		const code = await route(command, capturedCtx, parsed);
		const clean = [...stdout, ...stderr].join("\n").replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)?)/gu, "").trim();
		ctx.io.out(JSON.stringify({
			product: "doctor",
			command,
			ok: code === EXIT_OK,
			message: clean || (code === EXIT_OK ? `${command} completed.` : `${command} failed.`),
			...(command === "logs" ? { lines: stdout.flatMap((line) => line.split(/\r?\n/u)).filter(Boolean) } : {}),
		}));
		return code;
	} catch (error) {
		const message = redactLogSecrets(error instanceof Error ? error.message : "unknown error");
		ctx.io.out(JSON.stringify({ product: "doctor", command, ok: false, message }));
		return EXIT_ERROR;
	}
}
