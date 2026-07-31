<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- scentic-agpl-services — GCloud deployment manifests and reference configs -->

# GCloud Deployment (Manifests and Reference Configs Only)

> **Status:** MANIFESTS AND REFERENCE CONFIGS ONLY. Not deployed. No production GCP project has been provisioned.
>
> **Warning:** **Do not deploy until authorized by the project owner.** The manifests and commands in this directory are reference material for a future production deployment of the Scentic AGPL services gateway to Google Cloud. They have not been executed against a live GCP project. Running them will create billable cloud resources and may expose internal services if networking is misconfigured.

---

## 1. Purpose

This directory contains **deployment manifests and reference configuration** for running the Scentic AGPL gateway on Google Cloud Platform (GCP). It is **not** a deployment execution guide. The files here are:

- `cloud-run-gateway.yaml` — Cloud Run service manifest for the gateway.
- `secret-manager.md` — Secret Manager secret inventory and creation commands (reference).
- `service-accounts.md` — Least-privilege service account setup (reference).
- `vpc-networking.md` — VPC connector and private networking reference.
- `deploy-commands.md` — Reference `gcloud` commands (do not execute without authorization).

All files are documentation/manifest only. They are reviewed for correctness and security posture, not executed.

## 2. Target architecture

```
                ┌──────────────────────────────────────────────────────────────┐
                │  GCP Project: scentic-agpl-prod  (NOT YET PROVISIONED)       │
                │                                                              │
                │   ┌────────────────────────────────┐                         │
                │   │  AGPL Gateway                  │                         │
                │   │  Cloud Run (internal-only)     │                         │
                │   │  Node.js 20 / Express          │                         │
                │   │  Port 3101, /health probe      │                         │
                │   │  Min 1 / Max 3 instances       │                         │
                │   │  1 vCPU, 512MiB                │                         │
                │   └───┬──────────────────────┬─────┘                         │
                │       │                      │                              │
                │       │ VPC connector        │ VPC connector                 │
                │       ▼                      ▼                              │
                │   ┌─────────────┐      ┌──────────────────┐                 │
                │   │ Kimai       │      │ OpenSign Server  │                 │
                │   │ (Cloud Run  │      │ (Cloud Run / GCE)│                 │
                │   │  or GCE)    │      │                  │                 │
                │   └──────┬──────┘      └────┬─────────┬───┘                 │
                │          │                  │         │                     │
                │          ▼                  ▼         ▼                     │
                │   ┌─────────────┐    ┌──────────┐  ┌────────────┐           │
                │   │ Cloud SQL   │    │ MongoDB  │  │  GCS       │           │
                │   │ Postgres    │    │ (Atlas / │  │  Bucket    │           │
                │   │ (gateway +  │    │  GCE)    │  │ (OpenSign  │           │
                │   │  Kimai*)    │    │          │  │  files)    │           │
                │   └─────────────┘    └──────────┘  └────────────┘           │
                │                                                              │
                │   Secrets: Cloud Secret Manager (least-priv per service)     │
                │   Logging: Cloud Logging                                     │
                │   Monitoring: Cloud Monitoring + Uptime checks               │
                └──────────────────────────────────────────────────────────────┘
```

- **Gateway** — Cloud Run, internal-only ingress, min instances 1 (avoid cold starts on internal calls), max 3, 1 vCPU, 512MiB. The gateway itself is stateless; durable state (mappings, nonce, outbox) is backed by Cloud SQL Postgres in production (see `docs/DEPLOYMENT.md` and the storage section of `docs/AGPL_04_CLOSEOUT.md`). SQLite is supported for single-instance dev/local only and is rejected in production unless explicitly overridden (not recommended).
- **Cloud SQL Postgres** — production durable store for the gateway (mapping, nonce, outbox tables) and optionally Kimai. Private IP in the AGPL VPC. HA regional for production.
- **Secret Manager** — every secret is stored and accessed via Secret Manager; no secrets in env files or images. See `secret-manager.md`.
- **VPC** — a VPC connector lets Cloud Run reach Kimai, OpenSign, Cloud SQL (private IP), and MongoDB over private networking. See `vpc-networking.md`.

> \* Kimai upstream targets MySQL/MariaDB. Cloud SQL Postgres here is the gateway durable store. Kimai database provisioning is documented in `docs/DEPLOYMENT.md` §3.2.

## 3. Prerequisites (informational only — do not provision without authorization)

- A GCP project (working name `scentic-agpl-prod`) with billing enabled.
- `gcloud` CLI installed and authenticated with an account that can create projects, VPCs, Cloud Run services, Cloud SQL instances, Secret Manager secrets, and IAM bindings.
- A container image of the gateway pushed to Artifact Registry in the target project (placeholder: `gcr.io/PROJECT_ID/scentic-agpl-gateway:TAG`).
- VPC peering or an Internal Load Balancer route from the Scentic core project to the AGPL project (see `docs/DEPLOYMENT.md` §4).

## 4. Cost considerations (reference)

| Item | Driver | Notes |
|---|---|---|
| Cloud Run (gateway) | Requests + vCPU-sec + GiB-sec | Min-instances=1 keeps a small always-on cost. Max=3 caps autoscale spend. |
| Cloud SQL Postgres | Always-on tier + storage | HA regional roughly doubles compute cost. Single-zone acceptable only for staging. |
| VPC connector | Per-connection fee + data processing | Cheaper than internet egress for internal traffic. |
| Secret Manager | Secret versions + access calls | Negligible at this scale. |
| Artifact Registry | Storage + data transfer | Modest; grows with image count. |
| Network egress | Scentic↔AGPL traffic via peering | Peered/internal traffic is cheaper than internet egress. |

See `docs/DEPLOYMENT.md` §9 for the full cost table (incl. Kimai/OpenSign/MongoDB/GCS).

## 5. What this directory is NOT

- It is **not** a deployed environment.
- It is **not** an executed deployment runbook.
- It is **not** proof that the gateway runs on GCloud. Real deployment + health evidence is AGPL-05 scope (real GCloud deployment, Scentic core integration, E2E contract tests).
- It is **not** authorization to provision anything. The project owner must explicitly authorize deployment.

## 6. Related files

- `docs/DEPLOYMENT.md` — full deployment plan (architecture, service-by-service, networking, secrets, monitoring, cost, rollout order).
- `deploy/gcloud/cloud-run-gateway.yaml` — gateway Cloud Run manifest.
- `deploy/gcloud/secret-manager.md` — secret inventory + reference commands.
- `deploy/gcloud/service-accounts.md` — least-privilege service accounts.
- `deploy/gcloud/vpc-networking.md` — VPC connector + private networking.
- `deploy/gcloud/deploy-commands.md` — reference `gcloud` commands (do not execute without authorization).
