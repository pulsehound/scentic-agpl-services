<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- scentic-agpl-services — GCloud deployment commands (REFERENCE ONLY, do not execute) -->

# Deployment Commands (Reference Only — Do Not Execute)

> **Status:** REFERENCE ONLY. No GCP project provisioned. **Do not execute these commands without project-owner authorization.** Running them will create billable cloud resources and may expose internal services if networking is misconfigured.
>
> This document is a command reference, not an execution runbook. It exists so that the deployment path is reviewable end-to-end before any real provisioning. Real deployment + health evidence is pending GCP project provisioning (see `docs/PRODUCTION_BLOCKERS.md`).

---

## 1. Project + API enablement (reference)

```bash
# Replace PROJECT_ID and BILLING_ACCOUNT_ID.
gcloud projects create PROJECT_ID --name="Scentic AGPL prod"
gcloud beta billing projects link PROJECT_ID --billing-account=BILLING_ACCOUNT_ID

gcloud config set project PROJECT_ID

gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  secretmanager.googleapis.com \
  artifactregistry.googleapis.com \
  compute.googleapis.com \
  vpcaccess.googleapis.com \
  servicenetworking.googleapis.com \
  iam.googleapis.com \
  monitoring.googleapis.com \
  logging.googleapis.com
```

## 2. Artifact Registry (reference)

```bash
# Replace PROJECT_ID and REGION.
gcloud artifacts repositories create scentic-agpl \
  --repository-format=docker \
  --location=REGION \
  --description="Scentic AGPL services images" \
  --project=PROJECT_ID

# Build + push the gateway image (run from the repo root, local or in CI).
# Replace TAG with an immutable tag or digest — never :latest in production.
gcloud auth configure-docker REGION-docker.pkg.dev
# docker build -f deploy/Dockerfile.gateway -t REGION-docker.pkg.dev/PROJECT_ID/scentic-agpl/gateway:TAG .
# docker push REGION-docker.pkg.dev/PROJECT_ID/scentic-agpl/gateway:TAG
```

> The Dockerfile at `deploy/Dockerfile.gateway` is tagged **LOCAL DEVELOPMENT ONLY** (it was simplified in AGPL-05 to drop native build tooling since `pg` is pure JS, but it is not a hardened multi-stage production build). A production build must use a hardened multi-stage Dockerfile that does not ship devDependencies or build toolchains. Pending production hardening (see `docs/PRODUCTION_BLOCKERS.md`).

## 3. Service accounts (reference)

See `service-accounts.md` for the full least-privilege plan.

```bash
gcloud iam service-accounts create gateway-runtime \
  --display-name="Scentic AGPL gateway runtime" \
  --project=PROJECT_ID

# Cloud SQL Client (project-scoped).
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member="serviceAccount:gateway-runtime@PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/cloudsql.client"

# Artifact Registry Reader (per-repo).
gcloud artifacts repositories add-iam-policy-binding scentic-agpl \
  --location=REGION \
  --member="serviceAccount:gateway-runtime@PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/artifactregistry.reader"
```

Per-secret Secret Manager bindings: see `secret-manager.md` §5.

## 4. VPC + connector + private services (reference)

See `vpc-networking.md` for the full VPC reference.

```bash
gcloud compute networks create scentic-agpl-vpc --subnet-mode=custom --project=PROJECT_ID

gcloud compute networks subnets create agpl-subnet \
  --network=scentic-agpl-vpc \
  --region=REGION \
  --range=10.20.0.0/20 \
  --enable-private-ip-google-access \
  --project=PROJECT_ID

gcloud compute networks vpc-access connectors create scentic-agpl-connector \
  --network=scentic-agpl-vpc \
  --region=REGION \
  --range=10.30.0.0/28 \
  --project=PROJECT_ID

# Private services access for Cloud SQL.
gcloud compute addresses create google-managed-services-agpl \
  --global --purpose=VPC_PEERING --prefix-length=16 \
  --network=scentic-agpl-vpc --project=PROJECT_ID

gcloud services vpc-peerings connect \
  --service=servicenetworking.googleapis.com \
  --ranges=google-managed-services-agpl \
  --network=scentic-agpl-vpc --project=PROJECT_ID
```

Firewall rules: see `vpc-networking.md` §4.

## 5. Cloud SQL Postgres (reference)

The Cloud SQL Postgres instance is the **gateway durable store** in production (mapping/nonce/idempotency/outbox tables). The schema is defined in `gateway/src/storage/postgres-schema.sql` (13 tables, `TIMESTAMPTZ`, `JSONB` outbox payload) and is auto-created on gateway boot by `gateway/src/storage/postgres-store.ts` (delivered in AGPL-05).

