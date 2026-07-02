# PRD-002: Telemetry source-of-truth SSE stream and schema

> **Status:** Backlog
> **Priority:** P0
> **Effort:** L (1-3d)
> **Schema changes:** Additive (defines the metrics and log SQLite tables/columns services write and doctor reads)

---

## Overview

This module implements the producer and schema side of [`ADR-0001`](../../../knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md). It delivers the single Server-Sent-Events stream from doctor to hive that renders the fleet in near real time, defines the metrics and log SQLite schema that services write and doctor reads, and specifies the memory-bounding via windowed queries plus retention and rotation so logs never balloon.

ADR-0001 decision 3 locks exactly one SSE stream, doctor to hive, feeding the health rail, the `/buzzing` readiness screen, and the health page. There is no service-to-doctor SSE and no other streaming surface. The stream carries the in-memory source-of-truth model that [PRD-001](../prd-001-service-registration-and-telemetry-ingestion/prd-001-service-registration-and-telemetry-ingestion-index.md) builds by polling each service's SQLite and probing `/health`. Where PRD-001 owns ingestion and registration, this module owns what flows out and the shape of what is stored: the enumerated metrics (actions taken, files processed, memories created since last restart), log rows with a verbosity level, and Deep Lake connection and stats (such as last-communication time).

doctor stays crash-proof and dependency-light: the SSE producer uses `node:http` and the SQLite reads use the built-in `node:sqlite`. Memory stays bounded because doctor queries windows rather than loading whole logs, and the portal pages request bounded slices.

**This index covers the module scope.** Sub-PRDs 002a, 002b, and 002c own the producer, the schema, and the bounding policy.

---

## Goals

- Deliver exactly one resilient, fail-soft SSE stream from doctor to hive that renders near real time on the portal (health rail, `/buzzing`, health page).
- Emit the merged fleet health plus the enumerated metrics: actions taken, files processed, and memories created since last restart.
- Define the metrics and log SQLite schema: what columns and tables services write and doctor reads, including log rows carrying a verbosity level.
- Define the Deep Lake connection and stats fields (for example last-communication time) surfaced through the feed.
- Keep memory bounded via windowed reads plus retention and rotation so logs never grow without limit under sustained logging.

## Non-Goals

- Service registration and the poll-and-merge ingestion loop (owned by [PRD-001](../prd-001-service-registration-and-telemetry-ingestion/prd-001-service-registration-and-telemetry-ingestion-index.md)).
- Any service-to-doctor stream or a second streaming surface. Exactly one SSE hop, doctor to hive (ADR-0001 decision 3).
- The portal-side rendering of the health rail, `/buzzing`, and health page. Those are hive's forthcoming PRD-004 / PRD-005; this module defines the feed and event shapes they consume.
- Writing sensitive data. Only non-sensitive telemetry flows (no tokens, credentials, org secrets, or Deep Lake data payloads).
- Adding an external runtime dependency to doctor.

