# PRD-004c: Supervision continuity and trusted-path checks through the window

> **Status:** Draft
> **Parent:** [PRD-004: Apiary fleet-root migration](./prd-004-apiary-fleet-root-migration-index.md)
> **Priority:** P0
> **Effort:** M (3-8h)
> **Schema changes:** None (path defaults and a trusted-root check change; no entry field changes)

---

## Overview

Doctor supervises the other daemons, so its defaults and its security checks must stay correct while the fleet migrates one product at a time. Three surfaces are affected:

1. **The built-in honeycomb fallback entry.** When no registry file exists, doctor supervises the honeycomb primary at built-in defaults, whose pid path is `~/.honeycomb/daemon.pid` (`doctor/src/registry.ts:114-124`, pid path at `doctor/src/registry.ts:118`). Honeycomb's parallel PRD moves that pid to `~/.apiary/honeycomb/daemon.pid`; the fallback entry must track the new location with a legacy fallback.
2. **The default pid paths.** The same legacy default is built in `resolveConfig` (`doctor/src/config.ts:155`) and as the per-entry parse default (`doctor/src/registry.ts:243`). Both must track honeycomb's migration the same way. The `HONEYCOMB_DAEMON_PID_PATH` env override (`doctor/src/config.ts:163,177`) is unchanged.
3. **The telemetry-path trust coercion (security-relevant).** `coerceTelemetryDbPath` pins telemetry databases under the single trusted root `~/.honeycomb/telemetry/` (`doctor/src/registry.ts:194-221`, root built at `doctor/src/registry.ts:209`, containment via `assertWithinBase` at `doctor/src/registry.ts:215`). This check exists to stop a poisoned registry from turning doctor into an arbitrary-file-read primitive over the unauthenticated loopback SSE stream (the security posture documented at `doctor/src/registry.ts:190-199`). It must accept the new per-product locations `~/.apiary/<product>/telemetry/` and, during the window, the legacy root, WITHOUT weakening containment.

The general continuity rule: registry entry values are authoritative and are already arbitrary paths (`pidPath` accepts any path with `~` expansion, `doctor/src/registry.ts:177-181`), so a not-yet-migrated nectar whose entry still says `~/.honeycomb/nectar.pid` keeps being probed with zero changes. What this sub-PRD changes is only the built-in defaults and the trust boundary.

---

## Goals

- `honeycombFallbackEntry` points its pid path at `~/.apiary/honeycomb/daemon.pid` with a legacy-aware existence check: when the new path does not exist but the legacy `~/.honeycomb/daemon.pid` does, the fallback entry carries the legacy path for this boot.
- The `resolveConfig` default pid path (`doctor/src/config.ts:155`) and the per-entry parse default (`doctor/src/registry.ts:243`) apply the same new-first, legacy-fallback resolution; the env override wins unchanged.
- `coerceTelemetryDbPath` validates against a set of trusted roots instead of one: `<root>/<product>/telemetry/` for each supervised product, plus the legacy `~/.honeycomb/telemetry/` for the duration of the window. A path inside none of them still degrades to `undefined` (health-probe-only), never a crash, never an honored escape.
- Explicit mid-window continuity: entries carrying legacy paths (pid or telemetry DB) parse, probe, and ingest identically to today.

## Non-Goals

- Moving honeycomb's actual pid/lock/telemetry files: honeycomb's parallel PRD.
- Widening what a registry entry may point at. The trust boundary stays exactly as tight per root; only the root set grows, and it shrinks back when the legacy window closes.
- The registry file relocation and merge rule: owned by [004b](./prd-004b-apiary-fleet-root-migration-coordination-surface.md).

---

## User stories

- As an operator who upgraded doctor but not honeycomb, doctor's registry-absent fallback still finds honeycomb's pid at the legacy path and supervision is uninterrupted.
- As an operator with a fully migrated fleet, doctor's defaults point at the new locations and nothing references `~/.honeycomb`.
- As a security reviewer, I can verify that a registry entry pointing a telemetry DB at an arbitrary file outside the per-product telemetry directories is still rejected, exactly as before the migration.

---

## Proposed design

### Pid-path defaults

One small resolver, `defaultHoneycombPidPath(root, home)`: return `<root>/honeycomb/daemon.pid` unless that file does not exist AND `~/.honeycomb/daemon.pid` exists, in which case return the legacy path. It backs all three sites (`doctor/src/registry.ts:118`, `doctor/src/registry.ts:243`, `doctor/src/config.ts:155`). The check runs at resolution time (boot / registry reload), which matches how the defaults are consumed today; a honeycomb migrating while doctor is up is picked up on the next reload or restart, and the supervisor's existing restart ladder tolerates a transient wrong pid path the same way it tolerates a stale pid file today.

### Telemetry trusted roots (security-relevant)

Replace the single `trustedRoot` (`doctor/src/registry.ts:209`) with an ordered list:

- `<root>/<name>/telemetry` for the entry's own product name, where `<name>` is the already-validated filename-safe entry name (`coerceName`, `doctor/src/registry.ts:228-235`),
- the legacy `~/.honeycomb/telemetry` (window only).

