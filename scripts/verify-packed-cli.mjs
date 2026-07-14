import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is required for packed CLI verification");
const runNpm = (args, options = {}) => execFileSync(process.execPath, [npmCli, ...args], options);
const temp = mkdtempSync(join(tmpdir(), "doctor-packed-cli-"));
let tarball;

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

const identityColors = Object.freeze({
	bold: String, cyan: String, dim: String, green: String, red: String, yellow: String,
});

function fixtureContext(args, options = {}) {
	const stdout = [];
	const stderr = [];
	const command = args[0] ?? "";
	const failure = options.failure;
	let registered = options.registered ?? true;
	let state = options.initialState ?? (command === "start" ? "not-running" : "running");
	const classification = options.unhealthy ? { kind: "unreachable-timeout" } : { kind: "ok" };
	const fails = (name) => failure === name;
	const serviceModule = {
		install: async () => {
			if (fails(command)) return { ok: false, message: "fixture service install failed" };
			registered = true;
			state = "running";
			return { ok: true, message: "fixture Doctor service installed and running" };
		},
		uninstall: async () => {
			if (fails(command)) return { ok: false, message: "fixture service uninstall failed" };
			registered = false;
			state = "not-running";
			return { ok: true, message: "fixture Doctor service uninstalled" };
		},
	};
	const serviceLifecycle = {
		start: async () => {
			if (fails("start") || fails("restart")) return { ok: false, message: "fixture Doctor service start failed" };
			state = "running";
			return { ok: true, message: "fixture Doctor service started" };
		},
		stop: async () => {
			if (fails("stop") || fails("restart")) return { ok: false, message: "fixture Doctor service stop failed" };
			state = "not-running";
			return { ok: true, message: "fixture Doctor service stopped" };
		},
	};
	return {
		stdout,
		stderr,
		ctx: {
			io: { out: (text) => stdout.push(text), err: (text) => stderr.push(text) },
			confirm: async () => false,
			confirmToken: async () => false,
			isInteractive: () => false,
			colors: identityColors,
			deps: {
				probe: async () => classification,
				statusDaemons: () => [{
					name: "honeycomb",
					probe: async () => classification,
					readDaemonVersion: async () => classification.kind === "ok" ? "1.2.3-fixture" : null,
					readStatusState: () => ({ lastHealAt: null, lastKnownHealth: classification.kind }),
				}],
				readDaemonVersion: async () => "1.2.3-fixture",
				doctorVersion: "0.5.0-fixture",
				ladder: {
					decide: () => ({ rung: 1, advanced: false }),
					run: async () => ({ ok: true, action: "fixture remediation" }),
					escalate: async () => ({ ok: true, action: "fixture escalation" }),
				},
				rungContextFor: (value) => ({ classification: value, logger: {} }),
				decideRung: () => ({ rung: 1, advanced: false }),
				readConsecutiveFailures: () => 0,
				readStatusState: () => ({ lastHealAt: null, lastKnownHealth: classification.kind }),
				serviceState: () => state,
				serviceStateAsync: async () => {
					if (fails("status")) throw new Error("fixture status failed");
					return state;
				},
				serviceModule,
				serviceLifecycle,
				lifecycleSleep: async () => undefined,
				productUninstall: {
					precheck: () => ({ registryEntryExists: registered, stateDirExists: registered }),
					serviceStatusAsync: async () => state,
					isServiceRegistered: async () => registered,
					serviceUninstall: serviceModule.uninstall,
					removeState: () => ({ registryEntryRemoved: true, stateDirRemoved: true }),
				},
				optOut: { autoUpdateDisabled: false, source: "default" },
				update: {
					checkPrimaryUpdate: async () => "fixture daemon update check complete",
					applyPrimaryUpdate: async () => "fixture daemon update complete",
					checkSelfUpdate: async () => "fixture Doctor update check complete",
					selfUpdate: async () => fails("update") ? "fixture Doctor update failed" : "fixture Doctor update complete",
				},
				tailIncidents: async () => ["fixture Doctor incident"],
				tailServiceLogs: async (_argv, write) => {
					if (fails("logs")) return { ok: false, error: "fixture Doctor logs failed" };
					write("DOCTOR_PACKED_LOG_IDENTITY");
					write("Authorization: Bearer [REDACTED]");
					return { ok: true };
				},
				paths: { config: "/fixture/doctor", logs: "/fixture/doctor/service.log" },
				telemetrySummary: () => {
					if (fails("telemetry")) throw new Error("fixture telemetry failed");
					return options.optedOut
						? { state: "opted-out", controllingSetting: "DO_NOT_TRACK", destination: "disabled", optOutInstruction: "Set DO_NOT_TRACK=1" }
						: { state: "enabled", controllingSetting: "default", destination: "hosted", optOutInstruction: "Set DO_NOT_TRACK=1" };
				},
			},
		},
	};
}

