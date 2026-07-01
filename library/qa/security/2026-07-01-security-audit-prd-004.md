# Security Audit - PRD-004a / PRD-004b (multi-daemon registry, N supervisors, status `daemons[]`, CLI multi-daemon)

- **Date:** 2026-07-01
- **Auditor:** security-worker-bee
- **Repo:** hivedoctor (`@legioncodeinc/hivedoctor@0.1.10`)
- **Branch:** `feature/prd-004a-004b-multi-daemon-status` (worktree `the-apiary-hivedoctor-004`)
- **Scope:** the PRD-004a/004b diff only (registry loader, per-daemon state/incident shards, N supervisors + per-entry probe, status page `daemons[]`, CLI `status` / `logs --daemon`).

## Executive summary

hivedoctor is a zero-runtime-dependency, "can't-crash" watchdog. It has NO Deep Lake, NO MCP server, NO pre-tool-use VFS gate, and NO captured traces, so the Stinger's Hivemind-specific catalogs (Deep Lake SQL injection, the pre-tool-use gate, trace PII, prompt injection) DO NOT APPLY. The audit was adapted to hivedoctor's real attack surface: the registry `healthUrl` probe (SSRF), the daemon `name` -> file-path flow (path selection), the loopback status page, and information leakage.

Two findings were remediated in place (1 High, 1 Medium). Two Low findings are documented as accepted risk. Three surfaces reviewed clean. The gate is green after remediation (typecheck clean, 522 tests pass, build clean); no runtime dependency was added.

| # | Severity | Title | Status |
|---|----------|-------|--------|
| 1 | High | SSRF: registry `healthUrl` not restricted to loopback before probing | Remediated |
| 2 | Medium | CLI `logs --daemon <name>` not validated against the registry | Remediated |
| 3 | Low | Per-shard file permissions under `~/.honeycomb` use default modes | Accepted risk |
| 4 | Low | Registry read has no symlink/TOCTOU hardening | Accepted risk |
| - | Clean | Loopback-only status page bind (127.0.0.1, no CORS, no mutation, no proxy) | Verified |
| - | Clean | Information leakage (status page + CLI expose no `healthUrl`/`pidPath`/paths/secrets) | Verified |
| - | Clean | Path traversal via registry `name` (charset-validated + `resolveInBase` containment) | Verified |

---

## Finding 1 - SSRF via registry `healthUrl` (High) - REMEDIATED

**Location:** `src/registry.ts` `coerceHealthUrl` (probed in `src/compose/index.ts` `buildDaemon`, ~line 513-514).

**Description.** The registry file `~/.honeycomb/hivedoctor.daemons.json` is an external input written by installers. Each entry's `healthUrl` is fetched by every per-daemon supervisor on a timer (`probeHealth({ healthUrl: entry.healthUrl })`) and the daemon's reachability is reflected on the loopback status page. Before remediation, `coerceHealthUrl` validated only the URL scheme (http/https) and accepted ANY host. A tampered registry (or a malicious installer) could set a non-loopback `healthUrl` (e.g. `http://169.254.169.254/...` or an external host), turning the watchdog into a server-side-request-forgery primitive that fetches an attacker-controlled origin from the user's machine repeatedly. This is the same vulnerability class the-hive found and fixed as High (its `isLoopbackBaseUrl` gate on daemon bases; PRD-001 security remediation).

**Severity rationale.** SSRF from a persisted external file that is fetched automatically on a timer, with the result surfaced on a local HTTP page. High.

