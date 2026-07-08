# PRD-002a: The doctor to hive SSE producer

> **Status:** Draft
> **Parent:** [PRD-002: Telemetry source-of-truth SSE stream and schema](./prd-002-telemetry-sot-sse-and-schema-index.md)
> **Priority:** P0
> **Effort:** M (3-8h)
> **Schema changes:** None (producer over the in-memory model)

---

## Overview

Implement the single Server-Sent-Events producer that streams doctor's in-memory source-of-truth model to hive in near real time. This realizes [`ADR-0001`](../../../knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md) decision 3: exactly one SSE stream, doctor to hive, feeding the health rail, the `/buzzing` readiness screen, and the health page. There is no service-to-doctor SSE and no other streaming surface.

The producer reads the merged model that [PRD-001c](../prd-001-service-registration-and-telemetry-ingestion/prd-001c-service-registration-and-telemetry-ingestion-poll-merge-loop.md) maintains and emits well-defined events for fleet health and the enumerated metrics. It is served with `node:http` only, keeping doctor dependency-light and crash-proof, and it is fail-soft: a disconnecting portal, a slow consumer, or an unavailable service database must never wedge or crash doctor.

---

## Goals

- Serve exactly one SSE stream from doctor to hive.
- Emit event shapes for fleet health plus the enumerated metrics (actions taken, files processed, memories created since last restart), log rows with verbosity, and Deep Lake stats.
- Deliver near real time: portal state trails doctor's model by about one poll interval.
- Be resilient and fail-soft: recover from consumer disconnects and per-service data gaps without crashing.
- Use only Node built-ins (`node:http`).

## Non-Goals

- Defining the metric and log columns and verbosity levels (002b) or retention (002c).
- The portal-side rendering (hive forthcoming PRD-004 / PRD-005).
- Any inbound stream from services to doctor.
- Replacing the coarse `GET /status.json` on `:3852`; the SSE stream enriches it.

---

## User stories

- As hive portal, I open one SSE connection to doctor and receive near-real-time fleet health and metrics without polling each daemon.
- As an operator watching `/buzzing`, I see readiness update within about a second of a service coming up or going down.
- As doctor, when the portal drops its connection, I clean up and keep running; I never crash because a consumer left.

---

## Event shapes

The stream emits typed events carrying, at minimum:

- **Fleet health:** per-service health and the coarse status doctor already computes (`ok | degraded | unreachable | unknown`), plus disconnect/last-seen state from PRD-001c.
- **Metrics:** actions taken, files processed, and memories created since last restart, per service (columns defined in 002b).
- **Logs:** recent log rows carrying a verbosity level (schema in 002b), delivered as bounded slices (002c).
- **Deep Lake stats:** connection state and stats such as last-communication time (fields in 002b).

Exact event names and framing are settled in implementation; the contract is that all of the above are representable on the one stream.

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| a-AC-1 | Given the portal connects, when doctor serves telemetry, then there is exactly one SSE stream from doctor to hive and no other streaming surface. |
| a-AC-2 | Given the in-memory model updates, when the loop refreshes, then the stream emits fleet health plus the enumerated metrics in near real time (about one poll interval). |
| a-AC-3 | Given log rows exist, when they are emitted, then each carries a verbosity level. |
| a-AC-4 | Given a service reports Deep Lake stats, when telemetry is emitted, then Deep Lake connection and stats fields (for example last-communication time) are present. |
| a-AC-5 | Given the portal disconnects or consumes slowly, when that happens, then doctor cleans up the connection and keeps running (fail-soft). |
| a-AC-6 | Given a service database is temporarily unavailable, when the stream emits, then it degrades that service's fields gracefully and continues emitting for the rest of the fleet. |
| a-AC-7 | Given the producer, when it runs, then it uses only `node:http` and adds no external runtime dependency. |

---

## Implementation notes

- Serve alongside the existing status page at `doctor/src/status-page/server.ts` (`:3852`), reusing the loopback server rather than adding a new listener where practical.
- Read straight from the PRD-001c in-memory model; do not re-open SQLite in the producer.
- Emit bounded log slices (per 002c) rather than whole histories to keep both doctor and the portal memory bounded.

---

## Open questions

- [ ] Whether the SSE endpoint lives on `:3852` next to `/status.json` or on a dedicated loopback path/port.
- [ ] Event granularity: one merged snapshot event versus separate health/metrics/log events.

---

## Related

- [`ADR-0001-hive-telemetry-transport-and-single-source-of-truth`](../../../knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md)
- [PRD-001c poll-and-merge loop](../prd-001-service-registration-and-telemetry-ingestion/prd-001c-service-registration-and-telemetry-ingestion-poll-merge-loop.md) - builds the model this producer streams.
- [PRD-002b SQLite schema](./prd-002b-telemetry-sot-sse-and-schema-sqlite-schema.md) and [PRD-002c retention](./prd-002c-telemetry-sot-sse-and-schema-retention.md).
- hive [`ADR-0004-portal-landing-gate-and-path-based-routing`](../../../../../hive/library/knowledge/private/architecture/ADR-0004-portal-landing-gate-and-path-based-routing.md) - the portal routes that consume this stream.
