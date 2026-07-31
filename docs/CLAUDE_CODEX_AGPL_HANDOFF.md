# Claude / Codex AGPL Handoff

> **Created:** 2026-07-31
> **Author:** Droid (Factory AI)
> **Purpose:** Handoff document for future Claude Code and Codex agents working on the scentic-agpl-services repository.

---

## 1. Current Classification

```
AGPL SERVICES LOCAL DEPLOYMENT PACKAGE COMPLETE
PRODUCTION DEPLOYMENT NOT EXECUTED
SCENTIC CORE INTEGRATION NOT APPLIED
```

The AGPL gateway, Kimai integration, OpenSign integration, webhook dispatcher, Postgres durable store, Docker local stack, GCloud deployment manifests, mock Scentic receiver, source-offer materials, and connection manual are all delivered. No production deployment has been executed. Scentic core has not been modified.

---

## 2. Repository Paths

| Repository | Path | License | Role |
|-----------|------|---------|------|
| Scentic core | `C:\AIprojects\factoryai\scentic.ai` | Proprietary | READ-ONLY — inspect only, never modify |
| AGPL services | `C:\AIprojects\factoryai\scentic-agpl-services` | AGPL-3.0 | AGPL work repo — all code, docs, deployment files |

---

## 3. Boundary Rules

1. **No AGPL code in Scentic core.** The Scentic core repository must not contain any file from the AGPL gateway, Kimai vendor, OpenSign vendor, or any AGPL-licensed module.
2. **No Scentic proprietary code in AGPL repo.** The AGPL repo must not import, copy, bundle, or reference `@scentic/*` packages or any Scentic proprietary source file.
3. **Network/API boundary only.** Scentic core communicates with the AGPL gateway exclusively through documented REST routes and HMAC-signed webhook events. There is no shared library, shared database, shared package, or direct code dependency between the two repos.
4. **Scentic-side changes are documentation-only unless Yair authorizes implementation.** The AGPL repo documents what Scentic core would need to change (`docs/SCENTIC_CORE_REQUIRED_CHANGES.md`), but no agent may apply those changes to the Scentic core repository. Only Yair may decide whether and when to implement them.

---

## 4. What Has Been Built

| Component | Location | Status |
|-----------|----------|--------|
| AGPL gateway (Node.js/Express/TypeScript) | `gateway/src/` | Complete |
| Kimai integration (REST client, mapping, time entry CRUD) | `gateway/src/kimai/` | Complete |
| OpenSign integration (Parse Server client, signature endpoints) | `gateway/src/opensign/` | Complete |
| HMAC service-to-service auth | `gateway/src/auth/` | Complete |
| Mapping store (in-memory, SQLite, Postgres) | `gateway/src/mappings/`, `gateway/src/storage/` | Complete |
| Webhook dispatcher (HMAC-signed, retry, exponential backoff) | `gateway/src/events/` | Complete |
| Mock Scentic webhook receiver | `deploy/mock-scentic.js` | Complete |
| Postgres durable store (pg.Pool, ON CONFLICT, FOR UPDATE SKIP LOCKED) | `gateway/src/storage/postgres-store.ts` | Complete |
| Docker local stack (9 services) | `deploy/docker-compose.yml` | Complete |
| GCloud deployment manifests | `deploy/gcloud/` | Complete (manifests only) |
| Source-offer materials | `docs/SOURCE_OFFER.md`, `gateway/src/routes/health.ts` | Complete |
| Connection manual | `docs/SCENTIC_AGPL_CONNECTION_MANUAL.md` | Complete |
| Operator checklist | `docs/FINAL_OPERATOR_CHECKLIST.md` | Complete |
| Production blockers | `docs/PRODUCTION_BLOCKERS.md` | Complete |
| Scentic interface spec | `docs/SCENTIC_INTERFACE_SPEC.md` | Complete |
| Scentic required changes (documentation-only) | `docs/SCENTIC_CORE_REQUIRED_CHANGES.md` | Complete |

---

## 5. Exact Commits

