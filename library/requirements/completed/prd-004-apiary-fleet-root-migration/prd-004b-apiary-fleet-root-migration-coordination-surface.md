# PRD-004b: Relocating the fleet-shared coordination surface

> **Status:** Draft
> **Parent:** [PRD-004: Apiary fleet-root migration](./prd-004-apiary-fleet-root-migration-index.md)
> **Priority:** P0
> **Effort:** M (3-8h)
> **Schema changes:** None (the registry JSON shape, `device.json` shape, and `install-id` content are unchanged; only locations move)

---

## Overview

Doctor is the single manager of the fleet's shared coordination surface (ADR-0003: "doctor (the supervisor) remains their manager and the single writer/reader of the registry contract"). This sub-PRD relocates that surface to the fleet root and defines the compatibility window:

- **Registry:** `defaultRegistryPath` returns `~/.honeycomb/doctor.daemons.json` today (`doctor/src/registry.ts:105-107`); it moves to `~/.apiary/registry.json`. Every other product's installer writes entries into this file, so the window must tolerate entries written to either location until honeycomb, nectar, and hive ship their parallel PRDs and the superproject installer is updated.
- **Device id:** `deviceFilePath` returns `~/.honeycomb/device.json` today (`doctor/src/device-id.ts:50-52`); it moves to `~/.apiary/device.json`. This file is fleet-shared and doctor-managed, but the honeycomb daemon reads and writes the same file in the same shape (`src/daemon/runtime/assets/device.ts`, cited at `doctor/src/device-id.ts:8`), so the move must be coordinated with honeycomb's parallel PRD.
- **Install id:** the shared anonymous install id is read from `~/.honeycomb/install-id` today (`doctor/src/telemetry/capture.ts:141-144`); doctor reads it from `~/.apiary/install-id`. Doctor is a reader only; the writer is `install.sh` / `install.ps1` (superproject installer work).

The registry contract itself (doctor [`ADR-0002`](../../../knowledge/private/architecture/ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md), entry schema per PRD-004a plus PRD-001a) is unchanged; only the path moves.

---

## Goals

- `defaultRegistryPath` (`doctor/src/registry.ts:105`) resolves to `<root>/registry.json`; `loadRegistry` (`doctor/src/registry.ts:303`) reads the new path first and falls back to the legacy path when the new file is absent.
- A one-time, idempotent registry migration on first boot: when `~/.apiary/registry.json` is absent and `~/.honeycomb/doctor.daemons.json` exists and parses, copy it to the new location, then mark the legacy file migrated without destroying it (see Proposed design).
- An explicit merge/precedence rule for the window when BOTH files exist (a not-yet-updated product installer keeps writing the legacy file after doctor migrated).
- `device.json` and the install-id read move to the fleet root with new-path-first, legacy-fallback reads and the same one-time, additive migration posture.
- Registry reload triggers (boot, restart, explicit registration/deregistration; PRD-001 AC-7) re-run the same two-location resolution so a mid-window write to either file is picked up.
- Preserve the existing failure postures exactly: absent file falls back (today to `honeycombFallbackEntry`, `doctor/src/registry.ts:114`), malformed file fails loudly with `RegistryError` (`doctor/src/registry.ts:94`), and the boot-level fail-soft needs-attention record is unchanged.

## Non-Goals

- Updating the writers. honeycomb, nectar, and hive install verbs write their own registry entries; each is updated to the new location in its own parallel PRD. `install.sh` / `install.ps1` (registry writes, `install-id` writes, `APIARY_HOME` pinning) are superproject installer work.
- Changing any file's content shape: registry root `{ "daemons": [ ... ] }`, `device.json` `{ device_id, label, createdAt }` (`doctor/src/device-id.ts:31-38`), and the bare-UUID `install-id` are all byte-compatible.
- The built-in fallback entry's pid path and the telemetry trust roots: owned by [004c](./prd-004c-apiary-fleet-root-migration-supervision-continuity.md).

---

## User stories

- As an operator upgrading doctor first, my existing registry keeps supervising the same fleet: doctor migrates it to `~/.apiary/registry.json` on first boot and keeps honoring entries the not-yet-updated installers write to the legacy file.
- As a product installer that has already been updated, I write my entry to `~/.apiary/registry.json` and doctor picks it up on its reload triggers.
- As the telemetry pipeline, I keep resolving one stable device id and one stable install id across the move; no install is double-counted because the id file moved.

---

## Proposed design

### Two-location registry resolution

`loadRegistry` resolves in this order (each step uses the existing `readRegistryFile` semantics, `doctor/src/registry.ts:264`):

1. Read `<root>/registry.json`. Malformed: throw `RegistryError` (fail loud, unchanged posture).
2. Read the legacy `~/.honeycomb/doctor.daemons.json`. Malformed: throw `RegistryError`.
3. Combine per the merge rule below. If neither file exists, fall back to the built-in honeycomb entry exactly as today (`doctor/src/registry.ts:307`).

### Merge/precedence rule (RESOLVED per fleet ADR-0003, confirmed 2026-07-04)

