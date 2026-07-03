# Telemetry

> Category: Index | Version: 1.0 | Date: July 2026 | Status: Active

The telemetry domain covers both directions of doctor's data flow: the inbound ingestion pipeline that polls each service's local SQLite and probes `/health` to build the fleet model, the single outbound SSE stream that carries that model to hive, and the separate scrubbed outbound telemetry doctor phones home for its own operational health. Doctor is a reader of service telemetry and an honest, opt-out-gated emitter of its own.

**Related:**
- [telemetry-ingestion-pipeline.md](./telemetry-ingestion-pipeline.md): the poll-and-merge loop and the read-only SQLite reader
- [sse-producer.md](./sse-producer.md): the single doctor-to-hive `/events` stream (Contract C)
- [outbound-telemetry-and-privacy.md](./outbound-telemetry-and-privacy.md): the emit chokepoint, allow-list scrubbing, and opt-out gates
- [../architecture/telemetry-single-source-of-truth.md](../architecture/telemetry-single-source-of-truth.md): the ADR-0001/0002 pipeline overview and the three pinned contracts
