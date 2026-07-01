# PRD-001c: The poll-and-merge loop

> **Status:** Draft
> **Parent:** [PRD-001: Service registration and telemetry ingestion](./prd-001-service-registration-and-telemetry-ingestion-index.md)
> **Priority:** P0
> **Effort:** L (1-3d)
> **Schema changes:** None (read side only)

---

## Overview

Implement the roughly one-second poll-and-merge loop that makes hivedoctor the single source of truth. This is the puller half of [`ADR-0001`](../../../knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md) decision 2: hivedoctor polls each registered service's SQLite database (about once per second), probes each `/health`, merges both into an in-memory model, and is the one authoritative source of hive health and telemetry. It also implements the merge and reload behavior of [`ADR-0002`](../../../knowledge/private/architecture/ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md) decision 3.

The loop consumes the extended static registry (001a) to know which databases to open, and the runtime SQLite status contract (001b) to know what to read. It opens each database read-only in WAL mode using `node:sqlite`, runs windowed queries so memory stays bounded, and never adds an external runtime dependency. On a detected disconnect (missed check-ins plus failing `/health`), it records a last-seen time while keeping the static entry, so a down service still shows as supervised.

---

## Goals

- Poll each registered service's SQLite database about once per second, read-only, with windowed queries.
- Probe each service's `/health` on its configured interval and combine that with the SQLite reads.
- Merge the static "should exist" registry with the live runtime status into one in-memory source-of-truth fleet model.
- Detect disconnect (missed check-ins plus failing `/health`) and record a last-seen time without dropping the static entry.
- Reload the static registry into memory on boot, on restart, and on explicit registration or deregistration, and adjust which databases are polled.
- Keep memory bounded and the loop crash-proof: a bad or missing database for one service must not wedge the loop or affect other services.

## Non-Goals

- Producing the SSE stream from the in-memory model to the-hive (PRD-002, 002a).
- Defining the metric and log columns read (PRD-002, 002b) or retention and rotation (PRD-002, 002c). This loop performs windowed reads; the retention policy that bounds the underlying data is 002c.
- Restart, escalation, and remediation decisions (owned by hivenectar PRD-004a supervision).

---

## User stories

- As the portal (via hivedoctor's SoT model), I get a fleet view that is never more than about a second stale.
- As an operator, when a service crashes, hivedoctor shows it disconnected with a last-seen time within about one poll interval, and still lists it as a supervised daemon.
- As hivedoctor, when a service's database is missing or unreadable, I skip it, keep polling the rest, and mark that service needs-attention rather than crashing.

---

## Behavior

1. **Load and reload.** On boot, restart, and explicit registration/deregistration, load the static registry (001a) into memory and compute the set of databases to poll and services to probe.
2. **Poll.** About once per second, open each service's SQLite database(s) read-only in WAL mode and run windowed queries (recent rows and aggregates only).
3. **Probe.** Probe each service's `/health` on its configured interval.
4. **Merge.** Combine the static entry, the runtime status rows, and the `/health` result into one in-memory fleet model that is the single source of truth.
5. **Disconnect.** When check-ins are missed and `/health` fails, mark the service disconnected and record a last-seen time; keep the static entry.
6. **Isolate faults.** A missing, locked, or malformed database for one service is skipped and surfaced as needs-attention; it never wedges the loop or corrupts another service's state.

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| c-AC-1 | Given a registered service with a database path, when the loop runs, then hivedoctor opens that database read-only in WAL mode and runs windowed queries about once per second. |
| c-AC-2 | Given a service with a `/health` endpoint, when the loop runs, then hivedoctor probes `/health` and merges the result with the SQLite reads into the in-memory model. |
| c-AC-3 | Given static and runtime data for a service, when the loop merges, then the model reflects both the "should exist" entry and the live status as one authoritative record. |
| c-AC-4 | Given a service that stops checking in and fails `/health`, when about one poll interval elapses, then it is marked disconnected with a recorded last-seen time and its static entry is retained. |
| c-AC-5 | Given a registry change (boot, restart, or explicit (de)registration), when applied, then the loop reloads the registry and updates which databases it polls. |
| c-AC-6 | Given one service's database is missing, locked, or malformed, when the loop runs, then that service is skipped and marked needs-attention while every other service continues to be polled. |
| c-AC-7 | Given sustained polling, when the loop runs over time, then hivedoctor's memory stays bounded because queries are windowed rather than loading whole logs. |
| c-AC-8 | Given the poll loop, when it executes, then it uses only Node built-ins (`node:sqlite`, `node:http`, and similar) and no external runtime dependency. |

---

## Implementation notes

- Build on `hivedoctor/src/registry.ts` (loader) and `hivedoctor/src/status-page/server.ts` (the coarse `/status.json` this model enriches, per ADR-0001 references).
- Use one shared `node:sqlite` read path with a bounded query window; wrap each per-service read in isolation so a failure is local.
- The 1s cadence is a target, not a hard real-time guarantee; ADR-0001 accepts roughly poll-interval detection latency for a local operator dashboard.
- Windowed reads here rely on the retention/rotation in 002c to keep the underlying databases small; the loop must still bound its own query window independently.

---

## Open questions

- [ ] Whether the poll cadence is fixed at 1s or adaptive under load.
- [ ] How disconnect thresholds (missed check-in count plus `/health` failures) are configured per service versus globally.

---

## Related

- [`ADR-0001-hive-telemetry-transport-and-single-source-of-truth`](../../../knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md)
- [`ADR-0002-service-registration-static-registry-plus-runtime-sqlite`](../../../knowledge/private/architecture/ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md)
- [PRD-001a static registry schema](./prd-001a-service-registration-and-telemetry-ingestion-static-registry-schema.md) and [PRD-001b runtime SQLite status contract](./prd-001b-service-registration-and-telemetry-ingestion-runtime-sqlite-contract.md).
- [PRD-002a SSE producer](../prd-002-telemetry-sot-sse-and-schema/prd-002a-telemetry-sot-sse-and-schema-sse-producer.md) - consumes the in-memory model this loop builds.
- [PRD-002c memory-bounding and retention](../prd-002-telemetry-sot-sse-and-schema/prd-002c-telemetry-sot-sse-and-schema-retention.md) - keeps the polled databases small.
