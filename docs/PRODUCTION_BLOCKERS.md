# Production Blockers

> **Status:** AGPL services local deployment package complete. Production deployment NOT executed.
> **Date:** 2026-07-31

These blockers must be resolved before the AGPL services can be deployed to production.

## Critical Blockers (P0)

### PB-01: GCP Project Provisioning
- **Status:** BLOCKED
- **Owner:** Yair / Cloud admin
- **Requirement:** Provision `scentic-agpl-prod` GCP project with billing enabled
- **Details:** Separate GCP project for AGPL services to keep them isolated from Scentic core. Requires VPC peering between the AGPL project and the Scentic core project.
- **Resolution:** `gcloud projects create scentic-agpl-prod` + billing setup + IAM

### PB-02: Secret Manager Provisioning
- **Status:** BLOCKED
- **Owner:** Yair / Cloud admin
- **Requirement:** Create GCP Secret Manager secrets for all gateway credentials
- **Secrets required:**
  - `SCENTIC_SHARED_HMAC_SECRET` — signs Scentic-to-Gateway requests
  - `SCENTIC_WEBHOOK_HMAC_SECRET` — signs Gateway-to-Scentic webhooks
  - `KIMAI_ADMIN_API_TOKEN` — Kimai admin API token
  - `OPENSIGN_MASTER_KEY` — OpenSign Parse Server master key
  - `OPENSIGN_ADMIN_PASSWORD` — OpenSign admin password
  - `GATEWAY_DATABASE_URL` — Postgres connection string
- **Resolution:** See `deploy/gcloud/secret-manager.md` for reference commands

### PB-03: Cloud SQL Postgres Provisioning
- **Status:** BLOCKED
- **Owner:** Yair / Cloud admin
- **Requirement:** Provision Cloud SQL Postgres instance for gateway durable store
- **Details:** Private IP, VPC peered with the AGPL project. Postgres 16. Database name: `gateway`.
- **Resolution:** See `deploy/gcloud/deploy-commands.md` for reference commands

### PB-04: VPC and Networking
- **Status:** BLOCKED
- **Owner:** Yair / Cloud admin
- **Requirement:** VPC, subnet, Serverless VPC Access connector, firewall rules
- **Details:** Cloud Run needs VPC connector to reach Cloud SQL and internal services. Private Google Access required.
- **Resolution:** See `deploy/gcloud/vpc-networking.md` for reference

### PB-05: Scentic Core Integration
- **Status:** BLOCKED
- **Owner:** Yair
- **Requirement:** Implement Scentic-side changes per `docs/SCENTIC_CORE_REQUIRED_CHANGES.md`
- **Details:** Scentic core needs: `AGPL_GATEWAY` provider type, env-schema validation, webhook receiver route, time-tracking proxy routes, provider-health entry, audit events. These are documentation-only in the AGPL repo — Yair must land them in the Scentic core.
- **Resolution:** See `docs/SCENTIC_CORE_REQUIRED_CHANGES.md` for the complete spec

## High Blockers (P1)

### PB-06: OpenSign PFX Certificate
- **Status:** BLOCKED
- **Owner:** Yair / Security admin
- **Requirement:** Provision a real PDF signing certificate for OpenSign
- **Details:** Production e-signature requires a valid PFX certificate. Dev/local uses a throwaway cert. The PFX must be base64-encoded and stored in Secret Manager.
- **Resolution:** Obtain certificate from CA, encode as base64, store in Secret Manager

### PB-07: Real Kimai Production Setup
- **Status:** BLOCKED
- **Owner:** Yair / Ops
- **Requirement:** Production Kimai instance with admin user, API token, and proper configuration
- **Details:** Kimai needs: admin user with API token, team/customer/project/activity structure, proper mailer config, CORS settings.
- **Resolution:** Deploy Kimai (Cloud Run or GCE), create admin user, generate API token

### PB-08: Real OpenSign Production Setup
- **Status:** BLOCKED
- **Owner:** Yair / Ops
- **Requirement:** Production OpenSign instance with MongoDB, SMTP, and signing certificate
- **Details:** OpenSign needs: MongoDB Atlas or self-hosted MongoDB, SMTP (Mailgun or SES), PFX certificate, admin user, app ID and master key.
- **Resolution:** Deploy OpenSign server + frontend, configure MongoDB/SMTP/PFX

### PB-09: Source-Offer URL Finalization
- **Status:** BLOCKED
- **Owner:** Yair
- **Requirement:** Finalize the public source-offer repository URL
- **Details:** AGPL-3.0 Section 13 requires anyone interacting with the software remotely to have access to the complete source code. The repository URL must be finalized and accessible before external network use.
- **Resolution:** Decide on public repo URL (e.g., GitHub), ensure repo is accessible

### PB-10: Real Contract Test Evidence
- **Status:** BLOCKED
- **Owner:** AGPL team
- **Requirement:** Real Kimai and OpenSign container contract tests must pass
- **Details:** Current contract tests are mock-only or env-gated. Real contract tests must verify the full lifecycle against real Kimai/OpenSign instances.
- **Resolution:** Set up real Kimai/OpenSign instances, run contract tests, collect evidence

## Medium Blockers (P2)

### PB-11: Redis for Multi-Instance (Optional)
- **Status:** DOCUMENTED — Postgres is sufficient
- **Owner:** AGPL team
- **Requirement:** Redis is optional; Postgres provides atomic nonce/idempotency/outbox coordination
- **Details:** Postgres `ON CONFLICT DO NOTHING` for nonces, `ON CONFLICT` for idempotency, `FOR UPDATE SKIP LOCKED` for outbox processing. Redis would provide lower latency but is not required.
- **Resolution:** Document Postgres-based multi-instance safety. Add Redis only if latency requires it.

### PB-12: Monitoring and Alerting
- **Status:** BLOCKED
- **Owner:** Yair / Ops
- **Requirement:** Cloud Monitoring, alerting, log aggregation for production
- **Details:** Cloud Run logs to Cloud Logging. Need alerts for: gateway health, Postgres connections, Kimai/OpenSign connectivity, webhook delivery failures.
- **Resolution:** Configure Cloud Monitoring alerts, dashboards, SLOs

### PB-13: Backup and Disaster Recovery
- **Status:** BLOCKED
- **Owner:** Yair / Ops
- **Requirement:** Postgres backup and restore procedures for gateway state
- **Details:** Cloud SQL automated backups. Need tested restore procedure.
- **Resolution:** Enable Cloud SQL automated backups, test restore procedure

## Resolved Blockers

### RB-01: Durable Storage in Docker
- **Status:** RESOLVED (AGPL-05)
- **Resolution:** Replaced SQLite (better-sqlite3, segfaults in Docker) with Postgres (pg, pure JS). Docker stack now uses Postgres by default.

### RB-02: Store Factory Production Validation
- **Status:** RESOLVED (AGPL-04)
- **Resolution:** Store factory rejects memory store in production, requires explicit allow for SQLite, supports Postgres.

### RB-03: GCloud Deployment Manifests
- **Status:** RESOLVED (AGPL-04/05)
- **Resolution:** Cloud Run, Secret Manager, service accounts, VPC, deploy commands documented in `deploy/gcloud/`.
