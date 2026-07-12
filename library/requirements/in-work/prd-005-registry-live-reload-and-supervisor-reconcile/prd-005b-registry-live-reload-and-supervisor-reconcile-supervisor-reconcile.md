# PRD-005b: Supervisor-set reconciliation

> **Parent:** [PRD-005: Registry live-reload and supervisor reconcile](./prd-005-registry-live-reload-and-supervisor-reconcile-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** M (3-8h)

---

## Goals

Given a freshly-resolved `DaemonEntry[]` from the reload trigger (005a), reconcile doctor's live supervisor set to match it: add supervisors for newly-registered daemons, stop and drop supervisors for deregistered ones, rebuild supervisors whose entry fields changed, and leave unchanged entries untouched — all while keeping the primary (honeycomb) designation and its process-global surfaces stable and the telemetry poll loop in sync.

## Non-Goals

- Deciding *when* to reload or how the new list is produced — that is 005a.
- Killing, signalling, or restarting a daemon PROCESS on removal or field change. Reconcile operates on doctor's own supervisors, never on the supervised daemons themselves.
- Changing per-entry supervision behavior (probe cadence, restart ladder, boot grace) — reconcile reuses `buildDaemon` (`src/compose/index.ts:659`) so an added daemon is supervised identically to a boot-time one.

---

## User stories

### US-005b.1 — Adopt a newly-registered daemon

**As** the doctor watchdog, **I want to** start supervising a daemon that appears in the registry after boot, **so that** a product installed during onboarding (honeycomb, nectar) is watched and reported without a reboot.

**Acceptance criteria:**
- b-AC-1 Given the reconciled list contains a `name` not in the live set, when reconcile runs, then doctor calls `buildDaemon(entry)`, `arm()`s the new supervisor, and arms its startup grace so the just-registered daemon is not immediately escalated as down during its cold boot.
- b-AC-2 Given a daemon was just added, when the status page and telemetry loop next read, then the new entry appears in `readDaemonStatusRows` output and (if it carries `telemetryDbPath`) is ingested by the poll loop (parent AC-7).
- b-AC-3 Given the onboarding order (doctor boots on `[hive]`, then honeycomb registers, then nectar), when each reload fires, then doctor converges to supervising `[hive, honeycomb, nectar]`, and honeycomb answering its probe is what flips the `isFleetReady` gate green (parent AC-2).

### US-005b.2 — Drop a deregistered daemon

**As** the doctor watchdog, **I want to** stop supervising a daemon whose registry entry was removed, **so that** an uninstalled product stops being probed, escalated, and reported — without me terminating its process.

**Acceptance criteria:**
- b-AC-4 Given a `name` in the live set is absent from the reconciled list, when reconcile runs, then doctor `stop()`s that supervisor (idempotent), removes it from the live set, the status rows, and the telemetry poll loop.
- b-AC-5 Given a supervisor is dropped, when reconcile runs, then doctor does NOT kill/signal the daemon process (deregister = stop watching, the counterpart to PRD-003b `deleteRegistryEntry`), and the entry's persisted `state-<name>.json` / `incidents-<name>.ndjson` shards are left on disk untouched.

### US-005b.3 — Keep the primary daemon and global surfaces stable

**As** an operator, **I want** honeycomb's dashboard/status surfaces to stay coherent across reloads, **so that** a reload can never blank the top-level health, install-health heartbeat, or escalation banner.

**Acceptance criteria:**
- b-AC-6 Given the primary (honeycomb) entry's fields change, when reconcile runs, then doctor rebuilds the honeycomb supervisor in place and re-points the process-global surfaces (status-page top-level `escalation`/`health`, install-health snapshot source, auto-update restart re-arm) at the rebuilt primary — never leaving a dangling reference.
- b-AC-7 Given a reload result that transiently omits the honeycomb entry (another writer mid-update), when reconcile runs, then the primary is NOT torn down: the honeycomb slot is preserved (last-known primary retained) so the global surfaces stay bound, and honeycomb is re-adopted when it reappears. (Combined with 005a a-AC-4, a fully-unparseable read never reaches reconcile at all.)

### US-005b.4 — No churn on an unchanged or field-identical entry

**As** an operator, **I want** reconcile to be a precise diff, **so that** re-reading an unchanged registry never restarts a healthy supervisor.

**Acceptance criteria:**
- b-AC-8 Given an entry whose `name` and every field are identical to the live entry, when reconcile runs, then its supervisor is left exactly as-is (no rebuild, no re-arm, no probe reset).
- b-AC-9 Given an entry whose `name` matches a live entry but a field differs (`healthUrl`, `pidPath`, `probeIntervalMs`, `startupGraceMs`, `restartGiveUpThreshold`, `restartCooldownMs`, `telemetryDbPath`), when reconcile runs, then only that one supervisor is rebuilt (stop old → `buildDaemon(newEntry)` → arm), its `state-<name>.json` shard persists across the rebuild, and every other supervisor is untouched.
- b-AC-10 Given any failure while building/arming/stopping a single supervisor during reconcile, when it occurs, then it is swallowed with a log, the rest of the reconcile still applies, and doctor never crashes (parent AC-8).

---

## Data model changes

None. Reconcile mutates in-memory supervisor state only; per-entry on-disk shards are reused as-is across rebuilds.

---

## Technical considerations

- **Make the supervised set mutable.** Today `built: BuiltDaemon[]` is a boot-time `const` (`src/compose/index.ts:715`) and the status page closes over it (`readDaemonStatusRows`, `src/compose/index.ts:803`). Reconcile needs an owned, mutable collection (e.g. a `Map<string, BuiltDaemon>` keyed by `name`) that `readDaemonStatusRows` and the reconciler both reference, so a status read after a reconcile reflects the new set without re-wiring the status page.
- **Primary invariant.** The primary is `daemons[0]` (honeycomb) and backs `emitInstallHealthSnapshot` (`src/compose/index.ts:841`), the auto-update `restartDaemon` re-arm (`src/compose/index.ts:755`), and the status-page top-level `escalation`/`health` (`src/compose/index.ts:820`). Reconcile must treat the honeycomb slot specially: rebuild-in-place on change, never drop on a transient omission (b-AC-7). Keeping a stable `primary` reference that reconcile re-assigns atomically on a honeycomb rebuild is the safe shape.
- **Telemetry poll loop entry set.** `createPollLoop({ entries: daemons, … })` (`src/compose/index.ts:790`) snapshots the entry list. Give the poll loop a way to observe the reconciled entries (an `updateEntries(entries)` method, or rebuild the loop) so a newly-supervised daemon with `telemetryDbPath` starts being polled and a removed one stops — without disturbing the in-flight `/events` SSE stream.
- **Reuse, don't reinvent.** Add = `buildDaemon(entry)` + `supervisor.arm()` + `armStartupGrace()`. Remove = `supervisor.stop()`. Update = remove-then-add for that one name. All three already exist; reconcile is the orchestration + the diff.
- **Diff key + equality.** Diff by `name`; within a matched name compare the seven supervision fields for equality to decide identical-vs-changed. `escalation` is opaque pass-through and not compared.
- **Ordering within a tick.** Apply removes and updates before adds, or in any order — supervisors are independent, so there is no cross-entry ordering hazard; the only shared concern is the primary reference, handled explicitly.

## Files touched

### New files
- `src/registry-reconcile.ts` — `reconcileSupervisors(current: Map<string, BuiltDaemon>, next: DaemonEntry[], deps)` computing the add/remove/update diff and applying it via `buildDaemon` / `arm` / `stop`, with the primary-slot rule and the telemetry-loop update; pure enough to unit-test with fake supervisors.
- `tests/registry-reconcile.test.ts` — add/remove/update/no-op cases; primary-omission preserves the slot; a throwing `buildDaemon` for one entry doesn't abort the rest; telemetry entry-set updated.

### Modified files
- `src/compose/index.ts` — convert `built` to a reconcilable `Map`, expose `buildDaemon` to the reconciler, give the telemetry poll loop an entry-set update seam, make `primary` reassignable, and pass the reconciler as 005a's `onEntries` callback.
- `src/service/index.ts` (poll loop) or `src/ingestion/poll-loop.ts` — add the `updateEntries` seam if the loop is rebuilt rather than replaced.

## Test plan

- Unit (`registry-reconcile.test.ts`): fake `BuiltDaemon`s recording `arm`/`stop`; assert add→build+arm+grace, remove→stop+drop (no process signal), update→rebuild-one-only, no-op→nothing, primary-omission→slot kept, per-entry build throw→isolated.
- Integration (`compose` test, with 005a): boot on `[hive]`, write `[hive, honeycomb]`, tick the clock, assert honeycomb supervised + in status rows + polled; then write `[hive]` (drop honeycomb), tick, assert honeycomb supervisor stopped and gone from status/telemetry while its state shard remains on disk.
- Regression: an unchanged registry re-read across many ticks causes zero `arm`/`stop` calls (parent AC-4).

## Risks and open questions

- **Risk:** a rebuild-on-change briefly gaps that daemon's probe. **Mitigation:** rebuild is stop→build→arm within one tick; the per-entry `state-<name>.json` persists, so no remediation history or boot-grace accounting is lost. Acceptable; field changes are rare (install-time only).
- **Risk:** the primary-slot special-casing is the trickiest surface. **Mitigation:** explicit b-AC-6/b-AC-7 tests; keep a single mutable `primary` reference reconcile updates atomically.
- **Open question:** should a removed *primary* (honeycomb genuinely uninstalled, not a transient omission) ever drop the global surfaces, or is honeycomb-always-primary a hard invariant? DEFAULT: honeycomb is a hard primary — a real honeycomb uninstall is out of scope for a live reload and would be handled by doctor's own uninstall path.

## Related

- [`prd-005a-…-reload-trigger`](./prd-005a-registry-live-reload-and-supervisor-reconcile-reload-trigger.md) — produces the resolved entry list this sub-PRD reconciles.
- [PRD-001](../../completed/prd-001-service-registration-and-telemetry-ingestion/prd-001-service-registration-and-telemetry-ingestion-index.md) — the telemetry poll-and-merge loop whose entry set b-AC-2/b-AC-7 keep in sync.
- [PRD-004](../../completed/prd-004-apiary-fleet-root-migration/prd-004-apiary-fleet-root-migration-index.md) — `buildDaemon` / per-entry shard model this reconcile reuses.
