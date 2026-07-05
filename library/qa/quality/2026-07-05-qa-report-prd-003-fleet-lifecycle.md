# QA Report: PRD-003b + PRD-003c doctor scope (fleet lifecycle: `start`/`stop`/`uninstall`, `doctor purge`)

**Plan documents:**
- `library/requirements/backlog/prd-003-fleet-lifecycle-login-and-uninstall/prd-003b-fleet-lifecycle-login-and-uninstall-lifecycle-command-parity.md` (b-AC-1..7, doctor scope)
- `library/requirements/backlog/prd-003-fleet-lifecycle-login-and-uninstall/prd-003c-fleet-lifecycle-login-and-uninstall-doctor-purge.md` (c-AC-1..6)
- `library/requirements/backlog/prd-003-fleet-lifecycle-login-and-uninstall/prd-003-fleet-lifecycle-login-and-uninstall-index.md` (module AC-5/AC-8/AC-9, doctor scope)
- `library/ledger/EXECUTION_LEDGER-fleet-lifecycle.md` (orchestrator decisions 5/7/8/9/13, the frozen coverage inventory, the four accepted W1-D deviations, the W2-Dfix cycle, and the security wave)

**Base branch:** `feature/fleet-lifecycle` at `93632f4` (all PRD-003 doctor work is uncommitted in the worktree on top of this commit)
**Repo:** doctor (`@legioncodeinc/doctor`)
**Auditor:** quality-worker-bee (armed with quality-stinger)

## Ordering check