```bash
# Replace PROJECT_ID, REGION, DB_PASSWORD (from Secret Manager).
gcloud sql instances create scentic-agpl-gateway-db \
  --database-version=POSTGRES_15 \
  --tier=db-custom-1-3840 \
  --region=REGION \
  --network=projects/PROJECT_ID/global/networks/scentic-agpl-vpc \
  --no-assign-ip \
  --availability-type=REGIONAL \
  --backup-start-time=03:00 \
  --project=PROJECT_ID

# Create the gateway database + user.
gcloud sql databases create gateway --instance=scentic-agpl-gateway-db --project=PROJECT_ID
gcloud sql users create gateway \
  --instance=scentic-agpl-gateway-db \
  --password="<DB_PASSWORD from Secret Manager>" \
  --project=PROJECT_ID
```

> The Postgres production store (`GATEWAY_STORE_TYPE=postgres`) was **delivered in AGPL-05**. The store factory (`gateway/src/storage/store-factory.ts`) is async and creates the `PostgresMappingStore` (backed by `pg.Pool`, pure-JS driver) when `GATEWAY_DATABASE_URL` is set. Multi-instance safety is provided by `ON CONFLICT DO NOTHING` (nonces), `ON CONFLICT` (idempotency), and `FOR UPDATE SKIP LOCKED` (outbox). Redis is optional. See `docs/SCENTIC_AGPL_CONNECTION_MANUAL.md` §13 and `docs/SECURITY_THREAT_MODEL.md` T-17. The manifest in `cloud-run-gateway.yaml` references `GATEWAY_DATABASE_URL` from Secret Manager and supports both private-IP and Cloud SQL proxy (Unix socket) connection modes.

## 6. Secret Manager secrets (reference)

See `secret-manager.md` for the full secret inventory + creation commands.

```bash
printf '%s' "$(openssl rand -hex 32)" | \
  gcloud secrets create SCENTIC_SHARED_HMAC_SECRET --replication-policy=automatic --data-file=-

printf '%s' "$(openssl rand -hex 32)" | \
  gcloud secrets create SCENTIC_WEBHOOK_HMAC_SECRET --replication-policy=automatic --data-file=-

printf '%s' "<strong-kimai-admin-api-token>" | \
  gcloud secrets create KIMAI_ADMIN_API_TOKEN --replication-policy=automatic --data-file=-

printf '%s' "$(openssl rand -hex 32)" | \
  gcloud secrets create OPENSIGN_MASTER_KEY --replication-policy=automatic --data-file=-

printf '%s' "<strong-opensign-admin-password>" | \
  gcloud secrets create OPENSIGN_ADMIN_PASSWORD --replication-policy=automatic --data-file=-

# Gateway durable store — Cloud SQL Postgres connection string (AGPL-05).
# Replace the connection string with the real private-IP Cloud SQL URL
# (including the gateway DB user password). Use a unix-socket URL if using
# the Cloud SQL proxy connection mode (see cloud-run-gateway.yaml).
printf '%s' "postgres://gateway:<DB_PASSWORD>@<CLOUD_SQL_PRIVATE_IP>:5432/gateway" | \
  gcloud secrets create GATEWAY_DATABASE_URL --replication-policy=automatic --data-file=-
```

## 7. Cloud Run deploy (reference)

The canonical manifest is `cloud-run-gateway.yaml`. Apply it with `gcloud run services replace` (preferred) so the deployed service matches the reviewed manifest exactly. The imperative `gcloud run deploy` form is provided as a fallback.

```bash
# Preferred: apply the manifest.
# Edit cloud-run-gateway.yaml first (PROJECT_ID, REGION, TAG, CONNECTOR_NAME, GATEWAY_SA,
# CLOUD_SQL_PRIVATE_IP), then:
gcloud run services replace deploy/gcloud/cloud-run-gateway.yaml \
  --region=REGION --project=PROJECT_ID

# Fallback: imperative deploy (must replicate every field from the manifest).
# gcloud run deploy scentic-agpl-gateway \
#   --image=REGION-docker.pkg.dev/PROJECT_ID/scentic-agpl/gateway:TAG \
#   --region=REGION \
#   --port=3101 \
#   --ingress=internal \
#   --min-instances=1 \
#   --max-instances=3 \
#   --cpu=1 \
#   --memory=512Mi \
#   --vpc-connector=projects/PROJECT_ID/regions/REGION/connectors/scentic-agpl-connector \
#   --vpc-egress=private-ip-only \
#   --service-account=gateway-runtime@PROJECT_ID.iam.gserviceaccount.com \
#   --set-env-vars="NODE_ENV=production,PORT=3101,GATEWAY_STORE_TYPE=postgres,GATEWAY_ALLOW_SQLITE_IN_PRODUCTION=false,GATEWAY_POSTGRES_SSL_MODE=disable" \
#   --set-secrets="SCENTIC_SHARED_HMAC_SECRET=SCENTIC_SHARED_HMAC_SECRET:latest,SCENTIC_WEBHOOK_HMAC_SECRET=SCENTIC_WEBHOOK_HMAC_SECRET:latest,KIMAI_ADMIN_API_TOKEN=KIMAI_ADMIN_API_TOKEN:latest,OPENSIGN_MASTER_KEY=OPENSIGN_MASTER_KEY:latest,OPENSIGN_ADMIN_PASSWORD=OPENSIGN_ADMIN_PASSWORD:latest,GATEWAY_DATABASE_URL=GATEWAY_DATABASE_URL:latest" \
#   --project=PROJECT_ID
```

