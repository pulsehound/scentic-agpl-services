# Scentic AGPL Integration Plan

**Phase:** AGPL-00 (Discovery / Architecture / Workspace Setup)
**Date:** 2026-07-31
**Status:** DISCOVERY / ARCHITECTURE / WORKSPACE SETUP COMPLETE

---

## 1. Objective

Create a separate AGPL-licensed integration stack that bridges the proprietary Scentic.ai legal operating system with two AGPL-licensed upstream applications:

- **Kimai** (AGPL-3.0-or-later) — time tracking for law firms
- **OpenSign** (AGPL-3.0) — e-signature workflows

The proprietary Scentic core must communicate with AGPL services only through stable REST/webhook API contracts via a gateway service. No AGPL code, AGPL dependencies, or AGPL-licensed modules may be imported, linked, bundled, copied, or depended upon inside the Scentic core repository.

---

## 2. Repositories

| Repository | License | Path | Purpose |
|------------|---------|------|---------|
| `scentic.ai` | Proprietary | `C:\AIprojects\factoryai\scentic.ai` | Scentic core (already live on GCloud) |
| `scentic-agpl-services` | AGPL-3.0 | `C:\AIprojects\factoryai\scentic-agpl-services` | AGPL integration stack (this repo) |

**Separation rules:**
- Scentic core does NOT import, link, bundle, copy, or depend on Kimai/OpenSign/AGPL bridge code
- AGPL repo does NOT import private Scentic packages (`@scentic/*`)
- No Scentic proprietary code is copied into the AGPL repo
- No AGPL dependencies are added to Scentic
- Communication is exclusively through REST/webhook/API contracts

---

## 3. Scentic Integration Surface (Inspected)

### 3.1 Signature provider abstraction

Scentic has a `SignatureProvider` interface in `packages/signature/src/types.ts` with methods:
- `sendEnvelope(params)` — send document for signature
- `getEnvelopeStatus(envelopeId)` — poll status
- `sendReminder(envelopeId, signerEmail)` — remind signer
- `cancelEnvelope(envelopeId, reason)` — void/cancel
- `delegateSigner(envelopeId, originalEmail, newEmail, newName?)` — reassign
- `downloadSignedDocument(envelopeId)` — get completed PDF
- `verifyWebhook(payload, headers)` — verify webhook authenticity

Factory: `createSignatureProvider({ providerType?, webhookSecret? })` in `packages/signature/src/signature-providers.ts`. Currently supports NULL (fail-closed) and MOCK (test-only). Production guard throws if MOCK and NODE_ENV=production.

**Integration point:** A new provider type `AGPL_GATEWAY` would be added to Scentic in a future phase. This provider would make HTTP calls to the AGPL gateway instead of directly to an e-signature service. The Scentic core change is limited to adding a new provider implementation that calls the gateway REST API.

### 3.2 Signature workflow lifecycle

1. `createWorkflow(prisma, { documentId, senderId, signers })` — authorizes sender (canSend), validates signers, creates SignatureWorkflow record (status: DRAFT)
2. `sendEnvelope` — downloads source file from Google Drive, sends to provider, updates workflow status
3. Webhook events — `processWebhook(prisma, provider, { payload, headers })` — verifies authenticity, deduplicates via unique constraint, updates workflow status, calls `completeSignatureWorkflow` on completion
4. `completeSignatureWorkflow` — downloads signed PDF from provider, stores as SIGNED_EXECUTION PhysicalFile under same DocumentVersion (no version increment), computes SHA-256 checksum, queues extraction

**Key invariants preserved by gateway integration:**
- Only edit-authorized users can create/send workflows
- Partially signed files never become managed Documents
- Fully signed PDF stored as SIGNED_EXECUTION under same DocumentVersion
- Source editable file preserved
- Full workflow history retained permanently
- External signers do not get Scentic/Google Drive access
- No unauthorized user can see workflow existence, signer info, or signed PDFs

### 3.3 Provider health

