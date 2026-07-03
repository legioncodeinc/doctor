# PRD-003 Out-of-Scope Discoveries

> **PRD:** `prd-003-doctor-boot-grace-release-blocker` (formerly honeycomb PRD-067)
> **Discovered during:** Package-specific local live proof on 2026-06-29
> **Disposition:** Accepted into scope as AC-11 on 2026-06-29.

## OOS-1: Second Doctor `run` Can Exit Early When Status Port Is Already Bound

**Observation**

During package live testing, an older local `node bundle/cli.js run --no-auto-update` process was already listening on `127.0.0.1:3852`, the fixed Doctor status-page port.

When the test launched a second packaged `doctor run`, the status page could not bind. The status-page server correctly swallowed the bind failure, but the remaining long-running timers are unref'ed. With no referenced handle keeping the process alive, the second process could exit before it reached the first healthy tick.

**Original Scope Assessment**

This PRD is scoped to boot grace behavior once the supervisor is running:

- suppress remediation during the startup grace;
- keep the probe timeout short;
- resume normal remediation after grace;
- re-arm grace after successful restarts.

The fixed status-page port / duplicate Doctor process lifecycle behavior is adjacent operational hardening, not required for the boot-grace acceptance criteria.

The user accepted this into scope after review, so it is tracked in the honeycomb execution ledger as AC-11.

**Why It May Matter**

This can affect local manual tests and may affect real installs if:

- an older Doctor process is already running;
- the service manager starts a second instance instead of replacing the first;
- another process occupies `127.0.0.1:3852`;
- status-page bind failure leaves no referenced handles after startup.

**Resolution**

Both mitigations shipped with AC-11: `DOCTOR_STATUS_PAGE_PORT` env/config support so tests and operators can choose another loopback port, and a process-level keepalive handle for `run` so Doctor remains alive even when the status page cannot bind.
