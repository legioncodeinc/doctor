# PRD-005: Registry live-reload and supervisor reconcile

> **Status:** Backlog
> **Priority:** P0
> **Effort:** M (3-8h)
> **Schema changes:** None (no SQLite change; no registry-entry shape change). One new optional config/env knob for the reload interval.

---

## Overview

Doctor reads its supervised-daemon registry **exactly once, at boot**. `createDoctor()` calls `resolveDaemons()` a single time (`src/compose/index.ts:510`), builds one supervisor per entry into a fixed `const built: BuiltDaemon[]` (`src/compose/index.ts:715`), and never re-reads the registry file for the life of the process. Both registry writers document this contract explicitly: an appended entry "takes effect at doctor's next natural boot" (`honeycomb/src/daemon/runtime/telemetry/fleet-registry.ts`, `nectar/src/doctor-registry.ts:8-18`). There is no `fs.watch`, no periodic re-resolve, and no reload trigger anywhere in doctor's runtime — the "registry reload trigger, PRD-001 AC-7" mentioned in `src/registry.ts:465` is aspirational and unimplemented.

This boot-snapshot behavior produces a **deterministic onboarding deadlock** for fresh installs. The bare `irm | iex` / `curl … | sh` install (`scripts/install/install.ps1:1187` → `Invoke-PortalMain`) installs hive only; honeycomb, doctor, and nectar are then installed through the in-browser onboarding cards in the fixed order `INSTALLABLE_PRODUCTS = ["doctor", "honeycomb", "nectar"]` (`hive/src/shared/onboarding-types.ts:27`). Because `doctor install-service` registers **and immediately starts** doctor (`doctor/src/service/index.ts:281`), doctor snapshots the registry while it holds only `hive` (written by the portal's `hive install-service`). honeycomb and nectar append their entries **after** doctor has already booted, so doctor never supervises them. The onboarding "Bringing the fleet up green" gate requires honeycomb specifically (`isFleetReady` gates on `V1_REQUIRED_PEERS = ["honeycomb"]`, `hive/src/shared/fleet-readiness.ts:23`), so the gate never turns green and the user is stuck on `/onboarding` until the machine reboots. Multiple users have hit this.

This module makes doctor **re-read the registry at runtime and reconcile its live supervisor set** — spawning supervisors for newly-registered daemons, tearing down supervisors for deregistered ones, and updating changed entries — without a reboot and without any cross-product coordination (product installers need no change). It removes the ordering dependency entirely and also fixes the residual case where nectar (registered after doctor regardless of ordering) stays unsupervised until reboot.

This is the durable fix for the onboarding hang. It is the doctor-side counterpart to the mtime-gated live-reload honeycomb already shipped for its tenancy/storage snapshot (`honeycomb/src/daemon/storage/live-reload.ts`).

**This index covers the module scope.** Sub-PRDs 005a and 005b own the two discrete pieces below.

---

## Goals

- Re-read the supervised-daemon registry at runtime, on a bounded cadence, using the SAME two-location resolution doctor uses at boot (`resolveRegistryEntries`: `<root>/registry.json` first, then the legacy `~/.honeycomb/doctor.daemons.json`, merged additively).
- Reconcile the live supervisor set against the freshly-read registry: **add** a supervisor for a newly-registered daemon (with its cold-boot grace armed), **remove** the supervisor for a deregistered daemon (without killing the daemon process), and **update** a supervisor whose entry fields changed.
- Make an unchanged registry re-read a strict no-op: zero supervisor churn, zero restarts, no log spam.
- Keep the primary (honeycomb) designation and every process-global surface it backs (status page, install-health snapshot, escalation/needs-attention) stable across reloads.
- Update the telemetry poll-and-merge loop's entry set in lockstep, so a newly-supervised daemon with a `telemetryDbPath` begins being ingested and a removed one stops.
- Preserve doctor's zero-runtime-dependency, can't-crash posture end to end: the reload + reconcile run inside the same swallow-all-errors discipline as the watch loop, use Node built-ins only, and can never wedge or crash the watchdog.
- Fix the deterministic onboarding "Bringing the fleet up green" deadlock without changing any product installer, the install order, or the health gate.

## Non-Goals

- Changing the registry entry schema or the runtime SQLite contract (owned by [PRD-001](../../completed/prd-001-service-registration-and-telemetry-ingestion/prd-001-service-registration-and-telemetry-ingestion-index.md)). This module changes only *when* the file is read and what doctor does with a changed result.
- Changing the registry file location or the two-location window merge rule (owned by [PRD-004](../../completed/prd-004-apiary-fleet-root-migration/prd-004-apiary-fleet-root-migration-index.md)). Reload reuses `resolveRegistryEntries` verbatim.
- Changing the onboarding install order, the `INSTALLABLE_PRODUCTS` list, or the `V1_REQUIRED_PEERS` health gate. Those are hive-side; this module makes them irrelevant to the bug rather than editing them. (Reordering the queue is the fragile band-aid this module supersedes.)
- Adding an explicit push/reload trigger (a `POST /reload` endpoint, a signal, or an installer that pokes doctor). A pull-based periodic re-resolve is self-sufficient and needs no cross-product coordination; an explicit trigger is deferred (see Open questions).
- Restarting a running daemon whose registry fields changed beyond re-pointing its supervisor. Field changes rebuild the *supervisor*, not the daemon.
- Solving the concurrent registry read-modify-write race (NEC-032, `nectar/src/doctor-registry.ts:28`). It is a separate, writer-side concern; this module only tolerates a torn read (treats it as transient — see 005a).

---

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-005a-registry-live-reload-and-supervisor-reconcile-reload-trigger`](./prd-005a-registry-live-reload-and-supervisor-reconcile-reload-trigger.md) | The runtime re-read: a mtime-gated periodic re-resolve of both registry locations, the reload interval knob, torn/malformed-read safety (keep the current set), and fail-soft/can't-crash wrapping | Draft |
| [`prd-005b-registry-live-reload-and-supervisor-reconcile-supervisor-reconcile`](./prd-005b-registry-live-reload-and-supervisor-reconcile-supervisor-reconcile.md) | The reconcile: diff the new entry list against the live supervisor set (add/remove/update by name + field equality), the primary-daemon invariant, boot-grace arming on add, clean teardown on remove, telemetry-poll-loop + status-page coherence | Draft |

---

## Acceptance criteria (module-level)

| ID | Criterion | Maps to |
|---|---|---|
| AC-1 | Given doctor is running with a registry of `[hive]`, when a `honeycomb` entry is appended to the registry file, then within the reload interval doctor supervises honeycomb (a live supervisor, boot-grace armed) with no reboot. | 005a + 005b |
| AC-2 | Given the onboarding sequence installs doctor first (booting it on `[hive]`), then honeycomb, then nectar, when each registration completes, then doctor ends up supervising `[hive, honeycomb, nectar]` and `/health`/status reports honeycomb, so the `isFleetReady` gate greens without a reboot. | onboarding deadlock fix |
| AC-3 | Given a registry entry is removed (a product's deregister/uninstall), when doctor next reloads, then that daemon's supervisor is stopped and dropped from the supervised set, the status page, and the telemetry poll loop — and the daemon PROCESS is not killed by doctor. | 005b (deregister = stop watching, PRD-003b) |
| AC-4 | Given the registry file has not changed since the last read, when the reload cadence fires, then it is a strict no-op: no re-parse beyond the mtime check, no supervisor rebuild, no restart, no needs-attention record. | 005a idempotence + 005b no-op |
| AC-5 | Given the registry file is present but malformed (or a torn mid-write read), when doctor reloads, then the current supervised set is preserved unchanged (never torn down), the problem is logged + recorded to needs-attention, and reconcile resumes cleanly once the file parses again. | 005a safety |
| AC-6 | Given the honeycomb (primary) entry's fields change, or another product transiently drops it from the file, when doctor reloads, then the primary designation and every process-global surface it backs (status page top-level, install-health snapshot, escalation) stay bound to honeycomb and are never left dangling. | 005b primary invariant |
| AC-7 | Given a reload adds a daemon with a `telemetryDbPath`, when reconcile completes, then that entry is ingested by the telemetry poll-and-merge loop (and a removed entry stops being polled), with no effect on the supervision/remediation loops. | 005b telemetry coherence |
| AC-8 | Given any failure inside the reload or reconcile path (a throwing seam, an unreadable file, a spawn error building a supervisor), when it occurs, then it is swallowed with a log, the watch loop continues, and doctor never crashes or exits. | doctor design principle 1 |
| AC-9 | Given the whole module, when it ships, then doctor still uses only Node built-ins and adds no external runtime dependency. | doctor design principle 1 |

---

## Data model changes

None to any SQLite schema and none to the registry-entry JSON shape.

- One new optional configuration knob: the registry reload interval (default chosen in 005a). Resolved through the same env/config path as doctor's other intervals; absent means the built-in default.

---

## Technical considerations

- **`built` and the telemetry poll loop are snapshots today.** `built: BuiltDaemon[]` is a `const` array (`src/compose/index.ts:715`) and `createPollLoop({ entries: daemons, … })` (`src/compose/index.ts:790`) captures the boot-time entry list. Both the status-page rows (`readDaemonStatusRows` maps over `built`, `src/compose/index.ts:803`) and telemetry ingestion must observe the reconciled set, so this module makes the supervised set a mutable, reconcilable collection and gives the poll loop a way to update its entries (or rebuild it). This is the main structural change; 005b specs it.
- **Reuse `buildDaemon`.** The per-entry factory (`src/compose/index.ts:659`) already produces a fully-independent `{ entry, supervisor, ladder, stateStore }`. Adding a daemon on reload calls the same factory then `supervisor.arm()` + arms startup grace; removing calls `supervisor.stop()`. No new supervisor wiring is invented.
- **Pull, not push, and mtime-gated.** A periodic `stat`-and-compare on both registry locations, re-parsing only when an mtime changed, is robust across the atomic temp-file-plus-rename writes every product uses (`fs.watch` on the file breaks when a rename replaces the inode, and is unreliable on Windows). This mirrors honeycomb's shipped `live-reload.ts`. Interval is a trade-off between onboarding responsiveness (green within a few seconds of the last registration) and idle cost (a cheap `stat`); 005a picks the default.
- **Malformed-on-reload differs from malformed-on-boot.** At boot a malformed registry falls back to the honeycomb primary (`src/compose/index.ts:526`). On *reload* doctor already has a healthy supervised set, so a transient malformed/torn read must NOT tear it down — it keeps the current set and surfaces the problem, converging when the file parses again.
- **Can't-crash.** The reload + reconcile run under the same error-swallowing posture as the watch loop (`supervisor.ts` swallows every exception/rejection), so a reconcile fault is defense-in-depth logged and dropped.
- **Deregister semantics.** Removing a registry entry means "stop watching," not "kill the daemon" (the counterpart to PRD-003b's `deleteRegistryEntry` / product uninstall). Reconcile stops and drops the supervisor; it does not signal or terminate the daemon process.
- **CLI is unaffected.** `doctor status` reads the registry fresh in its own process (`src/cli/index.ts:127`), so it already reflects the current file; only the long-lived daemon needed the reload.

---

## Open questions

- [ ] **Reload interval default** (DEFAULT — confirm before implementation): a mtime `stat` every ~2s, re-parsing only on change. Fast enough that onboarding greens within seconds of the last product registering, cheap enough to run idle for the life of the daemon. Detailed in 005a.
- [ ] **Explicit reload trigger** (deferred): whether to additionally expose a loopback `POST /reload` (or reuse an existing signal) that an installer can poke for instant convergence. The periodic re-resolve makes this unnecessary for correctness; it would only shave the interval off the worst case. Left out of scope unless the interval proves too slow in practice.
- [ ] **Changed-entry granularity**: whether a field change rebuilds the whole supervisor (simple, a brief probe gap) or patches specific fields in place (more surgical). DEFAULT: rebuild the supervisor for that entry — its per-entry state shard (`state-<name>.json`) persists across the rebuild, so no remediation history is lost. Detailed in 005b.

---

## Related

- [`ADR-0002-service-registration-static-registry-plus-runtime-sqlite`](../../../knowledge/private/architecture/ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md) — the registry contract this module re-reads at runtime (doctor is its single manager).
- [PRD-001: Service registration and telemetry ingestion](../../completed/prd-001-service-registration-and-telemetry-ingestion/prd-001-service-registration-and-telemetry-ingestion-index.md) — owns the registry entry schema and the telemetry poll-and-merge loop whose entry set this module keeps in sync.
- [PRD-004: Apiary fleet-root migration](../../completed/prd-004-apiary-fleet-root-migration/prd-004-apiary-fleet-root-migration-index.md) — owns the two-location `resolveRegistryEntries` resolution this module reuses for each reload.
- hive [`fleet-readiness.ts`](../../../../../hive/src/shared/fleet-readiness.ts) — the `V1_REQUIRED_PEERS = ["honeycomb"]` onboarding gate this module unblocks.
- honeycomb [`fleet-registry.ts`](../../../../../honeycomb/src/daemon/runtime/telemetry/fleet-registry.ts) / nectar [`doctor-registry.ts`](../../../../../nectar/src/doctor-registry.ts) — the writers whose "takes effect at doctor's next boot" contract this module relaxes to "takes effect within one reload interval."
