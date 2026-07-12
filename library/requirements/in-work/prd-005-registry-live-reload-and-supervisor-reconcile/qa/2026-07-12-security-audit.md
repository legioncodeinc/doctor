# Security Audit — PRD-005 Registry Live-Reload & Supervisor Reconcile

- **Auditor:** security-worker-bee
- **Date:** 2026-07-12
- **Branch:** `feat/prd-005-registry-live-reload`
- **Repo:** `doctor` (git submodule of the-apiary) — a zero-runtime-dependency, can't-crash Node/TS watchdog
- **Scope:** the PRD-005 diff only — `src/registry-reload.ts` (new), `src/registry-reconcile.ts` (new), `src/compose/index.ts` (modified), `src/config.ts` (modified), read against the trust-boundary gates in `src/registry.ts` and the ingestion reload in `src/ingestion/poll-loop.ts`.
- **Result:** **CLEAN — 0 Critical, 0 High.** 3 Low (documented; 1 hardened via a regression test), 1 informational.

> NOTE ON STINGER FIT: my paired Stinger is Hivemind-tuned (Deep Lake SQL injection, MCP pre-tool-use gate, embeddings, npm/OpenClaw supply chain). Doctor has **none** of that surface — no Deep Lake, no SQL, no MCP server, no network server beyond a loopback status page, no captured-trace PII tables, no credentials on disk. The Hivemind-specific catalog items were checked for applicability and found **N/A**. This audit applies the general OWASP / secure-coding methodology scoped to doctor's actual threat model (poisoned external registry → SSRF / arbitrary-file-read / DoS / crash of the watchdog).

---

## Executive summary

