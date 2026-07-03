# QA Report: Core Functionality Gap Review (pre-release, public launch)

**Scope:** README promises vs `library/knowledge/` claims vs completed/in-work PRD acceptance criteria vs the actual code under `src/` and `tests/`.
**Base:** working tree on `main` after `e17159e` (uncommitted doc/brand churn present).
**Auditor:** quality-worker-bee (deep gap review, read-only; no source modified)
**Gate evidence:** `npx tsc --noEmit` clean in this audit environment. The vitest suite could not run here (Windows-installed `node_modules` on a Linux audit mount, rollup native module missing); CI's 3-OS matrix is the standing claim for the 486+ test suite and was not independently re-run.

## Verdict: PARTIAL. The skeleton is real, the headline promise is not.

The spirit is "tiny, zero-dep, OS-supervised watchdog that heals common failures on the spot and escalates loudly when it cannot." Half of that is genuinely delivered and delivered well: zero runtime dependencies is structurally true, the OS-supervision layer has real code for all three platforms, the health probes match what honeycomb, hive, and nectar actually expose, the update engine's blessed gate is fail-closed and pure, the credential non-touch policy is enforced by absence, and the boot-grace release blocker (PRD-003) is fully met in code and tests.

The other half is not delivered, and it is the half the README sells hardest. In the shipped production assembly, rung 1 (restart) is a logged no-op that returns `false`. Doctor cannot restart anything. "Kill it. Watch it come back." does not happen. Worse, the escalation trigger only fires when an advanced rung genuinely fails, and rung 2's fail-soft design means it almost never genuinely fails, so the most common real-world failure (daemon down, restart impossible) either loops `npm install -g` every 30 seconds forever or loops a skip forever, and never escalates. The watchdog that exists so "a wedged daemon never becomes a silent lost morning" currently produces exactly a silent lost morning, with an incident log nobody is told to read.

The knowledge docs are honest about the restart gap. The README is not. Do not launch with this README against this code.

## Scorecard

| Area | Verdict | Severity |
|---|---|---|
| Zero runtime dependencies | MET, structurally enforced | - |
| Health probes vs real daemon endpoints | MET | - |
| Multi-daemon registry (parse, containment, fallback) | MET | - |
| Repair ladder: rung 1 restart actually restarts | NOT MET in production wiring | CRITICAL |
| Repair ladder: escalation fires when healing fails | NOT MET for the dominant failure path | CRITICAL |
| Repair ladder: rung 2 loop behavior when blessed unknown | Unbounded npm-install churn, no escalation | HIGH |
| Exponential backoff between attempts | Dead code, never consulted | HIGH |
| Rungs 2/3 on non-primary daemons (hive, nectar) | Wrong target package by design | HIGH |
| CLI resilience to malformed registry | NOT MET, all verbs die | HIGH |
| Escalation actually reaching a human | Pull-only locally; push is maintainer telemetry | MEDIUM |
| README accuracy for public launch | Multiple false/broken claims | MEDIUM |
| OS service registration (launchd/systemd/schtasks/sc) | MET in code; live install untested in CI (documented) | LOW |
| Blessed-update gate, rollback, self-update boundary | MET | - |
| Credential non-touch policy | MET, enforced by absence | - |
| Telemetry chokepoint, allow-list, opt-out gates | MET | - |
| Status page + SSE (Contract C) | MET, loopback-only, escaped | - |
| PRD-003 (completed) acceptance criteria | MET, 11/11 | - |
| Knowledge docs accuracy | Largely accurate and candid; two overstatements | LOW |

## Critical findings

### C-1. Rung 1 cannot restart anything in production. The core promise is not wired.

**Claim.** README line 103: "Watches and heals. Probes each daemon's /health on a fixed interval... and repairs what it can." README lines 185-194, the whole pitch: `pkill -f honeycomb` then `doctor status` shows `healed 12s ago (rung 1: restart)`. README line 169: `doctor restart` "restart the primary daemon (rung 1)". Public overview (`library/knowledge/public/overview/overview.md` line 23): "A daemon you kill on purpose is typically back inside one probe interval."

**Reality.** The production restart seam is a logged no-op:

- `src/compose/index.ts:504-509`: default `restart` logs `compose.restart_no_os_service` and returns `false`.
- `src/cli/index.ts:272-291` (`runWatchdog`, the `doctor run` OS-service entry): calls `createDoctor({ cliNoAutoUpdate })` and injects no restart. The long-running watchdog runs with the no-op.
- `src/cli/index.ts:153-160`: the `doctor restart` CLI verb wires its own no-op (`cli.restart_no_os_service`, returns `false`).

