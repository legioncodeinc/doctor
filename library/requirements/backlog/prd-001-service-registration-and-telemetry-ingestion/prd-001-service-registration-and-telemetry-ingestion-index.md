# PRD-001: Service registration and telemetry ingestion

> **Status:** Backlog
> **Priority:** P0
> **Effort:** L (1-3d)
> **Schema changes:** Additive (extends the static registry entry with SQLite DB path[s]; introduces a service-written runtime SQLite status contract)

---

## Overview

This module implements the ingestion and registration side of hivedoctor's role as the single source of truth for fleet health. It realizes [`ADR-0001`](../../../knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md) (services write to SQLite, hivedoctor polls and owns the truth) and [`ADR-0002`](../../../knowledge/private/architecture/ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md) (two-layer registration: an installer-owned static registry plus a service-owned runtime SQLite status).

Today hivedoctor supervises the fleet from a static JSON registry at `~/.honeycomb/hivedoctor.daemons.json` whose entries carry `{ name, healthUrl, pidPath, probeIntervalMs, startupGraceMs, restartGiveUpThreshold, restartCooldownMs }` under a root of `{ "daemons": [ ... ] }` (introduced by hivenectar PRD-004a). hivedoctor reads that file on boot, falls back to the honeycomb primary when it is absent, and (per a recent fail-soft change) surfaces a needs-attention record rather than crash-looping when the file is malformed. This module extends that entry to also record where each service's SQLite database(s) live, defines what a service writes into its runtime SQLite on check-in, and adds the roughly one-second poll-and-merge loop that reads those databases read-only, probes each `/health`, and merges everything into an in-memory authoritative fleet model.

hivedoctor stays a "can't-crash", zero-runtime-dependency watchdog: the only new capability is reading SQLite through Node's built-in `node:sqlite` (Node >= 22.5, the `--experimental-sqlite` builtin honeycomb already relies on), so no external dependency is added.

**This index covers the module scope.** Sub-PRDs 001a, 001b, and 001c own the three discrete pieces below.

---

## Goals

- Extend the static registry entry so each service records the path(s) to its own SQLite telemetry database, fully backward compatible with the existing PRD-004a parser and its fail-soft fallback.
- Define a runtime SQLite status contract: what a service writes on check-in (registration record, binding time, last-seen, current health, metrics) and where.
- Add a poll-and-merge loop that, about once per second, opens each registered service's SQLite database read-only, runs windowed queries, probes each service's `/health`, and merges the results into a single in-memory source-of-truth model.
- Record a last-seen time when a service disconnects (missed check-ins plus failing `/health`) without crashing or losing the static "should exist" entry.
- Reload the static registry into memory on boot, on restart, and on explicit registration or deregistration, and keep supervising a service that is currently down.
- Preserve hivedoctor's zero-runtime-dependency, fail-soft posture end to end.

## Non-Goals

- The producer-facing SSE stream to the-hive and the metrics/log column schema. Those are owned by [PRD-002](../prd-002-telemetry-sot-sse-and-schema/prd-002-telemetry-sot-sse-and-schema-index.md).
- A runtime HTTP registration API. Registration remains a static file that installers edit and hivedoctor reads (locked in ADR-0002).
- Changing how the installer writes registration on install, update, or delete. That is the installer's responsibility (the-apiary [`ADR-0002`](../../../../../library/knowledge/private/architecture/ADR-0002-one-line-installer-product-loading-and-install-time-telemetry.md)); this module only consumes the extended entry.
- Adding an external runtime dependency to hivedoctor. Ingestion uses `node:sqlite` only.
- Restart, escalation, and remediation logic per daemon (delivered by hivenectar PRD-004a). This module consumes the registry that work established; it does not re-implement supervision.

