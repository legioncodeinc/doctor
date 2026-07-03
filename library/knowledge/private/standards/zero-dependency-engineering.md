# Zero-Dependency Engineering

> Category: Standards | Version: 1.0 | Date: July 2026 | Status: Active | Author: Mario Aldayuz

For every contributor to doctor: these are the enforced patterns that make a can't-crash, zero-dependency watchdog possible, with the real code that is the canonical example of each. Read this before adding any code that reads a file, parses input, shells out, or opens a socket.

**Related:**
- [documentation-framework.md](./documentation-framework.md)
- [../architecture/system-overview.md](../architecture/system-overview.md)
- [../architecture/composition-root.md](../architecture/composition-root.md)
- [../architecture/remediation-rungs-deep-dive.md](../architecture/remediation-rungs-deep-dive.md)
- [../security/trust-boundaries.md](../security/trust-boundaries.md)
- [../infrastructure/build-and-release.md](../infrastructure/build-and-release.md)
---

## Why these patterns exist

Doctor is a privileged, always-on, OS-supervised process whose entire job is to not crash. That single requirement forces a specific engineering style, and the style is not a matter of taste: it is the set of shapes that make crash-safety and zero dependencies achievable and reviewable. Every module in `src/` cites the four design principles by number in its header; this doc turns those principles into the concrete patterns a reviewer checks for. The principles themselves are in [../architecture/system-overview.md](../architecture/system-overview.md); the patterns below are how you satisfy them in code.

## Pattern 1: failures are values, never exceptions

The most pervasive pattern is that external actions resolve a value instead of throwing. A failed probe is a classification, a failed command is a result, a failed rung is a `RungResult`, a failed write is a logged loss. The whole system is built so the hot path never has to catch, because the things it calls do not throw.

The command runner is the canonical example: a non-zero exit, an ENOENT spawn failure, and a timeout kill all resolve to the same shape.

```typescript
export interface CommandResult {
	readonly ok: boolean;
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly detail?: string;
}
```

The health probe is the other canonical example: `probeHealth` is total, mapping every input including a hard transport failure to one of four classifications, so the watch loop can always make a decision and continue. The rule for contributors: a function that touches the outside world resolves a discriminated result or a defaulted value; it does not propagate an exception into the loop.

## Pattern 2: injected seams for every external action

Every external action is injected, not imported and called directly, so the composition root can wire a production default and a test can wire a recorder. This is what lets the smoke test drive the entire assembly hermetically: no real socket, no real npm, no real network, no real clock. The composition root's options list is the catalog of seams; `buildDaemon` is the pattern in miniature. Rung 1, for instance, takes its restart, PID read, health re-probe, clock, and cooldown bookkeeping all as injected functions:

```typescript
const entryRestartRung = createRestartRung({
	restart,
	readDaemonPid: () => readDaemonPid(entry.pidPath),
	isHealthy: entryIsHealthy,
	cooldownMs: entry.restartCooldownMs,
	clock,
	lastRestartAt: () => entryLastRestartAt,
	markRestarted: (at: number) => { entryLastRestartAt = at; },
});
```

The rule: new time-dependent or I/O-dependent behavior takes a `clock`/`now`/`fetch`/`runner` seam, or it will be untestable and flaky. Composition is where seams get their production defaults; see [../architecture/composition-root.md](../architecture/composition-root.md).

## Pattern 3: hand-rolled defensive coercion, no schema library

Doctor validates every external input by hand with Node built-ins. There is no zod, because zod is a runtime npm dependency and design principle 1 forbids one in the can't-crash process. Three modules are the canonical examples, and they share one posture: a malformed value falls back to a default rather than throwing.

`src/config.ts` layers env vars over `DEFAULTS`, each parse defensive:

```typescript
function parsePositiveInt(raw: string | undefined, fallback: number): number {
	if (raw === undefined || raw.trim() === "") return fallback;
	const n = Number.parseInt(raw.trim(), 10);
	return Number.isInteger(n) && n > 0 ? n : fallback;
}
```

`src/registry.ts` coerces each registry field the same way, with one deliberate exception: a missing or garbage `name` throws `RegistryError`, because a nameless entry cannot key a state shard, so it is the one fail-loud field in an otherwise fail-soft parser. `src/state.ts` hand-merges an arbitrary parsed object over `DEFAULT_STATE` field by field (`mergeState`), so a partially-corrupt state file degrades to a coherent object rather than propagating garbage into the loop. The rule: validate external input at the boundary with built-ins; default on garbage; fail loud only where a missing value cannot be defaulted safely.

## Pattern 4: path containment for every composed file path

Every fixed filename doctor joins onto a variable workspace dir routes through `resolveInBase` in `src/safe-path.ts`. This is both a real defense-in-depth control (a poisoned `DOCTOR_WORKSPACE_DIR` cannot escape the workspace) and a SAST-visibility measure (a taint tracker cannot prove a joined filename is constant, so the validator is where the tainted path becomes safe):

```typescript
export function resolveInBase(baseDir: string, ...segments: string[]): string
```