`ProviderTypeHealth` enum includes `SIGNATURE_PROVIDER` and `CALENDAR_PROVIDER`. The `checkProviderConfig` function checks env vars to determine status. The `productionBlocking` flag indicates whether a missing provider blocks production.

**Integration point:** A new `AGPL_GATEWAY` provider type could be added to `ProviderTypeHealth` to report gateway health. Or the existing `SIGNATURE_PROVIDER` type could be extended to check gateway URL availability.

### 3.4 Calendar provider abstraction

`CalendarProvider` interface with `createEvent`, `updateEvent`, `deleteEvent`, `syncEvents`. Currently NULL (fail-closed) and MOCK. No AGPL integration planned for calendar in AGPL-00.

### 3.5 Email filing

`parseEml(emlBuffer)` parses EML files. `fileEmail` creates a managed Document from an EML. No AGPL integration planned for email in AGPL-00.

### 3.6 API route conventions

Next.js App Router with RESTful patterns:
- `/api/signatures/create` — POST create workflow
- `/api/signatures/[workflowId]/send` — POST send envelope
- `/api/signatures/[workflowId]/status` — GET status
- `/api/signatures/webhook` — POST receive provider webhooks
- `/api/ops/provider-health` — GET provider health summary

### 3.7 Environment validation

`env-schema.ts` validates all env vars. Rejects MOCK in production. Requires private network URLs for sidecars. New env vars for AGPL gateway would need to be added.

### 3.8 Prisma schema

- `SignatureWorkflow` model with `providerType` (SignatureProviderType enum), `providerEnvelopeId`, status, participants, events
- `ProviderMapping` model for mapping Scentic entities to external provider objects
- `SignatureProviderType` enum currently: `MOCK`, `NULL` (and potentially DOCUSIGN, DOCSKETCH, NATIVE)

### 3.9 GCloud deployment assumptions

Scentic core is already running on GCloud. The AGPL services will be deployed in a separate GCP project (recommended) or as separate services in the same project.

---

## 4. Upstream Repo Inspection

### 4.1 Kimai

| Aspect | Details |
|--------|---------|
| License | AGPL-3.0-or-later |
| Stack | PHP 8.2+, Symfony 6, Doctrine ORM, MySQL/MariaDB (utf8mb4) |
| API | Full REST API at `/api` with Swagger docs at `/api/doc`. FOSRestBundle + JMS Serializer + OpenAPI |
| Auth | API access tokens (preferred), API passwords (deprecated), SAML SSO, LDAP, TOTP 2FA |
| Entity model | User → Customer → Project → Activity → Timesheet. Teams for grouping. Meta fields on all entities. Budgets, rates, colors |
| Plugins | Composer artifact packages in `var/packages/`. Plugin bundles implementing `PluginInterface` |
| Events | 100+ Symfony events (Create/Update/Delete for all entities). Webhook attribute system (`AsWebhook` attribute) |
| Docker | Multi-stage Dockerfile: `kimai/kimai2:fpm` and `kimai/kimai2:apache`. Entrypoint script. No docker-compose in repo |
| Database | MySQL or MariaDB. `DATABASE_URL` env var. Doctrine migrations |
| Env vars | `DATABASE_URL`, `MAILER_FROM`, `MAILER_URL`, `APP_ENV`, `APP_SECRET`, `CORS_ALLOW_ORIGIN` |
| Upgrade | `UPGRADING.md` + Doctrine migrations. Plugin reinstall on major upgrades |

### 4.2 OpenSign