`security-worker-bee` ran first on this branch. Its report (`library/qa/security/2026-07-04-security-audit-prd-003-fleet-lifecycle.md`) found and remediated one High (env-driven purge wipe target with no root/home floor and no resolved-path disclosure; fixed via `isForbiddenWipeTarget` in `src/safe-path.ts` plus the resolved-root line in the confirmation summary) and one Medium (the same class on `uninstall`'s state-dir removal), and documented two Lows as accepted risk. Its gate was green at hand-off (`npm run ci` exit 0, 65 files / 779 tests). Ordering is correct; this audit proceeds against the post-security-fix code and explicitly re-verifies that the security guard did not regress c-AC-2 or c-AC-6.

## Summary

The PRD-003b doctor scope and all of PRD-003c are substantively complete: all 7 b-AC and all 6 c-AC criteria plus the module-level AC-5/AC-8/AC-9 (doctor scope) are met with direct code and test evidence, both PRDs' non-goals are honored, the frozen coverage inventory in `src/purge/inventory.ts` matches the ledger's coverage table literally (diffed name by name below), purge is reachable only through the user-initiated `purge` CLI verb (never from the remediation ladder), and the security wave's `isForbiddenWipeTarget` guard did not regress the legitimate-custom-root or clean-machine paths. During this audit I found and fixed one Warning-level defect: `doctor uninstall` on a partially uninstalled machine (unit already deregistered, e.g. via a prior `uninstall-service`, with a stale registry entry or state dir remaining) completed the cleanup successfully but exited 1, because the service module reports `ok: false` for the already-gone-unit shape and the dispatcher returned that verbatim; this is the same already-absent classification gap that nectar (W2-Nfix) and hive (W3-Vfix) were each fixed for, and it violated b-AC-6's "already uninstalled exits 0" clause and AC-9's honest-termination contract. The fix keys exit-code forgiveness on the confident not-registered probe signal already in scope (ambiguity still biases to strict non-zero) and is pinned by two new tests. The security wave's remaining Low (`--yes=no` satisfies the shared `hasFlag` parser) is ruled DOCUMENT, not fix (rationale in Suggestions). One Suggestion (a stale `restart` menu summary) is noted for follow-up. The gate is green after the fix (`npm run ci` exit 0: typecheck clean, 65 test files, 781 tests, 2 of them new this audit). **Recommend shipping.**

## Scorecard

| Category      | Status | Notes |
|---------------|--------|-------|
| Completeness  | ✅ | 7/7 b-AC (doctor scope) and 6/6 c-AC pass with direct code + test evidence; module AC-5/8/9 (doctor scope) covered; both PRDs' non-goals honored (no npm-package removal in `uninstall`, purge never a remediation rung, nothing outside the allow-list). |
| Correctness   | ✅ | Purge ordering (others' services -> npm -> state dirs -> hard-failure gate -> doctor-self service -> doctor-self package last), typed-token gate, `--yes`-only bypass, registration-evidence no-op precheck, and the atomic generic registry delete all match the plan and the ledger's orchestrator decisions 5/7/9/13. One exit-code honesty defect found and FIXED this audit (see Warnings). |
| Alignment     | ✅ | Files land where the PRD's implementation notes point (`command-table.ts`/`dispatch.ts` for the menu + confirm plumbing, the rung-3 `CommandRunner` seam generalized for package removal, code-derived inventory); the four W1-D accepted deviations and the W2-Dfix additions are all present exactly as the ledger records them. |
| Gaps          | ⚠️ | One Warning found and FIXED (uninstall exit-code dishonesty on an already-absent unit); the security wave's two accepted Lows re-affirmed (one formally ruled DOCUMENT per this audit's mandate); two Suggestions noted. |
| Detrimental   | ✅ | No regressions: every pre-security-audit behavior of run/status/diagnose/heal/reinstall/uninstall-hivemind/update/self-update/install-service/uninstall-service/logs/help is untouched (diff-verified additive-only in `dispatch.ts`/`command-table.ts`); the one intentional behavior change (`restart`'s rung-1 RestartFn now stop+starts Doctor's own service) is ledger-documented accepted deviation 1; no test deleted or weakened (all diffs to existing test files are additive; `tests/service/helpers.ts` gained a backward-compatible `exists` seam); zero new runtime dependencies (repo stays zero-dep); the diff sweep found no two-word misspellings of Deeplake and no em/en dashes. |

## Critical Issues (must fix)

None.

## Warnings (should fix)

- [x] **FIXED - `doctor uninstall` exited 1 after a successful cleanup when the unit was already absent** - `src/cli/dispatch.ts:310` (pre-fix: the final `return serviceResult.ok ? EXIT_OK : EXIT_ERROR;` of `runUninstall`)

  b-AC-6 requires "`uninstall` on a product that is not installed **(or already uninstalled)** exits 0", and AC-9 requires every flow to "succeed with a clear message or fail with a plain-language, actionable error". The fully-clean machine correctly took the friendly no-op path, but the partially uninstalled shape was reachable and dishonest: after a prior `doctor uninstall-service` (which removes only the unit), a stale registry entry or state dir makes the precheck proceed, `serviceModule.uninstall()` then reports `ok: false` for the already-gone unit (its own message says "often because it was already gone", `src/service/index.ts:293-300`), and `runUninstall` returned that verbatim as `EXIT_ERROR` even though the registry entry and state dir were removed successfully. Doctor was the only fleet member without an already-absent classification: nectar received exactly this fix in W2-Nfix ("already-absent stays a friendly exit-0 no-op") and hive in W3-Vfix (the `isAlreadyAbsentFailure` classifier), per the ledger run log. The purge engine even documents the underlying shape ("its own `uninstall()` reports ok:false even for the extremely common 'was never registered' case", `src/purge/engine.ts:369-371`) and tolerates it there, but the `uninstall` verb did not.

  **Remediation applied:** the dispatcher already holds a confident registration signal (`servicePresent`, from `isServiceRegistered()` + `serviceStatusAsync()`, both of which bias to "present" on any ambiguity). The exit code now forgives a deregister failure only when that probe confidently reported the unit unregistered and not running before the uninstall began; a genuine deregister failure on a registered, running, or ambiguous unit still exits non-zero:

  ```ts
  // src/cli/dispatch.ts (after fix)
  return serviceResult.ok || !servicePresent ? EXIT_OK : EXIT_ERROR;
  ```

  Two new regression tests in `tests/cli/lifecycle-commands.test.ts`: "a failed service uninstall on a REGISTERED unit still maps to a non-zero exit" (the strict direction is preserved) and "b-AC-6/AC-9: an already-absent unit (stale registry/state only) exits 0 even when the deregister command reports an error" (the fixed direction, asserting the registry cleanup still ran and was reported).

## Suggestions (consider improving)

- [ ] **RULED: DOCUMENT, not fix - `--yes=<non-empty>` (e.g. `--yes=no`) satisfies `hasFlag` and bypasses the purge confirmation** - `src/cli/arg-parse.ts:73-75`, consumed at `src/cli/dispatch.ts:331` (`runPurge`)

  This audit was asked to rule on the security wave's remaining Low. Ruling: **document as accepted, do not fix on this branch.** Rationale: (1) it is pre-existing shared parser behavior, not introduced by PRD-003 - `heal --yes` (`dispatch.ts:152`), the rung gates (`dispatch.ts:172`), `update --check` (`dispatch.ts:201`), and `--version` (`dispatch.ts:451`) all read the same helper, so a purge-only `flags.yes === true` check would silently diverge one verb's flag semantics from every other verb's, and a global `hasFlag` change would alter four pre-existing verbs' contracts (and their tests) outside this PRD's scope under audit-time pressure; (2) no acceptance criterion requires `--yes=no` to be treated as refusal - c-AC-2 requires only that `--yes` bypasses, and the operator must still deliberately type a `--yes...` token on a command line that begins with the word `purge`, so intent to bypass is explicit and the gate is never weakened for anyone who passed no `--yes` token at all; (3) the 003d uninstall scripts carry their own independent flag parsing, so a correct fix is a small fleet-wide hygiene decision (strict boolean `--yes` for destructive verbs everywhere), best made deliberately as a follow-up issue rather than as a one-repo divergence. Recommended follow-up: a parser-level strict-boolean mode for destructive verbs, applied to doctor `purge` and the 003d scripts in the same pass.

- [ ] **Stale `restart` menu summary after the rung-1 RestartFn rewire** - `src/cli/command-table.ts:54` vs `src/cli/index.ts:203-216`

  The menu still says "Restart the primary daemon (rung 1)." but the CLI's rung-1 RestartFn now stop+starts DOCTOR'S OWN service (`serviceStop` + `serviceStart` of `com.legioncode.doctor`), per ledger-accepted deviation 1; the code comment itself concedes "a deliberate, narrower scope than the menu text implies". Before this branch the same menu line sat over a RestartFn that always returned false, so the copy was already inaccurate, and no AC governs it, hence Suggestion rather than Warning and not fixed under audit (the honest wording depends on a product decision: whether `doctor restart` should someday drive the primary daemon's own service surface, which belongs to `library-worker-bee`). Suggested interim copy: "Restart Doctor's own watchdog service (rung 1; the watchdog then re-probes and heals the primary daemon)."

- [ ] **Purge's clean-machine path still shells out best-effort deregisters before deciding "nothing to remove"** - `src/purge/engine.ts:268-278, 379-401`

  On a machine with zero Apiary assets, `purge --yes` still attempts every enumerated deregister argv and doctor's own `serviceModule.uninstall()` before concluding `nothingToRemove`. All attempts are idempotent, tolerated, and constant-argv, and c-AC-6 is satisfied (exit 0, single friendly line, pinned by test), so this is purely cosmetic process noise (a dozen short-lived no-op manager invocations). Consider probing before deregistering if anyone ever cares; noting only so the behavior is on record as intentional.

## Audit-specific verifications (the five items this audit was tasked with)

### 1. Security guard did not regress c-AC-2 / c-AC-6; confirmation copy complete

**PASS.** The `isForbiddenWipeTarget` gate (`src/purge/engine.ts:331`) refuses only a filesystem root, the home dir itself, or an ancestor of home. A legitimate custom absolute multi-segment `APIARY_HOME` still purges: pinned twice, pre-dating and post-dating the guard (`tests/purge/engine.test.ts:416-432` "/mnt/custom-apiary" honored; `tests/purge/engine.test.ts:489-497` "/srv/apiary-state" "still allows a legitimate dedicated custom root"). A clean machine still no-ops exit 0 (`tests/purge/engine.test.ts:388-399` engine level: `ok: true`, `nothingToRemove: true`, single friendly line; `tests/cli/purge.test.ts:92-99` CLI level: `EXIT_OK`). The c-AC-1 confirmation copy (`purgeSummaryLines`, `src/purge/engine.ts:228-238`) names every category the AC requires: the fleet root **with the live resolved path** (`resolved: <dir>`, threaded from `resolveApiaryRoot` at `engine.ts:257` and pinned by `tests/purge/engine.test.ts:401-414`), `~/.deeplake` **with the shared-credentials language** ("shared Deeplake credentials. This directory is ALSO used by a standalone Hivemind (\"@deeplake/hivemind\") install if you have one; removing it will sign that out too", pinned by `tests/purge/engine.test.ts:67-73`), the legacy `~/.hivemind`/`~/.honeycomb` dirs, all services current AND legacy, all npm packages including `@deeplake/hivemind`, and doctor's own service + package removed last.

### 2. Purge inventory coherence against the ledger's frozen table

**PASS - literal diff, every cell matches.** `src/purge/inventory.ts` vs the ledger's "Coverage inventory (FROZEN 2026-07-04 22:35)":

| Ledger cell | Inventory constant | Match |
|---|---|---|
| npm current: `@legioncodeinc/{honeycomb,nectar,hive,doctor}` | `OTHER_PRODUCTS[].npmPackage` x3 + `DOCTOR_NPM_PACKAGE` | ✅ |
| npm legacy: `@deeplake/hivemind` only (no unscoped names ever shipped) | `LEGACY_NPM_PACKAGES = ["@deeplake/hivemind"]` | ✅ |
| launchd current: `com.legioncode.{honeycomb,nectar,doctor,hive}` | `OTHER_PRODUCTS[].launchdLabel.current` x3 + `DOCTOR_UNIT_NAMES.launchdLabel.current` (= `SERVICE_LABEL` `com.legioncode.doctor`, `src/service/platform.ts:44`) | ✅ |
| launchd legacy: `ai.honeycomb.daemon` / `com.hivenectar.daemon` / `com.legioncode.hivedoctor` / `thehive` | `.legacy` arrays + `LEGACY_SERVICE_LABEL` (`platform.ts:53`) | ✅ |
| systemd current: `{honeycomb,nectar,doctor,hive}.service` | `.systemdUnit.current` x3 + `SYSTEMD_UNIT_NAME` (`platform.ts:47`) | ✅ |
| systemd legacy: `ai.honeycomb.daemon.service` / `hivenectar.service` / `hivedoctor.service` / `thehive.service` | `.legacy` arrays + `LEGACY_SYSTEMD_UNIT_NAME` (`platform.ts:56`) | ✅ |
| schtasks current: `honeycomb` / `nectar` / `doctor` / `hive` | `.windowsTask.current` x3 + `WINDOWS_TASK_NAME` (`platform.ts:50`) | ✅ |
| schtasks legacy: `HoneycombDaemon` / `HivenectarDaemon` / `HiveDoctor` / `thehive` | `.legacy` arrays + `LEGACY_WINDOWS_TASK_NAME` (`platform.ts:59`) | ✅ |
| Windows `sc` system scope, same name family | `deregisterScScope` attempted per name on win32, engine steps 1 and 4 (`engine.ts:273-275, 383-392`); pinned by `tests/purge/engine.test.ts:251-272` | ✅ |
| Four state roots: `~/.apiary` (resolved live), `~/.deeplake`, `~/.hivemind`, `~/.honeycomb` | resolved `resolveApiaryRoot` value + `STATE_DIR_NAMES` (`.deeplake`/`.hivemind`) + `legacyHoneycombRoot` (`engine.ts:330-350`) | ✅ |
| Registry locations: `~/.apiary/registry.json` and legacy `~/.honeycomb/doctor.daemons.json` | die with their containing roots (fleet root and `~/.honeycomb` are removed whole) | ✅ |
| System-scope paths (report-only): `/Library/LaunchDaemons/<label>.plist`, `/etc/systemd/system/<unit>` | `systemScopeLaunchdPath`/`systemScopeSystemdPath` (`inventory.ts:93-103`), report-only with the exact sudo command, all four products including doctor's own (`ALL_PRODUCT_UNIT_NAMES`, `engine.ts:50-53, 287-313`) | ✅ |

Doctor's own names are imported from `service/platform.ts` rather than re-declared (single drift point), and `tests/purge/inventory.test.ts` pins the whole table verbatim so any future drift fails the suite.

### 3. Purge is user-initiated only; `--yes` is the only bypass

**PASS.** Grep across `src/` finds purge referenced only in `cli/command-table.ts`, `cli/dispatch.ts`, `cli/context.ts`, `cli/index.ts`, and a comment in `safe-path.ts`; nothing in `src/remediation.ts`, `src/rungs/`, `src/compose/`, or `src/supervisor.ts` imports or invokes it, so the remediation ladder (rungs 1-3 + escalate) cannot reach it and it never runs unattended (PRD-003c non-goal honored). The only entry is `route()`'s `case "purge"` (`dispatch.ts:424-425`). Inside `runPurge` the only non-interactive path to `p.run()` is `hasFlag(parsed, "yes")` (`dispatch.ts:331`); without it, a non-TTY stdin refuses with instructions (`EXIT_DECLINED`, never hangs), and an interactive stdin must type the exact literal token `purge` through the dedicated `ConfirmTokenFn` seam, with an absent seam treated as "cannot confirm". The weaker y/N `ConfirmFn` is a separate type purge never touches. All four gate behaviors pinned in `tests/cli/purge.test.ts:29-81`.

### 4. Regression sweep of the pre-existing command surface

**PASS (one Warning fixed, above).** Diff review of `src/cli/command-table.ts`, `src/cli/dispatch.ts`, and `src/cli/index.ts`: `run`, `status`, `diagnose`, `heal`, `reinstall`, `uninstall-hivemind`, `update`, `self-update`, `install-service`, `uninstall-service`, `logs`, and `help` are byte-untouched in dispatch logic (the diff adds only the four new route cases, the four new handler functions, and a type import). `uninstall-service` deliberately stays service-unit-only and never calls the new `productUninstall` seam (pinned by `tests/cli/lifecycle-commands.test.ts:284-298`, satisfying b-AC-5 via the accepted deviation 2 posture: kept byte-identical rather than literally aliased). The one intentional behavior change is `restart`/`heal`'s rung-1 RestartFn (`cli/index.ts:203-225`), the ledger's accepted deviation 1 (see Suggestions for the menu-copy follow-up). The command menu lists the new verbs with honest summaries: `start`/`stop` name Doctor's own watchdog service, `uninstall` says exactly what it removes and that the npm package is kept, and `purge` leads with "DESTRUCTIVE:" and names full-machine scope with Doctor last (`command-table.ts:61-70`; presence pinned by `tests/cli/command-table.test.ts:40-48`). `ServiceFs` gained a required `exists` member (internal seam; all in-repo implementations updated) and `createServiceModule`'s return type widened to `FullServiceModule`, both backward-compatible for every existing call site; existing service-module install/uninstall bodies are unchanged.

### 5. Ruling on the security wave's remaining Low (`--yes=no`)

**Ruled DOCUMENT, not fix** - full rationale in the first Suggestion above.

## Plan Item Traceability

| # | Plan Requirement | Status | Implementation Location | Notes |
|---|---|---|---|---|
| b-AC-1 | doctor exposes `start`/`stop` that start/stop its daemon on macOS, Linux, Windows | ✅ | `src/service/argv.ts:133-174` (`startCommands`/`stopCommands`, all four managers), `src/service/index.ts:308-363` (module `start`/`stop`) + `366-410` (standalone `serviceStart`/`serviceStop`), `src/cli/dispatch.ts:247-256` (`runStartStop`), wired `cli/index.ts` (`serviceLifecycle: serviceModule`); `tests/service/argv.test.ts` (exact argv per manager), `tests/service/service-module.test.ts` ("start/stop (PRD-003b b-AC-1)"), `tests/cli/lifecycle-commands.test.ts:15-63` | Doctor controls only its OWN service (there is no cross-product service-control surface); consistent with each product owning its registration. |
| b-AC-2 | `uninstall` removes the OS unit, current label plus best-effort legacy label | ✅ | `src/cli/index.ts` `productUninstall.serviceUninstall` = `deregisterLegacyUnit(serviceDeps)` (`src/service/index.ts:443-471`) then `serviceModule.uninstall()` (unchanged 064b path incl. unit-file delete); `tests/service/service-module.test.ts` ("deregisterLegacyUnit" block: linux/darwin/win32 + tolerance) | |
| b-AC-3 | `uninstall` deletes doctor's registry entry, leaving other entries intact | ✅ | `src/registry.ts:597-668` (`deleteRegistryEntry`: atomic temp+rename, one matching array element only, preserves foreign entries + unknown top-level keys, fail-soft); called via `removeProductState` (`src/product-uninstall.ts:127`); `tests/registry.test.ts` ("deleteRegistryEntry (PRD-003b)", 8 tests), `tests/product-uninstall.test.ts:66-75` | |
| b-AC-4 | `uninstall` removes doctor's state dir and nothing else (no other product's dir, no wholesale registry, no `~/.deeplake`) | ✅ | `src/product-uninstall.ts:55-63` (`resolveOwnStateDir`: fixed literal `doctor` segment, `resolveInBase` containment) + `114-150` (`removeProductState`, `isForbiddenWipeTarget`-guarded); `tests/product-uninstall.test.ts:77-90, 112-123` (sibling dir + registry file + `~/.deeplake` + `~/.honeycomb` survive) | |
| b-AC-5 | Existing spellings (`install-service`/`uninstall-service` etc.) keep working | ✅ | `src/cli/dispatch.ts:226-244` (`runService`, untouched), menu rows retained; `tests/cli/lifecycle-commands.test.ts:269-298` (both verbs still dispatch; `uninstall-service` never touches the fuller seam) | Accepted deviation 2: kept byte-identical rather than literally aliased; the AC's "keep working" text is satisfied. |
| b-AC-6 | `uninstall` on a not-installed product exits 0 saying nothing to remove | ✅ | `src/cli/dispatch.ts:271-293` (read-only precheck: registry + state dir + `serviceStatusAsync` + `isServiceRegistered`, ambiguity biases to proceed); `src/service/index.ts:485-506` (`isServiceRegistered`: unit-FILE evidence on launchd/systemd, query success on schtasks/sc); exit-code honesty for the already-absent shape FIXED this audit (`dispatch.ts:310`); `tests/cli/lifecycle-commands.test.ts:133-200` (no-op, live-service-only, installed-but-inactive never false no-op, ambiguity bias, no over-trigger) + the 2 new exit-code tests; `tests/service/service-module.test.ts` ("isServiceRegistered", 9 tests incl. the verifier's exact scenario) | W2-Dfix (registration-evidence precheck) verified present; the remaining exit-code dishonesty was this audit's Warning, now fixed. |
| b-AC-7 | After `uninstall`, doctor no longer probes/remediates the removed product | ✅ | True by construction: the probe loop reads the registry fresh at boot; `tests/compose/multi-daemon.test.ts:83-123` ("b-AC-7: registry without an entry => no supervisor built for it", drives the real `deleteRegistryEntry` then re-boots `createDoctor`: 2 supervisors -> 1), `tests/registry.test.ts` ("b-AC-7: deleting doctor's own entry...") | |
| c-AC-1 | Purge without `--yes` prints an explicit destruction summary (dirs, services, packages, incl. `~/.deeplake`) and proceeds only on explicit confirmation; anything else aborts with no changes | ✅ | `src/purge/engine.ts:228-238` (`purgeSummaryLines`: every category, `~/.deeplake` shared-credentials/Hivemind language, resolved fleet root, doctor-last) + `257` (resolved root threaded); `src/cli/dispatch.ts:322-357` (`runPurge`: summary first, non-TTY refusal, typed-token `purge` via the separate `ConfirmTokenFn` seam, abort = `EXIT_DECLINED` + "no changes"); `src/cli/index.ts` (`realConfirmToken`: exact trimmed match, TTY re-check, never hangs); `tests/cli/purge.test.ts:29-63`, `tests/purge/engine.test.ts:67-73, 401-414` | Orchestrator decision 7 (typed token, not y/N) honored; security-wave resolved-root disclosure verified present and tested. |
| c-AC-2 | `purge --yes` runs the same wipe non-interactively | ✅ | `src/cli/dispatch.ts:331` (`hasFlag(parsed, "yes")`, the only bypass; identical `p.run()` engine path); `tests/cli/purge.test.ts:65-81`; custom-root non-regression `tests/purge/engine.test.ts:416-432, 489-497` | See the `--yes=no` ruling in Suggestions (documented Low, shared parser behavior). |
| c-AC-3 | After purge: no state roots, no unit (current or legacy) registered with launchd/systemd-user/schtasks, no current/legacy npm package | ✅ | `src/purge/engine.ts:259-436` (steps 1-5; win32 `sc` stop+delete for the same name family, steps 1 and 4; doctor's OWN legacy labels deregistered in the self step; system-scope survivors detected and reported with the exact sudo command, report-only per decision 13); `tests/purge/engine.test.ts:76-286` | W2-Dfix additions (own-legacy deregister, sc attempts, system-scope survivor reporting incl. the not-falsely-a-no-op case) all verified present and tested. |
| c-AC-4 | Doctor's own unit + package removed last; earlier failure means doctor survives, reports, and a re-run resumes | ✅ | `src/purge/engine.ts:354-367` (hard-failure gate blocks steps 4/5, prints which steps failed + re-run guidance) + `418-433` (own package last; its failure reported but never flips the result; success line prints before it, decision 9); `tests/purge/engine.test.ts:288-351` (skip + two-run resume) | Accepted deviation 3 (awaited-but-tolerant self npm-uninstall rather than detached; the 003d script is the documented Windows fallback). |
| c-AC-5 | Only allow-listed absolute paths and enumerated names; never follows a symlink out of a root; never glob-expands | ✅ | `src/purge/inventory.ts` (closed list), `src/purge/engine.ts:64-69` (`rmSync` recursive: unlinks, never dereferences; no glob/readdir anywhere in `src/purge/`), `isForbiddenWipeTarget` defense in depth; `tests/purge/engine.test.ts:353-386` (exact removal set; enumerated-names-only argv) + `435-497` (guard block) | Security Finding 4 (`existsSync` skips a dangling symlink, under-reporting one dead link) remains an accepted-risk Low; removal direction unaffected. |
| c-AC-6 | Clean machine: `purge --yes` exits 0 reporting nothing to remove | ✅ | `src/purge/engine.ts:404-416` (own-package presence detected before the determination, so a never-installed doctor is honest too); `tests/purge/engine.test.ts:388-399`, `tests/cli/purge.test.ts:92-99` | Guard non-regression re-verified this audit (item 1). |
| Module AC-5 | `doctor purge` confirmation + full coverage, doctor-self last | ✅ | Union of c-AC-1..4 evidence above | |
| Module AC-8 (doctor scope) | Nothing deleted outside the enumerated allow-list; clean machine no-op | ✅ | c-AC-5/c-AC-6 evidence + `src/product-uninstall.ts:132-138` (uninstall's guarded state-dir removal); `tests/product-uninstall.test.ts:97-110` (degenerate `APIARY_HOME` refuses; planted `precious.txt` survives) | |
| Module AC-9 (doctor scope) | Every flow terminates: clear success or plain-language actionable error, never blocks | ✅ | Non-TTY purge refusal (`dispatch.ts:337-341`); `realConfirmToken` TTY re-check; every runner call timeout-bounded (`SERVICE_COMMAND_TIMEOUT_MS` / the rung runner's caps); start/stop/uninstall map `ok:false` to non-zero with the manager's actual detail + "Run \`doctor install-service\` first" guidance; the already-absent exit-code fix this audit closes the "fails while succeeding" corner | |
| NG (003b) | `uninstall` does not remove the npm package | ✅ Honored | `src/product-uninstall.ts` module doc + no npm argv anywhere in the uninstall path; menu copy says "keeps the npm package" | Orchestrator decision 5. |
| NG (003c) | Purge never a remediation rung; ladder unchanged | ✅ Honored | No purge reference in `src/remediation.ts` / `src/rungs/` / `src/compose/` (grep-verified); ladder still rungs 1-3 + escalate (`tests/compose/create-doctor.test.ts` "registers rungs 1/2/3" still green) | |
| NG (003c) | Nothing outside the allow-list (user projects, npm caches, Node, unrelated `~/.config`) | ✅ Honored | c-AC-5 evidence; the enumerated-names argv test rejects any made-up name | |
| NG (003c) | Machine-local only; nothing deleted server-side | ✅ Honored | No network call anywhere in `src/purge/` (runner argv is launchctl/systemctl/schtasks/sc/npm only) | |

## Remediations applied this audit

| File | Change |
|---|---|
| `src/cli/dispatch.ts` | `runUninstall`'s exit code now forgives a deregister failure only when the pre-uninstall probe confidently reported the unit unregistered and not running (`serviceResult.ok || !servicePresent`); genuine failures on a registered/running/ambiguous unit still exit non-zero. |
| `tests/cli/lifecycle-commands.test.ts` | 2 new tests pinning both directions of the fix (strict non-zero on a registered unit; exit 0 for the already-absent stale-registry/state shape, with cleanup still reported). |

## Gate

`npm run ci` after remediation: **exit 0**. Typecheck clean; 65 test files, **781 tests passed** (779 at security hand-off + 2 new this audit), 0 failed, 0 skipped. Runtime dependencies: none (repo remains zero-dep). Changes left uncommitted per the run contract.

```
Test Files  65 passed (65)
     Tests  781 passed (781)
  Duration  3.21s
```

## Files Changed (branch diff, doctor repo)

- `library/qa/quality/2026-07-05-qa-report-prd-003-fleet-lifecycle.md` (A) - this report.
- `library/qa/security/2026-07-04-security-audit-prd-003-fleet-lifecycle.md` (A) - the security wave's report (pre-existing on this branch).
- `src/cli/command-table.ts` (M) - four new verbs (`start`/`stop`/`uninstall`/`purge`) in the `CommandName` union + menu, purge flagged DESTRUCTIVE; existing rows untouched.
- `src/cli/context.ts` (M) - new optional seams: `ConfirmTokenFn`, `isInteractive`, `serviceLifecycle`, `ProductUninstallDeps`, `PurgeDeps`/`PurgeReport`; all additive.
- `src/cli/dispatch.ts` (M, further modified this audit) - `runStartStop`, `runUninstall` (registration-evidence no-op precheck + lifecycle-event ordering + the exit-code fix), `runPurge` (summary -> non-TTY refusal -> typed token -> engine), four new route cases; existing handlers untouched.
- `src/cli/index.ts` (M) - production wiring: `realConfirmToken`, `isInteractive`, shared `serviceDeps`, rung-1 RestartFn rewired to Doctor's own service (accepted deviation 1), `productUninstall` + `purge` composition.
- `src/cli/service-stub.ts` (M) - new `ServiceLifecycleModule` interface (separate from `ServiceModule` so existing fixtures compile unchanged).
- `src/product-uninstall.ts` (A) - the b-AC-6 read-only precheck + the b-AC-3/4 registry-entry + guarded state-dir removal.
- `src/purge/inventory.ts` (A) - the ledger-frozen closed allow-list; doctor's own names imported from `service/platform.ts`.
- `src/purge/engine.ts` (A) - the injectable purge engine: fixed ordering, hard-failure gate, self-last, sc-scope attempts, system-scope survivor reporting, forbidden-target guard, resolved-root disclosure.
- `src/registry.ts` (M) - new generic `deleteRegistryEntry` (atomic, entry-scoped, fail-soft); existing readers/writers untouched.
- `src/safe-path.ts` (M) - new `isForbiddenWipeTarget` (security-wave remediation; fail-closed root/home/ancestor-of-home floor).
- `src/service/argv.ts` (M) - new `startCommands`/`stopCommands` builders (constant argv, all four managers).
- `src/service/index.ts` (M) - `ServiceFs.exists`, `FullServiceModule` (start/stop added), standalone `serviceStart`/`serviceStop`, `deregisterLegacyUnit`, `isServiceRegistered`; existing install/uninstall bodies unchanged.
- `tests/cli/command-table.test.ts` (M) - new-verbs presence test; existing assertions untouched.
- `tests/cli/helpers/fake-cli.ts` (M) - backward-compatible harness support for the new seams (`confirmToken`, `interactive`, `serviceLifecycle`, `productUninstall`, `purge`).
- `tests/cli/lifecycle-commands.test.ts` (A, further modified this audit) - b-AC-1..7 dispatcher tests + the 2 new exit-code regression tests.
- `tests/cli/purge.test.ts` (A) - the c-AC-1/c-AC-2 gate tests (token, abort, non-TTY refusal, `--yes`, stub).
- `tests/compose/multi-daemon.test.ts` (M) - additive b-AC-7 composition-level proof.
- `tests/product-uninstall.test.ts` (A) - b-AC-3/4/6 + the AC-8 degenerate-`APIARY_HOME` guard test.
- `tests/purge/engine.test.ts` (A) - 22 tests: c-AC-2..6 + the security-guard block (forbidden shapes refused, legitimate custom root still purges, resolved-root disclosure).
- `tests/purge/inventory.test.ts` (A) - pins the frozen inventory verbatim against the ledger table.
- `tests/registry.test.ts` (M) - additive `deleteRegistryEntry` suite (8 tests).
- `tests/service/argv.test.ts` (M) - additive start/stop argv tests per manager.
- `tests/service/helpers.ts` (M) - `MemoryFs.exists` + seed support (backward-compatible).
- `tests/service/service-module.test.ts` (M) - additive start/stop, standalone serviceStart/serviceStop, `deregisterLegacyUnit`, and `isServiceRegistered` suites.