PRD-005 makes doctor **re-read its supervised-daemon registry at runtime** (mtime-gated, interval-bounded) and **reconcile** the live supervisor set to match — the registry being an **external, untrusted input written by product installers**. The headline risk (threat model #1) is a *reload regression*: that the runtime re-read might trust a field that the boot-time read would have rejected, turning a tampered registry into a probe-SSRF, arbitrary-file-read, or arbitrary-file-write primitive without a reboot.

That risk is **not realized.** The reload trigger resolves entries through the exact same production function boot uses — `resolveRegistryEntries()` → `readRegistryFile()` → `parseEntry()` → the field coercions (`coerceHealthUrl`, `coerceTelemetryDbPath`, `coercePidPath`, `coerceName`). There is no alternate parse path and no bypass. The reconciler performs **no filesystem writes and sends no process signals**: removal calls only `supervisor.stop()` (sets a boolean flag) and the poll loop's `closeHandle()` (closes a read-only SQLite handle — never `unlink`). Every new async seam swallows all exceptions, preserving the can't-crash invariant. No new log line or needs-attention record emits a secret (the registry carries no secrets by construction).

I added **one test-only regression test** (zero runtime-code change) that drives the reload loop through its **real** production resolver over a poisoned on-disk registry, asserting the loopback SSRF gate and the telemetry path-containment gate both hold on the reload path — locking in the property that is today only guaranteed by code review.

- `npm run ci` (typecheck + vitest): **GREEN — 69 files, 832 tests** (was 831; +1 my test).
- `package.json` dependencies: **`{}`** (unchanged).

---

## Threat-model coverage (audited against doctor's real surface)

### 1. Reload must re-run the boot input coercions (no bypass) — the flagged HIGH-risk case → **PASS**

`src/registry-reload.ts:125-128` — the loop's default resolver is `() => resolveRegistryEntries({ home, env, platform })`, the identical function boot's `resolveDaemons` calls (`src/compose/index.ts:312`). The reload loop in the composition root is constructed with the **same trust anchors** as boot — `home` (`options.home ?? homedir()`), `env` (`options.env ?? process.env`), `platform: process.platform` (`src/compose/index.ts:489-500`, `src/registry-reload.ts` wiring at `src/compose/index.ts:876-880`). No widening of the telemetry trusted-root or pid-default derivation.

The coercions that therefore run on **every** reload:
- **SSRF gate** — `coerceHealthUrl` (`src/registry.ts:211-223`): rejects non-http(s) schemes and any non-loopback hostname (`LOOPBACK_HOSTNAMES`), falling back to the safe loopback default. A post-boot registry write pointing `healthUrl` at `169.254.169.254` (cloud link-local metadata) or any off-box origin is neutralized before the reconciler ever builds a probe for it.
- **Path containment** — `coerceTelemetryDbPath` (`src/registry.ts:259-293`): requires an **absolute** post-tilde path under a trusted root (`<root>/<own-name>/telemetry` or the legacy honeycomb window root) via `assertWithinBase`; a traversal / out-of-bounds path degrades to `undefined` (= "health-probe only"), so the poll loop never opens an arbitrary user-readable SQLite file.
- `coerceName` (filename-safe token, fail-loud) and `coercePidPath` (tilde-expand) also re-run.

**Regression proof added:** `tests/registry-reload.test.ts` → new describe *"reload re-runs the boot input coercions"* boots the loop with **no injected seams** (real `node:fs` stat + real `resolveRegistryEntries`) over a temp registry carrying `healthUrl: http://169.254.169.254/health` + a containment-escaping `telemetryDbPath`, and asserts the reconciler receives `healthUrl === http://127.0.0.1:3850/health` and `telemetryDbPath === undefined`.

### 2. Poisoned registry must not become a write / signal primitive via reconcile → **PASS**

`reconcileSupervisors` (`src/registry-reconcile.ts`) performs **no I/O of its own**. Its only effects are `buildDaemon()`, `supervisor.armStartupGrace()`, `armDaemon()`, `supervisor.stop()`, and `updateTelemetryEntries()`.
- **REMOVE** (`src/registry-reconcile.ts:135-152`) calls only `built.supervisor.stop()` → `src/supervisor.ts:374-376` sets `stopped = true`. It **never** signals or kills the daemon process (there is **no** `process.kill` anywhere in `src/`), and it **never** deletes the entry's `state-<name>.json` / `incidents-<name>.ndjson` shards (the module touches no filesystem).
- The telemetry-loop update drops handles via `closeHandle()` (`src/ingestion/poll-loop.ts:155-163`) — a read-only `db.close()`, never `unlink`/`rm`. A removed daemon's on-disk telemetry file is left intact.
- `pidPath` is consumed only by `defaultReadDaemonPid` (`src/compose/index.ts:131-139`) which `readFileSync`s the file and reduces it to a single parsed positive integer (or `null`); that integer feeds only rung-1's "lock-held-and-healthy → skip restart" guard (`src/remediation.ts:147-151`) and a debug log. It is never passed to a signal. (See Low-1 for the containment gap; impact is bounded to an integer oracle, no content exfiltration, no signal.)

### 3. Denial of service / resource exhaustion → **PASS (bounded)**

- **Reload churn is interval-gated.** `loop()` (`src/registry-reload.ts:234-240`) sleeps `intervalMs` between ticks; each tick does at most one re-resolve. A registry that flaps its mtime rapidly still costs at most one `stat`×2 + one parse per interval. The interval knob (`DOCTOR_REGISTRY_RELOAD_INTERVAL_MS`) is parsed by `parsePositiveInt` (`src/config.ts:110-114`): `0`, negative, `NaN`, and garbage all fall back to the 2000 ms default — **no busy-spin is reachable** from a bad value.
- **Malformed-file re-read is bounded** to once per interval and the log + needs-attention record is de-duplicated per distinct `(path + reason)` (`src/registry-reload.ts:215-232`).
- **No crash-loop.** See #4.

### 4. Can't-crash invariant as a security property → **PASS**

`tick()` wraps the whole cycle in try/catch (`src/registry-reload.ts:155-208`); each consumer hook (`onEntries`/`onProblem`/`onRecovered`) is individually try/caught; `arm()` attaches a defense-in-depth `run.catch` (`src/registry-reload.ts:251-256`); and `reconcileSupervisors` isolates every per-entry `buildDaemon`/`stop`/`arm` fault so one bad entry cannot abort the reconcile or crash doctor (`src/registry-reconcile.ts:141-227`, b-AC-10). A crafted registry cannot crash-loop the watchdog. Covered by existing tests a-AC-9 and the compose AC-5/AC-8 case (never-throws on garbage bytes).

### 5. Info disclosure → **PASS**

Registry entries carry a name, a loopback URL, and filesystem paths — **no secrets**. The new log lines and the needs-attention record (`src/compose/index.ts:882-899`) embed only the registry path and a parse-error reason string. No token, JWT, org id, or credential exists in this process to leak, and none is introduced. (doctor has no credentials file, no auth headers, no captured-trace PII tables.)

---

## Findings

| # | Severity | File:Line | Scenario | Status |
|---|----------|-----------|----------|--------|
| 1 | Low | `src/registry.ts:226-229` (`coercePidPath`) | `pidPath` lacks the `assertWithinBase` containment that `telemetryDbPath` has, so a poisoned registry can point it at any absolute path; `defaultReadDaemonPid` (`src/compose/index.ts:131-139`) `readFileSync`s it. **Impact is bounded to an integer/`null` oracle** — the raw content is never reflected (only a parsed positive-integer PID reaches a debug log) and the value is never passed to a signal (`process.kill` appears nowhere). Pre-existing at boot; reload gives it post-boot reachability at **parity** with boot (boot does not reject it either), so it is **not a reload regression**. | Documented — recommend follow-up |
| 2 | Low | `src/registry.ts:379-387` (`readRegistryFile`) | No upper bound on the `daemons` array length; each entry yields one supervisor loop + ladder + telemetry handle. A local actor who can write the registry can force N supervisors. Pre-existing at boot; reload makes it re-triggerable without a reboot. Each entry's fields are still coerced to safe values, and registry-write already requires local FS privilege. | Documented — recommend a sanity cap |
| 3 | Low | `src/compose/index.ts:696-706` (`armDaemon`) | Under sustained add/remove reload churn, `supervisorRuns` accumulates settled (resolved) run-promises — they are pushed on each add but never spliced on removal (only re-seeded in `start()`). Unbounded growth of tiny settled-promise references; negligible memory at the 2 s interval; correctness/hygiene rather than a practical DoS. **PR-introduced** (`armDaemon` is new in this PR). | **Fixed in this PR** — self-splice on settle |
| 4 | Info | `src/compose/index.ts:872-874` vs `:310-312` | The reload loop always watches the two-location default+legacy paths and ignores an injected `options.registryPath` single-file override, whereas boot honors it. A test/operator-override-seam inconsistency (functional, not security). Flag for `quality-worker-bee`. | Documented |

**Remediation performed:** no Critical/High. Scope + disposition are per-finding, not blanket:

- **Finding 3 (Low, `armDaemon`) is PR-introduced** — `armDaemon` and runtime reconcile churn are new in this PR — and has been **remediated in this PR**: the run-promise now self-splices from `supervisorRuns` on settle (`.finally`), so the join list cannot grow unbounded under add/remove churn.
- **Findings 1–2 (Low) are pre-existing at boot** and bounded behind local-filesystem write privilege; reload reaches them only at parity with boot. A containment fix for #1 (`coercePidPath`) and a cap for #2 (`daemons.length`) touch the shared boot parse path (wider blast radius than the PRD-005 diff) and are recommended as a scoped follow-up rather than folded into this review.
- **Finding 4 (Info)** is a functional test-seam note handed to `quality-worker-bee`, which judged it acceptable (the reload signature is mandated by a-AC-3; production never injects `registryPath`).

Also applied following the CodeRabbit review: the UPDATE path in `registry-reconcile.ts` now **builds the replacement before stopping the old supervisor**, so a throwing `buildDaemon` leaves the current (still-running) supervisor and the primary reference intact instead of stranding a stopped-but-referenced daemon (b-AC-10 strengthened; two regression tests added).

---

## Category checklist (each explicitly checked)

- SQL / query injection: **N/A** (no database, no query layer in doctor).
- SSRF via external input: **Checked — gated** (`coerceHealthUrl` loopback-only, re-run on reload; regression test added).
- Path traversal / arbitrary-file-read: **Checked — gated** (`coerceTelemetryDbPath` `assertWithinBase`, re-run on reload; `pidPath` bounded — Low-1).
- Arbitrary-file-write / process signal via reconcile: **None detected** (reconcile does no I/O; `stop()` sets a flag; no `process.kill`).
- Command injection: **None detected** (no shell/exec introduced by the diff).
- Denial of service / resource exhaustion: **Checked — bounded** (interval-gated; safe interval parse; entry-count Low-2).
- Crash / can't-crash violation: **None detected** (all seams swallow exceptions).
- Secret / credential / token exposure: **None detected** (no secrets in this process or the registry).
- PII in logs / captured traces: **N/A** (doctor stores no PII / captured traces).
- Prototype pollution via JSON parse: **Checked — not exploitable** (`parseEntry` reads only known own-property keys off the parsed object into a fresh typed entry; no recursive merge / no `__proto__` assignment).
- Supply chain / dependencies: **Checked — clean** (`dependencies: {}`; diff adds no imports beyond Node built-ins + intra-repo modules).

---

## Verification

```text
npm run ci      → typecheck PASS; vitest 69 files / 834 tests PASS
package.json    → "dependencies": {}   (unchanged)
audit change    → tests/registry-reload.test.ts  (the audit's own change: test-only reload input-coercion regression, zero runtime-code delta)
review changes  → src/registry-reconcile.ts + src/compose/index.ts (Low-3 self-splice + build-before-stop) with tests/registry-reconcile.test.ts (+2 regressions), applied post-audit per CodeRabbit review
```

## Recommended follow-ups (out of scope for this review's minimal diff)

1. **Low-1** — apply `assertWithinBase`-style containment to `coercePidPath` (bind to `<root>/<name>` + legacy honeycomb window root), mirroring `coerceTelemetryDbPath`, so `pidPath` cannot name an arbitrary file even as an integer oracle. Touches the boot parse path; needs its own test for the legacy-fallback pid case.
2. **Low-2** — add a sanity cap on `daemons.length` in `readRegistryFile` (e.g. reject / truncate beyond a generous ceiling) to bound supervisor fan-out from a pathological registry.
3. **Low-3** — ✅ **DONE in this PR**: settled run-promises now self-splice out of `supervisorRuns` on settle (`.finally` in `armDaemon`), eliminating the unbounded growth under churn.
4. **Info** — reconcile the reload-loop path source with boot's `options.registryPath` override so an operator single-file override is watched by reload too (assessed by `quality-worker-bee` as acceptable: the reload signature is mandated by a-AC-3 and production never injects `registryPath`).

## Ordering note

Security review ran **before** quality review, as required. The subsequent quality pass is recorded in `qa/2026-07-12-qa-report.md` (final QA: PASS, all 28 ACs VERIFIED).
