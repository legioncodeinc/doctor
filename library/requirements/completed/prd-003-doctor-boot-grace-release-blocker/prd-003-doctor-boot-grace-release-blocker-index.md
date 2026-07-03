# PRD-003: Doctor Boot Grace Release Blocker

> **Status:** Completed (implemented and verified 2026-06-29; adopted into the doctor repo 2026-07-03)
> **Provenance:** Moved from honeycomb PRD-067 (`honeycomb/library/requirements/archive/prd-067-doctor-boot-grace-release-blocker/`) during the fleet realignment. This work was authored while doctor still lived inside the honeycomb repository; it is doctor-owned and is renumbered here as doctor PRD-003. Honeycomb's execution ledger (`honeycomb/library/ledger/EXECUTION_LEDGER-prd-067.md`) records the full AC-by-AC verification evidence: all 11 ACs DONE, `npm run ci` in doctor passed (49 files / 486 tests), packaged live proofs completed.
> **Priority:** P0
> **Effort:** S (1-3h)
> **Schema changes:** None. Local Doctor state may gain non-breaking in-memory or file-backed boot metadata, but no DeepLake schema changes.

---

## Overview

Doctor currently begins probing the Honeycomb primary daemon immediately when Doctor starts. That is correct for a warm, already-running daemon, but it is dangerous during cold install and reboot: the primary daemon can take roughly 30 seconds to bind `/health` while it wires storage, services, and embeddings liveness. During that window Doctor can classify the daemon as unreachable and enter remediation before the daemon has had a fair chance to boot. This PRD is the immediate release-blocking fix: add an explicit startup and post-restart grace window so Doctor treats early failures as `booting`, not `dead`, while preserving short per-probe timeouts for genuinely wedged sockets.

This is the first PRD in the boot-experience sequence. It must ship before any public release that installs the Doctor bundle by default.

---

## Goals

- Prevent Doctor from killing, restarting, reinstalling, escalating, or incident-logging a primary daemon that is still inside the expected boot window.
- Add a default 60 second grace from Doctor start, plus the same grace after any Doctor-initiated restart or update restart.
- Keep `probeTimeoutMs` short so a hung health socket is still detected quickly after the grace window expires.
- Make the grace behavior visible in logs and local status without adding network calls, DeepLake reads, or new runtime dependencies.
- Add regression tests that prove initial cold boot, post-restart warmup, and post-grace remediation behavior.

## Non-Goals

- Building the future portal daemon or graphical boot shell. That surface moved to hive under the fleet realignment (hive PRD-003 and PRD-004).
- Redesigning the full health dashboard. That is hive PRD-005 plus doctor PRD-001/PRD-002.
- Increasing the daemon lifecycle start timeout beyond its current 45 second budget.
- Making embeddings warmup block daemon readiness. Embeddings remain background-warmed and observable.
- Adding a new DeepLake table, queue, or managed cloud dependency.
- Changing the primary daemon's `/health` contract except where an already-existing cached health signal is consumed.

---

## Code-grounded current state

> Paths below are as of the original authoring: `src/*` paths under this repo are doctor's own source; `honeycomb/src/*` paths refer to the honeycomb repository.

| Area | Current code fact | Release risk |
|---|---|---|
| Doctor config | `src/config.ts` defaults to `probeIntervalMs: 30_000`, `probeTimeoutMs: 2_000`, and `restartCooldownMs: 5_000`. There is no startup grace setting. | A 2 second probe timeout is fine, but without a grace policy the first refused connection is treated as actionable. |
| Supervisor loop | `src/supervisor.ts` calls `tick()` immediately inside `start()`, then sleeps for `probeIntervalMs`. | A cold primary daemon can be classified unhealthy at time zero. |
| Unhealthy path | `src/supervisor.ts` sends every non-`ok` classification through incident creation and `heal(...)`. | Early `unreachable-refused`, `unreachable-timeout`, or `degraded` classifications can trigger remediation while boot is still expected. |
| Probe classification | `src/health-probe.ts` maps refused/reset transport errors to `unreachable-refused`, timeouts to `unreachable-timeout`, and any answered non-OK response to `degraded`. | This is the right classifier, but it needs context from boot timing before remediation fires. |
| Restart rung | `src/remediation.ts` has only a 5 second cooldown after a Doctor restart. | A daemon that takes roughly 30 seconds to return can be restarted again on the next 30 second tick because the cooldown has expired. |
| Compose wiring | `src/compose/index.ts` starts the status page, then starts the supervisor loop; the supervisor receives no boot-grace dependency. | Production assembly cannot express "starting" today. |
| CLI lifecycle | `honeycomb/src/cli/runtime.ts` waits up to 45 seconds for daemon `/health`, and `honeycomb/src/commands/daemon.ts` reports "process holds the lock but is not answering /health yet" instead of "failed" when applicable. | The CLI already recognizes slow boot, but Doctor is not aligned with that behavior. |
| Install flow | `honeycomb/src/commands/install.ts` health-gates the primary daemon before opening the dashboard. | Fresh installs are especially exposed: the user sees slow boot while Doctor may already be trying to heal. |
| Daemon boot | `honeycomb/src/daemon/runtime/assemble.ts` can await the first storage health refresh before starting services when storage probing is enabled; embeddings liveness starts before background warmup. | Normal boot can exceed naive watchdog timing, especially first-run model and storage paths. |

