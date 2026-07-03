# The SSE Producer

> Category: Telemetry | Version: 1.0 | Date: July 2026 | Status: Active | Author: Mario Aldayuz

For engineers working on `src/ingestion/sse.ts`: this is the single doctor-to-hive telemetry stream, how a connection gets a snapshot on connect and a frame per tick, the slow-consumer handling, and the Contract C event shape it forwards.

**Related:**
- [telemetry-ingestion-pipeline.md](./telemetry-ingestion-pipeline.md)
- [outbound-telemetry-and-privacy.md](./outbound-telemetry-and-privacy.md)
- [../architecture/telemetry-single-source-of-truth.md](../architecture/telemetry-single-source-of-truth.md)
- [../operations/status-page-and-cli.md](../operations/status-page-and-cli.md)
- [ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md](../architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md)
---

## Exactly one stream

ADR-0001 decision 3 pins the transport from doctor to the portal: exactly one Server-Sent-Events stream, doctor to hive, and no other streaming surface anywhere. `src/ingestion/sse.ts` is that stream. It is served at `GET /events` on the existing loopback status page (`:3852`), alongside `/` and `/status.json`, rather than on a second listener. There is no service-to-doctor stream (services write SQLite; doctor polls), and there is no second producer. One event type, `fleet-telemetry`, carries the in-memory model the poll loop maintains.

This module never re-opens SQLite and never re-derives health. It forwards the poll loop's snapshots verbatim. The per-service fault handling already happened upstream (the poll loop's isolation produces a `telemetryFault`-flagged model for a bad service while every other field stays populated), so the SSE producer has no per-service logic of its own to write.

## Snapshot on connect, frame per tick

`handleSseRequest` serves one connection to completion. The lifecycle:

```mermaid
sequenceDiagram
    participant hive as hive portal
    participant sse as handleSseRequest
    participant loop as poll loop
    hive->>sse: GET /events
    sse->>hive: 200 text/event-stream, Cache-Control no-store, keep-alive
    sse->>loop: snapshot()
    sse->>hive: fleet-telemetry frame (current snapshot)
    sse->>loop: onSnapshot(listener)
    loop-->>sse: snapshot each ~1s tick
    sse->>hive: fleet-telemetry frame (per tick)
    hive--xsse: disconnect / error
    sse->>loop: unsubscribe (cleanup)
```

The connect handshake writes the SSE headers, then immediately writes the current snapshot so a new connection does not wait a full poll interval for its first frame. Only then does it subscribe to `pollLoop.onSnapshot`, so every subsequent tick pushes one frame. Each frame is one named event plus a single-line JSON `data:` payload:

```typescript
function formatSseEvent(event: FleetTelemetryEvent): string {
	return `event: ${FLEET_TELEMETRY_EVENT_NAME}\ndata: ${JSON.stringify(event)}\n\n`;
}
```

## Fail-soft writes and slow-consumer handling

Every write goes through `safeWrite`, which is the whole robustness story. `res.write` returns `false` when the socket cannot keep up (kernel buffer full); the producer treats that as a slow consumer and drops it rather than buffering without bound:

```typescript
const buffered = !res.write(frame);
if (buffered) {
	logger.warn("sse.slow_consumer_disconnected", {});
	cleanup();
	endQuietly();
}
```

A write that throws (a disconnected or errored socket) is caught the same way (`sse.write_failed`). The bounded-slice discipline that keeps the poll loop's `logs` window small extends to the transport here: a consumer that cannot keep up with backpressure is dropped, not queued. `cleanup` unsubscribes from the poll loop exactly once (guarded by an `unsubscribed` flag), and `endQuietly` ends the response tolerating a socket that is already gone.

The disconnect handlers cover every teardown path: `req.on("close")`, `req.on("error")`, `res.on("close")`, and `res.on("error")` all route to `cleanup`. The result is that one slow or dead consumer can never touch another connection or the poll loop's fan-out. This is the invariant ADR-0001 needs for the portal-facing SSE contract to be safe: N browser connections, one authoritative feed, and no single connection able to wedge the producer.

## The Contract C event shape

The payload the stream carries is `FleetTelemetryEvent` from `src/telemetry/schema.ts`, the pinned Contract C shape:

```json
{
  "asOf": "2026-07-01T18:00:00.000Z",
  "services": [
    {
      "name": "honeycomb",
      "health": "ok",
      "lastSeen": "2026-07-01T17:59:59.500Z",
      "metrics": { "actionsTaken": 12, "filesProcessed": 3, "memoriesCreated": 5 },
      "deeplake": { "connected": true, "lastCommunicationAt": "2026-07-01T17:59:50.000Z" },
      "telemetryFault": null
    }
  ],
  "logs": [{ "service": "honeycomb", "ts": "2026-07-01T17:59:59.400Z", "level": "info", "message": "..." }]
}
```

The semantics the portal relies on: a never-registered service is absent from `services`; a registered-but-silent one appears with `health: "unknown"`; `logs` is a bounded slice of only the rows written since the previous tick, never a history; and `telemetryFault` is non-null when that service's DB was skipped this tick. The full merge logic that produces these fields is in [telemetry-ingestion-pipeline.md](./telemetry-ingestion-pipeline.md).

## Wiring: the onEvents seam

The status page server (`src/status-page/server.ts`) stays deliberately agnostic of SQLite and the telemetry model. It exposes an optional `onEvents` handler and mounts `/events` only when the composition root wires it:

```typescript
onEvents: (req, res) => handleSseRequest(req, res, { pollLoop: telemetryPollLoop, logger }),
```

When the seam is not wired (a bare `createStatusPageServer` without `onEvents`, as in the status page's own tests), `/events` 404s like any other unknown path, and the 404 body's `paths` list omits `/events` so a probing script sees the real surface. The production composition always wires it. The REST fallback hive uses when the stream is unavailable is hive's `GET /api/fleet-status`, which reads the same fleet model; the SSE stream is the near-real-time path, that projection the fail-soft floor.

## Invariants for contributors

- There is exactly one stream, doctor to hive. No second producer, no service-to-doctor stream.
- The producer forwards snapshots; it never re-opens SQLite or re-derives per-service health.
- Every write goes through `safeWrite`. A backpressured or errored socket is dropped, never buffered without bound.
- `cleanup` unsubscribes exactly once and every teardown event routes to it. One dead consumer never touches another.
- The event shape is Contract C. A field change is a cross-repo contract change, coordinated through the ledger, not a local edit.
