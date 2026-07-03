# Doctor Overview

> Category: Overview | Version: 1.1 | Date: July 2026 | Status: Active | Author: Mario Aldayuz

What Doctor is, what it does for you, and how to get it running, written for people who use The Apiary rather than people who build it.

**Related:**
- [../../private/architecture/system-overview.md](../../private/architecture/system-overview.md)
- [../../private/operations/status-page-and-cli.md](../../private/operations/status-page-and-cli.md)
- [../../private/operations/os-service-registration.md](../../private/operations/os-service-registration.md)
---

## What Doctor is

Doctor is the watchdog for The Apiary stack. Your coding agents' memory runs on local daemons (honeycomb, hive, nectar), and a daemon that quietly dies at 2am costs you the next morning: sessions with the memory of a goldfish and twenty minutes re-explaining a codebase your agent knew yesterday. Doctor exists so that never happens. It was built by Mario Aldayuz to fix exactly that failure, after watching it happen to real installs with nobody the wiser.

It is deliberately tiny and deliberately boring: zero dependencies, Node built-ins only, built to be harder to kill than anything it watches. Your operating system supervises Doctor (launchd on macOS, systemd on Linux, a Scheduled Task on Windows), so it survives crashes and reboots on its own. Doctor, in turn, supervises everything else.

Doctor is production ready and tested in live scenarios. Everything below is shipped: multi-daemon registry supervision, the repair ladder with backoff, OS service registration on all three platforms, the blessed-update gate with rollback, the loopback status page and its JSON feed, the per-service telemetry ingestion loop, and the single live health stream the Hive portal renders.

## What it does for you

**Watches.** Every 30 seconds it probes each daemon's health endpoint. It does not just learn that something is wrong; it learns what kind of wrong: down, wedged, or degraded in a specific subsystem.

**Heals.** When a daemon is sick, Doctor climbs a repair ladder the way a careful operator would: restart it, and if three restarts in a row fail, reinstall it; remove a conflicting package if one is detected; back off exponentially between attempts; stop the instant health returns. A daemon you kill on purpose is typically back inside one probe interval, without you touching anything.

**Stays quiet when things are fine.** A healthy probe is a debug log line. Doctor does not nag, notify, or update anything on the happy path.

**Speaks up when it cannot fix something.** If the ladder runs out, Doctor writes a structured "needs attention" report: what it diagnosed, every step it tried, what happened, and what it recommends you do. That report lands on your local status page first, on your machine.

**Keeps the stack current, safely.** Doctor auto-updates the memory daemon only behind a "blessed release" gate: a version has to be explicitly approved for rollout, the update is verified healthy afterward, and a failed verify rolls back to the version that worked. A bad release cannot spread itself. Doctor never auto-updates its own package; `doctor self-update` is the only way that happens.

**Never touches your credentials.** If Doctor suspects a credential problem, it tells you and stops. There is no code in it that can read or delete your credentials file. Full stop.

## Install

The Apiary installer sets Doctor up automatically, including the OS service registration:

```bash
# macOS / Linux
curl -fsSL https://get.theapiary.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://get.theapiary.sh/install.ps1 | iex
```

Standalone install or update:

```bash
npm install -g @legioncodeinc/doctor
doctor install-service
```

That second command registers Doctor with your OS so it restarts on crash and starts on boot. `doctor uninstall-service` removes it cleanly.

## The status page

Open `http://127.0.0.1:3852` in a browser. It is served by Doctor itself, on your machine only (loopback; nothing is exposed to the network), so it works even when everything else is down, which is precisely when you need it. You get every daemon's health at a glance, the latest escalation if there is one, and copy-pasteable commands to fix what is fixable. The same data is machine-readable at `/status.json` if you want to script against it. The richer dashboard lives in the Hive portal at `http://127.0.0.1:3853`, rendered live from the telemetry feed Doctor maintains.

## The CLI in thirty seconds

```bash
doctor status      # health, versions, last heal, one screen
doctor diagnose    # what is wrong and what Doctor would do; takes no action
doctor heal        # run the repair ladder once (risky steps ask first)
doctor logs        # what happened, episode by episode
doctor update      # update the memory daemon via the blessed gate (--check to preview)
```

Run `doctor` bare for the full menu.

## Try to break it

Do not take the pitch on faith:

```bash
pkill -f honeycomb   # kill the memory daemon on purpose
# wait ~30 seconds
doctor status        # back to ok, with a fresh "last heal"
```

The failure happened, the fix happened, and you were never on the hook for either.

## Quick answers

**Does it need admin rights?** No. Doctor registers per-user by default on all three platforms: a LaunchAgent on macOS, a `systemctl --user` unit on Linux, a per-user Scheduled Task on Windows. No sudo, no UAC prompt.

**What if Doctor itself crashes?** Your OS restarts it. That is the entire point of the design: Doctor is supervised by launchd, systemd, or Task Scheduler, not by anything in the stack it watches.

**Will it update things behind my back?** Only the memory daemon, only behind the blessed gate, and only if you have not opted out (`doctor run --no-auto-update`, the `HONEYCOMB_NO_AUTO_UPDATE=1` env var, or a pinned version all disable it). Doctor never updates its own package automatically, ever.

**Can it break my install worse than it found it?** The risky repairs are gated. Reinstalls are serialized behind a lock, verified afterward, and rolled back on a failed verify. The one genuinely destructive action (removing a conflicting package) writes an audit record first and never touches your data directories.

**How do I turn it off?** `doctor uninstall-service` removes the OS registration cleanly. The stack keeps running; you are just back to being your own on-call.

## Privacy

When Doctor genuinely cannot heal an install, it can phone home a scrubbed diagnosis (step outcomes and version numbers, never credentials, tokens, file contents, or your code) so problems get fixed before you file a ticket. It is opt-out and it honors the standard switches: set `DO_NOT_TRACK=1` or `HONEYCOMB_TELEMETRY=0` and nothing leaves your machine. The opt-out is enforced at a single chokepoint in the code, which means it is actually verifiable, not a promise.

Everything the "needs attention" report contains is also shown to you first, on your own status page, before anything is sent anywhere.