| Phase | Commit SHA(s) | Description |
|-------|---------------|-------------|
| AGPL-00 | `0f92c38` | Workspace setup, planning docs, vendor clones |
| AGPL-01 | `0cff0cf`, `b4970db` | Gateway skeleton, Kimai integration, HMAC auth |
| AGPL-02 | `fd53268`, `3c2b17f` | OpenSign integration, signature endpoints |
| AGPL-03 | `f7e73ba`, `c4e93f5` | Webhook dispatcher, status endpoint, Docker stack, Scentic interface docs |
| AGPL-04 | `e01a2d4`, `e1218eb` | SQLite durable store, store factory, GCloud manifests |
| AGPL-05 | `a41ef8f`, `2624f6e` | Postgres durable store, Docker Postgres stack, mock Scentic receiver, final deployment package |

---

## 6. Current Tests and Status

```
Typecheck: PASS
Build:     PASS
Tests:     179 passed | 20 env-gated skipped | 199 total | 35 test files
Docker:    9 containers, gateway healthy with Postgres (durable=true, productionSuitable=true)
Scentic:   No modifications (clean working tree)
AGPL repo: Clean (all work committed)
```

The 20 skipped tests are:
- 11 Postgres store CRUD tests (require `GATEWAY_PG_TEST_URL` env var pointing to a running Postgres instance)
- 9 contract tests (require `GATEWAY_CONTRACT_TEST=true` and live Kimai/OpenSign endpoints)

---

## 7. Remaining Blockers

See `docs/PRODUCTION_BLOCKERS.md` for the full list. Summary:

| ID | Blocker | Owner |
|----|---------|-------|
| PB-01 | GCP project provisioning (`scentic-agpl-prod`) | Yair / Cloud admin |
| PB-02 | Secret Manager secrets (6 secrets) | Yair / Cloud admin |
| PB-03 | Cloud SQL Postgres instance (private IP) | Yair / Cloud admin |
| PB-04 | VPC, subnet, Serverless VPC Access connector | Yair / Cloud admin |
| PB-05 | Scentic core integration (AGPL_GATEWAY provider, webhook receiver, env-schema) | Yair only |
| PB-06 | OpenSign PFX certificate for PDF signing | Yair / Security admin |
| PB-07 | Real Kimai production setup (admin user, API token) | Yair / Ops |
| PB-08 | Real OpenSign production setup (MongoDB, SMTP, PFX) | Yair / Ops |
| PB-09 | Source-offer production URL finalization | Yair |
| PB-10 | Real contract test evidence against production services | AGPL team |

---

## 8. How to Run Locally

### Prerequisites
- Node.js 20+
- pnpm 10+
- Docker Desktop (with Compose v2)

### Install
```bash
cd C:\AIprojects\factoryai\scentic-agpl-services
pnpm install
```

### Start Docker stack (all 9 services)
```bash
# Git Bash or WSL recommended for shell scripts
scripts/local-up.sh

# Or directly with Docker Compose:
docker compose -f deploy/docker-compose.yml up -d
```

### Health check
```bash
scripts/local-healthcheck.sh

# Or manually:
curl http://localhost:3101/health
curl http://localhost:3101/api/v1/status
curl http://localhost:3199/health
```

### Run tests
```bash
cd gateway
pnpm test          # or: npx vitest run
pnpm typecheck     # or: npx tsc --noEmit
pnpm build         # or: npx tsc
```

### Run contract tests (requires live Docker stack)
```bash
export GATEWAY_CONTRACT_TEST=true
export GATEWAY_PG_TEST_URL=postgres://gateway:dev-gateway-pg-pass@localhost:5433/gateway
cd gateway
npx vitest run src/tests/contract/
npx vitest run src/tests/storage/postgres-store.test.ts
```

### Teardown
```bash
scripts/local-down.sh
# Or: docker compose -f deploy/docker-compose.yml down
```

### DANGER: Reset all data (destructive)
```bash
scripts/local-reset.sh
# Or: docker compose -f deploy/docker-compose.yml down -v
```

### Services and ports