When both files exist and parse: start from the new file's entries, then additively merge each legacy entry whose `name` is not already present. On a `name` collision the new-location entry wins wholesale (no field-level merging). Rationale: the new file is the migrated, doctor-managed copy; a legacy-only entry can only mean a not-yet-updated installer registered or re-registered a product after migration, and dropping it would silently unsupervise a live daemon. The alternative (legacy wins, on the theory that the most recent write is the freshest) was rejected because it would let a stale legacy file shadow migrated entries indefinitely. RESOLVED: this rule was adopted verbatim into fleet ADR-0003 "Resolved decisions" (the registry compatibility window contract, confirmed 2026-07-04) and is binding on all four repos; doctor never writes merged results back to the legacy file.

### One-time registry migration

On first boot where step 1 finds no file and step 2 finds a valid one: write the parsed content to `<root>/registry.json`, then rename the legacy file to `doctor.daemons.json.migrated` (kept, not deleted, so nothing unrecovered is ever destroyed; the rename also stops the merged-window rule from re-reading a stale copy forever). If the copy fails, leave the legacy file untouched and continue serving from it via the fallback read. If the rename fails after a successful copy, continue; the merge rule handles the still-present legacy file. Migration of a malformed legacy file is not attempted (it throws today; unchanged).

### Device id and install id

- `deviceFilePath` (`doctor/src/device-id.ts:50`) returns `<root>/device.json`. `resolveDeviceId` (`doctor/src/device-id.ts:127`) reads the new path; when absent or garbled it additionally reads the legacy path, and a valid legacy record is copied (not moved) to the new path via the existing best-effort persist seam, preserving the never-throws contract (`doctor/src/device-id.ts:151-157`). Only when both are absent does it mint a fresh id. The legacy file is left in place for the not-yet-migrated honeycomb daemon that still reads it; honeycomb's parallel PRD retires it.
- The install-id read (`doctor/src/telemetry/capture.ts:144`) resolves `<root>/install-id` first, then the legacy `~/.honeycomb/install-id`, then the device-id fallback exactly as today (`doctor/src/telemetry/capture.ts:136-159`). Doctor never writes this file.

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| b-AC-1 | Given only a legacy registry exists, when doctor boots, then the content is migrated to `<root>/registry.json`, the legacy file is preserved (renamed, not deleted), and the supervised fleet is identical before and after. |
| b-AC-2 | Given the migration already ran, when doctor boots again, then no migration work is repeated and no file is modified (idempotent). |
| b-AC-3 | Given both registry files exist with a colliding `name`, when the registry loads, then the new-location entry wins and the legacy-only entries are still supervised (additive merge). |
| b-AC-4 | Given a legacy-only entry appears mid-window (an old installer wrote the legacy file after migration), when a registry reload trigger fires, then the entry is picked up without a doctor restart beyond the existing reload semantics. |
| b-AC-5 | Given either registry file is present but malformed, when doctor loads it, then it throws `RegistryError` and the existing boot-level fail-soft needs-attention posture is preserved (never a crash-loop). |
| b-AC-6 | Given a valid legacy `device.json` and no new one, when `resolveDeviceId` runs, then it returns the legacy `device_id`, best-effort copies the record to `<root>/device.json`, never throws, and does not delete the legacy file. |
| b-AC-7 | Given `install-id` exists at the new location, when the telemetry distinct id resolves, then the new location wins; given only the legacy location, the legacy value is used; given neither, the device id fallback applies unchanged. |
| b-AC-8 | Given a registry copy failure during migration, when doctor boots, then the legacy file is untouched and doctor supervises from it via the fallback read (never delete what was not successfully migrated). |

---

## Implementation notes

- All new paths route through the 004a helper; `.apiary` is spelled in exactly one module.
- `LoadRegistryOptions.registryPath` (`doctor/src/registry.ts:82-87`) keeps meaning "the explicit single file to read"; when it is provided (tests, `compose/index.ts:306`), the two-location resolution and migration are bypassed, preserving hermetic tests.
- Keep every fs operation wrapped; the migration is best-effort and must never take the watchdog down (design principle 1).
- The rename-to-`.migrated` marker doubles as the removal criterion's audit trail: once all supported install paths ship the migration, the legacy fallback reads and the marker handling are deleted together (ADR-0003's defined removal criterion).

---

## Open questions

- [x] **Merge/precedence rule**: RESOLVED and adopted into fleet ADR-0003 "Resolved decisions" (confirmed 2026-07-04): new file wins per-`name`, legacy entries merge additively, no write-back to the legacy file (see Proposed design for the rationale and the rejected alternative).
- [ ] **Legacy marker name** (DEFAULT - confirm before implementation): `doctor.daemons.json.migrated`. Any suffix works; it only must stop the file from parsing as the live legacy registry while remaining recoverable by hand.

---

## Related

- [`ADR-0002-service-registration-static-registry-plus-runtime-sqlite`](../../../knowledge/private/architecture/ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md) - the contract whose path moves.
- [`ADR-0003-fleet-directory-ownership-and-neutral-state-root`](../../../knowledge/private/architecture/ADR-0003-fleet-directory-ownership-and-neutral-state-root.md) - the layout and migration rules.
- the-apiary [`ADR-0002-one-line-installer-product-loading-and-install-time-telemetry`](../../../../../library/knowledge/private/architecture/ADR-0002-one-line-installer-product-loading-and-install-time-telemetry.md) - the installer that must write the relocated registry and `install-id`.
- [PRD-004a shared root helper](./prd-004a-apiary-fleet-root-migration-shared-root-helper.md) and [PRD-004c supervision continuity](./prd-004c-apiary-fleet-root-migration-supervision-continuity.md).