| Aspect | Details |
|--------|---------|
| License | AGPL-3.0 (repo-level). OpenSignServer package.json declares MIT — inconsistency to investigate |
| Stack | React 19 + Parse Server 8 + Express 5 + MongoDB + S3-compatible storage |
| API | Parse Server REST at `/app/functions/<name>`. ~50 Cloud Functions. Headers: `X-Parse-Application-Id`, `X-Parse-Session-Token` |
| Auth | Parse username/password + session tokens, Google OAuth, SSO adapter, OTP/2FA (speakeasy) |
| Entity model | `contracts_Document` (Name, SignedUrl, CertificateUrl, IsCompleted, Signers, Placeholders, AuditTrail, ExpiryDate, etc.), `contracts_Template`, `contracts_Signature`, `contracts_Contactbook`, `contracts_Users`, `contracts_Teams`, `partners_Tenant` |
| Webhooks | **NO native webhook support.** Must poll `getDocument` or use WebSocket. Custom fork needed for webhook dispatch |
| Completed PDF | `SignedUrl` and `CertificateUrl` fields. Presigned S3 URLs (160s TTL) or JWT-signed local URLs (200s TTL) |
| Database | MongoDB (`MONGODB_URI` or `DATABASE_URI`) |
| Storage | S3-compatible (DigitalOcean Spaces, AWS S3) or local filesystem (`USE_LOCAL=TRUE`) |
| Email | Mailgun (`MAILGUN_*`) or SMTP (`SMTP_*`). Used for signer invitations, completion notifications, OTP |
| PDF signing | `@signpdf/signpdf` + PFX/p12 certificate (`PFX_BASE64`, `PASS_PHRASE`) |
| Docker | `docker-compose.yml` with server, mongo, client, caddy. Dockerfiles for each app |
| Env vars | `APP_ID`, `MASTER_KEY`, `MONGODB_URI`, `SERVER_URL`, `PARSE_MOUNT`, `DO_SPACE`, `MAILGUN_*` or `SMTP_*`, `PFX_BASE64`, `PASS_PHRASE` |
| Upgrade | Auto-running migration scripts on startup. `standard-version` for semver. No CHANGELOG.md |

---

## 5. Proposed Repository Structure

```
scentic-agpl-services/
  ├─ gateway/
  │   ├─ api/              # Express route handlers
  │   ├─ auth/             # Service-to-service auth middleware
  │   ├─ kimai/            # Kimai API client and mapping logic
  │   ├─ opensign/         # OpenSign API client and mapping logic
  │   ├─ mappings/         # Entity mapping store and sync logic
  │   ├─ webhooks/         # Webhook dispatch to Scentic core
  │   ├─ source-offer/     # AGPL source-offer endpoint
  │   ├─ tests/            # Gateway unit and integration tests
  │   └─ package.json      # Gateway dependencies (Express, no @scentic/* packages)
  ├─ vendor/
  │   ├─ kimai/            # Upstream Kimai (git clone, shallow)
  │   └─ opensign/         # Upstream OpenSign (git clone, shallow)
  ├─ deploy/
  │   ├─ docker-compose.yml  # Local dev: gateway + Kimai + OpenSign + MySQL + MongoDB
  │   ├─ gcloud/            # GCloud deployment configs (Cloud Run, GCE, Cloud SQL)
  │   ├─ cloud-run/         # Cloud Run service definitions
  │   ├─ secrets.example.md # Secret naming convention (no actual secrets)
  │   └─ env.example        # Deployment env template
  ├─ docs/
  │   ├─ SCENTIC_AGPL_INTEGRATION_PLAN.md    # This file
  │   ├─ SCENTIC_AGPL_CONNECTION_MANUAL.md   # Operator-facing connection guide
  │   ├─ API_CONTRACTS.md                     # REST API contracts
  │   ├─ KIMAI_MAPPING.md                     # Scentic → Kimai entity mappings
  │   ├─ OPENSIGN_MAPPING.md                  # Scentic → OpenSign entity mappings
  │   ├─ DEPLOYMENT.md                        # GCloud deployment plan
  │   ├─ SOURCE_OFFER.md                      # AGPL source offer compliance
  │   ├─ SECURITY_THREAT_MODEL.md             # Security threat model
  │   └─ NEXT_STEPS.md                        # Implementation roadmap
  ├─ scripts/
  │   ├─ setup.sh            # Initial setup script
  │   └─ update-vendor.sh    # Update upstream Kimai/OpenSign
  ├─ LICENSE                 # AGPL-3.0
  ├─ README.md
  ├─ .env.example
  └─ .gitignore
```

