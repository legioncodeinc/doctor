# Security Audit - PRD-003b / PRD-003c (fleet lifecycle: `start`/`stop`, three-part `uninstall`, `doctor purge`)

- **Date:** 2026-07-04
- **Auditor:** security-worker-bee (armed with security-stinger)
- **Repo:** doctor (`@legioncodeinc/doctor`)
- **Branch:** `feature/fleet-lifecycle` (uncommitted changes + untracked files only)
- **Scope:** the PRD-003 doctor diff: `src/purge/{inventory,engine}.ts`, `src/product-uninstall.ts`, the `ConfirmTokenFn` typed-confirmation seam (`src/cli/{context,index,dispatch}.ts`), `startCommands`/`stopCommands` + `ServiceLifecycleModule` (`src/service/{argv,index}.ts`), the generic `deleteRegistryEntry` (`src/registry.ts`), the `isServiceRegistered` probe, and the new tests.
- **Ordering check:** no QA report exists for this branch (`library/qa/quality/` holds only PRD-004 and the 2026-07-03 gap review). Security runs first; `quality-worker-bee` may follow.
- **`npm audit`:** 0 vulnerabilities (doctor is zero-runtime-dependency; devDependencies clean).

## Executive summary

Scope note: doctor is NOT the Hivemind stack. It has no Deeplake client, no MCP server, no pre-tool-use VFS gate, and no captured traces, so the Stinger's Hivemind-specific catalogs (Deeplake SQL injection, trace PII, prompt injection) do not apply verbatim. The audit was adapted to this branch's real attack surface, which the PRD itself names the run's most dangerous: `doctor purge`, a recursive machine-wipe verb, plus the three-part `uninstall` and the fixed-argv service lifecycle.

One High and one Medium finding were remediated in place; two Low findings are documented as accepted. The single most important finding: the purge engine recursively deleted whatever directory the env-driven fleet-root chain resolved to, with no floor against a filesystem root, the home directory, or an ancestor of home, and without ever showing the operator the resolved path at the confirmation prompt. A poisoned or mistaken `APIARY_HOME` (or `XDG_STATE_HOME` on Linux) plus `doctor purge --yes` was a whole-home / whole-disk wipe. A fail-closed wipe-target guard now refuses those three shapes on both the purge and uninstall paths, and the pre-confirmation summary now names the resolved root. The gate is green after remediation (`npm run ci` exit 0: typecheck clean, 65 files / 779 tests, 6 of them new guard tests). No runtime dependency was added.

| # | Severity | Title | Status |
|---|----------|-------|--------|
| 1 | High | `purge` fleet-root wipe target is env-driven with no root/home floor and no resolved-path disclosure at the confirmation | Remediated |
| 2 | Medium | `uninstall` state-dir removal (`<root>/doctor`) can resolve to the home directory under a degenerate `APIARY_HOME` | Remediated |
| 3 | Low | `--yes=<non-empty string>` (e.g. `--yes=no`) satisfies `hasFlag` and bypasses the purge confirmation | Accepted risk |
| 4 | Low | `PurgeFs.exists` uses `existsSync`, which follows symlinks: a dangling symlink at a state-dir target is skipped, not removed | Accepted risk |
| - | Clean | Purge allow-list closure (no glob, no traversal, no registry/user-derived deletion target) | Verified |
| - | Clean | Symlink semantics of the actual fs calls (`rmSync` recursive never dereferences) | Verified |
| - | Clean | Typed-token confirmation integrity (piped stdin / EOF / empty input / absent seams all refuse) | Verified |
| - | Clean | Command execution: fixed-argv `execFile`, no shell, enumerated names only | Verified |
| - | Clean | System-scope survivor REPORT lines built from compile-time constants only (sudo copy-paste safe) | Verified |
| - | Clean | `isServiceRegistered` probe (read-only, constant plan-derived paths, ambiguity biases safe) | Verified |
| - | Clean | Self-removal ordering cannot be reordered by a crafted failure | Verified |
| - | Clean | `deleteRegistryEntry` (atomic write, preserves foreign keys, fail-soft on malformed JSON) | Verified |
| - | Clean | No token / credential / PII leakage to logs or report lines | Verified |

---

## Finding 1 - env-driven purge wipe target with no floor and no disclosure (High) - REMEDIATED

