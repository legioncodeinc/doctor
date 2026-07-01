# PRD-002b: Metrics and log SQLite schema, verbosity, and Deep Lake stats

> **Status:** Draft
> **Parent:** [PRD-002: Telemetry source-of-truth SSE stream and schema](./prd-002-telemetry-sot-sse-and-schema-index.md)
> **Priority:** P0
> **Effort:** M (3-8h)
> **Schema changes:** Additive (the metrics and log tables/columns services write and hivedoctor reads)

---

## Overview

Define the SQLite schema that is the contract between each service (writer) and hivedoctor (reader), per [`ADR-0001`](../../../knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md). This sub-PRD specifies the metrics columns, the log table and its verbosity level, and the Deep Lake connection and stats fields that flow onto the SSE stream (002a). ADR-0001 explicitly names this as a contract whose drift must be handled additively.

The concrete metrics to capture are the ones the portal needs: actions taken, files processed, and memories created since last restart. Logs are written live by services (ADR-0001 decision 1) with a selectable verbosity level so the portal can filter. Deep Lake fields cover connection state and stats such as last-communication time. This schema pairs with the runtime status/check-in contract in [PRD-001b](../prd-001-service-registration-and-telemetry-ingestion/prd-001b-service-registration-and-telemetry-ingestion-runtime-sqlite-contract.md); 001b says when and how a service checks in, 002b says what the metric and log rows look like.

---

## Goals

- Define metrics columns: actions taken, files processed, and memories created since last restart (per service).
- Define a log table whose rows carry a verbosity level (for example error, warn, info, debug) plus timestamp and message.
- Define Deep Lake connection and stats fields, including last-communication time.
- Make the schema additive-only: new columns are added without breaking older readers or writers.
- Keep every field non-sensitive: no tokens, credentials, org secrets, or Deep Lake data payloads.

## Non-Goals

- The SSE event framing (002a) or retention and rotation (002c).
- The static registry entry (PRD-001a) or the check-in cadence (PRD-001b).
- Storing user memories, documents, or private graph contents. Only counts and stats are stored, never payloads.

---

## User stories

- As a service, I write my metrics and logs into columns hivedoctor already knows how to read, so adding telemetry needs no hivedoctor code change.
- As the portal, I render actions taken, files processed, and memories created since last restart, and I filter logs by verbosity.
- As an operator, I see whether a service's Deep Lake connection is alive and when it last communicated.

---

## Proposed schema

Exact table and column names are settled in implementation; the contract is that the following are representable and additive.

**Metrics (per service, since last restart):**

| Field | Meaning |
|---|---|
| actions taken | count of actions the service performed since restart |
| files processed | count of files processed since restart |
| memories created | count of memories created since restart |
| restart marker | how "since last restart" is anchored (for example a run id or start time) |

**Logs (written live):**

| Field | Meaning |
|---|---|
| timestamp | when the log row was written |
| verbosity level | error, warn, info, debug (selectable/filterable) |
| message | the non-sensitive log text |

**Deep Lake stats:**

| Field | Meaning |
|---|---|
| connection state | whether the Deep Lake connection is alive |
| last-communication time | when the service last successfully communicated with Deep Lake |
| stats | additional non-sensitive connection statistics |

All tables are opened read-only by hivedoctor in WAL mode.

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| b-AC-1 | Given the metrics schema, when a service writes, then actions taken, files processed, and memories created since last restart are each recorded per service. |
| b-AC-2 | Given the log schema, when a log row is written, then it carries a timestamp, a verbosity level, and a message. |
| b-AC-3 | Given the Deep Lake stats schema, when a service reports, then connection state and last-communication time are recorded. |
| b-AC-4 | Given a schema change, when a new column is needed, then it is added additively without breaking existing readers or writers. |
| b-AC-5 | Given any metrics, log, or Deep Lake row, when persisted, then it contains no tokens, credentials, org secrets, or Deep Lake data payloads. |
| b-AC-6 | Given the schema, when hivedoctor reads it, then all reads are read-only against WAL-mode databases. |

---

## Implementation notes

- Additive-only schema evolution mirrors the honeycomb daemon's healing convention (never a hand-rolled destructive `ALTER`); services own their writers, hivedoctor owns the reader.
- "Since last restart" needs a stable anchor (run id or process start time) so counters reset cleanly on restart without hivedoctor guessing.
- Verbosity is stored as a discrete level so 002a can forward it and the portal can filter without re-parsing message text.

---

## Open questions

- [ ] Whether metrics live as a rolling counter row or as periodic snapshots windowed by the reader.
- [ ] The canonical verbosity enumeration and whether it aligns with any existing honeycomb log-level convention.

---

## Related

- [`ADR-0001-hive-telemetry-transport-and-single-source-of-truth`](../../../knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md) - names the SQLite schema as the writer/reader contract.
- [PRD-001b runtime SQLite status contract](../prd-001-service-registration-and-telemetry-ingestion/prd-001b-service-registration-and-telemetry-ingestion-runtime-sqlite-contract.md) - the check-in contract these columns pair with.
- [PRD-002a SSE producer](./prd-002a-telemetry-sot-sse-and-schema-sse-producer.md) and [PRD-002c retention](./prd-002c-telemetry-sot-sse-and-schema-retention.md).
