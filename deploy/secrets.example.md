# Secret Naming Convention

This document describes the naming convention for secrets stored in GCloud Secret Manager for the scentic-agpl-services deployment. No actual secrets are listed here.

## Gateway secrets

| Secret name | Purpose | Rotation |
|-------------|---------|----------|
| `agpl-gateway-service-token` | Service-to-service auth token (Scentic → Gateway) | 90 days |
| `agpl-gateway-webhook-secret` | HMAC signing secret for webhooks (Gateway → Scentic) | 90 days |

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
