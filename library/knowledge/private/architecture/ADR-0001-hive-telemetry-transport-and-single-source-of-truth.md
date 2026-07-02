# ADR-0001, hive telemetry transport and doctor as the single source of truth

> **Status:** Active · **Date:** 2026-07-01
> **Supersedes:** none · **Refines:** nectar [`ADR-0003`](../../../../../nectar/library/knowledge/private/architecture/ADR-0003-three-daemon-topology-and-hive-portal.md) (the three-daemon topology) and nectar [`ADR-0004`](../../../../../nectar/library/knowledge/private/architecture/ADR-0004-hive-portal-daemon-role-and-boundaries.md) (hive aggregates health, not Deep Lake)
> **Owners:** platform, doctor, hive
> **Related:** hive [`ADR-0003`](../../../../../hive/library/knowledge/private/architecture/ADR-0003-future-sse-streaming-for-dashboard-freshness.md), hive [`ADR-0004`](../../../../../hive/library/knowledge/private/architecture/ADR-0004-portal-landing-gate-and-path-based-routing.md), [`ADR-0002`](./ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md)

## Context

The Apiary runs a four-process fleet: honeycomb (workload daemon, `:3850`), nectar (workload daemon, `:3854`), hive (always-on portal, `:3853`), and doctor (the supervisor watchdog, loopback status page `:3852`). doctor already supervises the workload daemons from a static registry and serves a coarse `GET /status.json` (per-daemon `ok|degraded|unreachable|unknown` only, no metrics). hive already consumes that status via its `/api/fleet-status` route.

Two forces converge:

1. The portal needs far more than coarse health: it needs live metrics (actions taken, files processed, memories created since last restart), live logs at selectable verbosity, and Deep Lake connection/stats, rendered in near real time.
2. doctor is deliberately a "can't-crash", ZERO-runtime-dependency watchdog (Node built-ins only). Any telemetry mechanism it gains must not add an external dependency or a failure mode that can wedge it.

The question this ADR settles: how does telemetry flow from each service to doctor, and from doctor to the portal?

## Decision drivers

- A dying service cannot reliably push a "I am crashing" message before it dies, so a push channel from services is exactly the wrong shape for the failure we care most about.
- doctor must stay dependency-light and crash-proof.
- Memory must stay bounded: the portal wants live logs, but doctor must never hold whole log histories in memory.
- The portal wants one authoritative, near-real-time feed, not N direct connections to N services.

## Decision

**Services write to SQLite; doctor polls and owns the truth; one SSE stream feeds the portal.**

1. **Services are producers, SQLite is the transport.** Each service (honeycomb, nectar, hive, and any future product) writes its own NON-SENSITIVE telemetry to its OWN local SQLite database: logs written live, health and metric check-ins written on an interval. Services never push to doctor.
2. **doctor is the puller and the single source of truth.** doctor polls each registered service's SQLite database (about once per second) and probes each service's `/health`, merges the results into an in-memory model, and is the one authoritative source of hive health and telemetry. Which databases/tables it polls comes from the registry ([`ADR-0002`](./ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md)).
3. **One SSE stream, doctor to hive.** doctor maintains exactly one Server-Sent-Events stream to hive, which renders the health rail, the `/buzzing` readiness screen, and the health page in near real time. There is NO service-to-doctor SSE and no other streaming surface. This makes real the future direction hive [`ADR-0003`](../../../../../hive/library/knowledge/private/architecture/ADR-0003-future-sse-streaming-for-dashboard-freshness.md) recorded as Proposed, scoped to the single doctor to hive hop.
4. **Zero-dependency SQLite.** doctor uses Node's built-in `node:sqlite` (Node >= 22.5, the `--experimental-sqlite` builtin honeycomb already relies on for its local queue), so it gains SQLite access without any external runtime dependency, preserving the watchdog's zero-dep ethos. Databases run in WAL mode so a service writes while doctor reads without lock contention. doctor opens service databases read-only.

Memory stays bounded because doctor queries windows (recent rows, aggregates) rather than loading whole logs; the portal pages request bounded slices over the SSE feed.