**Remediation.** Added a loopback allow-list (`LOOPBACK_HOSTNAMES = {127.0.0.1, localhost, ::1, [::1]}`, mirroring the-hive's `isLoopbackBaseUrl`) and gated `coerceHealthUrl` on it: a non-loopback host silently falls back to the safe loopback default (`DEFAULTS.healthUrl`) rather than ever being probed. This preserves the module's defensive "fall back, never crash" posture and adds no runtime dependency (node `URL` built-in only).

**Tests (`tests/registry.test.ts`):**
- non-loopback IP `healthUrl` (`169.254.169.254`) falls back to the loopback default;
- external hostname `healthUrl` (`evil.example.com`) falls back to the loopback default;
- loopback `healthUrl`s (`127.0.0.1`, `localhost`, `[::1]`) are accepted unchanged.

---

## Finding 2 - CLI `logs --daemon <name>` not validated against the registry (Medium) - REMEDIATED

**Location:** `src/cli/incidents-tail.ts` `createIncidentsTail` (invoked from `src/cli/dispatch.ts` `runLogs`).

**Description.** `hivedoctor logs --daemon <name>` takes an arbitrary CLI string and interpolates it into the shard filename `incidents-<name>.ndjson`. Actual path traversal is already contained by `resolveInBase` (a `..`/separator segment throws `PathContainmentError`, which is caught and degrades to an empty list), so no read escapes the workspace dir today. However, the requested defense-in-depth control - that `--daemon` accept only names that exist in the registry, not arbitrary strings used directly in a path - was missing: an unregistered/path-shaped name was interpolated directly and silently returned an empty list rather than being rejected.

**Severity rationale.** Real filesystem traversal is already blocked by `resolveInBase`, so this is an input-validation / defense-in-depth gap (unvalidated CLI input reaching a path template) rather than an exploitable traversal. Medium; remediated because the fix is small and Medium+ is in scope.

**Remediation.** `createIncidentsTail` now rejects a `--daemon <name>` that is not a member of the registry name list (the names it is already constructed with) by throwing a clear error; the dispatcher's existing try/catch maps it to a non-zero exit. Registry names are themselves validated filename-safe at parse time (`coerceName`, `/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/`), so membership implies path safety. The all-daemon path and the missing-file path remain fail-soft (empty list); only invalid input throws. No runtime dependency added.

**Tests (`tests/cli/incidents-tail.test.ts`):**
- an unregistered `--daemon` name (`hivenectar` not in registry) is rejected with `unknown daemon "..."`;
- a path-traversal `--daemon` name (`../../etc/passwd`) is rejected rather than selecting a file;
- a registered daemon's shard is still read normally.

---

## Finding 3 - Per-shard file permissions use default modes (Low) - ACCEPTED RISK

**Location:** `src/state.ts` (`state-<name>.json`), `src/incidents.ts` (`incidents-<name>.ndjson`).

**Description.** The per-daemon shards are written with `writeFileSync` / `appendFileSync` default modes (no explicit `0600`), under `~/.honeycomb`. This exactly matches the pre-existing single-daemon posture (`state.json`, `incidents.ndjson` were always written with default modes); PRD-004a only shards the same files by name, so there is no regression. The shard contents are secret-free by design (coarse health, remediation rungs, secret-free incident step details) - no credentials or tokens are written. On the target OSes the files live in a user-owned home directory.

**Decision.** Accepted risk (Low). Do not regress; a future hardening pass could set restrictive modes on all `~/.honeycomb` artifacts uniformly, but that is out of this branch's scope and the data is non-sensitive.

## Finding 4 - Registry read has no symlink/TOCTOU hardening (Low) - ACCEPTED RISK

**Location:** `src/registry.ts` `readRegistryFile`.

**Description.** The registry file is read with a single `readFileSync` (no `O_NOFOLLOW`, no realpath check). An attacker who can already write `~/.honeycomb/hivedoctor.daemons.json` (or symlink it) is inside the user's own trust boundary. Content-level tampering is the real risk, and that is now defended by the loopback `healthUrl` guard (Finding 1) and the filename-safe `name` guard. There is no privileged read here (hivedoctor runs as the user).

**Decision.** Accepted risk (Low). Symlink/TOCTOU hardening is disproportionate for a user-owned config file whose dangerous content vectors are already validated.

---

## Verified-clean surfaces

- **Loopback-only status page** (`src/status-page/server.ts`): binds `LOOPBACK = "127.0.0.1"` only (never `0.0.0.0`); serves only `GET /` and `GET /status.json`; no CORS headers, no mutation routes, no proxying/callout to daemons; `Cache-Control: no-store`; handler errors return a generic 500. Unchanged and correct.
- **Information leakage** (`src/status-page/server.ts`, `src/compose/index.ts` `readDaemonStatusRows`, `src/cli/dispatch.ts` `runStatus`): the `daemons[]` payload exposes only `name` / `health` / `escalation`; `healthUrl` and `pidPath` are never emitted. All interpolated HTML values pass through `escapeHtml`. 404/500 bodies are generic. CLI `status` prints daemon name, coarse health, version, and last-heal - no absolute paths, no secrets. Incident `detail` is secret-free by design.
- **Path traversal via registry `name`** (`src/registry.ts` `coerceName` + `src/safe-path.ts` `resolveInBase`): `name` is charset-validated to `/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/` (no dots/slashes) and fails loud otherwise; state/incident writes additionally route through `resolveInBase` containment. Defense in depth intact.

## Gate status after remediation

Run from `c:\Users\mario\GitHub\the-apiary-hivedoctor-004`:

- `npm run typecheck` - clean (tsc --noEmit, exit 0).
- `npm test` - **522 passed / 51 files** (516 baseline + 6 new security tests), exit 0.
- `npm run build` - clean (`tsc && esbuild`, bundle emitted), exit 0.

No runtime dependency was added; both fixes use Node built-ins only, preserving the zero-dependency can't-crash posture.

## Files changed

- `src/registry.ts` - loopback allow-list + loopback gate in `coerceHealthUrl` (Finding 1).
- `src/cli/incidents-tail.ts` - registry-membership guard on `--daemon <name>` (Finding 2) + module doc note.
- `tests/registry.test.ts` - 3 SSRF tests.
- `tests/cli/incidents-tail.test.ts` - 3 `--daemon` validation tests.
