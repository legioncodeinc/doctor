# OS Service Registration

> Category: Operations | Version: 1.0 | Date: July 2026 | Status: Active | Author: Mario Aldayuz

How doctor registers itself with launchd, systemd, and Windows so the OS restarts the restarter: platforms, scopes, exact commands, unit contents, file paths, and the legacy-label migration.

**Related:**
- [status-page-and-cli.md](./status-page-and-cli.md)
- [../architecture/system-overview.md](../architecture/system-overview.md)
- [../infrastructure/build-and-release.md](../infrastructure/build-and-release.md)
---

## The contract

Two non-negotiables, encoded in every unit template (`src/service/templates.ts`):

- **Restart on crash:** launchd `KeepAlive`, systemd `Restart=always`, Scheduled Task `RestartOnFailure`, sc auto-start service recovery.
- **Start on boot/login:** launchd `RunAtLoad`, systemd `WantedBy=default.target` via `enable --now`, a Scheduled Task `LogonTrigger`, sc `start= auto`.

Doctor shells out to the native manager (`launchctl` / `systemctl` / `schtasks` / `sc.exe`) through `execFile` with argv arrays, no shell, and vendors only the small unit templates as pure string builders. No service-manager npm dependency exists.

## Names, per fleet decision #32

Decision #32 (2026-07-02) set the fleet naming scheme to reverse-DNS `com.legioncode.<shortname>` with the short name `doctor`:

| Constant | Value |
|---|---|
| `SERVICE_LABEL` | `com.legioncode.doctor` |
| `SYSTEMD_UNIT_NAME` | `doctor.service` |
| `WINDOWS_TASK_NAME` | `doctor` |
| `LEGACY_SERVICE_LABEL` | `com.legioncode.hivedoctor` |
| `LEGACY_SYSTEMD_UNIT_NAME` | `hivedoctor.service` |
| `LEGACY_WINDOWS_TASK_NAME` | `HiveDoctor` |

Every `install-service` run begins with a best-effort deregistration of the legacy names (`legacyUninstallCommands` in `src/service/argv.ts`) and removal of the legacy unit file (`legacyUnitPath`), so a re-run migrates a pre-rename install instead of leaving two watchdogs racing over one daemon. When no legacy unit exists these commands fail harmlessly and the install proceeds.

## Platform and scope resolution

`resolveServicePlan` in `src/service/platform.ts` decides once, from three injected facts (platform, home dir, privileged or not):

- **macOS:** launchd. User scope = LaunchAgent at `~/Library/LaunchAgents/com.legioncode.doctor.plist`; system scope = `/Library/LaunchDaemons/com.legioncode.doctor.plist`.
- **Linux:** systemd. User scope = `~/.config/systemd/user/doctor.service` managed with `systemctl --user`; system scope = `/etc/systemd/system/doctor.service`.
- **Windows:** a per-user Scheduled Task is the DEFAULT (no admin, no UAC). A Windows Service via `sc.exe` is the enterprise opt-in at system scope only. Neither keeps a unit file doctor owns on disk.

User scope is the default everywhere: it needs no root/admin and matches a per-user `npm i -g`. System scope requires BOTH privilege and an explicit opt-in (`preferSystemScope`); a system request from an unprivileged process falls back to user scope and records `fellBackToUser` rather than failing the install. On Windows, privilege detection conservatively reports not-privileged (there is no cheap built-in admin check), so the per-user task always wins by default.

## Exact commands

From `src/service/argv.ts`; the unit file (when the platform has one) is written first, then these run in order with a 15s per-command timeout.

**Install:**

| Platform | Commands |
|---|---|
| macOS (user) | `launchctl bootstrap gui/<uid> <plist>` then `launchctl kickstart -k gui/<uid>/com.legioncode.doctor` |
| Linux (user) | `systemctl --user enable --now doctor.service` |
| Windows (default) | `schtasks /Create /XML <file> /TN doctor /F` then `schtasks /Run /TN doctor` |
| Windows (sc, opt-in) | `sc create doctor binPath="<node>" "<cli>" run start= auto` then `sc start doctor` |

**Uninstall:** `launchctl bootout gui/<uid>/com.legioncode.doctor` (then delete the plist); `systemctl --user disable --now doctor.service` (then delete the unit); `schtasks /Delete /TN doctor /F`; `sc stop doctor` + `sc delete doctor`. Deleting the unit file after deregistering is what keeps the unit from resurrecting on next boot.

