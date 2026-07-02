# Registry And State: Every File Doctor Reads Or Writes

> Category: Data | Version: 1.0 | Date: July 2026 | Status: Active | Author: Mario Aldayuz

The complete on-disk data reference: the daemon registry schema with every field, default, and coercion rule, doctor's own state files, the incident streams, and the full telemetry SQLite DDL.

**Related:**
- [../architecture/supervision-and-remediation.md](../architecture/supervision-and-remediation.md)
- [../architecture/telemetry-single-source-of-truth.md](../architecture/telemetry-single-source-of-truth.md)
- [../operations/status-page-and-cli.md](../operations/status-page-and-cli.md)
- [../security/trust-boundaries.md](../security/trust-boundaries.md)
- [../architecture/ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md](../architecture/ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md)
---

## The filesystem map

Everything lives under `~/.honeycomb/`:

| Path | Writer | Reader | Purpose |
|---|---|---|---|
| `~/.honeycomb/doctor.daemons.json` | installer | doctor | Static supervision registry (Contract A) |
| `~/.honeycomb/daemon.pid` | honeycomb daemon | doctor | Primary PID/lock file rung 1 respects |
| `~/.honeycomb/telemetry/<service>.sqlite` | each service | doctor (read-only) | Runtime telemetry (Contract B) |
| `~/.honeycomb/doctor/state.json` | doctor | doctor | Legacy/process-global state (lifecycle dedupe markers) |
| `~/.honeycomb/doctor/state-<name>.json` | doctor | doctor | Per-daemon remediation state shard |
| `~/.honeycomb/doctor/incidents.ndjson` | doctor | doctor, `doctor logs` | Process-global incident/escalation stream |
| `~/.honeycomb/doctor/incidents-<name>.ndjson` | doctor | doctor, `doctor logs --daemon` | Per-daemon incident shard |
| `~/.honeycomb/doctor/needs-attention.json` | doctor | honeycomb dashboard, status page | Latest primary escalation (read seam) |
| `~/.honeycomb/doctor/removed-packages.ndjson` | doctor (rung 3) | humans | Backup record of removed conflicting packages |
| `~/.honeycomb/doctor/launchd.out.log`, `launchd.err.log` | launchd | humans | macOS service stdout/stderr |

The workspace dir defaults to `~/.honeycomb/doctor` and is overridable with `DOCTOR_WORKSPACE_DIR`. Every fixed filename is joined under the workspace through `resolveInBase` (`src/safe-path.ts`) so no composed path can escape it.

## doctor.daemons.json

The root shape is a JSON object with a non-empty `daemons` array. Parsed by `readRegistryFile` in `src/registry.ts`, hand-validated with built-ins only.

```json
{
  "daemons": [
    {
      "name": "honeycomb",
      "healthUrl": "http://127.0.0.1:3850/health",
      "pidPath": "~/.honeycomb/daemon.pid",
      "probeIntervalMs": 30000,
      "startupGraceMs": 60000,
      "restartGiveUpThreshold": 3,
      "restartCooldownMs": 5000,
      "telemetryDbPath": "~/.honeycomb/telemetry/honeycomb.sqlite"
    }
  ]
}
```

### Field-by-field rules

| Field | Type | Required | Default | Coercion rule |
|---|---|---|---|---|
| `name` | string | YES | none | Must match `/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/` (filename-safe; it keys the state and incident shards). Missing or garbage name throws `RegistryError`: fail loud, this is the one non-defaultable field. |
| `healthUrl` | string | no | `http://127.0.0.1:3850/health` | Must parse as http/https AND resolve to a loopback host (`127.0.0.1`, `localhost`, `::1`, `[::1]`). Anything else, including a perfectly valid non-loopback URL, silently falls back to the default. This is the SSRF gate. |
| `pidPath` | string | no | `~/.honeycomb/daemon.pid` | Non-empty string, leading `~` expanded to the home dir. Garbage falls back. |
| `probeIntervalMs` | integer | no | `30000` | Positive integer or the default. |
| `startupGraceMs` | integer | no | `60000` | Positive integer or the default. |
| `restartGiveUpThreshold` | integer | no | `3` | Positive integer or the default. |
| `restartCooldownMs` | integer | no | `5000` | Non-negative integer (0 is legal) or the default. |
| `telemetryDbPath` | string | optional | absent | `~` expanded, must be ABSOLUTE post-expansion (a relative path is rejected outright because it would anchor to whatever cwd the process happens to have), then resolved and asserted to live under `~/.honeycomb/telemetry/` via `assertWithinBase`. Any escape, relative path, or garbage degrades to absent, which means health-probe-only. Never a crash, never a silently honored escape. |