| Service | Port | URL |
|---------|------|-----|
| Gateway | 3101 | http://localhost:3101 |
| Gateway health | 3101 | http://localhost:3101/health |
| Gateway status | 3101 | http://localhost:3101/api/v1/status |
| Source offer | 3101 | http://localhost:3101/source |
| Mock Scentic | 3199 | http://localhost:3199 |
| Mock Scentic events | 3199 | http://localhost:3199/events |
| Gateway Postgres | 5433 | localhost:5433 (db: gateway, user: gateway) |
| Kimai | 8001 | http://localhost:8001 |
| OpenSign API | 8080 | http://localhost:8080/app |
| OpenSign UI | 3000 | http://localhost:3000 |
| MailHog UI | 8025 | http://localhost:8025 |
| MailHog SMTP | 1025 | localhost:1025 |

---

## 9. Deployment Overview

### Local Docker stack
- 9 containers: gateway, gateway-postgres, mock-scentic, kimai, kimai-db (MariaDB), opensign-server, opensign-mongo, opensign-frontend, mailhog
- Gateway uses Postgres durable store by default (`GATEWAY_STORE_TYPE=postgres`)
- All data persists in Docker volumes (gateway-pg-data, kimai-db-data, opensign-mongo-data)
- Dev credentials only — not for production

### Future GCloud deployment (manifests only, not executed)
- **Cloud Run** for gateway service (min 1, max 3 instances, 1 vCPU, 512MiB)
- **Cloud SQL Postgres** for durable store (private IP, automated backups)
- **Secret Manager** for all secrets (6 secrets)
- **VPC** with Serverless VPC Access connector for private networking
- **Artifact Registry** for container images
- See `deploy/gcloud/` for manifests and reference commands

### Secrets (production)
| Secret | Purpose | Source |
|--------|---------|--------|
| `SCENTIC_SHARED_HMAC_SECRET` | Signs Scentic-to-Gateway requests | Secret Manager |
| `SCENTIC_WEBHOOK_HMAC_SECRET` | Signs Gateway-to-Scentic webhooks | Secret Manager |
| `KIMAI_ADMIN_API_TOKEN` | Kimai admin API token | Secret Manager |
| `OPENSIGN_MASTER_KEY` | OpenSign Parse Server master key | Secret Manager |
| `OPENSIGN_ADMIN_PASSWORD` | OpenSign admin password | Secret Manager |
| `GATEWAY_DATABASE_URL` | Postgres connection string | Secret Manager |

### Databases
| Database | Engine | Purpose |
|----------|--------|---------|
| Gateway store | Postgres 16 | Mappings, nonces, idempotency, outbox |
| Kimai store | MariaDB 10.11 | Kimai time-tracking data |
| OpenSign store | MongoDB 6 | OpenSign documents, workflows, signers |

### Public vs private endpoints
| Endpoint | Classification |
|----------|---------------|
| Gateway `/health`, `/source`, `/api/v1/status` | Public (no auth) |
| Gateway all other routes | Private (HMAC auth required) |
| Kimai | Private (internal network) |
| OpenSign server | Private (internal network) |
| OpenSign frontend | Public (signing pages for signers) |
| Mock Scentic | Private (local dev only) |

---

## 10. Interface Summary

### Scentic-to-Gateway endpoints (27 routes)

**Kimai-surface (16 routes):**
- `GET /health` — gateway liveness + upstream reachability
- `GET /api/v1/status` — detailed status (stores, providers, webhook, blockers)
- `POST /api/v1/admin/init-firm` — initialize Firm in Kimai
- `POST /api/v1/admin/disable-firm` — disable Firm
- `POST /api/v1/kimai/firm/{firmId}/user` — sync user
- `POST /api/v1/kimai/firm/{firmId}/client` — sync client
- `POST /api/v1/kimai/firm/{firmId}/matter` — sync matter
- `POST /api/v1/kimai/firm/{firmId}/activity` — sync activity
- `POST /api/v1/kimai/firm/{firmId}/time` — create time entry
- `GET /api/v1/kimai/firm/{firmId}/time` — list time entries
- `PUT /api/v1/kimai/firm/{firmId}/time/{timeEntryId}` — update time entry
- `DELETE /api/v1/kimai/firm/{firmId}/time/{timeEntryId}` — delete time entry
- `POST /api/v1/kimai/firm/{firmId}/export` — export timesheets
- `GET /api/v1/providers/kimai/health` — Kimai health
- `POST /api/v1/admin/reset-token` — reset admin token
- `GET /source` — AGPL source offer