---

## 6. Gateway Architecture

### 6.1 Runtime shape

```
Scentic core (proprietary, GCloud)
  |
  | REST / webhook (X-Scentic-Service-Token, X-Idempotency-Key, X-Correlation-Id)
  v
scentic-agpl-services gateway (AGPL, Node.js/Express)
  |                         |
  | Kimai REST API           | Parse Server REST API
  | (API token auth)         | (X-Parse-Session-Token)
  v                         v
Kimai (AGPL)            OpenSign (AGPL)
PHP/Symfony/MySQL       Node.js/Parse/MongoDB
```

### 6.2 Why Scentic calls the gateway, not Kimai/OpenSign directly

1. **License separation:** Scentic core must not depend on AGPL code. The gateway is the AGPL boundary.
2. **Multi-Firm scoping:** The gateway enforces Firm-scoped access. Every request includes Firm context. The gateway verifies Firm/User/Matter/Document mapping before calling Kimai/OpenSign.
3. **Data minimization:** The gateway strips unnecessary data before sending to Kimai/OpenSign. Matter names can be replaced with codes. Document content is sent to OpenSign only when needed for signature.
4. **Webhook gap:** OpenSign has no native webhooks. The gateway polls OpenSign and dispatches signed webhooks to Scentic. Scentic does not need to know about the polling mechanism.
5. **Abstraction:** If Kimai or OpenSign is replaced with a different provider, only the gateway changes. Scentic's API contract remains stable.
6. **Security:** The gateway provides a single controlled entry point. Direct access to Kimai/OpenSign can be network-restricted to only accept connections from the gateway.

### 6.3 Gateway responsibilities

1. **Service-to-service auth:** Verify `X-Scentic-Service-Token` on every request from Scentic
2. **Firm/User/Matter scoping:** Every API call includes Firm context. Gateway verifies mappings exist before calling Kimai/OpenSign
3. **Entity mapping:** Maintain mapping table: Scentic entity ID ↔ Kimai/OpenSign entity ID
4. **Kimai API client:** Translate Scentic time tracking requests to Kimai REST API calls
5. **OpenSign API client:** Translate Scentic signature requests to OpenSign Parse Server calls
6. **Webhook dispatch:** Poll OpenSign for completion, dispatch signed webhooks to Scentic
7. **Source offer:** Serve AGPL source offer at `/source-offer` endpoint
8. **Health reporting:** Report gateway + Kimai + OpenSign health at `/health`
9. **Audit logging:** Log all gateway operations with correlation IDs
10. **Data minimization:** Strip unnecessary data before sending to external services

---

## 7. Scentic Multi-Firm / Multi-User Mapping

### 7.1 Kimai mappings

| Scentic Entity | Kimai Entity | Mapping Key | Notes |
|----------------|-------------|-------------|-------|
| Firm | Team | team.name = Firm code | Firm-scoped isolation via team membership |
| User | User | user.username = Scentic user ID | API token per user; one Scentic user may map to one Kimai user |
| Client | Customer | customer.name = Client name or code | Team-scoped; only Firm's team sees this customer |
| Matter | Project | project.name = Matter code (configurable) | Under Customer; team-scoped; minimal matter data |
| Activity type | Activity | activity.name = Scentic task type | Global or project-specific |
| Time entry | Timesheet | timesheet.user/project/activity/duration | User, project, activity, start, end, description |

**Data minimization for Kimai:**
- Matter name → configurable code/label (Firm admin chooses what to send)
- Document content → NEVER sent to Kimai
- Signer info → NEVER sent to Kimai
- Legal hold status → NEVER sent to Kimai
- Only time tracking data (duration, activity, project, description) is sent

### 7.2 OpenSign mappings