The candidate path must satisfy `assertWithinBase` against at least one root, and the exact validated value is what the poll loop later opens (preserving the resolve-then-validate discipline documented at `doctor/src/registry.ts:210-215`). Binding the new-location root to the entry's OWN name (rather than accepting any product's telemetry dir for any entry) keeps the boundary per-product and is the tightest reading of ADR-0003's "no product writes into another product's subdir"; flagged below since a looser any-known-product set is defensible.

Call-out: this is a security boundary, not a convenience default. The failure mode it guards (arbitrary user-readable SQLite exfiltrated over the loopback SSE stream `/events`) is documented at `doctor/src/registry.ts:190-199` and must be re-verified by tests on both the new roots and the legacy root, including traversal attempts that escape via `..` and, on Windows, drive-letter re-anchoring.

### Mid-window continuity

No behavior change is needed for explicit entry values; add tests locking that in: an entry with a legacy `pidPath` and a legacy-root `telemetryDbPath` parses and is probed/ingested identically before and after this sub-PRD.

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| c-AC-1 | Given no registry file, a migrated honeycomb pid at `~/.apiary/honeycomb/daemon.pid`, when the fallback entry is built, then its `pidPath` is the new location. |
| c-AC-2 | Given no registry file, no new-location pid, and a legacy pid at `~/.honeycomb/daemon.pid`, when the fallback entry is built, then its `pidPath` is the legacy location and supervision continues uninterrupted. |
| c-AC-3 | Given `HONEYCOMB_DAEMON_PID_PATH` is set, when config resolves, then it wins over both defaults unchanged (`doctor/src/config.ts:177`). |
| c-AC-4 | Given an entry with `telemetryDbPath` under `~/.apiary/<its-own-name>/telemetry/`, when parsed, then the path is accepted and retained. |
| c-AC-5 | Given an entry with `telemetryDbPath` under the legacy `~/.honeycomb/telemetry/`, when parsed during the window, then the path is accepted (mid-window ingestion continuity). |
| c-AC-6 | Given an entry with `telemetryDbPath` outside every trusted root (including traversal via `..`, a relative path, or another product's subdir under the per-own-name default), when parsed, then it degrades to health-probe-only, never a crash and never an honored escape. |
| c-AC-7 | Given a registry entry carrying explicit legacy paths for a not-yet-migrated product, when doctor supervises it, then probing, restart laddering, and SQLite ingestion behave identically to pre-migration behavior. |
| c-AC-8 | Given the security tests, when they run, then containment is proven per root with `assertWithinBase` semantics on both POSIX and Windows path shapes. |

---

## Implementation notes

- Reuse `assertWithinBase` (`doctor/src/safe-path.ts`) per candidate root; do not hand-roll a prefix check.
- The `KNOWN_DAEMON_NAMES` list (`doctor/src/registry.ts:46`) stays advisory; the trusted-root binding uses the entry's validated `name`, so an unknown-but-filename-safe product gets its own `<root>/<name>/telemetry` root and nothing else.
- Keep the coercion total: every rejection path returns `undefined`, mirroring the existing posture (`doctor/src/registry.ts:216-220`).
- When the legacy window closes (ADR-0003's removal criterion), the legacy root drops out of the list and the pid-path resolver loses its legacy branch; leave a single grep-able marker comment (for example `LEGACY-HONEYCOMB-WINDOW`) on every window-only branch across 004a/b/c so the removal is one sweep.

---

## Open questions

- [ ] **Per-entry binding of the new trust roots** (DEFAULT - confirm before implementation): accept only `<root>/<entry-name>/telemetry` for each entry (tightest, recommended) versus accepting `<root>/<any-known-product>/telemetry` for any entry (looser, tolerates an entry whose `name` differs from its telemetry dir owner). DEFAULT: per-own-name binding.
- [ ] **Existence-check timing for the pid-path default** (DEFAULT - confirm before implementation): resolve at boot/reload (recommended, matches current default consumption) versus re-checking per probe tick (more responsive mid-window, more fs stats on the hot path). DEFAULT: boot/reload.

---

## Related

- [`ADR-0003-fleet-directory-ownership-and-neutral-state-root`](../../../knowledge/private/architecture/ADR-0003-fleet-directory-ownership-and-neutral-state-root.md) - the per-product layout the trust roots mirror.
- [`ADR-0002-service-registration-static-registry-plus-runtime-sqlite`](../../../knowledge/private/architecture/ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md) - the registry contract whose defaults these are.
- [PRD-001a extended static registry schema](../prd-001-service-registration-and-telemetry-ingestion/prd-001a-service-registration-and-telemetry-ingestion-static-registry-schema.md) - introduced `telemetryDbPath` and its trusted-root security posture.
- [PRD-004a shared root helper](./prd-004a-apiary-fleet-root-migration-shared-root-helper.md) and [PRD-004b coordination surface](./prd-004b-apiary-fleet-root-migration-coordination-surface.md).