**OpenSign-surface (11 routes):**
- `GET /api/v1/providers/opensign/health` — OpenSign health
- `POST /api/v1/opensign/firm/{firmId}/init` — init OpenSign firm
- `POST /api/v1/opensign/firm/{firmId}/user` — sync OpenSign user
- `POST /api/v1/opensign/firm/{firmId}/workflow` — create signature workflow
- `POST /api/v1/opensign/firm/{firmId}/workflow/{workflowId}/send` — send for signing
- `POST /api/v1/opensign/firm/{firmId}/workflow/{workflowId}/cancel` — cancel workflow
- `POST /api/v1/opensign/firm/{firmId}/workflow/{workflowId}/remind` — send reminder
- `POST /api/v1/opensign/firm/{firmId}/workflow/{workflowId}/poll` — poll status
- `GET /api/v1/opensign/firm/{firmId}/workflow/{workflowId}/completed` — get completed PDF
- `GET /api/v1/opensign/firm/{firmId}/workflow/{workflowId}/certificate` — get certificate
- `GET /api/v1/opensign/firm/{firmId}/workflows` — list workflows

### Gateway-to-Scentic webhook events (21 event types)

**Kimai events:** `KIMAI_CONNECTION_HEALTH_CHANGED`, `KIMAI_FIRM_INITIALIZED`, `KIMAI_MAPPING_CREATED`, `KIMAI_MAPPING_FAILED`, `KIMAI_TIME_ENTRY_CREATED`, `KIMAI_TIME_ENTRY_UPDATED`, `KIMAI_TIME_ENTRY_DELETED`, `KIMAI_TIME_ENTRY_EXPORT_READY`, `KIMAI_SYNC_FAILED`

**OpenSign events:** `OPENSIGN_CONNECTION_HEALTH_CHANGED`, `OPENSIGN_FIRM_INITIALIZED`, `OPENSIGN_USER_SYNCED`, `OPENSIGN_WORKFLOW_CREATED`, `OPENSIGN_WORKFLOW_SENT`, `OPENSIGN_WORKFLOW_STATUS_CHANGED`, `OPENSIGN_WORKFLOW_COMPLETED`, `OPENSIGN_WORKFLOW_CANCELLED`, `OPENSIGN_WORKFLOW_REMINDER_SENT`, `OPENSIGN_COMPLETED_PDF_READY`, `OPENSIGN_CERTIFICATE_READY`, `OPENSIGN_SYNC_FAILED`

### HMAC signing (both directions)

**Scentic-to-Gateway:**
- Headers: `Authorization: Bearer <timestamp>.<nonce>.<signature>`
- Signature: HMAC-SHA256 over `<method>\n<path>\n<timestamp>\n<nonce>\n<bodyHash>` using `SCENTIC_SHARED_HMAC_SECRET`
- Body hash: SHA-256 of raw body (or `"{}"` for bodyless requests)
- Timestamp tolerance: 5 minutes
- Nonce: unique per request, stored in nonce store (Postgres `ON CONFLICT DO NOTHING`)

**Gateway-to-Scentic (webhook):**
- Headers: `X-Gateway-Signature: sha256=<hex>`, `X-Gateway-Timestamp`, `X-Gateway-Nonce`, `X-Gateway-Event-Id`, `X-Gateway-Firm-Id`, `X-Gateway-Event-Type`
- Signature: HMAC-SHA256 over raw JSON body using `SCENTIC_WEBHOOK_HMAC_SECRET`
- Retry: exponential backoff (5s initial, 10min max, 5 retries)
- 2xx = DELIVERED, 4xx = FAILED_FINAL, 5xx/429 = FAILED_RETRYABLE