| Scentic Entity | OpenSign Entity | Mapping Key | Notes |
|----------------|----------------|-------------|-------|
| Firm | partners_Tenant + contracts_Teams | tenant_id per Firm | Firm-scoped isolation via tenant + ACLs |
| User | contracts_Users | user linked to _User | Session token per user; sender/admin mapping |
| Matter | Document metadata | metadata.matterId, metadata.firmId | Not a direct entity; attached to document for context |
| DocumentVersion/PhysicalFile | contracts_Document | document.Name = SCT number or filename | Upload PDF for signing; deleted after completion (configurable) |
| SignatureWorkflow | OpenSign signing workflow | workflow created via createDocumentFromApp | Signers, placeholders, expiry, reminders |
| SignatureParticipant | Signers array | signer.email, signer.name | External signers; no Scentic access |
| Completed PDF | SIGNED_EXECUTION PhysicalFile | gateway downloads via SignedUrl, sends to Scentic | Same DocumentVersion, no version increment |
| Audit certificate | SignatureEvent | gateway downloads via CertificateUrl, sends to Scentic | Permanent history record |

**Data minimization for OpenSign:**
- Document content → sent only for signature, deleted after completion (configurable retention)
- Matter name → replaced with SCT number or configurable code
- Client name → NEVER sent to OpenSign
- Other matter details → NEVER sent to OpenSign
- Only signer emails, names, and the PDF file are sent

### 7.3 Authorization constraints

- Wrong Firm must never see another Firm's Kimai/OpenSign records
- One Scentic user may belong to multiple Firms; mapping must be Firm-scoped (separate Kimai user per Firm or team-scoped access)
- External app IDs are stored as provider mappings in the gateway, not trusted as authorization
- Scentic remains source of truth for authorization
- Gateway must verify Firm/User/Matter/Document context on every call
- No direct OpenSign/Kimai callback may write into Scentic without signature verification and Scentic-side authorization
- No external app may receive broader Scentic legal data than required
- Document contents sent to OpenSign only when needed for signature
- Kimai receives minimal Matter data (codes/labels configurable by Firm)

---

## 8. Required Changes

### 8.1 Scentic-side changes (future phases, not in AGPL-00)

| Change | Package/File | Description |
|--------|-------------|-------------|
| New SignatureProviderType | `packages/db/prisma/schema.prisma` | Add `AGPL_GATEWAY` to `SignatureProviderType` enum |
| AGPL gateway signature provider | `packages/signature/src/agpl-gateway-provider.ts` (new) | Implements `SignatureProvider` interface, calls gateway REST API |
| Provider factory update | `packages/signature/src/signature-providers.ts` | Add `AGPL_GATEWAY` case to `createSignatureProvider` |
| Env vars | `.env.example`, `packages/infra/src/env-schema.ts` | Add `SCENTIC_AGPL_GATEWAY_URL`, `SCENTIC_AGPL_SERVICE_TOKEN`, `SCENTIC_AGPL_WEBHOOK_SECRET` |
| Provider health | `packages/ops/src/provider-health-service.ts`, `types.ts` | Add `AGPL_GATEWAY` to `ProviderTypeHealth`, check gateway URL |
| Webhook receiver | `apps/web/src/app/api/agpl/webhooks/events/route.ts` (new) | Receive signed webhooks from gateway, verify signature |
| Time tracking API routes | `apps/web/src/app/api/time-tracking/` (new) | CRUD for time entries via gateway |
| UI: time tracking page | `apps/web/src/app/time-tracking/page.tsx` (new) | Time tracking UI (new feature) |
| UI: settings page | `apps/web/src/app/settings/page.tsx` | Add AGPL gateway status to provider list |

**Important:** These changes are NOT made in AGPL-00. They are documented here as the plan for future phases. Scentic core is only inspected read-only in AGPL-00.

### 8.2 AGPL gateway changes (AGPL-01 onward)

