# PRD-004: Apiary fleet-root migration (doctor's share of ADR-0003)

> **Status:** Completed
> **Priority:** P0
> **Effort:** L (1-3d)
> **Schema changes:** None to SQLite; on-disk layout relocation (the registry file moves; its JSON shape is unchanged)

---

## Overview

This module is doctor's share of fleet [`ADR-0003`](../../../knowledge/private/architecture/ADR-0003-fleet-directory-ownership-and-neutral-state-root.md): migrate doctor's on-disk state from the legacy `~/.honeycomb` root to the new brand-neutral fleet root `~/.apiary/`. The root name was confirmed by the user on 2026-07-04 (`~/.apiary/` over the supervisor-branded `~/.doctor/`; the ADR's "DECISION TO CONFIRM" is resolved). `~/.deeplake/` is unchanged.

Doctor has the largest role of the four products. Every other product migrates exactly one per-product subdirectory; doctor migrates its own subdirectory (`~/.apiary/doctor/`) AND relocates the fleet-shared coordination surface it manages:

- the cross-daemon registry, `~/.honeycomb/doctor.daemons.json` (`doctor/src/registry.ts:105-107`) moving to `~/.apiary/registry.json`,
- the shared device id, `~/.honeycomb/device.json` (`doctor/src/device-id.ts:50-52`) moving to `~/.apiary/device.json`,
- the shared anonymous install id, `~/.honeycomb/install-id` (`doctor/src/telemetry/capture.ts:141-144`) moving to `~/.apiary/install-id` (installer-written; doctor is a reader).

Because doctor supervises the other daemons, it must also stay correct through the migration window: a not-yet-migrated honeycomb, nectar, or hive whose registry entry still carries legacy `~/.honeycomb` paths must keep being probed and ingested exactly as before. That includes the built-in honeycomb fallback entry (`doctor/src/registry.ts:114-124`), the default pid paths (`doctor/src/config.ts:155`, `doctor/src/registry.ts:243`), and the security-relevant telemetry-path trust coercion that today pins telemetry databases under `~/.honeycomb/telemetry/` (`doctor/src/registry.ts:194-221`, trusted root built at `doctor/src/registry.ts:209`).

All state resolution stays anchored on `os.homedir()` through one shared root helper; `process.cwd()` never participates (the ADR's structural fix for the service-manager working-directory footgun).

**This index covers the module scope.** Sub-PRDs 004a, 004b, and 004c own the three discrete pieces below.

---

## Goals

- Introduce one shared fleet-root helper with the ADR-0003 resolution chain (per the ADR's Resolved decisions, confirmed 2026-07-04): `APIARY_HOME` env var (the installer `--home=` pin is delivered as `APIARY_HOME`), then `$XDG_STATE_HOME/apiary` on Linux only when `$XDG_STATE_HOME` is explicitly set, then `<os.homedir()>/.apiary`. There is no `~/.local/state` default. Never `process.cwd()`.
- Move doctor's own runtime state (workspace dir, install lock, staged service artifacts) from `~/.honeycomb/doctor/` to `~/.apiary/doctor/`.
- Relocate the fleet-shared coordination surface doctor manages: registry to `~/.apiary/registry.json`, device id to `~/.apiary/device.json`, install id read from `~/.apiary/install-id`.
- Perform a one-time, idempotent, additive migration on first boot; never delete a legacy file that was not successfully migrated.
- Read the new path first and fall back to the legacy path for every relocated file until the fleet is migrated, so pid/lock/registry continuity is never lost mid-window.
- Tolerate registry entries written to either location during the window (other products' installers are updated in their own parallel PRDs), with an explicit merge/precedence rule.
- Keep supervising daemons whose registry entries still carry legacy paths; extend the telemetry trusted-root check to the new per-product locations without weakening it.
- Preserve doctor's zero-runtime-dependency, can't-crash posture end to end (built-ins only).

## Non-Goals

- Migrating honeycomb's, nectar's, or hive's own state. Each product moves its own subdirectory in a parallel PRD in its own repo (see Cross-repo coordination).
- The installer changes themselves: `install.sh` / `install.ps1` pinning the resolved root into service environments, writing `~/.apiary/install-id`, and the Windows LocalSystem enterprise opt-in capturing the installing user's home at install time. That is superproject installer work (the-apiary [`ADR-0002`](../../../../../library/knowledge/private/architecture/ADR-0002-one-line-installer-product-loading-and-install-time-telemetry.md)); this module only defines what doctor reads and honors (`APIARY_HOME` first).
- Changing the registry entry schema or the runtime SQLite contract. Those are owned by [PRD-001](../prd-001-service-registration-and-telemetry-ingestion/prd-001-service-registration-and-telemetry-ingestion-index.md); this module changes only where files live.
- Removing the legacy fallback reads. Removal has a defined criterion (all supported install paths ship the migration, per ADR-0003) and is deliberately out of scope here.
- Touching `~/.deeplake/` (explicitly unchanged by ADR-0003).

---

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-004a-apiary-fleet-root-migration-shared-root-helper`](./prd-004a-apiary-fleet-root-migration-shared-root-helper.md) | The shared fleet-root helper (resolution chain, never cwd) and doctor's own subdirectory move: workspace dir, install lock, staged service artifacts | Draft |
| [`prd-004b-apiary-fleet-root-migration-coordination-surface`](./prd-004b-apiary-fleet-root-migration-coordination-surface.md) | Relocating the fleet-shared coordination surface: registry, device id, install id; the one-time migration; the both-locations merge/precedence rule for the window | Draft |
| [`prd-004c-apiary-fleet-root-migration-supervision-continuity`](./prd-004c-apiary-fleet-root-migration-supervision-continuity.md) | Supervision continuity mid-window: the honeycomb fallback entry, default pid paths, and the telemetry-path trusted-root extension (security-relevant) | Draft |

---

## Acceptance criteria (module-level)

| ID | Criterion | Maps to |
|---|---|---|
| AC-1 | Given no overrides, when any doctor path is resolved, then it is anchored at `<os.homedir()>/.apiary` via the shared root helper and `process.cwd()` is never consulted. | ADR-0003 decision (home-anchored, never cwd) |
| AC-2 | Given `APIARY_HOME` is set (including the installer-pinned service environment), when doctor resolves the fleet root, then that value wins over XDG and the default. | ADR-0003 decision (one precedence chain) |
| AC-3 | Given a fresh boot where `~/.apiary/registry.json` is absent but `~/.honeycomb/doctor.daemons.json` exists, when doctor boots, then it performs the one-time migration and supervises the same fleet with no entry lost. | ADR-0003 migration |
| AC-4 | Given the migration already ran, when doctor boots again, then the migration is a no-op (idempotent) and no legacy file that failed to migrate has been deleted. | ADR-0003 migration (idempotent, additive) |
| AC-5 | Given entries written to the new and the legacy registry location during the window, when doctor loads the registry, then both locations' entries are visible under the documented merge/precedence rule. | ADR-0003 back-compat window |
| AC-6 | Given a supervised daemon whose registry entry still carries legacy `~/.honeycomb` paths (pid path, telemetry DB path), when doctor probes and ingests, then supervision behaves exactly as before the migration. | ADR-0003 back-compat window |
| AC-7 | Given a registry entry with a telemetry DB path under a new per-product location `~/.apiary/<product>/telemetry/`, when the entry is parsed, then the trusted-root check accepts it; a path outside every trusted root still degrades to health-probe-only. | ADR-0003 layout; PRD-001a security posture |
| AC-8 | Given doctor's own state (workspace, install lock), when doctor runs post-migration, then it lives under `~/.apiary/doctor/` and no new writes land under `~/.honeycomb/doctor/`. | ADR-0003 layout (per-product subdirs) |
| AC-9 | Given the whole module, when it ships, then doctor still uses only Node built-ins and adds no external runtime dependency. | doctor design principle 1 |

---

## Data model changes

None to any SQLite schema. The changes are on-disk layout only:

- The registry file relocates from `~/.honeycomb/doctor.daemons.json` to `~/.apiary/registry.json`. Its JSON shape (`{ "daemons": [ ... ] }`, PRD-004a fields plus PRD-001a's optional `telemetryDbPath`) is unchanged.
- `device.json` and `install-id` relocate to the fleet root with unchanged content shapes.
- Doctor's workspace artifacts (install lock, staged schtasks XML, launchd log paths) follow the workspace dir to `~/.apiary/doctor/`.

---

## Cross-repo coordination

This is a four-repo migration (ADR-0003's stated cost). Doctor's module is the anchor because it owns the shared surface; the parallel work is:

- **honeycomb:** a parallel fleet-root PRD (expected under `honeycomb/library/requirements/`) moving honeycomb's pid, lock, config, and telemetry to `~/.apiary/honeycomb/`, updating its registry-entry writes to the relocated registry, and moving its side of the shared `device.json` reader/writer (`src/daemon/runtime/assets/device.ts`, cited by `doctor/src/device-id.ts:8`).
- **nectar:** a parallel fleet-root PRD (expected under `nectar/library/requirements/backlog/`) replacing `RUNTIME_DIR_NAME = ".honeycomb"` (`nectar/src/config.ts:15`) with the shared root helper (`~/.apiary/nectar/`), including PRD-019's brooding `projects.json`, and updating its installer registry writes.
- **hive:** a parallel fleet-root PRD (expected under `hive/library/requirements/backlog/`) moving hive's runtime state to `~/.apiary/hive/` and updating its installer registry writes.
- **superproject installer:** `install.sh` / `install.ps1` write `~/.apiary/install-id`, write registry entries to `~/.apiary/registry.json`, pin the resolved root into service environments as `APIARY_HOME`, and (Windows LocalSystem enterprise opt-in only) capture the installing user's home at install time so state never lands under `System32` (ADR-0003 "Windows LocalSystem edge").

During the window, doctor tolerates a mixed fleet: any product not yet migrated keeps working through the legacy fallbacks defined in 004b and 004c.

---

## Open questions

- [x] **Merge/precedence rule when both registry files exist**: RESOLVED and adopted into fleet ADR-0003 "Resolved decisions" (the registry compatibility window contract, confirmed 2026-07-04): load `~/.apiary/registry.json`, then additively merge entries from the legacy file whose `name` is not already present; on a `name` collision the new-location entry wins; doctor never writes merged results back to the legacy file. Detailed in 004b.
- [x] **Linux default when `$XDG_STATE_HOME` is unset**: RESOLVED per fleet ADR-0003 "Resolved decisions" (confirmed 2026-07-04): honor XDG only when `$XDG_STATE_HOME` is explicitly set; the unqualified default is `~/.apiary` on every platform. Detailed in 004a.
- [ ] **Per-entry binding of the new telemetry trust roots** (DEFAULT - confirm before implementation): bind each entry's accepted new-location root to that entry's own product name. Detailed in 004c.

---

## Related

- [`ADR-0003-fleet-directory-ownership-and-neutral-state-root`](../../../knowledge/private/architecture/ADR-0003-fleet-directory-ownership-and-neutral-state-root.md) - the fleet ADR this module implements (local mirror; authoritative copy in the superproject).
- the-apiary [`ADR-0003`](../../../../../library/knowledge/private/architecture/ADR-0003-fleet-directory-ownership-and-neutral-state-root.md) - the authoritative superproject copy.
- [`ADR-0002-service-registration-static-registry-plus-runtime-sqlite`](../../../knowledge/private/architecture/ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md) - the registry contract whose path this module changes (doctor is its single manager).
- the-apiary [`ADR-0002-one-line-installer-product-loading-and-install-time-telemetry`](../../../../../library/knowledge/private/architecture/ADR-0002-one-line-installer-product-loading-and-install-time-telemetry.md) - the installer that writes the registry and pins the resolved root into service units.
- [PRD-001: Service registration and telemetry ingestion](../prd-001-service-registration-and-telemetry-ingestion/prd-001-service-registration-and-telemetry-ingestion-index.md) - owns the registry entry schema and the telemetry trusted-root posture this module relocates.
- nectar [`PRD-019: project-scoped brooding activation`](../../../../../nectar/library/requirements/backlog/prd-019-project-scoped-brooding-activation/prd-019-project-scoped-brooding-activation-index.md) - the forcing function whose brooding-state file lands at `~/.apiary/nectar/projects.json` per ADR-0003.