### Idempotency
- `Idempotency-Key` header on all POST/PUT/DELETE routes
- Key stored in Postgres `idempotency_keys` table with `ON CONFLICT` for atomic duplicate prevention
- Response cached and returned for duplicate keys

### Correlation IDs
- `X-Correlation-Id` header optional on requests, always on responses
- Propagated to outbox events and webhook payloads

### Firm/user/matter/document scoping
- Every route includes `firmId` in the path
- Auth middleware verifies `firmId` in path matches `firmId` in HMAC signature
- Store queries are Firm-scoped (`WHERE scentic_firm_id = $1`)
- Cross-firm access returns 404 (not 500) to prevent information leakage

### Retry behavior
- Gateway-to-upstream (Kimai/OpenSign): no retry (single attempt, error returned to Scentic)
- Gateway-to-Scentic (webhook): exponential backoff, 5 retries, 4xx stops retry
- Scentic-to-Gateway: Scentic may retry on 5xx/429, must not retry on 4xx

### Error handling
- All errors use `{ ok: false, error: { code, message, retryable } }` envelope
- Error codes: `UNAUTHORIZED`, `FIRM_SCOPE_VIOLATION`, `UPSTREAM_ERROR`, `NOT_FOUND`, `VALIDATION_ERROR`, `RATE_LIMITED`, `INTERNAL_ERROR`
- No internal details, stack traces, or secrets in error messages

---

## 11. Kimai Mapping Summary

| Scentic Entity | Kimai Entity | Relationship | Notes |
|----------------|-------------|--------------|-------|
| Firm | Team | 1:1 | Team created per Firm, all entities team-scoped |
| User | User | 1:1 | Per-user API token stored in mapping (encrypted) |
| Client | Customer | 1:1 | Team-scoped, display label sanitized for confidentiality |
| Matter | Project | 1:1 | Under Customer, team-scoped |
| Activity | Activity | 1:1 | Global or project-specific |
| TimeEntry | Timesheet | 1:1 | Linked to User + Project + Activity |

**Confidential labels:** When `KIMAI_USE_CONFIDENTIAL_LABELS=true`, customer and project names are replaced with sanitized labels before sending to Kimai. The original-to-sanitized mapping is stored in the gateway.

---

## 12. OpenSign Mapping Summary

| Scentic Entity | OpenSign Entity | Relationship | Notes |
|----------------|----------------|--------------|-------|
| Firm | `partners_Tenant` + `contracts_Teams` | 1:1 | Tenant + team per Firm, ACL-restricted |
| User | `contracts_Users` | 1:1 | Session token stored in mapping (encrypted) |
| SignatureWorkflow | `contracts_Document` + workflow | 1:1 | Document uploaded as base64, workflow created |
| Signer | OpenSign signer/contact | 1:1 | Email stored as hash only (`signer_email_hash`) |
| Completed PDF | OpenSign completed doc | 1:1 | Retrieved via polling, returned to Scentic via webhook event |
| Certificate | OpenSign audit certificate | 1:1 | Retrieved after completion, returned via webhook event |

**Known limitations:**
- No native OpenSign webhooks — gateway polls for status updates
- No manual reminder API — `remind` endpoint returns `NOT_SUPPORTED`
- No void/cancel function — `declinedoc` is used as closest equivalent
- PFX certificate required for digital signing (dev: throwaway, prod: real cert)
- OpenSign license inconsistency: root LICENSE is AGPL-3.0, `package.json` declares MIT

---

## 13. Tasks for Codex

Codex agents should focus on code-heavy work **in the AGPL repo only**:

1. **Finish real contract tests** — initialize Kimai admin user, run contract tests against live Docker stack, collect evidence
2. **Harden deployment** — improve health checks, add graceful shutdown for Postgres pool, add connection retry logic
3. **Implement production source-offer URL** — finalize the public repository URL, ensure source-offer route returns correct URL
4. **Improve Postgres migrations** — create formal migration files with forward/rollback, version tracking
5. **Prepare GCloud execution** — once GCP project is provisioned, execute the deployment commands in `deploy/gcloud/deploy-commands.md`
6. **Never touch Scentic core** — all Scentic-side changes are documentation-only in `docs/SCENTIC_CORE_REQUIRED_CHANGES.md`

