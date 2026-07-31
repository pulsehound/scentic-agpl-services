# Final Operator Checklist

> **Purpose:** Step-by-step checklist for an operator deploying the AGPL services stack.
> **Status:** AGPL services local deployment package complete. Production deployment NOT executed.

## Pre-Deployment

- [ ] Review `docs/SCENTIC_AGPL_CONNECTION_MANUAL.md` end-to-end
- [ ] Review `docs/PRODUCTION_BLOCKERS.md` — all P0 blockers must be resolved
- [ ] Review `docs/SECURITY_THREAT_MODEL.md`
- [ ] Confirm GCP project `scentic-agpl-prod` is provisioned with billing
- [ ] Confirm VPC and subnet are created
- [ ] Confirm Cloud SQL Postgres instance is provisioned (private IP)
- [ ] Confirm Secret Manager secrets are created (see `deploy/gcloud/secret-manager.md`)
- [ ] Confirm service account `gateway-runtime` is created with least-privilege roles
- [ ] Confirm Artifact Registry repository is created
- [ ] Confirm source-offer repository URL is finalized and accessible
- [ ] Confirm Kimai production instance is deployed and healthy
- [ ] Confirm OpenSign production instance is deployed and healthy
- [ ] Confirm OpenSign PFX certificate is provisioned
- [ ] Confirm SMTP/email service is configured for OpenSign
- [ ] Confirm Scentic core changes are landed by Yair (see `docs/SCENTIC_CORE_REQUIRED_CHANGES.md`)

## Local Deployment (Testing)

- [ ] Clone the AGPL repo: `git clone <source-offer-url>`
- [ ] Copy `.env.example` to `.env` and configure
- [ ] Set `GATEWAY_STORE_TYPE=postgres`
- [ ] Set `GATEWAY_DATABASE_URL` to local Postgres connection string
- [ ] Run `scripts/local-up.sh` to start the Docker stack
- [ ] Run `scripts/local-healthcheck.sh` to verify all services
- [ ] Verify gateway `/health` returns 200
- [ ] Verify gateway `/api/v1/status` shows `stores.productionSuitable: true`
- [ ] Verify gateway `/source` returns source-offer information
- [ ] Verify mock Scentic webhook receiver is receiving events
- [ ] Run contract tests: `GATEWAY_CONTRACT_TEST=true pnpm test:contract`
- [ ] Run `scripts/local-down.sh` to stop the stack

## Production Deployment (GCloud)

- [ ] Build and push gateway image to Artifact Registry
- [ ] Apply `deploy/gcloud/cloud-run-gateway.yaml` with real project ID
- [ ] Verify Cloud Run service is healthy
- [ ] Verify gateway can reach Cloud SQL Postgres
- [ ] Verify gateway can reach Kimai (internal URL)
- [ ] Verify gateway can reach OpenSign (internal URL)
- [ ] Verify webhook delivery to Scentic core
- [ ] Run production smoke tests
- [ ] Configure Cloud Monitoring alerts
- [ ] Enable Cloud SQL automated backups
- [ ] Test backup restore procedure
- [ ] Document rollback procedure

## Security Verification

- [ ] No secrets in environment files committed to git
- [ ] All secrets stored in Secret Manager
- [ ] HMAC secrets are strong random values (not placeholders)
- [ ] `SCENTIC_SHARED_HMAC_SECRET` and `SCENTIC_WEBHOOK_HMAC_SECRET` are distinct
- [ ] Internal URLs are private network URLs
- [ ] No `@scentic/*` imports in gateway code
- [ ] No Scentic proprietary code in AGPL repo
- [ ] No AGPL code in Scentic core repo
- [ ] Source-offer route accessible and correct
- [ ] Signer emails are hashed in storage
- [ ] No document contents stored in Postgres
- [ ] All mapping tables are Firm-scoped

## Compliance

- [ ] AGPL-3.0 license file present
- [ ] Source-offer URL accessible to all network users
- [ ] Upstream Kimai source pinned and unmodified
- [ ] Upstream OpenSign source pinned and unmodified
- [ ] OpenSign license inconsistency documented (see `docs/SOURCE_OFFER.md`)
- [ ] No production readiness claim until all P0/P1 blockers are resolved

## Rollback

- [ ] Document rollback procedure (see `deploy/gcloud/deploy-commands.md`)
- [ ] Cloud Run supports rolling back to previous revision
- [ ] Cloud SQL point-in-time recovery available
- [ ] Test rollback procedure in staging