It rejects any segment carrying a separator or a `..`, resolves the base to an absolute normalized path, joins, re-normalizes, and asserts the result is still contained. `assertWithinBase` is the sibling for an already-composed absolute path (used for the `telemetryDbPath` containment and the service unit paths). Callers catch a `PathContainmentError` broadly and fail-soft, so a containment violation degrades exactly like the existing defensive read/write handling and never crashes the watchdog. The rule: a fixed filename under a variable dir goes through `resolveInBase`; an externally-supplied absolute path goes through `assertWithinBase`. The security rationale is in [../security/trust-boundaries.md](../security/trust-boundaries.md).

## Pattern 5: execFile with argv arrays, never a shell

Every shell-out goes through the command runner (`src/rungs/command-runner.ts`), which uses `node:child_process.execFile` with an argv array and `shell: false`, so a package name or path can never be reinterpreted as a shell metacharacter. The one documented exception (the Windows `npm.cmd` fallback with `shell: true`) is provably safe because only fixed literals and a semver-validated version ever reach it. On top of that, any version string composed into an npm spec is validated as strict SemVer first (`parseVersion` in the update engine), because a rollback version once came from a network-sourced `/health` body and a spoofed `latest` or `>=0.0.0` range must never reach npm's resolver. The rule: no `exec`, no shell strings; argv arrays through the runner seam, with any version token semver-validated before it is composed.

## Pattern 6: node built-ins only, one import per capability

The zero-dependency commitment is structural. Each external capability maps to exactly one built-in:

| Capability | Built-in | Where |
|---|---|---|
| HTTP probing | `node:http` (`request`) | `src/health-probe.ts`, `src/cli/daemon-version.ts` |
| SQLite reads | `node:sqlite` (`DatabaseSync`, read-only) | `src/telemetry/sqlite-reader.ts` |
| HTTP serving | `node:http` (`createServer`, loopback) | `src/status-page/server.ts` |
| Shell-outs | `node:child_process` (`execFile`) | `src/rungs/command-runner.ts` |
| Outbound telemetry | global `fetch` (Node 22 built-in) | `src/telemetry/emit.ts`, `capture.ts` |
| IDs / atomic writes | `node:crypto` (`randomUUID`, `randomBytes`) | `state.ts`, `incidents.ts`, `install-lock.ts` |

The published package's `dependencies` field does not exist; `devDependencies` (TypeScript, esbuild, vitest) never ship. The OTLP envelope is hand-rolled (`src/telemetry/otlp-serializer.ts`) rather than pulling an OpenTelemetry SDK, and the CLI is a hand-rolled dispatcher over a single-sourced command table rather than a CLI framework. The rule: reach for a built-in; if there is no built-in, hand-roll it; a new runtime `dependencies` entry is a design-principle violation that needs an explicit decision.

## Pattern 7: atomic durable writes

Every durable file doctor owns is written atomically: serialize to a random-suffixed `.tmp` in the same dir, then `renameSync` over the target, so a crash mid-write never leaves a half-written file. `state.ts` and the needs-attention store are the canonical examples; both wrap the write so any failure is swallowed and logged (`state.write_failed`, `needs-attention.write_failed`), never thrown. The install lock uses the same primitive in reverse: an exclusive-create (`wx` flag) is the atomic test-and-set the mutex needs, with staleness reclaim so a process that dies mid-install never wedges the lock forever. The rule: a durable write is temp-then-rename and defensive; a mutex is exclusive-create with a staleness escape hatch.

## Pattern 8: fail-soft telemetry that never touches control flow

Every telemetry emit is fire-and-forget behind a bounded timeout, and it never changes control flow. The supervisor's error seam (`onError`), the escalation hosted sink, the install-health heartbeat, and the lifecycle capture events all follow this: the emit is not awaited in a way that can block, it is wrapped so it cannot throw, and a failure is a warn log. The chokepoint itself (`emitTelemetry`) resolves an outcome but never rejects. The rule: telemetry is observation, never a dependency; a new emit is fire-and-forget, fail-soft, and gated behind the opt-out (see [../telemetry/outbound-telemetry-and-privacy.md](../telemetry/outbound-telemetry-and-privacy.md)).

## The quality gate

All of this is enforced locally and in CI by one recipe: `npm run ci` is `tsc --noEmit` plus `vitest run`, with no ESLint or Prettier layer. The repo is self-contained with its own `tsconfig.json` and `vitest.config.ts`, strict ESM on Node 22. Because every external action is an injected seam, the test suite runs the whole assembly without a real socket, npm, or network, which is what makes the crash-safety claims testable rather than aspirational. The build and release side of this is in [../infrastructure/build-and-release.md](../infrastructure/build-and-release.md).

## The reviewer's checklist

When you review a doctor change, these are the questions each pattern turns into:

- Does a new external action throw into the loop, or resolve a value? (Pattern 1)
- Is a new I/O or time dependency injected, or imported and called directly? (Pattern 2)
- Does new external input reach a syscall or a URL without a defensive coercion that defaults? (Pattern 3)
- Does a new composed file path skip `resolveInBase` / `assertWithinBase`? (Pattern 4)
- Does a new shell-out use anything other than the runner seam with an argv array, or compose a version into an npm spec without semver validation? (Pattern 5)
- Does the change add a runtime `dependencies` entry, or reach for a built-in? (Pattern 6)
- Is a new durable write atomic and defensive? (Pattern 7)
- Does a new telemetry emit stay fire-and-forget, fail-soft, and gated? (Pattern 8)
