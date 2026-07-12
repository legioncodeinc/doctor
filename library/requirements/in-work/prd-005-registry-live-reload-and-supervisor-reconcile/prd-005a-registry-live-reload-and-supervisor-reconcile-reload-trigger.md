# PRD-005a: Registry reload trigger (mtime-gated periodic re-resolve)

> **Parent:** [PRD-005: Registry live-reload and supervisor reconcile](./prd-005-registry-live-reload-and-supervisor-reconcile-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** S (1-3h)

---

## Goals

Give doctor a runtime mechanism to detect that its supervised-daemon registry has changed and hand the freshly-resolved entry list to the reconciler (005b). The mechanism is a bounded, mtime-gated periodic re-resolve of both registry locations, running for the life of the daemon under doctor's can't-crash discipline.

## Non-Goals

- Acting on the new entry list (add/remove/update supervisors) — that is 005b. 005a's output is a resolved `DaemonEntry[]` (or a "no change" / "unchanged-because-unparseable" signal) handed to a reconcile callback.
- An `fs.watch`/inotify file watcher, or any push trigger. 005a is pull-based and mtime-gated on purpose (see Technical considerations).
- Changing `resolveRegistryEntries` or the two-location merge rule (PRD-004). 005a calls it unchanged.

---

## User stories

### US-005a.1 — Detect a changed registry at runtime

**As** the doctor watchdog, **I want to** notice when my registry file changes after boot, **so that** a daemon registered post-boot can be picked up without a reboot.

**Acceptance criteria:**
- a-AC-1 Given doctor has armed the reload loop, when the reload cadence fires, then doctor `stat`s BOTH registry locations (`<root>/registry.json` and the legacy `~/.honeycomb/doctor.daemons.json`) and compares each mtime (and existence) against the last observed values.
- a-AC-2 Given neither location's mtime/existence changed since the last check, when the cadence fires, then doctor does nothing further this tick — no file read, no parse, no reconcile call (strict idempotence, parent AC-4).
- a-AC-3 Given either location changed (mtime advanced, or a file appeared/disappeared), when the cadence fires, then doctor re-runs `resolveRegistryEntries({ home, env, platform })` and passes the resolved `DaemonEntry[]` to the reconcile callback (005b).

### US-005a.2 — Survive a malformed or torn read without losing the fleet

**As** the doctor watchdog, **I want to** treat an unparseable registry read as transient, **so that** a mid-write torn read or a temporarily-broken file never tears down daemons I am already supervising.

**Acceptance criteria:**
- a-AC-4 Given a changed registry file that fails to resolve (unparseable JSON, wrong shape, `RegistryError`, or any read error), when doctor reloads, then it does NOT call reconcile with an empty/partial list, keeps the last-observed mtimes UNADVANCED (so the next tick re-attempts the changed file), logs the failure once per distinct failure, and records a needs-attention entry naming the offending file.
- a-AC-5 Given a previously-malformed registry file that now parses, when the next cadence fires, then doctor resolves it and calls reconcile normally, and the needs-attention/log state clears on the next healthy read.
- a-AC-6 Given the malformed-on-reload path, when it runs, then it NEVER falls back to the honeycomb primary the way boot does (`src/compose/index.ts:526`): reload preserves the live set, boot bootstraps it — the two postures are deliberately different.

### US-005a.3 — Bounded cost and clean lifecycle

**As** an operator, **I want** the reload loop to be cheap and to stop cleanly, **so that** it costs nothing meaningful at idle and never leaks a timer.

**Acceptance criteria:**
- a-AC-7 Given the reload interval config/env knob is set, when doctor boots, then the loop uses it; absent, it uses the built-in default (DEFAULT ~2000 ms — confirm), resolved through the same config path as doctor's other intervals.
- a-AC-8 Given doctor's watch loop is disarmed (`stop()`), when shutdown runs, then the reload loop is disarmed too (idempotent), driven by the SAME injected `clock` the other loops use so tests are deterministic with a fake clock.
- a-AC-9 Given any exception in the stat/read/resolve path, when it is thrown, then it is swallowed with a log and the loop continues on its next tick (can't-crash, parent AC-8).

---

## Data model changes

None. One new optional interval knob (config + env), read defensively as absent → default. No registry-shape or SQLite change.

---

## Technical considerations

- **Why mtime-gated pull, not `fs.watch`.** Every product writes the registry via a temp-file-plus-atomic-rename (`honeycomb/src/daemon/runtime/telemetry/fleet-registry.ts` `writeMergedRegistry`, `nectar/src/doctor-registry.ts` `writeRegistryAtomic`). `fs.watch` bound to the file loses its target when the rename swaps the inode, and `fs.watch` is unreliable/duplicative on Windows — doctor's primary platform for this bug. A periodic `fs.statSync` on each path, comparing `mtimeMs` + existence, is a built-in, deterministic, cross-platform trigger that survives atomic replaces. It mirrors honeycomb's shipped `src/daemon/storage/live-reload.ts`.
- **Two locations.** During the ADR-0003 window entries can live in either file; `stat` and gate on BOTH, and let `resolveRegistryEntries` do the new-wins-per-name additive merge unchanged.
- **Torn-read tolerance.** A read that lands between another writer's `writeFile(tmp)` and `rename(tmp, path)` sees either the old file (rename is atomic) or, rarely, a partial temp artifact if a path is misconfigured; either way an unparseable result is treated as transient (a-AC-4) and retried next tick rather than acted on.
- **Not advancing mtime on failure** (a-AC-4) is deliberate: it guarantees the next tick re-attempts the exact file that failed, so a slow/racy writer converges rather than being skipped until its *next* write.
- **Built-ins only:** `node:fs` (`statSync`) + the existing `resolveRegistryEntries`. No new dependency. The loop is `async` over the injected `clock.sleep`, matching `runInstallHealthLoop` (`src/compose/index.ts:874`).

## Files touched

### New files
- `src/registry-reload.ts` — the mtime-gated reload loop: `createRegistryReloadLoop({ home, env, clock, logger, intervalMs, onEntries })` exposing `arm()` / `stop()`; the last-observed-mtime state; the tolerant re-resolve.
- `tests/registry-reload.test.ts` — fake clock + fake fs seams: unchanged→no-op, changed→onEntries called, malformed→current-set-kept + mtime-not-advanced + recovers, stop() disarms.

### Modified files
- `src/config.ts` — add the optional reload-interval field + its env read (defensive, default applied).
- `src/compose/index.ts` — construct + `arm()` the reload loop in `createDoctor`, wire `onEntries` to 005b's reconciler, and disarm it in the daemon's `stop()` path.

## Test plan

- Unit (`registry-reload.test.ts`): drive the fake clock; assert `resolveRegistryEntries` is called only when a fake mtime advances; assert an injected parse failure keeps the previous mtimes and calls `onEntries` zero times; assert recovery on the next healthy read; assert `stop()` cancels the loop.
- Integration (in `compose` test): boot doctor with a temp registry of `[hive]`, append a `honeycomb` entry to the file, advance the fake clock past one interval, assert the reconcile callback receives `[hive, honeycomb]`.

## Risks and open questions

- **Risk:** too-short an interval wastes wakeups; too-long delays onboarding green. **Mitigation:** mtime-gate makes the common (unchanged) tick a single `stat`; default ~2s. Open question in the index.
- **Open question:** should the interval auto-tighten during a detected onboarding window and relax afterward? Deferred — a fixed cheap interval is simpler and sufficient.

## Related

- [PRD-004](../../completed/prd-004-apiary-fleet-root-migration/prd-004-apiary-fleet-root-migration-index.md) — `resolveRegistryEntries` two-location resolution reused here.
- [`prd-005b-…-supervisor-reconcile`](./prd-005b-registry-live-reload-and-supervisor-reconcile-supervisor-reconcile.md) — the consumer of this trigger's resolved entry list.
- honeycomb `src/daemon/storage/live-reload.ts` — the mtime-gated live-reload prior art in the fleet.