## 8. Health check after deploy (reference)

```bash
# Internal health probe (run from inside the AGPL VPC, or via a bastion/IAP tunnel).
curl -s http://gateway.agpl.internal:3101/health
curl -s http://gateway.agpl.internal:3101/api/v1/status
```

Uptime checks + alerts are configured in Cloud Monitoring (see `docs/DEPLOYMENT.md` §7).

## 9. Rollback (reference)

### 9.1 Roll back the Cloud Run image

Cloud Run keeps a revision history. Roll back by pointing the service at the previous (known-good) revision or image tag.

```bash
# List recent revisions.
gcloud run revisions list --service=scentic-agpl-gateway \
  --region=REGION --project=PROJECT_ID

# Roll back to a previous revision (replace REVISION_ID).
gcloud run services update scentic-agpl-gateway \
  --region=REGION --project=PROJECT_ID \
  --revision=REVISION_ID
```

Or redeploy the previous image tag:

```bash
# Replace PREV_TAG with the previous known-good tag.
gcloud run services replace deploy/gcloud/cloud-run-gateway.yaml \
  --region=REGION --project=PROJECT_ID \
  # (edit the manifest to set image: ...:PREV_TAG before applying)
```

### 9.2 Roll back a Secret Manager secret version

```bash
# List versions and disable the bad latest version, re-enable the previous one.
gcloud secrets versions list SCENTIC_SHARED_HMAC_SECRET --project=PROJECT_ID
gcloud secrets versions disable LATEST_VERSION --secret=SCENTIC_SHARED_HMAC_SECRET --project=PROJECT_ID
gcloud secrets versions enable PREV_VERSION --secret=SCENTIC_SHARED_HMAC_SECRET --project=PROJECT_ID
# Redeploy the gateway service to pick up the rolled-back version pointer.
```

### 9.3 Roll back a Cloud SQL migration

The Postgres production store was delivered in AGPL-05. Every migration must have forward + rollback SQL. Rollback is performed by applying the reverse migration against the `gateway` database. Backups (daily + before-migration) are restored via:

```bash
gcloud sql backups list --instance=scentic-agpl-gateway-db --project=PROJECT_ID
gcloud sql backups restore BACKUP_ID \
  --restore-instance=scentic-agpl-gateway-db \
  --project=PROJECT_ID
```

## 10. What this is NOT

- These commands are **not executed**. No project is provisioned.
- The placeholder values (`PROJECT_ID`, `REGION`, `TAG`, `CLOUD_SQL_PRIVATE_IP`, `CONNECTOR_NAME`, `GATEWAY_SA`, `<DB_PASSWORD>`, `<strong-...>`) MUST be replaced before any real run.
- The Postgres production store adapter **is implemented** (AGPL-05; `gateway/src/storage/postgres-store.ts`), so `GATEWAY_STORE_TYPE=postgres` is a working path. Production deployment itself is still not executed — it is blocked on GCP project provisioning (see `docs/PRODUCTION_BLOCKERS.md`).

## 11. Related files

- `deploy/gcloud/cloud-run-gateway.yaml` — canonical Cloud Run manifest.
- `deploy/gcloud/secret-manager.md` — secret inventory + creation.
- `deploy/gcloud/service-accounts.md` — least-privilege SAs.
- `deploy/gcloud/vpc-networking.md` — VPC + connector + firewall.
- `docs/DEPLOYMENT.md` — full deployment plan (architecture, rollout order, monitoring, cost, §3.5 Postgres durable store).
- `docs/SCENTIC_AGPL_CONNECTION_MANUAL.md` §13 — Postgres durable store operator guide.
- `docs/SECURITY_THREAT_MODEL.md` T-17 — Postgres durable store security.
- `docs/PRODUCTION_BLOCKERS.md` — production blockers.
- `docs/AGPL_04_CLOSEOUT.md` — AGPL-04 closeout (GCloud manifests + SQLite store).
