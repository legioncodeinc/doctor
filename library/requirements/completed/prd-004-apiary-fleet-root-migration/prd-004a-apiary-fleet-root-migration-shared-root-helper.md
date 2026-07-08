# PRD-004a: The shared fleet-root helper and doctor's own subdirectory

> **Status:** Draft
> **Parent:** [PRD-004: Apiary fleet-root migration](./prd-004-apiary-fleet-root-migration-index.md)
> **Priority:** P0
> **Effort:** M (3-8h)
> **Schema changes:** None (on-disk layout only)

---

## Overview

Introduce the single root-resolution helper ADR-0003 mandates ("every product resolves the root through one shared helper so the chain is identical everywhere") and move doctor's own runtime state under it. Doctor's per-product subdirectory is `~/.apiary/doctor/`, replacing the legacy workspace `~/.honeycomb/doctor` (`doctor/src/config.ts:154`).

Doctor is a zero-runtime-dependency codebase that mirrors, not imports, shared patterns across the process boundary, so "shared helper" here means one doctor-local module implementing the fleet-wide chain byte-for-byte; the other repos implement the same chain in their own parallel PRDs.

The resolution chain, in precedence order (ADR-0003 "The root is home-anchored, selectable, and never cwd"):

1. `APIARY_HOME` environment variable (which is also how the installer's `--home=` flag reaches doctor at runtime: the installer pins the resolved root into the service environment).
2. XDG on Linux: `$XDG_STATE_HOME/apiary` only when `$XDG_STATE_HOME` is explicitly set and non-blank; when unset, fall through to the home default (RESOLVED per fleet ADR-0003 "Resolved decisions", confirmed 2026-07-04; there is no `~/.local/state/apiary` default).
3. `<os.homedir()>/.apiary` everywhere else.

`process.cwd()` never participates at any step. This is the structural fix for the service-manager working-directory footgun ADR-0003 documents (state anchored on `os.homedir()` cannot land in `System32` or `/` via an inherited working directory).

---

## Goals

- One doctor-local module (for example `src/apiary-root.ts`) exporting the root resolution with injectable `env` and `home` seams, matching the hermetic-test pattern of `resolveConfig` (`doctor/src/config.ts:150-153`).
- Doctor's default workspace dir becomes `<root>/doctor` (today `~/.honeycomb/doctor`, `doctor/src/config.ts:154`); the `DOCTOR_WORKSPACE_DIR` env override (`doctor/src/config.ts:162,176`) keeps working unchanged.
- Everything that composes paths under the workspace dir follows automatically, and is verified to: the install lock `install.lock` (`doctor/src/install-lock.ts:12,114`), the staged schtasks task XML (`doctor/src/service/index.ts:214,263`), and the launchd log paths (`doctor/src/service/templates.ts:94,96`).
- A one-time, idempotent migration of doctor's own workspace files from `~/.honeycomb/doctor/` to `~/.apiary/doctor/` on first boot, with a legacy-fallback read until it completes.
- Built-ins only; the helper never throws (can't-crash posture).

## Non-Goals

- Relocating the fleet-shared files (registry, device id, install id): owned by [004b](./prd-004b-apiary-fleet-root-migration-coordination-surface.md).
- The default pid paths and the telemetry trusted roots: owned by [004c](./prd-004c-apiary-fleet-root-migration-supervision-continuity.md).
- The installer writing `APIARY_HOME` into service units, and the Windows LocalSystem install-time home capture: superproject installer work (module Non-Goals).

---

## User stories

- As a fleet administrator, I set `APIARY_HOME=/srv/apiary` once (or pass `--home=` at install) and all of doctor's state lands there.
- As a Linux user with `$XDG_STATE_HOME` set, doctor's state respects my XDG configuration without any doctor-specific setting.
- As an operator upgrading an existing install, doctor's first boot after upgrade moves my workspace (including the install lock location) without losing supervision state, and a second boot changes nothing.

---

## Proposed design

- `resolveApiaryRoot(env: NodeJS.ProcessEnv = process.env, home: string = homedir(), platform: NodeJS.Platform = process.platform): string` implementing the chain above. A set-but-empty or whitespace-only `APIARY_HOME` is treated as unset (mirroring `DOCTOR_WORKSPACE_DIR` handling at `doctor/src/config.ts:176`).
- `resolveConfig` (`doctor/src/config.ts:150`) builds `defaultWorkspace` as `join(resolveApiaryRoot(env, home), "doctor")` instead of `join(home, ".honeycomb", "doctor")` (`doctor/src/config.ts:154`).
- The workspace migration: on boot, if `<root>/doctor/` is absent (or empty of doctor artifacts) and `~/.honeycomb/doctor/` exists, move its files into the new location. The install lock is deliberately NOT migrated as a live file: a lock present in the legacy dir is honored by a legacy-fallback staleness check, and new acquisitions happen only at the new path (`doctor/src/install-lock.ts` already receives the workspace dir injected, so it follows `workspaceDir` with no code change beyond the fallback check).
- Migration failure of any individual file leaves that file in place (never delete a legacy file not successfully migrated) and doctor continues with the legacy-fallback read for it.

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| a-AC-1 | Given `APIARY_HOME` is set to a non-empty path, when the root is resolved, then that path wins over XDG and the default on every platform. |
| a-AC-2 | Given Linux with `$XDG_STATE_HOME` set and no `APIARY_HOME`, when the root is resolved, then it is `$XDG_STATE_HOME/apiary`. |
| a-AC-3 | Given no overrides, when the root is resolved, then it is `<os.homedir()>/.apiary`, and no code path reads `process.cwd()`. |
| a-AC-4 | Given a legacy workspace at `~/.honeycomb/doctor/` and no new workspace, when doctor boots, then the workspace files are migrated to `~/.apiary/doctor/` and subsequent writes (install lock, staged task XML, launchd logs) land only under the new path. |
| a-AC-5 | Given the migration already ran, when doctor boots again, then no file is moved, overwritten, or deleted (idempotent). |
| a-AC-6 | Given a legacy file that fails to migrate (for example a permissions error), when the migration runs, then the file is left in place, doctor reads it via the legacy fallback, and doctor does not crash. |
| a-AC-7 | Given `DOCTOR_WORKSPACE_DIR` is set, when config is resolved, then it wins over the new default exactly as it does today (`doctor/src/config.ts:176`). |

---

## Implementation notes

- Keep the helper dependency-free (`node:os`, `node:path` only) and total: any unexpected condition resolves to the home-anchored default, never a throw.
- Tests inject `env`, `home`, and `platform`; no real home directory or real `process.env` (matching the existing hermetic pattern in `config.ts` tests).
- The staged schtasks XML path is currently string-composed from `p.home` (`doctor/src/service/index.ts:214,263`); route it through the workspace dir (or the helper) rather than re-deriving `~/.honeycomb/doctor` inline, so there is exactly one place the subdirectory is spelled.

---

## Open questions

- [x] **Linux default when `$XDG_STATE_HOME` is unset**: RESOLVED per fleet ADR-0003 "Resolved decisions" (confirmed 2026-07-04): honor XDG only when `$XDG_STATE_HOME` is explicitly set; the unqualified default is `~/.apiary` uniform across all platforms. The ADR now carries the canonical `resolveFleetRoot` chain that all four repos implement identically; this PRD cites it rather than restating it.

---

## Related

- [`ADR-0003-fleet-directory-ownership-and-neutral-state-root`](../../../knowledge/private/architecture/ADR-0003-fleet-directory-ownership-and-neutral-state-root.md) - the resolution chain and layout this implements.
- [PRD-004b coordination surface](./prd-004b-apiary-fleet-root-migration-coordination-surface.md) and [PRD-004c supervision continuity](./prd-004c-apiary-fleet-root-migration-supervision-continuity.md) - both consume this helper.
- `honeycomb/src/cli/daemon-service.ts` - the existing XDG awareness ADR-0003 says the Linux precedence must align with (honeycomb's parallel PRD owns that side).
