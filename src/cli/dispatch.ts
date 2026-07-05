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
import { resolveCommand, type CommandName } from "./command-table.js";
import { DOCTOR_VERSION } from "../version.js";
import type { CliContext, ServiceState } from "./context.js";
import { SERVICE_NOT_AVAILABLE } from "./service-stub.js";
import type { HealthClassification } from "../health-probe.js";

/** Exit codes the dispatcher returns. 0 = ok; 1 = handler error; 2 = user declined a gate. */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_DECLINED = 2;

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
async function runStatus(ctx: CliContext): Promise<number> {
	const { io, colors, deps } = ctx;
	const daemonSources = deps.statusDaemons();
	// The service state prefers the bounded ASYNC probe (wired to serviceStatus in the composition
	// root, IRD-192 AC-5) so a registered task reports its real state, never a hardcoded "unknown".
	// The probe is bounded by SERVICE_COMMAND_TIMEOUT_MS in the wiring; it never blocks indefinitely.
	// The sync serviceState() seam is the test-harness fallback when the async probe is not injected.
	const serviceState = deps.serviceStateAsync !== undefined ? await deps.serviceStateAsync() : deps.serviceState();

	io.out(colors.bold("Doctor status"));
	io.out(`  Doctor service: ${colors.cyan(serviceState)}`);
	io.out(`  Doctor version: ${deps.doctorVersion}`);
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

		io.out("");
		io.out(colors.bold(`Daemon: ${daemon.name}`));
		io.out(`  Daemon health:      ${colors.cyan(healthLabel(classification))}`);
		io.out(`  Daemon version:     ${daemonVersion ?? colors.dim("unknown (daemon unreachable)")}`);
		io.out(`  Last heal:          ${state.lastHealAt ?? colors.dim("never")}`);
	}

	// Opt-out flags - honest about which layer disabled auto-update (OD-5 / AC-064e.4).
	const autoUpdate = deps.optOut.autoUpdateDisabled
		? colors.yellow(`disabled (${deps.optOut.source})`)
		: colors.green("enabled");
	io.out("");
	io.out(`  Auto-update:        ${autoUpdate}`);
	if (deps.optOut.pinnedVersion !== undefined) {
		io.out(`  Pinned version:     ${deps.optOut.pinnedVersion}`);
	}
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
	io.out(`Ran ${colors.cyan(result.action)} -> ${outcome}${result.detail ? ` (${result.detail})` : ""}`);
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
	io.out(`Ran ${colors.cyan(result.action)} -> ${outcome}${result.detail ? ` (${result.detail})` : ""}`);
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

/** `update [--check]`: primary-daemon update via the blessed gate (064e). */
async function runUpdate(ctx: CliContext, parsed: ParsedArgs): Promise<number> {
	const { io, deps } = ctx;
	if (hasFlag(parsed, "check")) {
		io.out(await deps.update.checkPrimaryUpdate());
		return EXIT_OK;
	}
	io.out(await deps.update.applyPrimaryUpdate());
	return EXIT_OK;
}

/** `self-update` (AC-064f.5): THE ONLY path that updates Doctor's own package. */
async function runSelfUpdate(ctx: CliContext): Promise<number> {
	ctx.io.out(await ctx.deps.update.selfUpdate());
	return EXIT_OK;
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
		io.out(SERVICE_NOT_AVAILABLE);
		return EXIT_OK;
	}
	if (kind === "uninstall" && deps.lifecycle !== undefined) {
		// Fire-and-forget BEFORE teardown: the emitter never throws/rejects, and the POST
		// (bounded 2s) races the manager commands below rather than delaying them.
		void deps.lifecycle.uninstalled();
	}
	const result = kind === "install" ? await deps.serviceModule.install() : await deps.serviceModule.uninstall();
	io.out(result.message);
	if (kind === "install" && result.ok && deps.lifecycle !== undefined) {
		// Once per machine: the emitter checks + persists the state-store marker itself.
		await deps.lifecycle.installed();
	}
	return result.ok ? EXIT_OK : EXIT_ERROR;
}

/** `start` / `stop` (PRD-003b b-AC-1): front doctor's OWN OS service, when 003b is wired. */
async function runStartStop(ctx: CliContext, kind: "start" | "stop"): Promise<number> {
	const { io, deps } = ctx;
	if (deps.serviceLifecycle === undefined) {
		io.out(SERVICE_NOT_AVAILABLE);
		return EXIT_OK;
	}
	const result = kind === "start" ? await deps.serviceLifecycle.start() : await deps.serviceLifecycle.stop();
	io.out(result.message);
	return result.ok ? EXIT_OK : EXIT_ERROR;
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
		io.out(SERVICE_NOT_AVAILABLE);
		return EXIT_OK;
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
	io.out(serviceResult.message);

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
		for (const line of p.summaryLines()) io.out(`  - ${line}`);
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
	for (const line of report.lines) io.out(line);
	return report.ok ? EXIT_OK : EXIT_ERROR;
}

/** `logs`: tail the local incident log. */
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
			io.out(colors.dim(`No incidents recorded yet for daemon "${daemonName}".`));
		} else {
			io.out(colors.dim("No incidents recorded yet."));
		}
		return EXIT_OK;
	}
	for (const line of lines) io.out(line);
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
			return runRung(ctx, 1, false, parsed);
		case "reinstall":
			return runRung(ctx, 2, true, parsed);
		case "uninstall-hivemind":
			return runUninstallHivemind(ctx, parsed);
		case "update":
			return runUpdate(ctx, parsed);
		case "self-update":
			return runSelfUpdate(ctx);
		case "install-service":
			return runService(ctx, "install");
		case "uninstall-service":
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
			return runLogs(ctx, parsed);
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
	const parsed = parseArgs(argv);
	const command = resolveCommand(parsed.command);

	// `--version` / `-v` / `-V` -> print just the version string and exit, BEFORE the
	// bare-invocation banner fallback (otherwise `doctor --version` shows the banner).
	if (hasFlag(parsed, "version") || argv.includes("-v") || argv.includes("-V")) {
		ctx.io.out(DOCTOR_VERSION);
		return EXIT_OK;
	}

	// Bare invocation (no command) -> banner + menu (AC-064f.1).
	if (command === null && parsed.command === undefined) {
		return runHelp(ctx);
	}

	// An UNKNOWN command token: print a short error + the menu, exit non-zero.
	if (command === null) {
		ctx.io.err(ctx.colors.red(`Unknown command: ${parsed.command ?? ""}`));
		ctx.io.out(renderBannerWithMenu(ctx.colors));
		return EXIT_ERROR;
	}

	try {
		return await route(command, ctx, parsed);
	} catch (error) {
		// Crash-safe: a handler error is reported, never a thrown stack trace (parent AC-8).
		ctx.io.err(ctx.colors.red(`Command failed: ${error instanceof Error ? error.message : "unknown error"}`));
		return EXIT_ERROR;
	}
}
