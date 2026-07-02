# Status Page And CLI

> Category: Operations | Version: 1.0 | Date: July 2026 | Status: Active | Author: Mario Aldayuz

The operator's reference: every endpoint on the `:3852` status page, every CLI verb with its real behavior and exit codes, the env vars that tune the watchdog, and a short runbook for the common failures.

**Related:**
- [os-service-registration.md](./os-service-registration.md)
- [../data/registry-and-state.md](../data/registry-and-state.md)
- [../architecture/supervision-and-remediation.md](../architecture/supervision-and-remediation.md)
- [../architecture/telemetry-single-source-of-truth.md](../architecture/telemetry-single-source-of-truth.md)
---

## The status page on :3852

`src/status-page/server.ts` serves a minimal read-only HTTP surface bound to `127.0.0.1` only, never `0.0.0.0`. Its job is comfort UX: the user has something authoritative to look at while the primary daemon (and its dashboard) is down. The port is `statusPagePort` (default 3852, distinct from the daemon's 3850/3851); a bind error (`EADDRINUSE`, `EACCES`) is swallowed and logged as `status-page.bind_failed`, never a crash. The server accepts no mutations, proxies nothing, and calls nothing out.

### GET /

A single HTML page with inline CSS (zero external resources, zero network calls from the page): overall health badge, a per-daemon table (name, health, escalation), the latest escalation as pretty-printed JSON, and suggested commands. All dynamic strings are HTML-entity escaped.

### GET /status.json

The same data, machine-readable, `Cache-Control: no-store`:

```typescript
export interface StatusJson {
	readonly health: "ok" | "degraded" | "unreachable" | "unknown";
	readonly daemons: readonly {
		readonly name: string;
		readonly health: StatusPageHealth;
		readonly escalation: NeedsAttentionFile | null;
	}[];
	readonly escalation: NeedsAttentionFile | null;   // the primary's record, kept top-level for back compat
	readonly suggestedCommands: readonly string[];
	readonly asOf: string;                             // ISO-8601
}
```

The top-level `health` aggregates deterministically (`aggregateDaemonHealth` in `src/compose/index.ts`): any `unreachable` wins, then any `degraded`, all-`unknown` stays `unknown`, `unknown` mixed with anything else reads `degraded`, otherwise `ok`. Suggested commands are derived from health plus unresolved escalations: `reinstall-primary` maps to the `npm install -g @legioncodeinc/honeycomb@latest` line, `uninstall-conflicting-hivemind` to `npm uninstall -g @deeplake/hivemind`, and `clear-credentials` to a comment telling you to review `~/.deeplake/credentials.json` yourself, because doctor will not touch it.

### GET /events

The single doctor-to-hive SSE stream (Contract C): `text/event-stream`, one event type `fleet-telemetry`, the current snapshot written immediately on connect and one frame per poll tick (~1s) after. Mounted onto this same listener by the composition root via the `onEvents` seam; a build that never wires the seam 404s the path like any other unknown route. Slow or disconnected consumers are dropped, never buffered without bound.

### Anything else

404 with a JSON body listing the known paths, so a probing script learns the surface: `{ "error": "not found", "paths": ["/", "/status.json", "/events"] }`.

## The CLI

`doctor` with no arguments prints the banner and menu. The verb set is single-sourced in `src/cli/command-table.ts` and dispatched in `src/cli/dispatch.ts`; there is deliberately no `clear-credentials` verb anywhere in the table. Exit codes: `0` ok, `1` handler error, `2` user declined a confirmation gate.

| Verb | What it actually does |
|---|---|
| `run` | The long-running OS-service entry. Started by the service manager, not by hand; returns only after SIGTERM/SIGINT drives a graceful stop. |
| `status` | Doctor service state, doctor version, then per-daemon: health label, daemon version, last heal. Ends with the auto-update opt-out state and its source (cli/env/state/pin). |
| `diagnose` | Classify health and print the recommended rung. Takes NO action; it consults the pure `decide()` only and never calls `ladder.run`. |
| `heal` | Probe, decide the rung, run it once. Rungs >= 2 confirm first unless `--yes`. |
| `restart` | Run rung 1 directly (ungated). |
| `reinstall` | Run rung 2 directly (gated; `--yes` bypasses). |
| `uninstall-hivemind` | Run rung 3 (always confirms; `--yes` bypasses). Removes the `@deeplake/hivemind` package only, never `~/.deeplake/` state. |
| `update [--check]` | Primary-daemon update through the blessed gate. `--check` runs `previewUpdate()`: reads installed + latest + blessed and runs the same gate, mutating nothing. |
| `self-update` | The ONLY code path that updates `@legioncodeinc/doctor` itself. Doctor never self-updates in the background. |
| `install-service` | Register the OS service (writes the unit, runs the manager commands, migrates legacy `hivedoctor` units). Non-zero exit on a manager failure. |
| `uninstall-service` | Stop and remove the OS service and its unit file. |
| `logs` | Tail incident episodes: `--lines <n>` (default 20), `--daemon <name>` to filter one shard. |
| `help` | Banner plus this menu. |

Useful flags: `--version` / `-v` / `-V` print the build-injected version and exit. `--yes` auto-confirms gated repairs. `run --no-auto-update` is the highest-precedence auto-update opt-out.

## Env var reference

Watchdog tuning (all optional, all defensively parsed; garbage falls back to the default):

| Var | Default | Meaning |
|---|---|---|
| `DOCTOR_PROBE_INTERVAL_MS` | 30000 | Watch-loop probe cadence |
| `DOCTOR_PROBE_TIMEOUT_MS` | 2000 | Per-probe HTTP timeout |
| `DOCTOR_STARTUP_GRACE_MS` | 60000 | Cold-boot / post-restart grace |
| `DOCTOR_HEALTH_URL` | `http://127.0.0.1:3850/health` | Primary daemon health URL (http/https only) |
| `DOCTOR_STATUS_PAGE_PORT` | 3852 | Status page port; 0 = OS-assigned |
| `DOCTOR_BACKOFF_FLOOR_MS` / `DOCTOR_BACKOFF_CEILING_MS` | 1000 / 30000 | Geometric backoff bounds (inverted values clamp) |
| `DOCTOR_RESTART_GIVE_UP` | 3 | Failed restarts before advancing to rung 2 |
| `DOCTOR_RESTART_COOLDOWN_MS` | 5000 | No-double-restart window (0 legal) |
| `DOCTOR_INSTALL_HEALTH_INTERVAL_MS` | 3600000 | Install-health telemetry heartbeat |
| `DOCTOR_WORKSPACE_DIR` | `~/.honeycomb/doctor` | Doctor's own state/incident dir |
| `HONEYCOMB_DAEMON_PID_PATH` | `~/.honeycomb/daemon.pid` | Primary PID/lock file |

Behavior toggles:

| Var | Effect |
|---|---|
| `HONEYCOMB_NO_AUTO_UPDATE=1` | Disable auto-update (env layer; the CLI flag outranks it) |
| `HONEYCOMB_PIN_VERSION=<semver>` | Pin the primary daemon; a pin at any layer disables forward updates |
| `DO_NOT_TRACK=1` | Zero telemetry leaves the box |
| `HONEYCOMB_TELEMETRY=0` | Same, Honeycomb-wide convention |

## Runbook

**A daemon shows `unreachable (connection refused)`.** It is down. Give doctor one probe interval; `doctor status` should show a heal (rung 1). If the restart keeps failing, `doctor logs --daemon <name>` shows the episode steps, and after three failures the ladder advances to reinstall on its own.

**A daemon shows `unreachable (timed out / wedged)`.** The process is alive but hung. Same ladder applies; the distinction is in the incident trigger (`timeout`), which is your hint the box hit a backlog wedge rather than a crash.

**The status page shows a needs-attention escalation.** The ladder exhausted. Read `escalation.diagnosis` and `escalation.steps` on `/status.json` (or `~/.honeycomb/doctor/needs-attention.json`), run the suggested commands, and know that `recommendedAction: "clear-credentials"` means doctor wants you to review `~/.deeplake/credentials.json` by hand; it will never do that itself.

**The page mentions a malformed registry.** `~/.honeycomb/doctor.daemons.json` is present but broken; doctor fell back to supervising only the honeycomb primary at defaults. Fix the JSON (check `name` fields first, they are the only fail-loud ones) and restart the service. Daemons listed in the broken file were NOT being supervised in the meantime; the banner says so.

**Nothing on :3852.** The bind likely failed (port already taken) and was deliberately swallowed. Check the service logs for `status-page.bind_failed`, then set `DOCTOR_STATUS_PAGE_PORT` on the service environment or free the port. Doctor keeps supervising either way; the page is comfort, not a dependency.

**`doctor status` says auto-update `disabled (pin)` unexpectedly.** Something set `HONEYCOMB_PIN_VERSION`. The `source` field in the output names the layer that made the decision; precedence is CLI flag, then env, then persisted state, then the pin alone.

**Kill test.** `pkill -f honeycomb`, wait one probe interval, then `doctor status`: the daemon row should be back to `ok` with a fresh last-heal. That round trip is the whole product working.