**Status:** `launchctl print gui/<uid>/com.legioncode.doctor`; `systemctl --user is-active doctor.service`; `schtasks /Query /TN doctor`; `sc query doctor`. `doctor status` classifies the result as `running`, `not-running`, or `unknown`.

The modern `bootstrap`/`bootout` launchctl verbs are used on purpose; the legacy `load -w`/`unload -w` are avoided.

## What the units contain

All three templates exec `node <cli.js> run` as an argv array, never through a shell, so a path with spaces cannot mis-split (systemd tokens are explicitly quoted by `quoteSystemdToken`; XML values go through `escapeXml`).

**launchd plist:** `RunAtLoad` true, `KeepAlive` true, `ThrottleInterval` 5 (seconds between crash-restarts, `RESTART_SEC`), `ProcessType` Background, stdout/stderr to `~/.honeycomb/doctor/launchd.out.log` and `launchd.err.log` so a LaunchAgent never needs root-writable log paths.

**systemd unit:** `Type=simple`, `Restart=always`, `RestartSec=5`, `StartLimitIntervalSec=0` (never give up), `After=network.target`, `WantedBy=default.target`.

**Scheduled Task XML:** `LogonTrigger`, `RunLevel` LeastPrivilege, `MultipleInstancesPolicy` IgnoreNew (single instance), `ExecutionTimeLimit` PT0S (no time limit), `RestartOnFailure` with `Interval` `PT1M` and `Count` 999. The interval is deliberately NOT the POSIX 5 seconds: Task Scheduler rejects sub-minute intervals (`PT5S` fails XML validation, IRD-192's root cause), so `WINDOWS_RESTART_INTERVAL = "PT1M"` is the floor Windows accepts. Battery conditions are disabled so a laptop on battery still gets its watchdog.

## Install and uninstall in practice

```bash
doctor install-service     # resolve plan -> deregister legacy -> write unit -> register + start
doctor uninstall-service   # stop + deregister -> delete unit file
```

Both delegate to `createServiceModule` in `src/service/index.ts`. Every step is crash-safe: a manager command failure becomes a returned `ServiceResult` with the last meaningful line of the manager's own stderr (length-capped), and the CLI maps `ok: false` to a non-zero exit so installers see an honest failure. The one-line install script (`curl -fsSL https://get.theapiary.sh | sh`, or the PowerShell equivalent) runs `install-service` for you; `--no-doctor` opts out at install time.

Lifecycle telemetry rides along, gated and fail-soft: `doctor_installed` fires once per machine after a successful install (deduped via the state-store marker), `doctor_uninstalled` fires fire-and-forget before teardown. Opt-outs apply as everywhere else.

## Verify after install

```bash
# The service manager's own view:
launchctl print gui/$(id -u)/com.legioncode.doctor    # macOS: state should be "running"
systemctl --user is-active doctor.service              # Linux: prints "active"
schtasks /Query /TN doctor                             # Windows: status "Running" or "Ready"

# Doctor's own view:
doctor status                                          # "Doctor service: running"
curl -s http://127.0.0.1:3852/status.json | head       # the page is up

# The real proof (restart-on-crash):
pkill -f "doctor.*run"                                 # kill the watchdog itself
sleep 10 && doctor status                              # the OS brought it back
```

## Troubleshooting

**macOS: `bootstrap` fails with "Bootstrap failed: 5: Input/output error".** Usually the unit is already loaded. Run `launchctl bootout gui/$(id -u)/com.legioncode.doctor` then reinstall, or just re-run `doctor install-service` (the install re-runs bootout paths best-effort).

**Linux: unit starts but dies at boot before login.** User-scope systemd units run in the user manager, which starts at login unless lingering is enabled. `loginctl enable-linger <user>` makes the user manager (and doctor) start at boot.

**Windows: `schtasks /Create` fails with an Interval format error.** You are running a hand-edited XML with a sub-minute restart interval; Task Scheduler's floor is `PT1M`. Use the doctor-rendered XML.

**Two doctors running after an upgrade from hivedoctor.** Should not happen (install deregisters legacy names first), but if a hand-installed legacy unit used a nonstandard path, remove it manually: check `~/Library/LaunchAgents/com.legioncode.hivedoctor.plist`, `~/.config/systemd/user/hivedoctor.service`, and `schtasks /Query /TN HiveDoctor`.
