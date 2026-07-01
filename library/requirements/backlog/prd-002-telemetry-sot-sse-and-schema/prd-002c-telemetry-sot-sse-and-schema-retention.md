# PRD-002c: Memory-bounding and retention/rotation

> **Status:** Draft
> **Parent:** [PRD-002: Telemetry source-of-truth SSE stream and schema](./prd-002-telemetry-sot-sse-and-schema-index.md)
> **Priority:** P0
> **Effort:** M (3-8h)
> **Schema changes:** None (policy over the 002b schema)

---

## Overview

Keep memory and disk bounded so logs never balloon under sustained logging. This realizes [`ADR-0001`](../../../knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md)'s bounded-memory decision driver from both ends: hivedoctor reads windows (recent rows and aggregates) rather than loading whole logs, and services cap and rotate their telemetry databases so the underlying files stay small.

ADR-0001 states memory stays bounded because hivedoctor queries windows and the portal pages request bounded slices, and it lists "hivedoctor must manage many SQLite readers and be disciplined about windowed queries" as a negative consequence to manage. This sub-PRD makes that discipline explicit and adds the retention and rotation policy that keeps the write side bounded too, so a chatty service cannot grow an unbounded log file.

---

## Goals

- Windowed reads: hivedoctor reads only recent rows and aggregates, never whole log histories, so its memory stays bounded regardless of how much a service has logged.
- Bounded SSE slices: log data sent over the stream is delivered as bounded slices, so the portal stays bounded too.
- Retention and rotation: services cap their log tables (by row count, age, or size) and rotate or prune old rows so the databases stay small.
- The policy holds under sustained high-volume logging without unbounded growth in hivedoctor memory or on disk.

## Non-Goals

- The SSE producer itself (002a) or the schema definitions (002b).
- The poll cadence (PRD-001c) beyond requiring its reads be windowed.
- Long-term archival of logs to any external store. Telemetry is local, bounded, and disposable.

---

## User stories

- As hivedoctor, no matter how much a service logs, my memory footprint for reading its telemetry stays roughly constant because I only ever query a bounded window.
- As an operator, a runaway service that logs continuously does not fill the disk, because its log table is capped and rotated.
- As the portal, when I request logs, I get a bounded slice, not an unbounded history.

---

## Behavior

1. **Windowed reads (reader side).** hivedoctor's queries always bound their result set (recent rows within a time or count window, or aggregates). No query loads a whole log table.
2. **Bounded slices (stream side).** Log payloads over SSE are chunked into bounded slices so neither hivedoctor nor the portal holds an unbounded history.
3. **Retention and rotation (writer side).** Each service caps its log table by a policy (row count, age, or size budget) and prunes or rotates older rows, keeping the database small.
4. **Sustained-load safety.** Under continuous logging, hivedoctor memory and the on-disk database both stay within their bounds.

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| c-AC-1 | Given a service with a large log history, when hivedoctor reads it, then the query returns only a bounded window (recent rows or aggregates) and hivedoctor memory does not grow with total log volume. |
| c-AC-2 | Given the SSE stream carries logs, when it emits, then log data is delivered as bounded slices rather than whole histories. |
| c-AC-3 | Given a service logs continuously, when the retention policy runs, then old rows are pruned or rotated and the log table stays within its cap (by count, age, or size). |
| c-AC-4 | Given sustained high-volume logging over time, when the system runs, then hivedoctor memory and the on-disk telemetry database both stay bounded. |
| c-AC-5 | Given retention/rotation, when it prunes, then it removes only old telemetry rows and never touches non-telemetry data or another service's database. |

---

## Implementation notes

- The reader-side window (hivedoctor) and the writer-side cap (services) are independent defenses; both are required. Windowed reads protect hivedoctor even if a writer's cap misbehaves, and the cap protects the disk even if a reader over-fetches.
- Choose one primary cap dimension (row count is simplest and most predictable) with age as a secondary trim; size budget is a backstop.
- Rotation should be crash-safe and WAL-friendly so a rotate that races with hivedoctor's read never corrupts the database or wedges the reader.

---

## Open questions

- [ ] The default cap values (rows, age, size) and whether they are per service or global.
- [ ] Whether rotation is delete-in-place (prune rows) or file rotation, given hivedoctor holds read-only handles.

---

## Related

- [`ADR-0001-hive-telemetry-transport-and-single-source-of-truth`](../../../knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md) - the bounded-memory driver and the windowed-query consequence this sub-PRD operationalizes.
- [PRD-002a SSE producer](./prd-002a-telemetry-sot-sse-and-schema-sse-producer.md) - emits the bounded slices.
- [PRD-002b SQLite schema](./prd-002b-telemetry-sot-sse-and-schema-sqlite-schema.md) - the tables this policy caps.
- [PRD-001c poll-and-merge loop](../prd-001-service-registration-and-telemetry-ingestion/prd-001c-service-registration-and-telemetry-ingestion-poll-merge-loop.md) - whose reads must stay windowed.