There is no code path anywhere in the repo that restarts a workload daemon. Not through the service manager, not by spawning the daemon binary, nothing. The private docs admit it plainly (`library/knowledge/private/architecture/remediation-rungs-deep-dive.md` line 78: "until the OS-restart seam is wired by the service integration, the injected default logs compose.restart_no_os_service and returns false"). The README does not.

**Why it matters.** This is the product. A user who runs the README's own kill test gets a daemon that stays dead for three probe intervals and then gets `npm install -g @legioncodeinc/honeycomb` run at them (see C-2). Every "heals", "healed", "back inside one probe interval", and the entire "Kill it. Watch it come back." section is currently false advertising for the shipped bits.

**Suggested fix.** Either wire the restart seam before launch (the honest options: shell out to the daemon's own start command per registry entry, or drive the daemon's OS service unit if one exists), or rewrite the README to say what the code does today: detect, classify, reinstall, report. Do not ship the kill-test section against a no-op restart.

### C-2. The escalation trigger is unreachable on the dominant failure path. The loud give-up never happens.

**Claim.** README line 95: ladder "climbs restart, reinstall, remove-conflict, escalate." README line 225: "when it truly cannot fix something, it does not shrug. It writes a structured report, surfaces it on the local status page, and... sends the scrubbed diagnosis." Spirit: escalates loudly so a wedged daemon never becomes a silent lost morning.

**Reality.** Escalation fires only when the advanced rung GENUINELY fails, meaning `!result.ok && result.skipped !== true` (`src/supervisor.ts:205`). Trace what rung 2 can return (`src/rungs/reinstall.ts`):

- `ok: true` `unverified-no-blessed` (line 142-144): npm install succeeded, no blessed version known. No escalation.
- `ok: true, skipped` `already-blessed` (line 112-114): installed matches blessed. No escalation.
- `ok: false, skipped` `install-lock-held` (line 119-121): skip. No escalation.
- `ok: false` `npm-exit-N` or `unverified-got-X`: the ONLY escalating outcomes.

Combine with C-1 and `decide()` (`src/remediation.ts:220-225`, failures >= threshold always returns rung 2, and the failure counter is never incremented past the advance because skips and successes leave it alone):