---

## 14. Tasks for Claude Code

Claude Code agents should focus on architecture, security, and human-readable documentation:

1. **Architecture/security review** — review the async store interface design, Postgres query safety, HMAC implementation, Firm-scoping enforcement
2. **Review handoff and connection manual** — verify `docs/SCENTIC_AGPL_CONNECTION_MANUAL.md` is operator-ready and complete
3. **Review Scentic boundary** — verify no AGPL code exists in Scentic core, no Scentic proprietary code in AGPL repo
4. **Review claims/license/source-offer wording** — verify AGPL-3.0 compliance, source-offer completeness, OpenSign license inconsistency documentation
5. **Review provider/security assumptions** — verify Kimai team-based Firm isolation, OpenSign tenant-based Firm isolation, nonce replay prevention, idempotency guarantees
6. **Prepare human-readable operator checklist** — verify `docs/FINAL_OPERATOR_CHECKLIST.md` is actionable and complete

---

## 15. Guardrails

1. **Do not claim production readiness** — the status is explicitly "LOCAL DEPLOYMENT PACKAGE COMPLETE / PRODUCTION DEPLOYMENT NOT EXECUTED"
2. **Do not close blockers without real evidence** — every blocker in `docs/PRODUCTION_BLOCKERS.md` requires executed evidence to close
3. **Do not run destructive reset scripts without warning** — `scripts/local-reset.sh` deletes all volumes irreversibly
4. **Do not use real client data in tests** — tests must use generated data prefixed with `SCENTIC_TEST_` or random UUIDs
5. **Do not log secrets/signing links/document contents** — the gateway uses `redactSecret()` for all sensitive values in logs and status responses
6. **Do not expose Scentic proprietary code in AGPL source offer** — the source offer covers the AGPL repo only

---

## 16. Final Next Steps

1. **Initialize Kimai admin user locally** — create admin user in the Docker Kimai instance, generate API token, configure gateway
2. **Provision OpenSign PFX/dev cert** — create or obtain a dev PFX certificate for local OpenSign testing
3. **Run real local contract tests** — with Kimai admin and OpenSign PFX configured, run `GATEWAY_CONTRACT_TEST=true` contract tests
4. **Finalize source-offer URL** — decide on public repository URL for AGPL source-offer compliance
5. **Optionally deploy AGPL services to GCloud** — once GCP project is provisioned and all blockers are resolved
6. **Only then decide whether Yair implements Scentic-core integration** — Scentic core changes are gated on Yair's approval

---

## 17. Why the AGPL Services Must Remain Separate from Scentic Core

### The licensing problem

Kimai and OpenSign are both AGPL-3.0 licensed components. AGPL-3.0 is a strong copyleft license: it requires that anyone who interacts with the software over a network has the right to receive the complete corresponding source code. If AGPL-licensed code were imported into, linked with, or bundled inside the proprietary Scentic core, the copyleft obligations of AGPL-3.0 would extend to the entire Scentic core, effectively forcing Scentic core to become AGPL-licensed as well. This would destroy Scentic core's proprietary licensing posture.

### The separation solution

To use Kimai and OpenSign without contaminating the proprietary Scentic core, the AGPL services are maintained in a **completely separate repository** (`scentic-agpl-services`). This repository:

- Contains the AGPL gateway code, Kimai and OpenSign vendor clones, deployment files, and AGPL-side integration logic.
- Is itself AGPL-3.0 licensed, which is compatible with the upstream Kimai and OpenSign licenses.
- Communicates with Scentic core exclusively over a **network/API boundary** — REST routes and HMAC-signed webhook events.

Scentic core:

- Remains proprietary and separate.
- Must not import, link, bundle, copy, or depend on any AGPL code from the AGPL services repo.
- Must not import or reference `@scentic/*` packages from the AGPL repo (there are none — the AGPL repo has no Scentic proprietary dependencies).
- Communicates with the AGPL gateway only through the documented REST/webhook API contracts in `docs/SCENTIC_INTERFACE_SPEC.md`.

### What each repo may and may not contain