**Location:** `src/purge/engine.ts` step (3) (`const fleetRoot = resolveApiaryRoot(env, home, platform)` followed by `removeStateDirIfPresent(fs, fleetRoot, ...)`, pre-fix ~line 316-317), with `src/apiary-root.ts:76-98` as the resolution chain and `purgeSummaryLines()` (pre-fix line 222) as the confirmation copy.

**Description.** Purge deliberately targets the LIVE resolved fleet root (ledger-frozen decision: "a customized install is fully wiped too"), and the resolver honors `APIARY_HOME` on every platform and `XDG_STATE_HOME` on Linux. Absolute-only enforcement exists (`isAbsoluteRoot` via `win32.isAbsolute`, so a relative value can never anchor on cwd), but an absolute value can still name a catastrophic directory. `APIARY_HOME=/`, `APIARY_HOME=C:\`, `APIARY_HOME=$HOME`, or `APIARY_HOME=/home` each flowed straight into `rmSync(fleetRoot, { recursive: true, force: true })`, turning the fleet-root step into a whole-disk or whole-home recursive delete. Two factors amplified it to High on this verb specifically: (a) `doctor purge --yes` runs the wipe with zero prompts, so a leaked or scripted env var needs no operator interaction; (b) even interactively, `purgeSummaryLines()` said only "default ~/.apiary" and never displayed the resolved path, so the typed-token gate could not inform the operator that the target had been redirected.

**Severity rationale.** Destructive scope amplification of the machine-wipe verb via an environment variable, on the exact focus surface the PRD calls "no env-driven path that an attacker-controlled environment variable could point at an arbitrary directory". Data destruction rather than data theft, but blast radius is the entire home directory or filesystem. High.

**Remediation.**

- New `isForbiddenWipeTarget(target, home)` in `src/safe-path.ts` (the repo's existing path-safety module): refuses (returns true) when the resolved target is a filesystem root (`parse(x).root === x`, covering `/`, `C:\`, `\\server\share\`), the home directory itself, or an ancestor of home (trailing-separator compare, so `/home/us` is never treated as an ancestor of `/home/user`). Fail-closed: an unresolvable comparison refuses. A legitimate fleet root is always a dedicated directory, so the guard never blocks a real install (proven by the sibling-custom-root test).
- `src/purge/engine.ts` step (3): the fleet-root removal is now gated on the guard; a forbidden target produces a hard `FAILED ... REFUSED` outcome naming `APIARY_HOME / XDG_STATE_HOME`, which (per the existing c-AC-4 machinery) also blocks steps (4)/(5), so doctor's own service and package are never touched after a refusal.
- Disclosure: `purgeSummaryLines()` takes an optional `resolvedFleetRoot`; the engine's `summaryLines()` now passes the live resolved root, so the pre-confirmation summary names the actual directory an env override points at before the operator types `purge`.

**Tests (`tests/purge/engine.test.ts`, new `c-AC-5/AC-8 security guard` block):**
- `APIARY_HOME=$HOME` is refused: nothing removed, report fails, `REFUSED`/`APIARY_HOME` line present, doctor's own uninstall never called;
- `APIARY_HOME=/` (filesystem root) is refused;
- `APIARY_HOME=/home` (ancestor of `/home/tester`) is refused;
- a legitimate dedicated custom root (`/srv/apiary-state`) still purges normally;
- `summaryLines()` names the resolved root under an `APIARY_HOME` override.

---

## Finding 2 - `uninstall` state-dir removal can resolve to home (Medium) - REMEDIATED

**Location:** `src/product-uninstall.ts` `removeProductState` (pre-fix ~line 131: `rmSync(resolveOwnStateDir(...), { recursive: true, force: true })`).

**Description.** `doctor uninstall` removes `<fleetRoot>/doctor`. The `doctor` segment is a fixed literal and `resolveInBase` asserts containment under the root, but the ROOT is the same env-driven value as Finding 1. In the degenerate shape where home's basename is `doctor` and `APIARY_HOME` names home's parent, `<root>/doctor` resolves to the home directory itself, and the recursive delete would wipe it. Narrower than Finding 1 (the target is always one fixed segment below the root, never the root itself), hence Medium.

**Remediation.** `removeProductState` now routes the resolved target through the same `isForbiddenWipeTarget` guard before the existence check; a forbidden target reports `stateDirRemoved: false` and deletes nothing (4 lines, inside the Medium <5-line fix window).

**Test (`tests/product-uninstall.test.ts`):** the crafted `APIARY_HOME=<parent-of-home>` + home-named-`doctor` shape refuses; the planted `precious.txt` inside home survives.

---

## Finding 3 - `--yes=<non-empty>` bypasses the purge confirmation (Low) - ACCEPTED RISK

**Location:** `src/cli/arg-parse.ts:73-75` (`hasFlag`), consumed by `runPurge` (`src/cli/dispatch.ts`).

**Description.** `hasFlag` returns true for a boolean `--yes` AND for any non-empty string value, so `doctor purge --yes=no` (or `--yes no`, which the parser binds as a value) bypasses the confirmation exactly like `--yes`. The operator still had to type a `--yes...` token on the purge command line, so intent to bypass is explicit; the confusion is that a value spelled `no` reads as a negation. This is pre-existing shared parser behavior (`update --check`, `--json` use the same helper), not new to this branch.

**Decision.** Accepted risk (Low). A stricter purge-only check (`flags.yes === true`) would diverge purge's flag semantics from every other verb's; document instead. Flag for `quality-worker-bee` to weigh as UX.

## Finding 4 - `exists` follows symlinks; dangling links are skipped (Low) - ACCEPTED RISK

**Location:** `src/purge/engine.ts` `createNodePurgeFs` (`exists: existsSync`).

**Description.** `existsSync` dereferences symlinks. A DANGLING symlink sitting at a state-dir target (e.g. `~/.hivemind -> /gone`) reports "not present" and is left on disk, so purge under-reports cleanup by one dead link. The removal direction is unaffected: when the link target exists, `rmSync` unlinks the link itself without entering the target (see verified-clean below), so this is a hygiene gap, never a traversal.

**Decision.** Accepted risk (Low). An `lstatSync`-based probe would remove the dead link too; cosmetic.

---

## Verified-clean surfaces (per the PRD's five focus areas)

### (1) Purge allow-list closure and symlink semantics

- Every deletion target is one of: the guarded resolved fleet root; `join(home, ".deeplake" | ".hivemind")`; `legacyHoneycombRoot(home)` (`~/.honeycomb`). All are absolute paths anchored on the injected home (`homedir()` in production, `src/cli/index.ts:123`) plus fixed literal directory names from the frozen `STATE_DIR_NAMES` table. No glob expansion exists anywhere in `src/purge/` (grep-verified: no `glob`, no `readdir`-and-match, no wildcard).
- No deletion target is ever derived from the registry, argv, or any user-supplied string. The `c-AC-5` tests pin the exact removal set and the exact argv name set against made-up entries.
- `rmSync(path, { recursive: true, force: true })` (both `createNodePurgeFs.removeDir` and `removeProductState`'s default) uses `lstat` semantics: a symlink encountered inside a tree is unlinked, not entered, and a target path that IS a symlinked dir has the link removed rather than the referent's contents. A planted symlink can therefore never redirect the delete outside a root. `force: true` keeps absent paths a no-op (idempotent re-run).

### (2) Confirmation integrity (`ConfirmTokenFn`)

- Piped / non-TTY stdin without `--yes`: `runPurge` refuses with instructions and `EXIT_DECLINED` before any prompt (`ctx.isInteractive?.() ?? false`, absent seam = non-interactive = refuse). `realConfirmToken` independently re-checks `process.stdin.isTTY` so it is safe standalone and never blocks on input that cannot arrive.
- EOF / empty / wrong-case input: only an exact trimmed match of the literal `purge` resolves true; `""`, `PURGE`, `y` all abort with no changes. An absent `confirmToken` seam is treated as "cannot confirm" (declines), never as consent.
- `--yes` is the only bypass (subject to Finding 3's Low nit), and the `--yes` path prints no prompt but still runs the identical engine. The gate lives in the dispatcher, not the engine, so no alternate code path reaches `p.run()` unconfirmed; `tests/cli/purge.test.ts` pins all four gate behaviors.
- The weaker y/N `ConfirmFn` (`realConfirm`) is untouched and purge never uses it; the two seams are separate types, so neither can weaken the other.

### (3) Command execution

- Every service/npm removal flows through the injected `CommandRunner` = `createExecFileRunner()` (`src/rungs/command-runner.ts`): `execFile`, `shell: false`, `windowsHide`, output-capped, timeout-bounded. The only `shell: true` path is the documented win32 `npm.cmd` last-resort fallback, and purge's npm argv (`ls -g <pkg> --depth 0`, `uninstall -g <pkg>`) consists exclusively of fixed literals plus frozen inventory package names, so no attacker-controlled token can reach that shell.
- Unit/task names in argv come only from `OTHER_PRODUCTS` / `DOCTOR_UNIT_NAMES` / `LEGACY_NPM_PACKAGES` (compile-time constants in `src/purge/inventory.ts`) and `src/service/platform.ts` constants. The launchd domain uses a numeric `uid` from `process.getuid`. Nothing registry-derived or user-derived is ever placed in argv (pinned by the `c-AC-5` enumerated-names test).
- The system-scope survivor REPORT lines (`sudo launchctl bootout system/<label>`, `sudo systemctl disable --now <unit>`, `sudo rm <path>`) are built from `ALL_PRODUCT_UNIT_NAMES` and `systemScopeLaunchdPath`/`systemScopeSystemdPath`, i.e. exclusively from the same compile-time constants. A malicious registry entry name cannot reach the copy-paste-into-sudo string: the registry is never read by the purge engine at all.
- `startCommands` / `stopCommands` (`src/service/argv.ts`) are pure constant-argv builders over the plan's fixed label/unit/task names; the exec path never enters start/stop argv.

### (4) `isServiceRegistered` probe

- Read-only. For launchd/systemd it checks `fs.exists(plan.unitPath)`, where `unitPath` is composed from `homedir()` plus fixed constants in `src/service/platform.ts` (`userUnitPath`/`systemUnitPath`); no user-derived or registry-derived segment exists, so no crafted unit path can be injected. For schtasks/sc it delegates to the existing bounded `serviceStatus` query.
- Ambiguity (unresolved plan, fs error, spawn error) biases to `true` = "registered", whose worst case is an extra idempotent, best-effort deregister attempt; the dangerous direction (false no-op leaving a unit registered) is structurally excluded.

### (5) Self-removal ordering

- The order is sequential code, not data-driven: (1) other services, (1b) survivor report, (2) npm packages, (3) state dirs, then the `hardFailures` gate, then (4) doctor's own service, then (5) doctor's own package. A crafted failure can only ABORT progression at the gate (now including the Finding 1 refusal), never reorder it; steps inside (1)-(3) tolerate each other's failures so one failure cannot hide the rest of the report. `serviceModule.uninstall()` exceptions are caught and reported. The `c-AC-4` tests pin skip-and-resume.

### Registry delete writer

- `deleteRegistryEntry` (`src/registry.ts`) writes atomically (random-suffixed temp file + `renameSync` in the same directory), removes only the matching `daemons` array element, preserves every other entry and every unrecognized top-level key verbatim, and fails soft on absent/malformed/unwritable files WITHOUT ever overwriting content it cannot parse (no destructive "repair"). Callers pass the fixed literal `"doctor"`. JSON round-trip, no string interpolation, no injection surface.

### Leakage

- No credential, token, or captured-trace content exists in this repo. Report lines and log events carry only paths, package names, unit names, and exit-code details. The one credential-adjacent action, deleting `~/.deeplake`, is named explicitly (with the standalone-Hivemind warning) in the confirmation summary per c-AC-1.

---

## Files changed (remediation)

| File | Change |
|---|---|
| `src/safe-path.ts` | New `isForbiddenWipeTarget(target, home)` guard (fail-closed; filesystem root / home / ancestor-of-home). |
| `src/purge/engine.ts` | Fleet-root removal gated on the guard (hard REFUSED failure blocks doctor-self steps); `purgeSummaryLines(resolvedFleetRoot?)` + engine `summaryLines()` disclose the resolved root. |
| `src/product-uninstall.ts` | `removeProductState` routes the state-dir target through the same guard. |
| `tests/purge/engine.test.ts` | 5 new tests: three forbidden shapes refused, legitimate custom root still purges, summary discloses resolved root. |
| `tests/product-uninstall.test.ts` | 1 new test: degenerate `APIARY_HOME` shape refuses instead of deleting home. |

Diff reviewed post-remediation (`git diff`): security-scoped only; no unrelated changes.

## Gate

`npm run ci` after remediation: exit 0. Typecheck clean; 65 test files, 779 tests passed (6 new); `npm audit` 0 vulnerabilities. Changes left uncommitted per the run contract.

## Recommended follow-up

- The 003d uninstall scripts (`scripts/install/uninstall.sh` / `.ps1`, superproject scope, audited separately) implement the same fleet-root deletion from the same env chain; the sibling auditor should confirm an equivalent root/home floor exists there.
- Finding 3 (`--yes=no`) is worth a parser-level ruling (strict boolean for destructive verbs) in a hygiene pass.