- **Blessed channel unreachable or empty** (the current state per the docs' own B-3 note): every unhealthy tick past three failed restarts runs a REAL `npm install -g @legioncodeinc/honeycomb`, gets `ok: true unverified-no-blessed`, and never escalates. That is an npm install every 30 seconds, forever, on a box whose daemon is down. Network churn, disk churn, npm registry hammering, zero human signal.
- **Blessed version known and matching**: every tick skips `already-blessed`, forever. Zero repair, zero escalation, zero human signal.

The existing test suite pins this behavior in as intended: `tests/supervisor-escalation.test.ts` line 116 "does NOT escalate when the advanced rung succeeds." The narrow window that does escalate (npm exits non-zero, or the verify mismatches) is real but rare.

**Why it matters.** The product's stated reason to exist is that an unhealable failure gets loud. In the two most likely terminal states it stays quiet indefinitely, and in one of them it actively churns npm every 30 seconds. That is both the silent failure the spirit forbids and a resource-abuse bug.

**Suggested fix.** Two changes, both small:
1. Escalate on "advanced rung ran but health did not return within N ticks", not on "advanced rung returned ok:false". Track ticks-since-advance in the state shard; after N (say 3) post-rung-2 unhealthy ticks, build the EscalationRecord and go loud. That closes both quiet loops.
2. Rate-limit rung 2: once a reinstall has run for the current incident episode, do not run it again until health flipped ok in between (persist a `lastReinstallAt` or an episode flag). One repair attempt per episode, then escalate.

## High findings

### H-1. Exponential backoff is marketed but never consulted. Dead code in the hot path.

**Claim.** README line 95: "with exponential backoff between rungs." README line 215: "Repairs back off exponentially." `library/knowledge/private/architecture/backoff-and-restart-policy.md` builds a whole doc around the geometric schedule.

**Reality.** `Backoff.delayMs()` is defined (`src/backoff.ts:45,75`) and called by nothing. Grep the entire `src/` tree: the only references are inside `backoff.ts` itself. The supervisor loop sleeps a fixed `probeIntervalMs` every iteration (`src/supervisor.ts:333`). `advance()` and the persisted `backoffRung` are maintained faithfully (`src/supervisor.ts:253-258`, `src/state.ts`) and then influence nothing. Retry spacing is a constant 30 seconds no matter how long the crash loop has run. The backoff-and-restart-policy doc quietly concedes this in its second-to-last paragraph ("the primary loop cadence between healthy ticks is the fixed probeIntervalMs") while the README states the opposite outright.

**Why it matters.** The anti-stampede and anti-hammer properties the README sells (jittered geometric spacing so a fleet does not retry in lockstep) do not exist at runtime. Combined with C-2's npm-per-tick loop, there is nothing slowing a failing box down.

**Suggested fix.** In the unhealthy branch of the loop, sleep `max(probeIntervalMs, backoff.delayMs())` after a genuine failed repair, or gate rung execution (not probing) on the backoff delay. Or delete the machinery and the claim. Either is honest; the current state is neither.

### H-2. Rungs 2 and 3 target the honeycomb package no matter which daemon is sick.

**Claim.** README line 105: "Supervises the whole fleet... honeycomb, hive, and nectar." README line 103: "repairs what it can."

**Reality.** The reinstall and uninstall rungs are built once, hard-wired to `PRIMARY_PACKAGE = "@legioncodeinc/honeycomb"`, and shared across EVERY entry's ladder (`src/compose/index.ts:511-536`, `rungs: [entryRestartRung, reinstallRung, uninstallRung]` at 625-630, `src/rungs/reinstall.ts:40`). So when hive or nectar exhausts its restart threshold, doctor's "repair" is to reinstall honeycomb, a package that has nothing to do with the sick daemon. With C-1 (restarts always fail) that path is reached after exactly three ticks for any down non-primary daemon. The composition-root doc states this design choice but does not confront that it makes rung 2 a no-op-with-side-effects for two of the three fleet members.

**Why it matters.** For hive and nectar the ladder is: restart (cannot act), reinstall the wrong package (cannot help), never escalate (C-2). Fleet supervision is real for observation and fake for remediation on two thirds of the fleet.

**Suggested fix.** Either scope rung 2 per entry with a per-daemon package name in the registry (additive field, matches the existing contract style), or make `decide()` for non-primary entries skip rung 2 and go straight to escalation. The second is a five-line change and immediately honest.

### H-3. A malformed registry file kills the entire CLI, including the commands the escalation runbook tells you to run.

**Claim.** The malformed-registry posture is documented as fail-soft: watchdog falls back to the primary, logs, records a needs-attention banner (`library/knowledge/private/data/registry-and-state.md` lines 72-77). The status-page runbook then tells the operator to check `doctor status` and fix the file.

**Reality.** The watchdog side is correct (`resolveDaemons` catches `RegistryError`, `src/compose/index.ts:276-292`). The CLI side is not: `buildCliContext` calls `readRegistryFile` bare (`src/cli/index.ts:92-93`). A malformed `~/.honeycomb/doctor.daemons.json` throws `RegistryError` out of context construction; `runCli`'s last-resort catch turns every single verb (`status`, `logs`, `diagnose`, `heal`, `install-service`, all of them) into `doctor: <parse error>` exit 1. The one moment the docs direct you to the CLI is the one moment the CLI is guaranteed dead.

**Why it matters.** The diagnostic surface fails exactly when the thing it diagnoses fails. That is the shared-failure-domain mistake the whole architecture exists to avoid.

**Suggested fix.** Wrap the registry read in `buildCliContext` with the same catch-and-fall-back the compose root uses, and print a one-line warning naming the malformed file. Ten lines, mirrors existing code.

## Medium findings

### M-1. "Escalates loudly" is pull-only for the user; the push channel goes to the maintainers.

**Claim.** Spirit: escalation reaches a human. README line 225: structured report, status page, scrubbed diagnosis home.

**Reality.** The two escalation stores are `needs-attention.json` plus the loopback status page (pull: the user must look), and the PostHog hosted sink (`src/escalation/hosted-sink.ts`), which reaches Legion's maintainers, not the user, and is silenced entirely by `DO_NOT_TRACK=1` / `HONEYCOMB_TELEMETRY=0` / empty key. There is no local push of any kind: no desktop notification, no terminal-session hook, no email. A privacy-conscious user (opted out) whose install wedges gets a JSON file in a dot-directory and a webpage they were never prompted to open. This matches what the code and docs say it does; it just does not match the "never a silent lost morning" bar the product sets for itself, especially stacked on C-2 where the escalation often never fires at all.

**Suggested fix.** Cheap wins that stay zero-dep: have honeycomb's session-start hook surface the needs-attention banner into the agent session (the read seam already exists for the dashboard), and/or `doctor status` non-zero exit + banner when an unresolved escalation exists so scripts can alert. Document that the hosted sink is a maintainer channel, not a user channel.

### M-2. README ships a broken image and a wrong badge.

- Line 154 embeds `assets/screenshots/dashboard.png`. The directory does not exist (only `assets/brand/` does). The "Using the dashboard" section opens with a broken image on GitHub and npm. The HTML comment above it even says "screenshot pending".
- Line 19: a `harnesses-6` badge. Doctor has no harnesses; that badge is copied from the hivemind README template and is meaningless here.

**Suggested fix.** Drop or comment out the `<img>` until the capture exists; delete the harness badge or replace it with something true (daemons supervised, platforms).

### M-3. README presents rung 3 as part of the automatic ladder. It is CLI-only.

README line 95 and the line-211 mermaid ("conflict detected -> remove conflicting Hivemind" inside the automatic flow) say the ladder climbs restart, reinstall, remove-conflict, escalate. `decide()` (`src/remediation.ts:220-225`) only ever returns rung 1 or rung 2; rung 3 runs solely via `doctor uninstall-hivemind` / a targeted `heal`. The knowledge docs state this correctly (`remediation-rungs-deep-dive.md` line 44). The README overstates the automation.

**Suggested fix.** One sentence in the README: rung 3 is operator-invoked, confirmed, and audited; the automatic loop stops at rung 2 plus escalation.

### M-4. Standalone install supervises honeycomb only, silently.

`npm install -g @legioncodeinc/doctor && doctor install-service` (README line 129-131) with no registry file present supervises only the honeycomb primary (`resolveDaemons` fallback, `src/compose/index.ts:284`). Hive and nectar coverage depends on the Apiary installer (or hive's own self-registration) writing `doctor.daemons.json`. The README's feature bullet ("Supervises the whole fleet... honeycomb, hive, and nectar") reads as if it is intrinsic. Fine behavior, mislabeled.

**Suggested fix.** One clause in the standalone-install section: "supervises the honeycomb primary out of the box; the stack installer registers hive and nectar in the registry."

## Low findings

- **L-1. Stale manifest comment.** `package.json` line 4 `"//version"` comment says "INT placeholder, still 0.0.0 so a stray publish is obvious" while `version` is `0.1.10` and the package is live on npm. Confusing archaeology in a file everyone reads first.
- **L-2. `files` allowlist names `LICENSE`; the file is `LICENSE.md`.** Harmless because npm auto-includes `LICENSE*` regardless, and `pack-check.mjs` verifies the bin, but the entry is dead. Fix the string.
- **L-3. Docs paperwork lag (self-acknowledged).** PRD-001/PRD-002 sit in `library/requirements/backlog/` as Draft while the telemetry-single-source-of-truth doc says the doctor-side ACs are VERIFIED in the ledger and the code is composed and live. `in-work/` is empty. Move the folders or the labels; today the requirements tree misstates program state to anyone who does not also read the ledger.
- **L-4. QA reports reference nectar's PRD-004 paths.** `library/qa/quality/2026-07-01-qa-report-prd-004.md` points at `nectar/library/requirements/backlog/prd-004-...` for its plan documents. Cross-repo pointers are fine, but the doctor requirements tree has no local record that PRD-004a/b landed here. A stub index under `completed/` would make this repo self-describing.
- **L-5. CI cannot prove live service lifecycle** (install, reboot survival, restart-on-crash). `ci.yaml` documents this exclusion honestly. Before a public launch, run the manual 3-platform live proof once and record it; the README's OS-supervision claims currently rest on unit-tested string templates plus that hand validation.
- **L-6. `doctor heal`/`diagnose` are primary-only.** `dispatch.ts` probes only the primary for `diagnose`/`heal` while `status`/`logs` are fleet-aware. Matches PRD-004b's non-goals, but the CLI table in the README does not say so.

## What was verified and holds

- **Zero runtime dependencies (the flagship constraint): TRUE.** `package.json` has no `dependencies` key at all; dev deps are typescript/esbuild/vitest/@types/coverage only. `esbuild.config.mjs:83` externalizes `node:*` only, so any smuggled dep would be bundled or break the build, and the config comments enforce intent. Transport is `node:http` (`src/health-probe.ts`), SQLite is `node:sqlite` read-only (`src/telemetry/sqlite-reader.ts`), shell-outs are `execFile` argv arrays (`src/rungs/command-runner.ts`), validation is hand-rolled. `pack-check.mjs` fail-closes the publish surface.
- **Health probes match the workload daemons.** honeycomb `:3850/health`, hive `:3853/health` returns `{status:"ok",...}` JSON to non-HTML callers (`hive/src/daemon/server.ts:105-116`), nectar `:3854/health` returns `{status: ok|degraded}` with 200/503 (`nectar/src/health.ts:154-171`). The probe's `ok` rule (200 + status:"ok") and defensive `parseReasons` handle all three, including nectar's honeycomb-shaped-reasons absence. Loopback SSRF gate on `healthUrl` and `telemetryDbPath` containment verified in `src/registry.ts`.
- **Ladder order exists as documented in the knowledge base** (restart, reinstall, uninstall registered per-entry; escalation terminal; rung 3 CLI-only), with per-daemon state/incident shards, per-entry cooldown, and the needs-attention isolation rule (`buildEscalationHookFor`, honeycomb-only shared file) all matching `src/compose/index.ts`.
- **OS-supervision code is real on all three platforms.** launchd plist / systemd unit / Scheduled Task XML / sc argv with restart-on-crash and start-on-boot encoded, legacy `hivedoctor` deregistration, user-scope default, privileged fallback logic (`src/service/platform.ts`, `templates.ts`, `argv.ts`), per-OS CI matrix.
- **Blessed-update engine matches its docs.** Fail-closed channel (`src/update/blessed-channel.ts`), pure `decideUpdate` with the latest==blessed requirement, strict-semver guard before any npm spec, shared install lock, the healthy-before/supervised-restart rollback rule, jittered 30-minute poll that arms no timer when disabled, and the self-update boundary (compose never touches `@legioncodeinc/doctor`; `doctor self-update` is the sole path).
- **Credential non-touch is enforced by absence.** No filesystem code path under `~/.deeplake/` anywhere in `src/`; the only occurrences are comments, the suggested-command shell comment on the status page, and the deferred-action note. No `clear-credentials` verb in the command table.
- **Telemetry chokepoint and privacy posture.** Single egress in `emit.ts` with four ordered gates, positive allow-list, Bearer-header key, 2s abort, fail-soft; capture path mirrors the gates; SSE consumer drop-not-buffer; status page loopback-only with entity escaping.

## Completed-PRD traceability: PRD-003 (Doctor Boot Grace Release Blocker)

The only PRD in `library/requirements/completed/`. All 11 ACs verified against current source.

| AC | Requirement | Status | Evidence |
|---|---|---|---|
| AC-1 | Refused probe inside 60s grace logs booting, no ladder | MET | `src/supervisor.ts:297-301` (grace check before the unhealthy branch); grace armed at construction `:159` |
| AC-2 | Timeout inside grace: no incident, counters unchanged | MET | Same early return; incident open + heal only after the grace gate (`:303-309`) |
| AC-3 | Degraded inside grace: no remediation, no escalation | MET | Grace gate is classification-agnostic for any non-ok kind |
| AC-4 | Grace expired, still unreachable: existing remediation path | MET | `:303-309` unchanged unhealthy path |
| AC-5 | Successful restart: no second restart before post-restart grace ends | MET | `armStartupGrace(now)` on kicked restart `src/supervisor.ts:247`; plus cooldown guard `src/remediation.ts:139-142` |
| AC-6 | Failed restart opens no grace | MET | Grace re-arm only inside the `result.ok` branch (`:242-248`); failed branch advances backoff/counter only |
| AC-7 | `DOCTOR_STARTUP_GRACE_MS` override + malformed fallback | MET | `src/config.ts` positive-int parser wiring `startupGraceMs`; `tests/config.test.ts` |
| AC-8 | Healthy during grace resets stale backoff/state | MET | The ok branch runs before the grace gate (`:277-295`) |
| AC-9 | Status page shows no terminal failure/escalation from the boot window | MET | No incident/escalation is written inside grace, so nothing reaches the page; `tests/compose/create-doctor.test.ts` |
| AC-10 | Packaged install, ~30s daemon boot, zero restarts/incidents | MET (test + recorded live proof) | `tests/supervisor.test.ts` grace describe block; honeycomb ledger live proof referenced by the PRD |
| AC-11 | Occupied `:3852` port: bind swallowed, watchdog stays alive to SIGTERM | MET | `status-page.bind_failed` swallow in `src/status-page/server.ts`; keep-alive interval in `runWatchdog` (`src/cli/index.ts:278`); `tests/cli/run-watchdog.test.ts` |

The fourth grace arming point (update-engine restart re-arm) is also present: `src/compose/index.ts:692`.

## Bottom line for launch

Fix order if the launch date holds: C-2 (escalate on persistent post-advance unhealth, rate-limit rung 2) and H-3 (CLI registry fallback) are small and stop the two worst behaviors. C-1 is the strategic call: wire a real restart or rewrite the README to sell detection, reinstall, and reporting instead of healing. H-1 and the README items (M-2, M-3, M-4) are an afternoon. Everything else on the positive list is genuinely solid work and holds up under adversarial reading.