| Change | File | Description |
|--------|------|-------------|
| Gateway app skeleton | `gateway/package.json`, `gateway/src/index.ts` | Express app with health, auth, source-offer endpoints |
| Service-to-service auth | `gateway/auth/middleware.ts` | Verify X-Scentic-Service-Token |
| Kimai API client | `gateway/kimai/client.ts` | HTTP client for Kimai REST API |
| OpenSign API client | `gateway/opensign/client.ts` | HTTP client for Parse Server REST API |
| Mapping store | `gateway/mappings/store.ts` | SQLite or in-memory mapping table |
| Time tracking routes | `gateway/api/kimai-routes.ts` | REST endpoints for time tracking |
| Signature routes | `gateway/api/opensign-routes.ts` | REST endpoints for signature workflows |
| Webhook dispatch | `gateway/webhooks/dispatch.ts` | Send signed webhooks to Scentic core |
| OpenSign polling | `gateway/opensign/poller.ts` | Poll OpenSign for completion, dispatch webhooks |
| Tests | `gateway/tests/` | Unit and integration tests |

### 8.3 Kimai changes

No modifications to Kimai source are required for basic integration. Kimai's REST API and team-based access control are sufficient. If deeper integration is needed later (e.g., custom webhook dispatch), a Kimai plugin can be developed and placed in `var/packages/`.

| Change | Type | Description |
|--------|------|-------------|
| Team creation per Firm | API call (no source change) | Create Kimai team for each Scentic Firm |
| API token per user | API call (no source change) | Create Kimai API token for each Scentic user |
| CORS configuration | Env var `CORS_ALLOW_ORIGIN` | Allow gateway origin |
| Optional: webhook plugin | Future plugin | Symfony event subscriber that dispatches webhooks to gateway |

### 8.4 OpenSign changes

OpenSign has no native webhook support. For completion detection, two options:

**Option A: Gateway polling (recommended for AGPL-01):**
- No OpenSign source modifications needed
- Gateway polls `getDocument` Cloud Function at intervals (e.g., every 30 seconds for active workflows)
- On completion, gateway downloads signed PDF and dispatches webhook to Scentic

**Option B: OpenSign fork with webhook dispatch (future):**
- Add a webhook dispatch in `DocumentAftersave.js` or the `signPdf` completion path
- Fork OpenSign and maintain the fork in `vendor/opensign-fork/`
- Track modifications as patches in `patches/opensign/`

For AGPL-00, Option A is recommended. No OpenSign source modifications are needed.

| Change | Type | Description |
|--------|------|-------------|
| Tenant per Firm | API call (no source change) | Create partners_Tenant for each Scentic Firm |
| User per Scentic user | API call (no source change) | Create OpenSign user for each Scentic user |
| Email configuration | Env vars | Configure Mailgun or SMTP for signer notifications |
| PFX certificate | Env vars | Configure PDF signing certificate |
| Optional: webhook fork | Future fork | Add webhook dispatch to OpenSign completion path |

### 8.5 Deployment files

| File | Description |
|------|-------------|
| `deploy/docker-compose.yml` | Local dev: gateway + Kimai + MySQL + OpenSign + MongoDB |
| `deploy/gcloud/terraform/` | GCloud IaC (future, AGPL-04) |
| `deploy/cloud-run/gateway.yaml` | Cloud Run service definition for gateway |
| `deploy/cloud-run/kimai.yaml` | Cloud Run service definition for Kimai |
| `deploy/cloud-run/opensign.yaml` | Cloud Run service definition for OpenSign |
| `deploy/secrets.example.md` | Secret naming convention documentation |

### 8.6 Connection manual

See `docs/SCENTIC_AGPL_CONNECTION_MANUAL.md` for the operator-facing connection guide.

---

## 9. Deployment Architecture (GCloud)

### Recommended: Option B — Separate GCP Project

**Rationale:**
1. **Licensing separation:** A separate GCP project provides a clear operational and billing boundary between proprietary Scentic and AGPL services
2. **Security isolation:** Separate service accounts, IAM policies, and network rules
3. **Secret isolation:** Secrets in GCloud Secret Manager are project-scoped
4. **Billing clarity:** AGPL service costs are tracked separately
5. **AGPL compliance:** Clear boundary strengthens the argument that AGPL code is not combined with proprietary code

**Architecture:**