The known daemon names are `honeycomb`, `hive`, and `nectar` (`KNOWN_DAEMON_NAMES`), but parsing is permissive: any filename-safe token loads.

### Failure postures, both deliberate

- **File absent:** `readRegistryFile` returns `null`; `loadRegistry`/`resolveDaemons` falls back to a single honeycomb entry. The compose-root fallback (`honeycombEntryFromConfig`) preserves env overrides from `resolveConfig`, so a missing registry does not drop your `DOCTOR_*` tuning.
- **File present but malformed** (unparseable JSON, wrong root shape, empty `daemons`, bad `name`): the parser throws `RegistryError`, and the composition root catches it (`resolveDaemons` in `src/compose/index.ts`), falls back to the honeycomb primary, logs `registry.malformed_fallback`, and records a needs-attention escalation recommending manual intervention. Throwing out of boot would hand the OS supervisor a crash loop; this path refuses to.

The `telemetryDbPath` containment is the fix from the security review of the telemetry ingestion work (commit `ad2174a`): without it, a poisoned registry could point doctor's read-only poller at any user-readable SQLite file and leak Contract-B-shaped contents over the unauthenticated loopback `/events` stream.

## state.json and state-\<name\>.json

`src/state.ts`. One shard per supervised daemon (`state-honeycomb.json`, `state-nectar.json`, ...); the un-suffixed `state.json` remains as the process-global store used for lifecycle telemetry dedupe markers.

```typescript
export interface DoctorState {
	readonly version: 1;
	readonly lastKnownHealth: "ok" | "degraded" | "unreachable" | "unknown";
	readonly currentRung: number;                 // 1 = restart
	readonly consecutiveRestartFailures: number;  // drives the give-up-after-3 advance
	readonly backoffRung: number;                 // geometric step count, survives reboots
	readonly lastHealAt: string | null;           // ISO-8601 of last confirmed return to healthy
	readonly lastRestartAt: string | null;        // ISO-8601 of last doctor-performed restart (cooldown)
	readonly installedEventReported?: boolean;            // doctor_installed dedupe marker
	readonly updatedEventReportedVersion?: string;        // doctor_updated per-version dedupe marker
}
```

Defaults (`DEFAULT_STATE`): `lastKnownHealth: "unknown"`, `currentRung: 1`, counters 0, timestamps null. Reads are total: a missing file, unreadable dir, or garbage JSON yields `DEFAULT_STATE`, and a partially valid object is hand-merged field by field over the defaults (`mergeState`), so a corrupt file degrades to a coherent state instead of propagating junk into the loop. Writes are atomic: serialize to a random-suffixed `.tmp` in the same dir, then `renameSync` over the target; any failure is swallowed and logged as `state.write_failed`.

## incidents.ndjson and incidents-\<name\>.ndjson

`src/incidents.ts`. Append-only NDJSON, one `Incident` per line:

```typescript
export interface Incident {
	readonly id: string;                       // UUID
	readonly openedAt: string;                 // ISO-8601
	readonly trigger: "unreachable" | "timeout" | "degraded" | "unknown";
	readonly healthKind: HealthClassification["kind"];
	readonly healthReasons?: ProbeHealthReasons;   // degraded only: storage/embeddings/schema
	readonly steps: readonly IncidentStep[];       // ordered, each { rung, action, outcome, detail?, at }
	readonly resolved: boolean;
	readonly closedAt: string;
}
```

Step outcomes are `succeeded`, `failed`, or `skipped`. The file caps at 5 MiB (`DEFAULT_MAX_BYTES`); at or past the cap it rotates once to `<file>.1`, so a box that flaps for days never grows an unbounded log. Failed appends are swallowed and logged with the incident id. The per-daemon shards are what `doctor logs --daemon <name>` tails, and what the status page reads back per-daemon escalations from (`readPerDaemonEscalation` in `src/compose/index.ts`).

## needs-attention.json

