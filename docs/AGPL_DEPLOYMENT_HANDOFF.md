# AGPL Deployment Handoff

> **Status:** AGPL SERVICES LOCAL DEPLOYMENT PACKAGE COMPLETE / PRODUCTION DEPLOYMENT NOT EXECUTED / SCENTIC CORE INTEGRATION NOT APPLIED
> **Date:** 2026-07-31

## 1. Repository Boundaries

### AGPL Repository (this repo)
- **Location:** `C:\AIprojects\factoryai\scentic-agpl-services`
- **License:** AGPL-3.0
- **Contents:** Gateway service, Kimai/OpenSign integration, Docker deployment, GCloud manifests, docs
- **May be deployed separately** from Scentic core

### Scentic Core Repository (proprietary)
- **Location:** `C:\AIprojects\factoryai\scentic.ai`
- **License:** Proprietary
- **Status:** UNTOUCHED — no modifications made during AGPL-01 through AGPL-05
- **Integration requires future Scentic-side changes by Yair only** (see `docs/SCENTIC_CORE_REQUIRED_CHANGES.md`)

### Upstream AGPL Projects
- **Kimai:** `vendor/kimai/` — pinned at SHA `7c2ed4b07cca2e15b1ab4cc5947afdf899a76401`, unmodified
- **OpenSign:** `vendor/opensign/` — pinned at SHA `f72624fa26211fe00776453d99a67120a4f5e060`, unmodified

## 2. What Was Delivered (AGPL-01 through AGPL-05)

| Phase | Deliverable | Status |
|-------|-------------|--------|
| AGPL-00 | Workspace setup, planning docs, vendor clones | COMPLETE |
| AGPL-01 | Gateway skeleton, Kimai integration, HMAC auth, 37 tests | COMPLETE |
| AGPL-02 | OpenSign integration, signature endpoints, 42 tests | COMPLETE |
| AGPL-03 | Webhook dispatcher, status endpoint, Docker stack, Scentic interface docs | COMPLETE |
| AGPL-04 | SQLite durable store, store factory, GCloud manifests | COMPLETE (SQLite local-only) |
| AGPL-05 | Postgres durable store, Docker Postgres stack, mock Scentic receiver, final docs | COMPLETE |

## 3. Architecture

```
Scentic core (proprietary, UNTOUCHED)
  |
  | REST (HMAC-signed) / webhook (HMAC-signed)
  v
scentic-agpl-services gateway (AGPL-3.0)
  |
  | Postgres (durable store)
  |
  +---> Kimai (AGPL, time tracking)
  +---> OpenSign (AGPL, e-signatures)
  +---> Mock Scentic webhook receiver (local dev only)
```

## 4. Storage Architecture

| Store Type | Use Case | Docker? | Multi-Instance? | Production? |
|------------|----------|---------|-----------------|-------------|
| memory | Tests, dev | Yes | No | No |
| sqlite | Bare-metal local dev | No (segfaults) | No | No (unless explicitly allowed) |
| postgres | Docker, production | Yes | Yes (atomic ops) | Yes |

**Multi-instance safety:** Postgres provides atomic nonce prevention (`ON CONFLICT DO NOTHING`), idempotency (`ON CONFLICT`), and safe outbox processing (`FOR UPDATE SKIP LOCKED`). Redis is optional — Postgres is sufficient.

## 5. Local Deployment

```bash
# Clone the repo
git clone <source-offer-url>
cd scentic-agpl-services

# Configure environment
cp .env.example .env
# Edit .env: set GATEWAY_STORE_TYPE=postgres, GATEWAY_DATABASE_URL, secrets

# Start the stack (requires Docker)
scripts/local-up.sh

# Verify health
scripts/local-healthcheck.sh

# Run contract tests
GATEWAY_CONTRACT_TEST=true pnpm test:contract

# Stop the stack
scripts/local-down.sh

# DANGER: Reset all data
scripts/local-reset.sh
```

**Services:**
- Gateway: http://localhost:3101
- Gateway health: http://localhost:3101/health
- Gateway status: http://localhost:3101/api/v1/status
- Source offer: http://localhost:3101/source
- Mock Scentic: http://localhost:3199
- Kimai: http://localhost:8001
- OpenSign API: http://localhost:8080/app
- OpenSign UI: http://localhost:3000
- MailHog: http://localhost:8025
- Gateway Postgres: localhost:5433

## 6. GCloud Deployment (Manifests Only — NOT Deployed)

GCloud deployment manifests are in `deploy/gcloud/`:
- `cloud-run-gateway.yaml` — Cloud Run service manifest
- `secret-manager.md` — Secret Manager setup
- `service-accounts.md` — Service account setup
- `vpc-networking.md` — VPC configuration
- `deploy-commands.md` — Reference gcloud commands
- `README.md` — Overview and warnings

**No GCP project has been provisioned. No gcloud command has been executed.**
Real deployment requires: GCP project, billing, VPC, Cloud SQL, Secret Manager, Artifact Registry, Cloud Run.

## 7. Production Blockers

See `docs/PRODUCTION_BLOCKERS.md` for the complete list. Key P0 blockers:
1. GCP project provisioning
2. Secret Manager provisioning
3. Cloud SQL Postgres provisioning
4. VPC and networking
5. Scentic core integration (by Yair)

## 8. Source-Offer Obligations (AGPL-3.0)

- Repository is AGPL-3.0 licensed
- Source-offer route at `/source` provides license info and upstream references
- Source-offer URL must be finalized before external network use
- Upstream Kimai and OpenSign source included in `vendor/` directory
- See `docs/SOURCE_OFFER.md` for full details

## 9. What Yair Must Do

1. **Review** `docs/SCENTIC_CORE_REQUIRED_CHANGES.md` — complete spec of Scentic-side changes
2. **Implement** the Scentic-side `AGPL_GATEWAY` provider, env-schema, webhook receiver, time-tracking routes
3. **Provision** GCP project, secrets, Cloud SQL, VPC (or delegate to cloud admin)
4. **Deploy** Kimai and OpenSign production instances (or delegate to ops)
5. **Obtain** OpenSign PFX certificate for PDF signing
6. **Finalize** source-offer repository URL
7. **Run** contract tests against real services
8. **Authorize** production deployment

## 10. What Was NOT Done

- No Scentic core modifications (read-only)
- No production GCloud deployment (manifests only)
- No production readiness claim
- No real production Kimai/OpenSign credentials
- No OpenSign PFX certificate provisioning
- No live contract test evidence against production services