```
GCP Project: scentic-prod (existing)
  └─ Scentic core (Cloud Run / GCE)
      - Next.js app
      - PostgreSQL (Cloud SQL)
      - Redis (Memorystore)
      - Google Workspace integration

GCP Project: scentic-agpl-prod (new)
  ├─ Gateway (Cloud Run, internal-only)
  │   - Node.js/Express
  │   - No database (stateless, uses Kimai/OpenSign APIs)
  ├─ Kimai (Cloud Run / GCE)
  │   - PHP 8.2 / Symfony 6 / Apache
  │   - MySQL (Cloud SQL MySQL)
  ├─ OpenSign Server (Cloud Run / GCE)
  │   - Node.js / Parse Server / Express
  │   - MongoDB (MongoDB Atlas or self-hosted GCE)
  │   - File storage (GCS bucket)
  ├─ OpenSign Frontend (Cloud Run, public for signing pages)
  │   - React app
  └─ Networking
      - VPC with private subnets
      - VPC peering to scentic-prod (for Scentic → Gateway communication)
      - Internal Load Balancer for gateway
      - No public IPs for gateway, Kimai, or OpenSign server
      - Public IP only for OpenSign frontend (signing pages)
```

**Communication flow:**
1. Scentic core → Gateway: via VPC peering + Internal Load Balancer (internal IP, no public exposure)
2. Gateway → Kimai: via internal network (same VPC)
3. Gateway → OpenSign: via internal network (same VPC)
4. Gateway → Scentic core (webhooks): via VPC peering (internal)
5. OpenSign frontend → OpenSign server: via internal network
6. Signers → OpenSign frontend: via public internet (HTTPS, Caddy reverse proxy)

See `docs/DEPLOYMENT.md` for full deployment plan.

---

## 10. Interface Contract Summary

See `docs/API_CONTRACTS.md` for full REST API contracts. Summary:

### Authentication
- Service-to-service: `X-Scentic-Service-Token` header (shared secret, rotated via admin endpoint)
- Webhook verification: HMAC-SHA256 signature in `X-Gateway-Signature` header
- Idempotency: `X-Idempotency-Key` header on all POST/PUT/DELETE
- Correlation: `X-Correlation-Id` header on all requests/responses