---

## Required behavior

### Boot grace

Doctor must compute a grace deadline when the supervisor is constructed or started:

- Default: `60_000` ms.
- Env override: `DOCTOR_STARTUP_GRACE_MS`.
- Invalid values fall back to default, matching the defensive config style in `src/config.ts`.
- The grace window begins when Doctor starts, not when the first failed probe occurs.

During this window:

- A non-`ok` probe result is recorded as a booting observation, not an unhealthy incident.
- The remediation ladder is not invoked.
- `consecutiveRestartFailures`, `backoffRung`, and `currentRung` are not advanced.
- The incident log is not appended.
- The status page can report `unknown` or `booting`; if `booting` would require a state-file enum migration, prefer an in-memory status provider for the immediate release.

### Post-restart grace

When a remediation rung or update flow successfully kicks a daemon restart, Doctor must start a new grace deadline:

- Default: same value as startup grace, `60_000` ms.
- The existing 5 second restart cooldown remains a short duplicate-action guard, not the boot-readiness policy.
- A failed restart action does not open a post-restart grace. Only a kicked restart or update restart does.

### Degraded during grace

During boot grace, `degraded` should also be non-remediating unless a future code path can prove the daemon has already completed boot and is now failing. For this immediate release, keep the rule simple and safe:

- Any non-`ok` inside grace is `booting`.
- Any non-`ok` after grace follows the existing remediation path.

This intentionally avoids distinguishing storage/schema/embeddings during the first 60 seconds. The priority is preventing the watchdog from fighting normal boot.

### Probe timeout remains small

Do not set `DOCTOR_PROBE_TIMEOUT_MS` to 60 seconds. That would make every hung socket hold the supervisor loop for a minute. The correct design is:

- Keep probe timeout at 2 seconds by default.
- Add a separate grace deadline around the decision to heal.

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given Doctor starts and the primary daemon is not yet listening, when the first probe returns `unreachable-refused` inside the first 60 seconds, then Doctor logs a booting observation and does not invoke the remediation ladder. |
| AC-2 | Given Doctor starts and `/health` times out inside the startup grace, when the supervisor tick completes, then no incident is written and restart failure counters remain unchanged. |
| AC-3 | Given Doctor starts and `/health` returns `degraded` inside the startup grace, when the supervisor tick completes, then no remediation runs and no escalation is emitted. |
| AC-4 | Given the startup grace has expired and the primary daemon is still unreachable, when the next tick runs, then the existing unhealthy remediation path runs exactly as it does today. |
| AC-5 | Given a restart rung returns `ok: true`, when the next probe occurs before the post-restart grace expires, then Doctor does not attempt a second restart. |
| AC-6 | Given a restart action returns `false`, when the tick completes, then no post-restart grace is opened and the existing failed-restart/backoff logic applies. |
| AC-7 | Given `DOCTOR_STARTUP_GRACE_MS=90000`, when config resolves, then the supervisor uses a 90 second grace. Given the env value is malformed, zero, or negative, it falls back to 60 seconds. |
| AC-8 | Given the daemon becomes healthy during startup grace, when `/health` returns `ok`, then Doctor records healthy state and resets any stale backoff exactly as the existing healthy path does. |
| AC-9 | Given the status page is running while Doctor is inside grace, when `/status.json` is requested, then the page does not claim a terminal failure or show an escalation caused by the boot window. |
| AC-10 | Given the packaged Honeycomb install starts Doctor and the primary daemon on this machine, when the primary takes about 30 seconds to boot, then Doctor does not restart, reinstall, or escalate during that boot. |
| AC-11 | Given the local status-page port is already bound when `doctor run` starts, when the status page fails to bind, then Doctor logs/swallow the bind failure and the watchdog process remains alive until SIGTERM/SIGINT while still probing/healing the primary daemon. |

