<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- scentic-agpl-services — GCloud least-privilege service account reference -->

# Service Account Setup (Reference Only)

> **Status:** REFERENCE ONLY. No GCP project provisioned. Do not execute these commands without project-owner authorization.

---

## 1. Gateway runtime service account

The gateway Cloud Run service runs as a dedicated, least-privilege service account. It is granted the minimum roles required to:

1. Read its own secrets from Secret Manager.
2. Reach Cloud SQL (Postgres) over private IP.
3. Pull its own image from Artifact Registry.

### 1.1 Create the service account

```bash
# Replace PROJECT_ID.
gcloud iam service-accounts create gateway-runtime \
  --display-name="Scentic AGPL gateway runtime" \
  --project=PROJECT_ID
```

The service account email is `gateway-runtime@PROJECT_ID.iam.gserviceaccount.com` (referred to as `GATEWAY_SA` in `cloud-run-gateway.yaml`).

### 1.2 Grant least-privilege roles

| Role | Purpose | Scope |
|---|---|---|
| `roles/secretmanager.secretAccessor` | Read the gateway's secrets (`SCENTIC_SHARED_HMAC_SECRET`, `SCENTIC_WEBHOOK_HMAC_SECRET`, `KIMAI_ADMIN_API_TOKEN`, `OPENSIGN_MASTER_KEY`, `OPENSIGN_ADMIN_PASSWORD`). | Per-secret IAM binding (NOT project-wide). See `secret-manager.md` §5. |
| `roles/cloudsql.client` | Connect to the Cloud SQL Postgres instance used as the gateway durable store (mapping/nonce/outbox tables). | Project or instance level. |
| `roles/artifactregistry.reader` | Pull the gateway container image from Artifact Registry. | Per-repository IAM binding preferred over project-wide. |

```bash
# Replace PROJECT_ID, GATEWAY_SA, REGION, and repository names.

# Cloud SQL Client (project-scoped; tighten to instance-scoped if preferred).
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member="serviceAccount:GATEWAY_SA@PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/cloudsql.client"

# Artifact Registry Reader (per-repository binding preferred).
gcloud artifacts repositories add-iam-policy-binding scentic-agpl \
  --location=REGION \
  --member="serviceAccount:GATEWAY_SA@PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/artifactregistry.reader"

# Secret Manager Secret Accessor — granted per secret, NOT project-wide.
# See deploy/gcloud/secret-manager.md §5 for the per-secret binding loop.
```

## 2. What the gateway service account must NOT have

- No `roles/owner`, `roles/editor`, or any broad administrative role.
- No project-wide `roles/secretmanager.secretAccessor` (use per-secret bindings so the SA can read only its own secrets, not Kimai's or OpenSign's).
- No access to the Scentic core GCP project (separate project; no cross-project IAM grant).
- No Cloud SQL Admin (`cloudsql.admin`) — the gateway only connects as a client, it does not administer instances.
- No write access to Artifact Registry (the gateway only pulls images; CI/CD pushes images under a separate build SA).

## 3. Separate service accounts for Kimai and OpenSign

Kimai and OpenSign run under their own least-privilege service accounts, scoped to their own secrets and storage. The gateway SA has no access to Kimai's or OpenSign's secrets.

- **Kimai runtime SA:** `roles/cloudsql.client` (Kimai MySQL instance), `roles/secretmanager.secretAccessor` on `kimai-DATABASE_URL`, `kimai-APP_SECRET`, etc.
- **OpenSign runtime SA:** `roles/secretmanager.secretAccessor` on `opensign-APP_ID`, `opensign-MASTER_KEY`, `opensign-MONGO_URL`, `opensign-S3_*`, `opensign-PFX_*`, plus GCS / object-storage access scoped to the OpenSign files bucket.

## 4. CI/CD build service account (separate)

The CI/CD pipeline that builds and pushes the gateway image runs under a separate build SA with `roles/artifactregistry.writer` on the gateway repository only. It must NOT have any runtime roles (no Secret Manager accessor, no Cloud SQL client). Build and runtime SAs are distinct principals.

## 5. Related files

- `deploy/gcloud/cloud-run-gateway.yaml` — references `GATEWAY_SA` in `serviceAccountName`.
- `deploy/gcloud/secret-manager.md` — per-secret IAM binding loop.
- `docs/DEPLOYMENT.md` §5 — full secrets + per-service SA plan.