| Rule | AGPL repo | Scentic core |
|------|-----------|-------------|
| AGPL gateway code | May contain | Must not contain |
| Kimai/OpenSign vendor code | May contain | Must not contain |
| AGPL-licensed dependencies | May depend on | Must not depend on |
| Scentic proprietary code | Must not contain | May contain |
| `@scentic/*` packages | Must not import | May import |
| Direct code dependency on the other repo | Must not have | Must not have |
| Network/API dependency on the other repo | May have (as server) | May have (as client) |

### The network boundary is the correct boundary

The correct separation between AGPL services and proprietary Scentic core is a **network/API boundary**, not a code boundary. Scentic core calls the AGPL gateway over HTTP REST routes. The gateway calls back to Scentic core via HMAC-signed webhook events. Neither repo shares code, libraries, databases, or packages with the other. This is the same pattern used by many proprietary systems that integrate with AGPL services: the AGPL service runs as a separate process, and the proprietary system communicates with it over a documented API.

### Scentic-side changes are documentation-only

The AGPL repo documents exactly what Scentic core would need to change to integrate with the gateway (`docs/SCENTIC_CORE_REQUIRED_CHANGES.md`). These changes include:

- A new `AGPL_GATEWAY` signature provider type
- Environment variable schema validation for gateway connection
- A webhook receiver route to process events from the gateway
- Time-tracking proxy routes
- Provider health entries
- Audit events

**No agent may apply these changes to the Scentic core repository.** Only Yair may decide whether and when to implement them. Until then, the Scentic-side changes remain documentation-only in the AGPL repo.

### Source-offer scope

The AGPL source offer (required by AGPL-3.0 Section 13) covers the **AGPL repo only**. It includes:

- The gateway source code
- Upstream Kimai and OpenSign source (available at their public URLs, pinned in `docs/UPSTREAM_SOURCES.md`)
- Deployment files, scripts, and documentation
- No Scentic proprietary source code

The source-offer route (`GET /source`) provides license information, upstream references, and repository URL. The source-offer URL must be finalized before external network use.

### Future agents must not collapse the repos

Future agents (Claude Code, Codex, or any other) must not:

1. Move AGPL gateway code into the Scentic core repository
2. Move Kimai or OpenSign vendor code into the Scentic core repository
3. Create shared private packages between the two repos
4. Import AGPL-licensed dependencies into Scentic core
5. Import Scentic proprietary code into the AGPL repo
6. Create a monorepo that combines both repos
7. Weaken the network/API boundary in any way

The separation is intentional, legally motivated, and must be preserved.

---

## References

- `docs/AGPL_05_CLOSEOUT.md` — final phase closeout
- `docs/AGPL_05_EVIDENCE.md` — executed evidence
- `docs/AGPL_DEPLOYMENT_HANDOFF.md` — deployment handoff
- `docs/FINAL_OPERATOR_CHECKLIST.md` — operator checklist
- `docs/PRODUCTION_BLOCKERS.md` — production blockers
- `docs/SCENTIC_AGPL_CONNECTION_MANUAL.md` — operator-facing connection manual
- `docs/SCENTIC_CORE_REQUIRED_CHANGES.md` — Scentic-side changes (documentation only)
- `docs/SCENTIC_INTERFACE_SPEC.md` — interface specification (27 routes, 21 events)
- `docs/SCENTIC_ENV_VARS_REQUIRED.md` — environment variables
- `docs/API_CONTRACTS.md` — REST API contracts
- `docs/KIMAI_MAPPING.md` — Kimai entity mapping
- `docs/OPENSIGN_MAPPING.md` — OpenSign entity mapping
- `docs/DEPLOYMENT.md` — deployment guide
- `docs/SOURCE_OFFER.md` — AGPL source-offer compliance
- `docs/SECURITY_THREAT_MODEL.md` — security threat model
- `docs/NEXT_STEPS.md` — implementation roadmap
- `docs/UPSTREAM_SOURCES.md` — upstream source pinning
- `deploy/gcloud/` — GCloud deployment manifests
- `deploy/docker-compose.yml` — Docker local stack
