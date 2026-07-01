# PRD-001a: Extended static registry schema

> **Status:** Draft
> **Parent:** [PRD-001: Service registration and telemetry ingestion](./prd-001-service-registration-and-telemetry-ingestion-index.md)
> **Priority:** P0
> **Effort:** S (1-3h)
> **Schema changes:** Additive (one optional field per registry entry)

---

## Overview

Extend the installer-owned static registry at `~/.honeycomb/hivedoctor.daemons.json` so each daemon entry also records where that service's SQLite telemetry database(s) live. This is the "where do I poll" half of [`ADR-0002`](../../../knowledge/private/architecture/ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md) decision 1: the static registry answers who should exist and how to supervise it, and now also where its telemetry sits, so [`ADR-0001`](../../../knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md)'s poll loop knows which files to open.

The extension must be strictly additive. Today an entry is `{ name, healthUrl, pidPath, probeIntervalMs, startupGraceMs, restartGiveUpThreshold, restartCooldownMs }` under a root `{ "daemons": [ ... ] }` (from hivenectar PRD-004a). Legacy entries with no database path must keep parsing exactly as before, and the recent fail-soft posture (fall back and surface needs-attention on a malformed file, never crash-loop) must be preserved.

---

## Goals

- Add an optional field on each registry entry recording the service's SQLite telemetry database path(s).
- Support one or more database paths per service (a service may split logs and metrics across databases).
- Keep the root shape and every existing PRD-004a field unchanged.
- Preserve fail-soft parsing: a malformed registry falls back and surfaces a needs-attention record.

## Non-Goals

- Deciding what tables or columns live inside those databases (owned by PRD-002, 002b).
- Writing the registry file. Installers own registry writes (the-apiary ADR-0002).
- Any runtime registration API.

---

## User stories

- As hivedoctor's poll loop, I read each entry's database path(s) so I know which SQLite files to open read-only.
- As an operator with an older registry, my existing entries keep working after upgrade, and services without a database path are treated as health-probe-only.
- As the installer, I append one optional field to an entry without breaking hivedoctor's parser.

---

## Proposed schema

Each entry gains an optional field for the SQLite database path(s). Exact field name and single-string-vs-array normalization are settled in implementation, but the contract is:

- The field is optional. Absent means "no SQLite telemetry for this service; probe `/health` only".
- The field accepts one path or a list of paths (normalized to a list internally).
- Paths are absolute or resolved relative to the honeycomb config root, consistent with `pidPath` handling.
- All other fields (`name`, `healthUrl`, `pidPath`, `probeIntervalMs`, `startupGraceMs`, `restartGiveUpThreshold`, `restartCooldownMs`) and the `{ "daemons": [ ... ] }` root are unchanged.

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| a-AC-1 | Given an entry with a SQLite database path field, when the registry is parsed, then hivedoctor records that path (or list of paths) on the in-memory entry. |
| a-AC-2 | Given a legacy entry with no database path field, when the registry is parsed, then the entry loads without error and is marked health-probe-only. |
| a-AC-3 | Given an entry with a list of database paths, when parsed, then all paths are retained and available to the poll loop. |
| a-AC-4 | Given a malformed registry file, when parsed, then hivedoctor falls back and surfaces a needs-attention record and does not crash-loop. |
| a-AC-5 | Given the existing PRD-004a fields, when the extended parser runs, then every existing field is preserved with identical semantics. |

---

## Implementation notes

- Extend the registry loader/parser at `hivedoctor/src/registry.ts` (the loader ADR-0002 cites). Keep the additive field optional in the type and default it to an empty list.
- Reuse the existing fail-soft parse path introduced by the recent change; do not add a new failure mode.
- Normalize a single string path and an array of paths to one internal list so the poll loop (001c) has one shape to consume.

---

## Open questions

- [ ] Field name and whether to allow per-database role hints (for example logs vs metrics) now or defer to PRD-002.
- [ ] Whether relative paths resolve against the honeycomb config root or the service's install directory.

---

## Related

- [`ADR-0002-service-registration-static-registry-plus-runtime-sqlite`](../../../knowledge/private/architecture/ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md)
- [`ADR-0001-hive-telemetry-transport-and-single-source-of-truth`](../../../knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md)
- hivenectar [`PRD-004`](../../../../../hivenectar/library/requirements/backlog/prd-004-hivedoctor-registry-and-thehive/prd-004-hivedoctor-registry-and-thehive-index.md) - PRD-004a's registry and parser this extends.
- [PRD-001b runtime SQLite status contract](./prd-001b-service-registration-and-telemetry-ingestion-runtime-sqlite-contract.md) and [PRD-001c poll-and-merge loop](./prd-001c-service-registration-and-telemetry-ingestion-poll-merge-loop.md).