`src/escalation/needs-attention-store.ts`. The dashboard read seam: doctor writes, the honeycomb dashboard (and doctor's own status page) reads. Strictly one-directional.

```typescript
export interface NeedsAttentionFile {
	readonly version: 1;
	readonly escalation: EscalationRecord;  // diagnosis, steps, recommendedAction, wouldHaveTaken?, at
	readonly resolved: boolean;             // true once a later heal cycle restored health
	readonly recordedAt: string;
	readonly resolvedAt?: string;           // absent while unresolved
}
```

A missing file means "no escalation has occurred" and is not an error. Readers must check `version` and tolerate unknown fields. Only the honeycomb primary's escalation hook writes this shared file; every other daemon's escalations stay in their own incident shards so one daemon's give-up can never overwrite another's banner.

## removed-packages.ndjson

Rung 3's audit trail (`src/rungs/uninstall-hivemind.ts`). One record appended BEFORE each removal of a conflicting `@deeplake/hivemind` global; if the record cannot be written, the destructive uninstall is skipped.

```typescript
export interface RemovedPackageRecord {
	readonly package: string;        // "@deeplake/hivemind"
	readonly version: string | null;
	readonly at: string;             // ISO-8601, written before the uninstall ran
}
```

## Telemetry SQLite DDL (Contract B, complete)

Doctor reads these tables; it never creates or writes them. Each service owns its database in WAL mode; doctor opens it with `new DatabaseSync(path, { readOnly: true, timeout: 1000 })`.

```sql
CREATE TABLE IF NOT EXISTS service_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  binding_time TEXT NOT NULL,       -- ISO-8601, set once at process start
  last_seen TEXT NOT NULL,          -- ISO-8601, updated every heartbeat
  health TEXT NOT NULL,             -- 'ok' | 'degraded' | 'unconfigured'
  deeplake_connected INTEGER,       -- 0/1, nullable
  deeplake_last_comm TEXT           -- ISO-8601, nullable
);

-- honeycomb's metric set (3 counters)
CREATE TABLE IF NOT EXISTS service_metrics (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  actions_taken INTEGER NOT NULL DEFAULT 0,
  files_processed INTEGER NOT NULL DEFAULT 0,
  memories_created INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- nectar's metric set (5 counters; own table variant, additive per PRD-002b-AC-4)
CREATE TABLE IF NOT EXISTS service_metrics (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  files_registered INTEGER NOT NULL DEFAULT 0,
  nectars_minted INTEGER NOT NULL DEFAULT 0,
  descriptions_generated INTEGER NOT NULL DEFAULT 0,
  hive_graph_versions INTEGER NOT NULL DEFAULT 0,
  embeddings_computed INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS service_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('error','warn','info','debug')),
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_service_logs_ts ON service_logs(ts DESC);
```

Contract rules: `service_status` and `service_metrics` are single-row (`id = 1`) latest-wins tables updated in place. `service_logs` is append-only, writer-capped at 5,000 rows (oldest deleted past the cap). Metrics reset to zero on process start; `binding_time` is the "since last restart" anchor. Non-sensitive columns only. Doctor's reads are all either a single-row `id = 1` lookup or a windowed `id > ? ORDER BY id ASC LIMIT ?` scan (`readNewLogs`), so memory stays bounded regardless of history.

## Config env overrides

`resolveConfig` in `src/config.ts` layers these over `DEFAULTS`; every parse falls back to the default on garbage, never throws:

`DOCTOR_PROBE_INTERVAL_MS`, `DOCTOR_PROBE_TIMEOUT_MS`, `DOCTOR_STARTUP_GRACE_MS`, `DOCTOR_HEALTH_URL`, `DOCTOR_STATUS_PAGE_PORT` (0 asks the OS for an ephemeral port), `DOCTOR_BACKOFF_FLOOR_MS`, `DOCTOR_BACKOFF_CEILING_MS` (a ceiling below the floor clamps up to the floor), `DOCTOR_RESTART_GIVE_UP`, `DOCTOR_RESTART_COOLDOWN_MS`, `DOCTOR_INSTALL_HEALTH_INTERVAL_MS` (default 3,600,000 = 60 min), `DOCTOR_WORKSPACE_DIR`, `HONEYCOMB_DAEMON_PID_PATH`.