try {
	// `--ignore-scripts` deliberately prevents lifecycle execution during pack/install, so
	// build explicitly first and never verify a stale bundle left by an earlier checkout.
	runNpm(["run", "build"], { stdio: "pipe" });
	const packed = JSON.parse(runNpm(["pack", "--json", "--ignore-scripts"], { encoding: "utf8" }));
	const filename = packed[0]?.filename;
	if (typeof filename !== "string") throw new Error("npm pack did not return a tarball filename");
	tarball = join(process.cwd(), filename);
	runNpm(["install", "--prefix", temp, "--ignore-scripts", tarball], { stdio: "pipe" });
	const bin = join(temp, "node_modules", "@legioncodeinc", "doctor", "bundle", "cli.js");
	const bundledSource = readFileSync(bin, "utf8");
	assert(!bundledSource.includes("DOCTOR_PACKED_"), "packed executable contains a shipped packed-test environment seam");
	const { dispatch } = await import(pathToFileURL(bin).href);
	assert(typeof dispatch === "function", "packed executable does not expose the programmatic dispatcher");

	const apiaryHome = join(temp, "apiary-home");
	const doctorDir = join(apiaryHome, "doctor");
	mkdirSync(doctorDir, { recursive: true });
	writeFileSync(join(doctorDir, "service.log"), [
		"2026-07-13T10:00:00Z DOCTOR_PACKED_LOG_IDENTITY",
		"2026-07-13T10:00:01Z Authorization: Bearer packed-secret",
	].join("\n"));
	for (const product of ["hive", "honeycomb", "nectar"]) {
		const dir = join(apiaryHome, product);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "service.log"), `POISON_${product.toUpperCase()}\n`);
	}

	const baseEnv = { ...process.env, APIARY_HOME: apiaryHome, NO_COLOR: "1" };
	const run = (args, extraEnv = {}) => spawnSync(process.execPath, [bin, ...args], {
		encoding: "utf8",
		env: { ...baseEnv, ...extraEnv },
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: 4 * 1024 * 1024,
	});
	const expectExit = (args, expected, extraEnv = {}) => {
		const result = run(args, extraEnv);
		assert(result.error === undefined, `${args.join(" ")} failed to spawn: ${result.error?.message}`);
		assert(result.status === expected, `${args.join(" ")} exited ${result.status}, expected ${expected}: ${result.stdout}${result.stderr}`);
		return result;
	};
	const expectJson = (args, expected, extraEnv = {}) => {
		const result = expectExit([...args, "--json"], expected, extraEnv);
		assert(result.stderr === "", `${args.join(" ")} JSON wrote stderr: ${result.stderr}`);
		return JSON.parse(result.stdout.trim());
	};
	const runFixture = async (args, expected, options = {}) => {
		const fixture = fixtureContext(args, options);
		const status = await dispatch(args, fixture.ctx);
		assert(status === expected, `${args.join(" ")} fixture exited ${status}, expected ${expected}: ${fixture.stdout.join("\n")}${fixture.stderr.join("\n")}`);
		return fixture;
	};
	const expectFixtureJson = async (args, expected, options = {}) => {
		const fixture = await runFixture([...args, "--json"], expected, options);
		assert(fixture.stderr.length === 0, `${args.join(" ")} fixture JSON wrote stderr: ${fixture.stderr.join("\n")}`);
		return JSON.parse(fixture.stdout.join("\n"));
	};

	const help = expectExit(["--help"], 0).stdout;
	assert(expectExit([], 0).stdout === help, "bare invocation and --help differ");
	assert(help.includes("DOCTOR") && help.includes("Legion Code Inc. x Activeloop"), "packed help lacks standard brand anatomy");
	assert((help.match(/Legion Code Inc\. x Activeloop/gu) ?? []).length === 1, "packed help does not contain exactly one credit line");
	assert(!help.includes("LEGION CODE INC.") && !help.includes("powered by deeplake.ai"), "packed art contains legacy partner prose");
	for (const command of ["start", "stop", "restart", "install", "uninstall", "service-install", "service-uninstall", "update", "status", "logs", "telemetry"]) {
		assert(new RegExp(`^\\s*${command}\\s`, "mu").test(help), `packed help omits ${command}`);
	}
	assert(!/^\s*register\s/mu.test(help), "Doctor help advertises exempt register command");

	const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
	assert(expectExit(["--version"], 0).stdout === `doctor v${manifest.version}\n`, "unexpected packed version output");
	assert(expectJson(["--version"], 0).version === manifest.version, "packed JSON version mismatch");
	assert(expectJson(["register"], 2).ok === false, "Doctor register exemption did not return JSON usage failure");
	assert(expectJson(["start", "--bogus"], 2).ok === false, "malformed start option was accepted");
	assert(expectExit(["telemetry", "--bogus"], 2).status === 2, "malformed telemetry option was accepted");
	assert(expectJson(["logs", "--lines", "0", "--no-follow"], 2).ok === false, "malformed logs option was not usage exit 2");

	const successCases = [
		{ args: ["start"], options: { initialState: "not-running" } },
		{ args: ["stop"], options: { initialState: "running" } },
		{ args: ["restart"], options: { initialState: "running" } },
		{ args: ["install"] },
		{ args: ["uninstall", "--yes"] },
		{ args: ["service-install"] },
		{ args: ["service-uninstall"] },
		{ args: ["update", "--check"] },
		{ args: ["status"] },
		{ args: ["logs", "--no-follow"] },
		{ args: ["telemetry"] },
	];
	for (const { args, options } of successCases) {
		const human = await runFixture(args, 0, options);
		assert(human.stdout.join("\n").trim() !== "", `${args.join(" ")} fixture human success emitted no output`);
		const payload = await expectFixtureJson(args, 0, options);
		assert(payload.product === "doctor" && payload.ok === true, `${args.join(" ")} fixture JSON success envelope is invalid`);
	}

	const logs = expectExit(["logs", "--no-follow"], 0).stdout;
	assert(logs.includes("DOCTOR_PACKED_LOG_IDENTITY") && logs.includes("[REDACTED]"), "packed logs lack Doctor identity or redaction");
	for (const product of ["HIVE", "HONEYCOMB", "NECTAR"]) assert(!logs.includes(`POISON_${product}`), `packed logs leaked ${product}`);
	assert(expectJson(["logs", "--no-follow"], 0).lines.some((line) => line.includes("DOCTOR_PACKED_LOG_IDENTITY")), "packed JSON logs lack Doctor identity");

	for (const args of [["start"], ["stop"], ["restart"], ["install"], ["uninstall", "--yes"], ["service-install"], ["service-uninstall"], ["update"], ["status"], ["logs", "--no-follow"], ["telemetry"]]) {
		const failure = args[0];
		await runFixture(args, 1, { failure, initialState: failure === "start" ? "not-running" : "running" });
		const payload = await expectFixtureJson(args, 1, { failure, initialState: failure === "start" ? "not-running" : "running" });
		assert(payload.product === "doctor" && payload.ok === false, `${args.join(" ")} fixture JSON failure envelope is invalid`);
	}

	const optedOut = await expectFixtureJson(["telemetry"], 0, { optedOut: true });
	assert(optedOut.telemetry.state === "opted-out" && optedOut.telemetry.destination === "disabled", "packed dispatcher opted-out telemetry is incorrect");
	const unhealthy = await expectFixtureJson(["status"], 0, { unhealthy: true, initialState: "not-running" });
	assert(unhealthy.status.process.state === "stopped" && JSON.stringify(unhealthy.status.details).includes("unreachable"), "packed dispatcher unhealthy/stopped status is incorrect");
} finally {
	if (tarball) rmSync(tarball, { force: true });
	rmSync(temp, { recursive: true, force: true });
}
