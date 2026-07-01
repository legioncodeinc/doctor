# PRD-001b: Runtime SQLite status contract

> **Status:** Draft
> **Parent:** [PRD-001: Service registration and telemetry ingestion](./prd-001-service-registration-and-telemetry-ingestion-index.md)
> **Priority:** P0
> **Effort:** M (3-8h)
> **Schema changes:** Additive (a service-owned runtime status surface in SQLite)

---

## Overview

Define the runtime status contract: what each service writes into its own SQLite database on check-in, so hivedoctor can merge live state into its authoritative model. This is the service-owned, churning layer of [`ADR-0002`](../../../knowledge/private/architecture/ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md) decision 2, and the writer half of [`ADR-0001`](../../../knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md) decision 1 (services are producers, SQLite is the transport).

ADR-0002 splits registration into two layers on purpose: the installer-owned static registry (001a) says who should exist and how to supervise it and survives while a service is down, while the service-owned runtime SQLite holds the live state that changes on every check-in. Cramming runtime state into the static JSON file was explicitly rejected because it turns a static config into a high-churn file that fights the atomic-write and fail-soft-parse posture. This sub-PRD specifies the runtime side so those two layers stay cleanly separated.

---

## Goals

- Specify what a service writes on check-in: its registration record, binding time, last-seen, current health, and metrics.
- Define the check-in cadence (health and metric check-ins on an interval; see ADR-0001) and that logs are written live.
- Require WAL mode so a service can write while hivedoctor reads without lock contention, and so hivedoctor can open the database read-only.
- Keep the contract non-sensitive: no tokens, credentials, org secrets, or Deep Lake data payloads are ever written to telemetry SQLite.

## Non-Goals

- The exact metrics and log column definitions and verbosity levels. Those are PRD-002 (002b); this sub-PRD defines the check-in and status contract the poll loop consumes.
- The SSE stream that carries this data to the portal (PRD-002, 002a).
- hivedoctor's read side (the poll-and-merge loop is 001c).
- The static registry schema (001a).

---

## User stories

- As a workload service (honeycomb, hivenectar, the-hive), on check-in I write my binding time, last-seen, current health, and metrics into my local SQLite so hivedoctor can read them without me pushing anything.
- As hivedoctor, I read a service's runtime status rows read-only and merge them with the static "should exist" entry to produce the fleet model.
- As a security reviewer, I confirm no sensitive value ever lands in a telemetry database.

---

## The contract

On check-in, a service writes a runtime status record that carries at least:

- **Registration record:** the service identity that ties this runtime row back to its static registry entry (for example `name`).
- **Binding time:** when the service bound its port/socket for the current run.
- **Last-seen / check-in time:** updated on every check-in so hivedoctor can compute staleness.
- **Current health:** the service's self-reported health at check-in.
- **Metrics:** the service's current metric snapshot (the concrete columns are owned by 002b).

Rules:

- Health and metric check-ins are written on an interval; logs are written live (ADR-0001 decision 1).
- Databases run in WAL mode; hivedoctor opens them read-only (ADR-0001 decision 4).
- Only non-sensitive telemetry is written.

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| b-AC-1 | Given a service checks in, when it writes runtime status, then the row includes at least its registration record, binding time, last-seen, current health, and metrics. |
| b-AC-2 | Given a running service, when it operates, then it writes health and metric check-ins on an interval and writes logs live. |
| b-AC-3 | Given a service's telemetry database, when hivedoctor opens it, then it opens read-only and the database is in WAL mode so writes and reads do not contend. |
| b-AC-4 | Given any runtime status or log write, when it is persisted, then it contains no tokens, credentials, org secrets, or Deep Lake data payloads. |
| b-AC-5 | Given a runtime status row, when hivedoctor reads it, then the registration record lets hivedoctor associate it with the correct static registry entry. |

---

## Implementation notes

- This contract is written by each service, not by hivedoctor; hivedoctor only reads it. The reference implementation lives in each service repo, but the contract is owned here so all writers agree.
- Use `node:sqlite` on the writer side where a service is Node-based, consistent with the fleet's zero-external-dependency ethos; non-Node services must still produce WAL-mode SQLite that hivedoctor can open read-only.
- The last-seen semantics pair with 001c: the service updates last-seen on check-in, and hivedoctor records a last-seen on detected disconnect.

---

## Open questions

- [ ] Whether runtime status is a single upsert row per service or an append-only check-in log windowed by the reader.
- [ ] Whether binding time and registration record live in the same table as metrics or a small dedicated status table.

---

## Related

- [`ADR-0002-service-registration-static-registry-plus-runtime-sqlite`](../../../knowledge/private/architecture/ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md)
- [`ADR-0001-hive-telemetry-transport-and-single-source-of-truth`](../../../knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md)
- [PRD-002b metrics and log SQLite schema](../prd-002-telemetry-sot-sse-and-schema/prd-002b-telemetry-sot-sse-and-schema-sqlite-schema.md) - the concrete columns this contract references.
- [PRD-001a static registry schema](./prd-001a-service-registration-and-telemetry-ingestion-static-registry-schema.md) and [PRD-001c poll-and-merge loop](./prd-001c-service-registration-and-telemetry-ingestion-poll-merge-loop.md).