---

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-002a-telemetry-sot-sse-and-schema-sse-producer`](./prd-002a-telemetry-sot-sse-and-schema-sse-producer.md) | The single doctor to hive SSE producer: event shapes, near-real-time delivery, resilient/fail-soft, one stream | Draft |
| [`prd-002b-telemetry-sot-sse-and-schema-sqlite-schema`](./prd-002b-telemetry-sot-sse-and-schema-sqlite-schema.md) | The metrics and log SQLite schema, verbosity levels, and Deep Lake stats fields | Draft |
| [`prd-002c-telemetry-sot-sse-and-schema-retention`](./prd-002c-telemetry-sot-sse-and-schema-retention.md) | Memory-bounding via windowed reads plus retention and rotation (log cap) | Draft |

---

## Acceptance criteria (module-level)

| ID | Criterion | Maps to |
|---|---|---|
| AC-1 | Given a healthy fleet, when the portal connects, then doctor maintains exactly one SSE stream to hive that renders the health rail, `/buzzing`, and health page in near real time. | ADR-0001 decision 3 |
| AC-2 | Given the SSE stream, when it emits, then it carries the merged fleet health plus the enumerated metrics: actions taken, files processed, and memories created since last restart. | ADR-0001 decision 2 and 3 |
| AC-3 | Given a service writes logs, when doctor reads them and forwards over SSE, then each log row carries a verbosity level. | ADR-0001 decision 1 |
| AC-4 | Given a service with a Deep Lake connection, when telemetry is emitted, then Deep Lake connection and stats fields (for example last-communication time) are present. | ADR-0001 context |
| AC-5 | Given sustained logging, when the system runs over time, then doctor memory stays bounded via windowed reads and the underlying databases stay bounded via retention and rotation. | ADR-0001 decision drivers (bounded memory) |
| AC-6 | Given the SSE producer, when the portal disconnects or a service database is unavailable, then the stream is fail-soft (it recovers and never crashes doctor). | ADR-0001 decision 4 (crash-proof) |
| AC-7 | Given the producer and schema, when they run, then doctor adds no external runtime dependency (`node:http` and `node:sqlite` only). | ADR-0001 decision 4 |

---

## Data model changes

Additive, defined in 002b: metrics tables/columns (actions taken, files processed, memories created since last restart), a log table whose rows carry a verbosity level, and Deep Lake connection/stats fields (including last-communication time). These are the columns doctor reads (read-only, WAL) and forwards. Retention and rotation (002c) bound their growth. The runtime status/check-in contract these columns pair with is owned by PRD-001 (001b).

---

## API changes

Additive: a single SSE endpoint served by doctor and consumed by hive (event shapes defined in 002a). This enriches, and does not replace, the existing coarse `GET /status.json` on `:3852`.

---

## Related

- [`ADR-0001-hive-telemetry-transport-and-single-source-of-truth`](../../../knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md) - the single-SSE and SQLite-schema-as-contract decision this module implements.
- [`ADR-0002-service-registration-static-registry-plus-runtime-sqlite`](../../../knowledge/private/architecture/ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md) - the registry that tells doctor which databases hold the schema this module reads.
- [PRD-001: Service registration and telemetry ingestion](../prd-001-service-registration-and-telemetry-ingestion/prd-001-service-registration-and-telemetry-ingestion-index.md) - builds the in-memory model this module streams.
- nectar [`PRD-004: doctor daemon registry + hive portal daemon`](../../../../../nectar/library/requirements/backlog/prd-004-doctor-registry-and-hive/prd-004-doctor-registry-and-hive-index.md) - the registry + hive module this builds on.
- nectar [`ADR-0003-three-daemon-topology-and-hive-portal`](../../../../../nectar/library/knowledge/private/architecture/ADR-0003-three-daemon-topology-and-hive-portal.md) and [`ADR-0004-hive-portal-daemon-role-and-boundaries`](../../../../../nectar/library/knowledge/private/architecture/ADR-0004-hive-portal-daemon-role-and-boundaries.md) - the topology and portal boundaries; hive holds no data plane, so fleet telemetry flows through doctor's SSE.
- hive [`ADR-0004-portal-landing-gate-and-path-based-routing`](../../../../../hive/library/knowledge/private/architecture/ADR-0004-portal-landing-gate-and-path-based-routing.md) - the portal routing (health rail, `/buzzing`, health page) that consumes this stream.
- hive forthcoming PRD-004 / PRD-005 (portal rendering of this telemetry feed), expected under [`hive/library/requirements/backlog/`](../../../../../hive/library/requirements/backlog/).
- honeycomb [`PRD-069: Application Health Dashboard`](../../../../../honeycomb/library/requirements/backlog/prd-069-application-health-dashboard/prd-069-application-health-dashboard-index.md) - this realignment supersedes PRD-069's health-endpoint aggregation portion; the near-real-time health surface now flows from doctor's SSE rather than honeycomb-local aggregation.
