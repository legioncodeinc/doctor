---
ai_description: |
  This folder contains internal engineering and business documentation.
  ADRs MUST live in architecture/ADR-<n>-<kebab-slug>.md.
  Engineering standards MUST live in standards/documentation-framework.md.
  Other domain folders (<domain>/) are repo-specific and may be created as
  needed (ai/, auth/, data/, frontend/, infrastructure/, integrations/,
  marketing/, operations/, personas/, reporting/, roadmap/, scanners/,
  security/, strategy/, etc.).
  Do NOT file customer-facing content here (that goes in knowledge/public/).
  Write path: library/knowledge/private/<domain>/<kebab-slug>.md.
human_description: |
  Internal engineering and business documentation.
  - architecture/: Architecture Decision Records (ADRs)
  - standards/: Documentation framework and coding standards
  - <domain>/: Any repo-specific knowledge domain (ai/, auth/, data/, etc.)
  Default landing zone for any doc that does not need to be customer-facing.
  When creating a new domain folder, add a README.md explaining what belongs.
---

# Knowledge — Private

Internal documentation for engineers, product, and AI agents.

## Document index

Start with the system overview, then follow the domain you are working in.

### architecture/

| Doc | What it covers |
|---|---|
| [system-overview.md](./architecture/system-overview.md) | Why doctor exists, the four design principles, fleet topology, zero-dependency commitment, provenance |
| [supervision-and-remediation.md](./architecture/supervision-and-remediation.md) | The watch loop, 4-kind health classification, startup grace, the repair ladder, backoff, incidents, a worked episode |
| [telemetry-single-source-of-truth.md](./architecture/telemetry-single-source-of-truth.md) | The ADR-0001/0002 pipeline: services write SQLite, doctor polls and owns the fleet model, one SSE stream to hive; Contracts A/B/C |
| [ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md](./architecture/ADR-0001-hive-telemetry-transport-and-single-source-of-truth.md) | The locked telemetry-transport decision |
| [ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md](./architecture/ADR-0002-service-registration-static-registry-plus-runtime-sqlite.md) | The locked two-layer registration decision |

### data/

| Doc | What it covers |
|---|---|
| [registry-and-state.md](./data/registry-and-state.md) | Full doctor.daemons.json schema with every field/default/coercion, state.json, incidents.ndjson, needs-attention.json, complete telemetry SQLite DDL |

### operations/

| Doc | What it covers |
|---|---|
| [status-page-and-cli.md](./operations/status-page-and-cli.md) | The :3852 endpoints, the real CLI verb table, env var overrides, runbook |
| [os-service-registration.md](./operations/os-service-registration.md) | launchd/systemd/schtasks specifics, exact commands, unit contents, legacy hivedoctor migration |

### infrastructure/

| Doc | What it covers |
|---|---|
| [build-and-release.md](./infrastructure/build-and-release.md) | tsc + esbuild bundle, version injection, zero-dep policy, blessed-release auto-update engine, the OIDC npm release pipeline |

### security/

| Doc | What it covers |
|---|---|
| [trust-boundaries.md](./security/trust-boundaries.md) | Loopback-only surfaces, the untrusted registry, telemetryDbPath containment, credential non-touch policy, scrubbed telemetry and opt-outs |

Customer-facing companion: [../public/overview/overview.md](../public/overview/overview.md).

## Required sub-folders (always present)

| Folder | Contents |
|---|---|
| `architecture/` | ADRs: `ADR-<n>-<kebab-slug>.md`. Locked decisions with context, alternatives, consequences. |
| `standards/` | `documentation-framework.md` and any repo-specific writing rules. |

## Optional domain folders

Create any of these as needed: `ai/`, `auth/`, `data/`, `frontend/`, `infrastructure/`, `integrations/`, `marketing/`, `operations/`, `personas/`, `reporting/`, `roadmap/`, `scanners/`, `security/`, `strategy/`, `reference/`, `<product>-ux-ui/`.

## What does NOT belong here

- Customer-facing content (put in `knowledge/public/`)
- PRDs or IRDs (put in `requirements/` or `issues/`)
- Brand assets (put in `legion-shared/brands/`)