```mermaid
flowchart LR
    hc["honeycomb :3850"] -->|"writes logs live + metrics on interval"| hcdb[("honeycomb.sqlite")]
    hn["nectar :3854"] -->|"writes"| hndb[("nectar.sqlite")]
    th["hive :3853"] -->|"writes"| thdb[("hive.sqlite")]
    doctor["doctor (SoT)"] -->|"poll ~1s (read-only) + probe /health"| hcdb
    doctor --> hndb
    doctor --> thdb
    doctor -->|"one SSE stream"| portal["hive dashboard"]
```

## Consequences

**Positive.**

- Robust to crashes: a service that dies simply stops updating its SQLite rows and stops answering `/health`; doctor detects it within roughly one poll interval, no lost "dying" push required.
- doctor stays crash-proof and dependency-light (built-in `node:sqlite` only).
- Decoupled producer/consumer: services do not need to know doctor's address or protocol; they only write local files.
- One authoritative feed to the portal, not N browser-to-daemon connections.

**Negative.**

- Detection latency is roughly the poll interval (about 1s), acceptable for a local operator dashboard but not instantaneous.
- doctor must manage many SQLite readers and be disciplined about windowed queries to keep memory bounded.
- SQLite schemas become a contract between each service (writer) and doctor (reader); schema drift must be handled additively (owned by doctor PRD-002 and the per-service PRDs).

**Reversibility.** Moderate. The producer/consumer split via SQLite is a clean seam; a future move to a push or hybrid model would change doctor's ingestion side and the service writers, but the portal-facing SSE contract would be unaffected.

## Alternatives considered and rejected

### Services push health/logs to doctor over SSE or HTTP (REJECTED)

Each service opens a stream (or posts) to doctor. Rejected because the failure we most need to detect, a crash, is precisely when a service cannot push; it also adds N inbound streams, makes doctor a server for its supervisees (inverting the watchdog relationship), and couples every service to doctor's address and protocol.

### Hybrid: SQLite for logs/metrics, plus a lightweight push for immediate state changes (CONSIDERED, REJECTED for v1)

Keep the SQLite pull for bulk telemetry but add a small service-to-doctor push so a clean shutdown or state change is reflected instantly. Deferred: it reintroduces an inbound channel and its failure modes for a marginal latency win over a 1s poll. Can be revisited if sub-second state transitions ever matter.

### doctor reads each service's data over HTTP `/metrics` instead of SQLite (REJECTED)

Rejected because it requires each service to keep serving while degraded, does not survive a crashed-but-not-exited process well, and does not give the portal durable history; SQLite gives durable, queryable, crash-surviving local state for free.

## Relationship to the corpus ADRs

- nectar [`ADR-0004`](../../../../../nectar/library/knowledge/private/architecture/ADR-0004-hive-portal-daemon-role-and-boundaries.md) decision #2 (hive holds no Deep Lake client; it aggregates from daemon APIs) is unchanged: the portal still holds no data plane. This ADR routes fleet health/telemetry through doctor as SoT rather than through per-daemon API aggregation, which is complementary (workload data via hive's BFF proxy per hive ADR-0002; fleet health/telemetry via doctor's SSE per this ADR).
- hive [`ADR-0003`](../../../../../hive/library/knowledge/private/architecture/ADR-0003-future-sse-streaming-for-dashboard-freshness.md): this ADR makes its Proposed SSE real, but only for the doctor to hive health/telemetry feed.

## References

- `doctor/src/status-page/server.ts` - the current coarse `/status.json` this telemetry feed enriches.
- `doctor/src/registry.ts` - the registry that will also record each service's SQLite database location (see [`ADR-0002`](./ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md)).
- nectar [`prd-004`](../../../../../nectar/library/requirements/backlog/prd-004-doctor-registry-and-hive/prd-004-doctor-registry-and-hive-index.md) - the registry + hive module this builds on.
- Forthcoming doctor [`prd-001`](../../../requirements/backlog/prd-001-service-registration-and-telemetry-ingestion/prd-001-service-registration-and-telemetry-ingestion-index.md) (registration + ingestion) and [`prd-002`](../../../requirements/backlog/prd-002-telemetry-sot-sse-and-schema/prd-002-telemetry-sot-sse-and-schema-index.md) (SSE + schema) implement this ADR.
