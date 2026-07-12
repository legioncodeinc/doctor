# Execution Ledger — PRD-005: Registry live-reload and supervisor reconcile

> Single source of truth for the smoker run. Status values: OPEN / IN PROGRESS / DONE / VERIFIED / BLOCKED.
> Branch: `feat/prd-005-registry-live-reload` (doctor submodule). PRD: `library/requirements/in-work/prd-005-registry-live-reload-and-supervisor-reconcile/`.

## Wave plan

| Wave | Bee | Model | Owns | Exit criteria |
|---|---|---|---|---|
| 1 | `typescript-node-worker-bee` | opus | Implement 005a + 005b in full (both sub-PRDs are one cohesive change to `src/compose/index.ts`; splitting would only cause merge conflicts). New `src/registry-reload.ts` + `src/registry-reconcile.ts`, config knob, compose refactor (`built`→mutable, poll-loop entry-set update, primary invariant), full Vitest coverage. | Every module AC + a-AC + b-AC implemented; `npm run ci` (typecheck + vitest) green; no pre-existing test broken. |
| 2 | `security-worker-bee` | opus | Audit the reload/reconcile surface (SSRF via registry healthUrl already loopback-gated; path handling; can't-crash; no new attack surface). Remediate Critical/High in place. | Clean at ≥ medium; fixes don't regress any AC. |
| 3 | `quality-worker-bee` | opus | Verify implementation against all three PRD files; write QA report to the PRD's `qa/`. | Every AC VERIFIED; report written. |

Dependencies: Wave 1 → Wave 2 → Wave 3 (strict; security before quality).

## AC Ledger

### Module-level (index)

| ID | Criterion (abbrev) | Status | Owner |
|---|---|---|---|
| AC-1 | Append `honeycomb` to a `[hive]` registry → within interval doctor supervises honeycomb (armed, boot-grace) without reboot | VERIFIED | ts-node |
| AC-2 | Onboarding order (doctor first on `[hive]`, then honeycomb, then nectar) → doctor converges to `[hive,honeycomb,nectar]`; honeycomb reported → gate greens, no reboot | VERIFIED | ts-node |
| AC-3 | Entry removed → supervisor stopped + dropped from set/status/telemetry; daemon process NOT killed | VERIFIED | ts-node |
| AC-4 | Unchanged registry → strict no-op (mtime check only, no rebuild/restart/needs-attention) | VERIFIED | ts-node |
| AC-5 | Malformed/torn read → current set preserved, logged + needs-attention, resumes when parseable | VERIFIED | ts-node |
| AC-6 | Primary (honeycomb) field change or transient omission → primary + global surfaces stay bound, never dangling | VERIFIED | ts-node |
| AC-7 | Reload adds daemon w/ telemetryDbPath → ingested by poll loop; removed one stops; no effect on supervision loops | VERIFIED | ts-node |
| AC-8 | Any failure in reload/reconcile → swallowed + logged, watch loop continues, doctor never crashes | VERIFIED | ts-node |
| AC-9 | Ships with Node built-ins only, no external runtime dependency | VERIFIED | ts-node |

### 005a — Reload trigger

| ID | Criterion (abbrev) | Status | Owner |
|---|---|---|---|
| a-AC-1 | Cadence fires → `stat` BOTH registry locations, compare mtime + existence vs last observed | VERIFIED | ts-node |
| a-AC-2 | Neither changed → nothing further (no read/parse/reconcile) | VERIFIED | ts-node |
| a-AC-3 | Either changed → re-run `resolveRegistryEntries`, pass entries to reconcile callback | VERIFIED | ts-node |
| a-AC-4 | Changed-but-unparseable → no empty reconcile, mtimes NOT advanced, log once, needs-attention names file | VERIFIED | ts-node |
| a-AC-5 | Previously-malformed now parses → reconcile normally, log/needs-attention clears | VERIFIED | ts-node |
| a-AC-6 | Malformed-on-reload NEVER falls back to honeycomb primary (unlike boot) — preserves live set | VERIFIED | ts-node |
| a-AC-7 | Interval knob honored; absent → built-in default (~2000ms) via same config path | VERIFIED | ts-node |
| a-AC-8 | `stop()` disarms reload loop (idempotent); driven by injected clock (deterministic tests) | VERIFIED | ts-node |
| a-AC-9 | Any exception in stat/read/resolve → swallowed + logged, loop continues next tick | VERIFIED | ts-node |

### 005b — Supervisor reconcile

| ID | Criterion (abbrev) | Status | Owner |
|---|---|---|---|
| b-AC-1 | New name → `buildDaemon(entry)` + `arm()` + startup grace armed | VERIFIED | ts-node |
| b-AC-2 | Added daemon → appears in status rows + (if telemetryDbPath) ingested by poll loop | VERIFIED | ts-node |
| b-AC-3 | Onboarding order converges to `[hive,honeycomb,nectar]`; honeycomb answering flips gate | VERIFIED | ts-node |
| b-AC-4 | Name absent from new list → `stop()` supervisor, remove from set/status/telemetry | VERIFIED | ts-node |
| b-AC-5 | Dropped supervisor → daemon process NOT killed; `state-<name>.json`/`incidents-<name>.ndjson` left on disk | VERIFIED | ts-node |
| b-AC-6 | Primary field change → rebuild in place + re-point global surfaces, never dangling | VERIFIED | ts-node |
| b-AC-7 | Transient omission of honeycomb → primary NOT torn down, re-adopted on reappearance | VERIFIED | ts-node |
| b-AC-8 | Identical entry → supervisor untouched (no rebuild/re-arm/probe reset) | VERIFIED | ts-node |
| b-AC-9 | Changed field → only that supervisor rebuilt (stop→build→arm); state shard persists; others untouched | VERIFIED | ts-node |
| b-AC-10 | Failure building/arming/stopping one supervisor → swallowed + logged, rest of reconcile applies, no crash | VERIFIED | ts-node |

## Log

- Phase 0 complete: branch `feat/prd-005-registry-live-reload` cut; PRD moved to in-work; 28 ACs enumerated; wave plan set.
- Wave 1 (ts-node) complete: all 28 ACs implemented + covered by passing tests. New `src/registry-reload.ts` (mtime-gated re-resolve loop) + `src/registry-reconcile.ts` (add/remove/update/no-op diff with the primary invariant + telemetry-set update); `registryReloadIntervalMs` knob added to `src/config.ts` (default 2000, `DOCTOR_REGISTRY_RELOAD_INTERVAL_MS`); `src/compose/index.ts` refactored (`built` array -> mutable `Map<string, BuiltDaemon>`, `let primary` re-pointable, `armDaemon` seam, reload loop armed in `start()` / disarmed in `stop()`, live getters). Tests: `tests/registry-reload.test.ts` (a-AC-1..9), `tests/registry-reconcile.test.ts` (b-AC-1..10), `tests/compose/registry-reload-reconcile.test.ts` (module AC-1..9 end to end). `npm run ci` green: typecheck clean, 831 tests passing (69 files), zero pre-existing tests broken. `package.json` dependencies still `{}` (Node built-ins only). Status DONE (not VERIFIED — awaiting Wave 2 security + Wave 3 quality).
- Orchestrator verification of Wave 1: independently re-ran `npm run ci` (831/831 green); read `src/registry-reload.ts`, `src/registry-reconcile.ts`, and the full `src/compose/index.ts` + `src/config.ts` diff. Confirmed no stubs/mocks-in-production; `armDaemon` truly arms runtime-added supervisors via `supervisor.start()`; `updateTelemetryEntries` maps to the pre-existing real `PollLoop.reload` seam; reconcile does zero filesystem I/O (so removal cannot kill a process or delete a shard by construction). Proceeding to Wave 2 (security).
- Wave 2 (security-worker-bee, opus) complete: CLEAN — 0 Critical, 0 High. Reload resolves through the exact production coercion path boot uses (loopback-only healthUrl SSRF gate, assertWithinBase telemetryDbPath containment); reconcile does zero fs writes / zero process signals. Added a hermetic regression test proving a poisoned registry (link-local healthUrl + traversal telemetryDbPath) is neutralized on the reload path. Only pre-existing Lows at boot parity (pidPath containment, daemons[] length cap, supervisorRuns splice) — documented as follow-ups, not reload regressions. Report: qa/2026-07-12-security-audit.md. npm run ci green (832), deps {}.
- Wave 3 (quality-worker-bee, opus) complete: PASS — all 28 ACs VERIFIED by an independent adversarial pass; no PARTIAL/FAIL. Confirmed strict no-op on unchanged registry, malformed-reload preserves live set + never falls back to primary, removal does zero fs I/O (no process kill/shard delete by construction), primary rebuild re-points global surfaces + transient omission keeps the slot, telemetry PollLoop.reload coherence, deps {}. Two beyond-AC Suggestions (S-1 registryPath seam is spec-conformant per a-AC-3; S-2 armDaemon running-branch integration coverage) — neither an AC gap. Report: qa/2026-07-12-qa-report.md. npm run ci green (832).
- Close-out clean (security before quality, correct order). All 28 ACs VERIFIED. Ledger ready to ship.
- CodeRabbit review resolved (PR #20): (code) UPDATE path in registry-reconcile.ts now builds the replacement BEFORE stopping the old supervisor — a throwing buildDaemon leaves the current supervisor + primary intact (b-AC-10 strengthened, +2 regression tests); (code) armDaemon run-promises self-splice from supervisorRuns on settle, bounding the join list under add/remove churn (security Low-3, now PR-introduced-and-fixed); (docs) narrowed the "zero fs I/O" wording to "no process kill or shard deletion", added `text` fence languages, reclassified security Low-3, and corrected the stale "QA has not run" ordering note. npm run ci green (834 tests).
