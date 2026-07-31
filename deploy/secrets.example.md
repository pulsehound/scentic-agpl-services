# Secret Naming Convention

This document describes the naming convention for secrets stored in GCloud Secret Manager for the scentic-agpl-services deployment. No actual secrets are listed here.

## Gateway secrets

The gateway uses **two distinct HMAC secrets** that MUST be different values, stored in separate Secret Manager secrets, and rotated independently (90-day cadence). See `docs/SCENTIC_INTERFACE_SPEC.md` §3.3 (key separation) and `docs/SCENTIC_ENV_VARS_REQUIRED.md` §4 (rotation).

| Secret name | Purpose | Rotation |
|-------------|---------|----------|
| `agpl-gateway-service-token` (alias: `agpl-shared-hmac-secret`) | Shared HMAC secret used to verify Scentic → Gateway requests (`X-Scentic-Signature`). Env: `SCENTIC_SHARED_HMAC_SECRET` / `SCENTIC_SERVICE_TOKEN`. | 90 days |
| `agpl-gateway-webhook-secret` (alias: `agpl-webhook-hmac-secret`) | HMAC signing secret for Gateway → Scentic webhooks (`X-Gateway-Signature: sha256=<hex>`). Env: `SCENTIC_WEBHOOK_HMAC_SECRET` / `GATEWAY_WEBHOOK_SECRET`. Distinct from the service token. | 90 days |
| `agpl-gateway-database-url` (alias: `GATEWAY_DATABASE_URL`) | Cloud SQL Postgres connection string for the gateway durable store (AGPL-05). Format: `postgres://gateway:<password>@<cloud-sql-private-ip>:5432/gateway` (private IP) or a unix-socket URL when using the Cloud SQL proxy. Env: `GATEWAY_DATABASE_URL`. Required when `GATEWAY_STORE_TYPE=postgres`. Never logged; password component must be strong and non-placeholder. | On compromise / DB password rotation |

> **AGPL-03 note:** the webhook dispatcher (`gateway/src/events/webhook-dispatcher.ts`) is disabled when either `SCENTIC_WEBHOOK_TARGET_URL` or `SCENTIC_WEBHOOK_HMAC_SECRET` is unset — no unsigned webhooks are ever sent. Rotation uses the dual-secret overlap window documented in `docs/SCENTIC_ENV_VARS_REQUIRED.md` §4. The two gateway secrets must never share the same value.

> **AGPL-05 note:** `GATEWAY_DATABASE_URL` is a Secret Manager secret (not a plaintext env value or baked into the image). It is the only durable-store credential; the gateway's Postgres schema (`gateway/src/storage/postgres-schema.sql`) stores no document contents, raw signer emails (only `signer_email_hash`), or HMAC secrets — so the connection string is the single sensitive value in the gateway store. The Cloud SQL instance must have no public IP (`--no-assign-ip`); see `deploy/gcloud/cloud-run-gateway.yaml` and `deploy/gcloud/deploy-commands.md` §5. The `GATEWAY_POSTGRES_SSL_MODE` env var (plain, not secret) controls SSL; use `require`+ for any non-private hop.

## Kimai secrets

| Secret name | Purpose | Rotation |
|-------------|---------|----------|
| `agpl-kimai-app-secret` | Symfony APP_SECRET | On compromise |
| `agpl-kimai-db-password` | MySQL database password | 180 days |
| `agpl-kimai-admin-password` | Kimai admin account password | On compromise |

## OpenSign secrets

| Secret name | Purpose | Rotation |
|-------------|---------|----------|
| `agpl-opensign-master-key` | Parse Server MASTER_KEY (used by the gateway for OpenSign operations in AGPL-02; production target: provisioning only) | On compromise |
| `agpl-opensign-admin-password` | OpenSign admin account password (gateway logs in with this to obtain a session token) | 180 days |
| `agpl-opensign-app-id` | Parse Server APP_ID | Fixed (not secret, but managed) |
| `agpl-opensign-pfx-base64` | PFX certificate for PDF signing | On certificate expiry |
| `agpl-opensign-pass-phrase` | PFX passphrase | With PFX rotation |
| `agpl-opensign-mailgun-key` | Mailgun API key (if using Mailgun) | 180 days |
| `agpl-opensign-smtp-pass` | SMTP password (if using SMTP) | 180 days |
| `agpl-opensign-s3-access-key` | S3/GCS access key | 180 days |
| `agpl-opensign-s3-secret-key` | S3/GCS secret key | 180 days |

## Rules

1. No secrets in the repository (no .env files, no hardcoded values)
2. All secrets stored in GCloud Secret Manager (project: scentic-agpl-prod)
3. Secrets accessed via workload identity (no key files)
4. Each service has its own service account with minimal Secret Manager access
5. Secret rotation is automated where possible
6. No secrets are shared between Scentic core and AGPL services
7. No secrets are logged or exposed in error messages
