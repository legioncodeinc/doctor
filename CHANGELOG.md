# Changelog

## v0.6.0 — 2026-07-14

Doctor's CLI now standardizes on the Apiary command contract: canonical `service-install`/`service-uninstall`, a new `logs`/`telemetry` surface, stable JSON output, and a verified `update` command with health-checked rollback, while keeping the previous commands available as deprecated aliases.

## Unreleased

- Standardize Doctor on the Apiary CLI contract: canonical `service-install` / `service-uninstall`, stable JSON envelopes, grouped Doctor branding, service-isolated `logs`, read-only `telemetry`, and shared exit codes.
- Preserve `install-service` / `uninstall-service` as deprecated aliases, preserve fleet incident records as `doctor incidents`, and preserve the former primary-daemon updater as `doctor daemon-update`.
- Make canonical `doctor update` update Doctor itself with pinned release resolution, restart/health verification, and rollback to the installed version on failed verification. `doctor self-update` remains a deprecated compatibility alias.

## v0.5.0 — 2026-07-12

Doctor now re-reads the daemon registry at runtime and automatically supervises newly registered daemons (or drops removed ones) without requiring a restart, fixing onboarding hangs where services registered after boot were never watched.

## v0.4.3 — 2026-07-08

Release accumulated changes since the last version.

