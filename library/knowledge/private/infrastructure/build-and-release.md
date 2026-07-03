# Build And Release

> Category: Infrastructure | Version: 1.0 | Date: July 2026 | Status: Active | Author: Mario Aldayuz

How the doctor package builds, why it ships with zero runtime dependencies, how the blessed-release auto-update engine keeps the fleet safe from a bad publish, and how the npm release pipeline works.

**Related:**
- [../operations/os-service-registration.md](../operations/os-service-registration.md)
- [../operations/auto-update-engine.md](../operations/auto-update-engine.md)
- [../architecture/system-overview.md](../architecture/system-overview.md)
- [../standards/zero-dependency-engineering.md](../standards/zero-dependency-engineering.md)
- [../telemetry/outbound-telemetry-and-privacy.md](../telemetry/outbound-telemetry-and-privacy.md)
- [../security/trust-boundaries.md](../security/trust-boundaries.md)
---

## The build: tsc plus esbuild, one file out

`npm run build` is two steps (`package.json` scripts): `tsc` emits modular ESM to `dist/` (with `rootDir: "."`, so the entry lands at `dist/src/cli/bin.js`), then `esbuild.config.mjs` bundles that single entry into `bundle/cli.js`, the `bin` target. The bundle is:

- `platform: "node"`, `format: "esm"`, Node >= 22.5 (`engines`).
- External: `node:*` only. Everything else reachable is first-party TypeScript, so it bundles in. The per-OS service unit templates are pure string builders in `src/service/templates.ts` and get bundled too; the published package carries no template assets.
- Shebang preserved from `src/cli/bin.ts`, mode stamped 0755, and an ESM marker `{"type":"module"}` package.json written beside the bundle.
- A `createRequire` banner shims any transitively bundled CJS `require`; belt-and-suspenders in a built-ins-only graph, but cheap.

The published tarball is four files by allowlist: `bundle/cli.js`, `bundle/package.json`, `README.md`, `LICENSE`. `npm run pack:check` (`scripts/pack-check.mjs`) verifies the payload, scans for forbidden/secret filenames, and confirms the bin is present before any cut.

### Version single-sourcing

esbuild reads this package's own `package.json` version and inlines it via `define` as `__DOCTOR_VERSION__`, so the shipped binary always reports exactly what was cut (`doctor --version`). Doctor versions independently of the root honeycomb package (PRD-063 OD-6); there is one manifest and no cross-manifest sync. The `typeof` guards in `src/version.ts` mean an un-bundled dev or test run (no `define`) falls through to an env/sentinel path, keeping `tsc --noEmit` and `vitest run` green without a bundle.

Two more tokens are defined at build time: `__HONEYCOMB_POSTHOG_KEY__` and `__HONEYCOMB_POSTHOG_HOST__`. An unset key compiles to the empty string, which the telemetry chokepoint treats as hard-disabled, so a local or fork build emits nothing. The key is a public write-only ingest key, embedded in the tarball by design; the CI secret only keeps it out of logs and fork PRs. No real key is ever committed to source.

## Why zero runtime dependencies

The policy is design principle 1 made concrete. Three reasons, in priority order:

1. **No supply chain to compromise.** A watchdog is a privileged, always-on, auto-started process. Every dependency is an author, a registry entry, and a postinstall hook you now trust with that position. Doctor trusts nobody: `dependencies` does not exist in its manifest.
2. **No dependency can take the watchdog down.** A native module with an ABI mismatch, a package that throws on import, a transitive breaking change: any of these would crash the process whose entire job is to not crash.
3. **Nothing to install means nothing to fail installing.** The single-file bundle plus Node built-ins works the moment the tarball unpacks, on all three OSes, with no postinstall step.

The gate every change must pass locally and in CI: `npm run ci` = `tsc --noEmit` + `vitest run`.

## The blessed-release auto-update engine

Doctor keeps the PRIMARY daemon (`@legioncodeinc/honeycomb`) current; it never auto-updates itself (`doctor self-update` is the only path that touches `@legioncodeinc/doctor`, AC-6). npm `@latest` alone is necessary but not sufficient: a 30-minute poll against raw `@latest` would fan a bad publish across the fleet in half an hour. So updates are gated on a blessed version.

**The gate.** `blessed-version.json` is a static object on the install CDN (`https://get.theapiary.sh/blessed-version.json`), flipped by a CI bless step gated on canary and smoke health. `fetchBlessedVersion` (`src/update/blessed-channel.ts`) is fail-closed: unreachable, non-2xx, timeout, or an unparseable body all resolve to "stay on the current version". Fetching the channel can never trigger an update; only a positively parsed blessed version can. The pure `decideUpdate` gate then requires installed < blessed, latest == blessed, no opt-out, no pin.