---

## Implementation record

Implemented 2026-06-29 (see the honeycomb execution ledger for full evidence). Where the behavior landed in this repo:

1. `DoctorConfig` in `src/config.ts` carries `startupGraceMs` with a `60_000` default and `DOCTOR_STARTUP_GRACE_MS` env parsing through the existing positive-int parser (AC-7).
2. `src/supervisor.ts` tracks a private `graceUntilMs`, arms it at construction and at `start()`, logs `tick.booting` with `kind` and `remainingMs` for any non-`ok` inside grace, and skips incident creation and `heal(...)` (AC-1/2/3). It also exposes `armStartupGrace()` as a public re-arm seam.
3. A successful rung-1 restart re-arms the grace alongside recording `lastRestartAt` (AC-5); a failed restart does not (AC-6).
4. `src/compose/index.ts` wires `startupGraceMs` per supervised daemon entry, and the auto-update engine's `restartDaemon` calls `primary.supervisor.armStartupGrace()` after a successful post-update restart.
5. `DOCTOR_STATUS_PAGE_PORT` config support exists so tests and operators can move the local page away from a colliding port, and the long-running `doctor run` process holds an explicit referenced handle so a status-page bind failure cannot end the watchdog process (AC-11).

Tests: `tests/config.test.ts` (default, override, malformed/zero/negative fallback), `tests/supervisor.test.ts` (the `supervisor startup grace (PRD-067)` describe block covering AC-1 through AC-8 and AC-10), `tests/compose/create-doctor.test.ts` (AC-9 status-page behavior during grace), `tests/cli/run-watchdog.test.ts` (AC-11 occupied-port keepalive).

---

## Release gate

This PRD blocked release. All gate conditions were met on 2026-06-29:

- All ACs above satisfied with test plus packaged live-proof evidence.
- A packaged live proof demonstrated a 30 second delayed primary boot with zero restarts, zero incidents, final state `ok`.
- `npm run ci` passed (49 files, 486 tests at the time of close-out).

---

## Resolved decisions

- [x] **Status page wording:** boot grace is tracked internally without state-file churn. The status page may expose `booting` from in-memory supervisor state without widening the local state schema; the richer portal wording belongs to hive.
- [x] **Default boot grace:** 60 second default (`60_000` ms), configurable by `DOCTOR_STARTUP_GRACE_MS`.
- [x] **Post-update restart grace:** the same 60 second grace applies after update-triggered restarts as after manual/Doctor-triggered restarts.

---

## Related

- honeycomb [PRD-064: Doctor Self-Healing Watchdog](../../../../../honeycomb/library/requirements/in-work/prd-064-doctor-self-healing-watchdog/prd-064-doctor-self-healing-watchdog-index.md) - the program doctor was originally built under.
- honeycomb [PRD-065: Doctor Go-Live and Activation](../../../../../honeycomb/library/requirements/completed/prd-065-doctor-go-live/prd-065-doctor-go-live-index.md)
- honeycomb PRD-067 (the original of this PRD, archived): `honeycomb/library/requirements/archive/prd-067-doctor-boot-grace-release-blocker/`
- honeycomb execution ledger: `honeycomb/library/ledger/EXECUTION_LEDGER-prd-067.md`
- The superseded honeycomb boot-experience follow-ups, now owned elsewhere under the fleet realignment: hive PRD-003/PRD-004 (portal gate and /buzzing, formerly honeycomb PRD-068/PRD-070) and hive PRD-005 plus doctor PRD-001/PRD-002 (health surface and telemetry, formerly honeycomb PRD-069).
- `src/config.ts`
- `src/supervisor.ts`
- `src/health-probe.ts`
- `src/remediation.ts`
- `src/compose/index.ts`
- `honeycomb/src/cli/runtime.ts`
- `honeycomb/src/commands/install.ts`