---

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-001a-service-registration-and-telemetry-ingestion-static-registry-schema`](./prd-001a-service-registration-and-telemetry-ingestion-static-registry-schema.md) | Extend the static registry entry with SQLite DB path(s); backward compatibility and fail-soft parsing | Draft |
| [`prd-001b-service-registration-and-telemetry-ingestion-runtime-sqlite-contract`](./prd-001b-service-registration-and-telemetry-ingestion-runtime-sqlite-contract.md) | The runtime SQLite status contract: what services write on check-in (binding time, last-seen, health, metrics) | Draft |
| [`prd-001c-service-registration-and-telemetry-ingestion-poll-merge-loop`](./prd-001c-service-registration-and-telemetry-ingestion-poll-merge-loop.md) | The roughly one-second poll-and-merge loop: read-only windowed reads, `/health` probe, in-memory SoT, last-seen on disconnect, registry reload triggers | Draft |

---

## Acceptance criteria (module-level)

| ID | Criterion | Maps to |
|---|---|---|
| AC-1 | Given a registry entry that records a service's SQLite DB path(s), when hivedoctor boots, then it loads that path into its in-memory model and polls that database. | ADR-0002 decision 1 |
| AC-2 | Given a legacy registry entry with no SQLite DB path field, when hivedoctor parses the registry, then it loads the entry without error and treats the service as health-probe-only (no SQLite ingestion), preserving PRD-004a behavior. | ADR-0002 negative consequence (backward compat) |
| AC-3 | Given a malformed registry file, when hivedoctor loads it, then it falls back and surfaces a needs-attention record rather than crash-looping (existing fail-soft posture preserved). | ADR-0002 context |
| AC-4 | Given a registered service that has checked in, when the service writes its runtime status to SQLite, then that row carries at least its registration record, binding time, last-seen, current health, and metrics fields defined by the contract. | ADR-0002 decision 2 |
| AC-5 | Given a healthy fleet, when the poll loop runs, then hivedoctor opens each service's SQLite database read-only, runs windowed queries, probes each `/health`, and merges both into one in-memory source-of-truth model about once per second. | ADR-0001 decision 2 |
| AC-6 | Given a service that stops checking in and stops answering `/health`, when roughly one poll interval elapses, then hivedoctor marks it disconnected and records a last-seen time without dropping its static registry entry. | ADR-0001 positive consequence; ADR-0002 decision 3 |
| AC-7 | Given the registry changes (boot, restart, or explicit registration/deregistration), when the change is applied, then hivedoctor reloads the static registry into memory and adjusts which databases it polls. | ADR-0002 decision 3 |
| AC-8 | Given hivedoctor's ingestion path, when it runs, then it uses only Node built-ins (including `node:sqlite`) and adds no external runtime dependency. | ADR-0001 decision 4 |

---

## Data model changes

Additive, described in detail in the sub-PRDs:

- **Static registry entry (001a):** add an optional field recording the service's SQLite telemetry database path(s). The root shape `{ "daemons": [ ... ] }` and all existing PRD-004a fields are unchanged; older entries without the new field remain valid.
- **Runtime SQLite status (001b):** a service-owned status surface (registration record, binding time, last-seen, current health, metrics). hivedoctor opens these databases read-only in WAL mode. The column-level metrics and log schema itself is owned by PRD-002 (002b); 001b defines the status/check-in contract that the poll loop consumes.

---

## Related

- [`ADR-0001-hive-telemetry-transport-and-single-source-of-truth`](../../../knowledge/private/architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md) - the SQLite-pull transport and single-source-of-truth decision this module ingests against.
- [`ADR-0002-service-registration-static-registry-plus-runtime-sqlite`](../../../knowledge/private/architecture/ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md) - the two-layer registration decision this module implements.
- [PRD-002: Telemetry source-of-truth SSE stream and schema](../prd-002-telemetry-sot-sse-and-schema/prd-002-telemetry-sot-sse-and-schema-index.md) - the producer and schema side of ADR-0001; consumes the in-memory model this module builds.
- hivenectar [`PRD-004: hivedoctor daemon registry + thehive portal daemon`](../../../../../hivenectar/library/requirements/backlog/prd-004-hivedoctor-registry-and-thehive/prd-004-hivedoctor-registry-and-thehive-index.md) - PRD-004a introduced the static registry and its fail-soft parser this module extends.
- hivenectar [`ADR-0003-three-daemon-topology-and-thehive-portal`](../../../../../hivenectar/library/knowledge/private/architecture/ADR-0003-three-daemon-topology-and-thehive-portal.md) and [`ADR-0004-thehive-portal-daemon-role-and-boundaries`](../../../../../hivenectar/library/knowledge/private/architecture/ADR-0004-thehive-portal-daemon-role-and-boundaries.md) - the topology and portal boundaries hivedoctor's SoT role refines.
- the-hive [`ADR-0004-portal-landing-gate-and-path-based-routing`](../../../../../the-hive/library/knowledge/private/architecture/ADR-0004-portal-landing-gate-and-path-based-routing.md) - the portal routing that consumes fleet telemetry.
- the-hive forthcoming PRD-004 / PRD-005 (portal consumption of the telemetry feed), expected under [`the-hive/library/requirements/backlog/`](../../../../../the-hive/library/requirements/backlog/).
- the-apiary [`ADR-0002-one-line-installer-product-loading-and-install-time-telemetry`](../../../../../library/knowledge/private/architecture/ADR-0002-one-line-installer-product-loading-and-install-time-telemetry.md) - the installer that writes and updates the static registry entry.
- honeycomb [`PRD-069: Application Health Dashboard`](../../../../../honeycomb/library/requirements/backlog/prd-069-application-health-dashboard/prd-069-application-health-dashboard-index.md) - this realignment supersedes PRD-069's health-endpoint aggregation portion; fleet health now flows through hivedoctor as SoT rather than honeycomb-local aggregation.