**The transaction.** `runUpdateTransaction` (`src/update/update-engine.ts`) approximates atomicity the only way npm allows: record the installed version as the rollback target, capture a pre-update health baseline, acquire the shared install lock (so it can never race rung 2's reinstall; lock held means skip), `npm i -g @legioncodeinc/honeycomb@<blessed>` pinned to the exact version, restart the daemon, verify `/health`. Healthy means done. A healthy-to-unhealthy regression rolls back: reinstall the recorded prior version, restart, re-verify, and emit the rollback telemetry event either way. A daemon that was already down before the update, or that has no supervised service to restart through, is NOT rolled back on a failed verify (the update cannot make an already-down daemon worse); that outcome is honestly labeled `updated_unverified`. Every version string is validated as strict semver before it is composed into an npm spec, so a spoofed `/health` version can never smuggle `latest` or a range into `npm install`.

**The cadence.** A 30-minute poll TTL with up to plus or minus 10 percent jitter (`src/update/poll-loop.ts`) so the fleet never stampedes npm or the CDN in lockstep. When auto-update is disabled (CLI flag > `HONEYCOMB_NO_AUTO_UPDATE` > persisted state > a pin at any layer), the loop never ticks at all: a disabled box does zero registry and CDN polling.

## The release pipeline

`.github/workflows/release.yaml` publishes `@legioncodeinc/doctor` from this repo on `v*` tags, with a manual `workflow_dispatch` that ALWAYS rehearses (`dry_run` defaults to true). Two jobs, deliberately split:

**Gate (read-only).** `npm ci`, the full `npm run ci` gate, `pack:check`, then the telemetry-keyed build (after pack-check on purpose, because pack-check's `prepack` rebuild is keyless and would otherwise overwrite the artifact). Two fail-closed guards: the pushed tag must equal `package.json`'s version, and the publishability preflight aborts on the `0.0.0` not-cut-yet sentinel or a name other than `@legioncodeinc/doctor`. The built `bundle/` is handed forward as an artifact.

**Publish (privileged, no repo code execution).** Downloads the gate-built bundle and runs `npm publish --provenance --access public --ignore-scripts`, so no third-party install/build/test code ever executes with the publish identity. Auth is tokenless npm Trusted Publishing: GitHub's short-lived OIDC identity (the `id-token: write` permission) is verified by npm against the trusted publisher configured on the package (org + repo + this workflow filename). There is no `NPM_TOKEN` anywhere. The workflow upgrades npm to >= 11.5.1 first (Node 22 bundles 10.x, which cannot do OIDC publishing) and strips setup-node's scaffolded dummy auth token so npm actually takes the OIDC path. An idempotency probe (`npm view <pkg>@<version>`) makes the publish tail rerunnable: an already-published version skips the upload and still mints the GitHub Release.

A real publish requires all three of: a `push` event, a tag ref `vX.Y.Z`, and not a dispatch dry run. The intent to publish is the tag, not a credential.

One housekeeping note: the `//version` comment in `package.json` still describes the version as "the 0.0.0 sentinel", which was true before the first cut; the actual version field is past 0.1.x and the sentinel now lives on only as the workflow's fail-closed guard. Trust the field and the workflow, not the comment.

## CI on every change

`.github/workflows/ci.yaml` runs the same `npm run ci` recipe as the release gate on pushes and PRs, deliberately WITHOUT the telemetry env vars: only the release pipeline bakes a real PostHog key, so no CI artifact from an ordinary run can ever emit. Dependency caching stays off on the release pipeline as cache-poisoning hardening; `npm ci` installs from the committed lockfile every time.

`pack:check` is the tarball conscience: it runs `npm pack --json` (which triggers `prepack`, itself a full build), then asserts the payload contains exactly the allowlisted files, that no secret-shaped or forbidden filename rode along, and that `bundle/cli.js` is present and executable. It runs on demand locally and always in the release gate.

## Cutting a release, the whole checklist

1. Land the change on `main` with `npm run ci` green.
2. Bump deliberately: `npm version <x.y.z>` (this is the single source of truth the bundle inlines).
3. Push the commit and the `v<x.y.z>` tag.
4. The gate job re-runs everything, checks tag == version, checks the name and the 0.0.0 sentinel, builds keyed, and uploads the bundle.
5. The publish job authenticates via OIDC, publishes with provenance, and mints the GitHub Release with generated notes.
6. Nothing to do for consumers: doctor never auto-updates itself, so installs pick the new version up on their next explicit `npm install -g` or `doctor self-update`.

Rehearse any of this without shipping via the workflow's manual dispatch; `dry_run` defaults to true, so the button is safe by default.

## Update and rollback outcomes, for dashboards

Every transaction resolves one of seven statuses (`UpdateTransactionStatus` in `src/update/update-engine.ts`), and the observable outcomes feed telemetry so fleet rollout health is measurable:

| Status | Meaning |
|---|---|
| `updated` | Installed and verified healthy on the new version |
| `updated_unverified` | Installed and kept; no healthy baseline or no supervised daemon to verify against |
| `rolled_back` | Post-update health failed; recovered on the prior version |
| `rollback_failed` | Post-update health failed AND the rollback did not recover |
| `install_failed` | The npm install itself failed |
| `no_update` | The gate declined (opt-out, pin, not blessed, already current, or a fail-closed read) |
| `skipped_lock_held` | Another installer (rung 2) held the shared lock |

## Developer loop

```bash
npm install          # dev deps only; the shipped package has zero runtime deps
npm run typecheck    # tsc --noEmit
npm run test         # vitest run
npm run ci           # the gate: typecheck + test
npm run build        # tsc + esbuild -> bundle/cli.js
npm run pack:check   # verify the publish payload
```

The repo is self-contained: its own `tsconfig.json` and `vitest.config.ts`, independent of any parent-repo gates. Cutting a release is `npm version <x.y.z>`, push the `v<x.y.z>` tag, and let the workflow do the rest.