### Endpoint groups
1. **Auth & Admin:** /auth/verify, /health, /admin/init-firm, /admin/disable-firm, /admin/rotate-secret, /source-offer
2. **Time Tracking (Kimai):** /kimai/firm/{firmId}/mappings/*, /kimai/firm/{firmId}/time-entries/*
3. **Signature (OpenSign):** /opensign/firm/{firmId}/workflows/*
4. **Webhooks (→ Scentic):** /webhooks/opensign/events, /webhooks/kimai/events

### Error codes
400 INVALID_INPUT, 401 UNAUTHORIZED, 403 FORBIDDEN, 404 NOT_FOUND, 409 CONFLICT, 429 RATE_LIMITED, 500 INTERNAL, 502 BAD_GATEWAY, 503 UNAVAILABLE

---

## 11. Security Threat Model Summary

See `docs/SECURITY_THREAT_MODEL.md` for full threat model. Key threats:

| ID | Threat | Severity | Key Control |
|----|--------|----------|-------------|
| T-01 | Cross-Firm leakage via Kimai customer/project names | HIGH | Team-scoped access; gateway verifies Firm context |
| T-02 | Cross-Firm leakage via OpenSign document titles/signers | HIGH | Tenant + ACL isolation; gateway verifies Firm context |
| T-03 | Webhook spoofing (forged gateway → Scentic) | CRITICAL | HMAC-SHA256 signature verification |
| T-04 | Replay attacks | HIGH | Idempotency keys + timestamp window + nonce |
| T-05 | Stale mappings (deleted entities still active) | MEDIUM | Sync on every call; periodic reconciliation |
| T-06 | User removed but still active in Kimai/OpenSign | MEDIUM | Gateway checks Scentic user status; disable on suspend/offboard |
| T-07 | Firm offboarded but AGPL records accessible | MEDIUM | Admin disable-firm endpoint; gateway blocks requests for disabled Firms |
| T-08 | Direct access to Kimai/OpenSign bypassing gateway | HIGH | Network isolation; Kimai/OpenSign only accept gateway IP |
| T-09 | Email notifications leaking matter names | MEDIUM | Data minimization; configurable codes instead of real names |
| T-10 | OpenSign completed PDF injection/tampering | HIGH | SHA-256 checksum verification; PDF validation |
| T-11 | Kimai time entry injection | MEDIUM | Gateway enforces Firm/User context; no direct Kimai API access |
| T-12 | Overbroad service account | MEDIUM | Per-Firm scoped credentials; least privilege |
| T-13 | Source-offer exposing proprietary code | MEDIUM | Source-offer only serves AGPL repo contents; no Scentic code |
| T-14 | Logs containing document contents/signers/matter names | HIGH | Log sanitization; no document content in logs |
| T-15 | AGPL license contamination | CRITICAL | No AGPL imports in Scentic; separate repos; CI license scan |
| T-16 | OpenSign MASTER_KEY compromise | HIGH | Key rotation; key in Secret Manager; network isolation |

---

## 12. AGPL-00 Deliverables

| Deliverable | Status | Path |
|-------------|--------|------|
| AGPL workspace created | DONE | `C:\AIprojects\factoryai\scentic-agpl-services` |
| Git repo initialized | DONE | `.git/` |
| Kimai cloned | DONE | `vendor/kimai/` |
| OpenSign cloned | DONE | `vendor/opensign/` |
| LICENSE (AGPL-3.0) | DONE | `LICENSE` |
| README.md | DONE | `README.md` |
| .env.example | DONE | `.env.example` |
| .gitignore | DONE | `.gitignore` |
| Directory structure | DONE | `gateway/`, `vendor/`, `deploy/`, `docs/`, `scripts/` |
| Integration plan | DONE | `docs/SCENTIC_AGPL_INTEGRATION_PLAN.md` (this file) |
| API contracts | DONE | `docs/API_CONTRACTS.md` |
| Kimai mapping | DONE | `docs/KIMAI_MAPPING.md` |
| OpenSign mapping | DONE | `docs/OPENSIGN_MAPPING.md` |
| Deployment plan | DONE | `docs/DEPLOYMENT.md` |
| Connection manual | DONE | `docs/SCENTIC_AGPL_CONNECTION_MANUAL.md` |
| Source offer | DONE | `docs/SOURCE_OFFER.md` |
| Security threat model | DONE | `docs/SECURITY_THREAT_MODEL.md` |
| Next steps | DONE | `docs/NEXT_STEPS.md` |

---

## 13. Validation

| Check | Result |
|-------|--------|
| Scentic repo not modified | PASS (read-only inspection only) |
| AGPL workspace created | PASS |
| Kimai cloned | PASS (shallow clone, AGPL-3.0-or-later) |
| OpenSign cloned | PASS (shallow clone, AGPL-3.0) |
| LICENSE file present | PASS (AGPL-3.0) |
| No Scentic proprietary code in AGPL repo | PASS |
| No @scentic/* package dependencies | PASS (no package.json in gateway yet) |
| No AGPL dependencies in Scentic | PASS (Scentic not modified) |
| Directory structure matches plan | PASS |
| All docs created | PASS |

---

## 14. AGPL-00 Final Status

**DISCOVERY / ARCHITECTURE / WORKSPACE SETUP COMPLETE**

- Scentic integration surface fully inspected
- Kimai and OpenSign repos cloned and inspected
- Gateway architecture designed
- API contracts defined
- Entity mappings designed
- Deployment plan recommended (separate GCP project)
- Security threat model created
- Source offer compliance structure planned
- All required docs created
- No Scentic core modifications made
- No invasive code changes made (scaffold only)

**Next step:** Wait for approval before proceeding to AGPL-01 (gateway skeleton + Kimai integration).
