# AGPL Services — Next Steps & Implementation Roadmap

> **Status:** Planning document. Tracks the phased implementation of the Scentic AGPL services stack (gateway + Kimai + OpenSign) and the required Scentic core changes.
>
> **Current phase:** AGPL-03 COMPLETE — AGPL-04 (Deployment and production readiness) is next.

---

## 1. AGPL-00 status

**DISCOVERY / ARCHITECTURE / WORKSPACE SETUP — COMPLETE**

Completed in AGPL-00:

- Repository workspace established (`scentic-agpl-services`): `gateway/`, `vendor/kimai/`, `vendor/opensign/`, `deploy/`, `scripts/`, `docs/`, `.env.example`, `LICENSE` (AGPL-3.0).
- Architecture decision: separate GCP project (`scentic-agpl-prod`) for AGPL services (see `docs/DEPLOYMENT.md`).
- AGPL source-offer compliance plan defined (see `docs/SOURCE_OFFER.md`).
- Operator connection manual drafted (see `docs/SCENTIC_AGPL_CONNECTION_MANUAL.md`).
- API contract surface scoped (to be detailed in `docs/API_CONTRACTS.md`).

Not yet done (handed off to the phases below): gateway implementation, Kimai/OpenSign clients, Scentic core adapter, deployment, and source-offer verification.

---

## 2. AGPL-01 — Gateway skeleton + Kimai integration

**STATUS: COMPLETE** — Gateway skeleton + Kimai integration foundation delivered. See `docs/AGPL_01_CLOSEOUT.md` and `docs/AGPL_01_EVIDENCE.md`.

### Deliverables

- Create the gateway Node.js/Express application in `gateway/` (TypeScript or JavaScript per repo convention; lint, format, tests).
- Implement **service-to-service auth** middleware: validate `Authorization: Bearer <SCENTIC_AGPL_SERVICE_TOKEN>` on every non-public route (`/health` and `/source-offer` are public). Constant-time comparison.
- Implement the **Kimai API client** (REST) in `gateway/src/kimai/`:
  - Base URL + API token from env.
  - Endpoints used: teams, users, customers, projects, activities, timesheets.
  - Typed response wrappers and error normalization.
- Implement **mapping CRUD** in `gateway/src/mappings/` for:
  - Firm → Kimai team (+ OpenSign tenant placeholder for AGPL-02).
  - User → Kimai user.
  - Client → Kimai customer.
  - Matter → Kimai project.
- Implement **time entry CRUD** in `gateway/src/time/`:
  - Create / list / update / delete timesheet entries against Kimai.
  - Map Scentic user/matter/activity to Kimai user/project/activity.
- Implement `GET /health` (with `deps.kimai`), `POST /auth/verify`, and the mapping + time routes per `docs/API_CONTRACTS.md`.

### What was delivered in AGPL-01

- Gateway Node.js/Express/TypeScript app with Vitest (35 tests).
- HMAC service-to-service auth (timestamp, nonce, signature, firm scoping, constant-time compare).
- In-memory mapping store (Firm, User, Client, Matter, Activity, TimeEntry) with cross-firm leakage prevention.
- Kimai API client (endpoints verified against `vendor/kimai/` source).
- Kimai service with firm-scoped operations and confidential label mode.
- REST endpoints: health, source-offer, firm init, user/client/matter/activity sync, time entry CRUD, export, admin.
- Event outbox for future webhook dispatch to Scentic.
- Upstream source pinning (`docs/UPSTREAM_SOURCES.md`).
- Config/env validation with production checks.
- Scentic core: NOT MODIFIED (read-only inspection only).
- OpenSign: NOT MODIFIED (AGPL-02 scope).

### Remaining gaps (carry forward to AGPL-04)

- Per-user Kimai API token (currently uses `KIMAI_ADMIN_API_TOKEN` fallback).
- In-memory nonce store (production needs Redis).
- In-memory mapping store (production needs SQLite/Postgres).
- No real-Kimai contract test yet (mock only).

### Tests

- Unit tests for Kimai client (mocked Kimai HTTP).
- Unit tests for mapping CRUD and time entry CRUD.
- Contract tests against a real Kimai Docker instance (CI) covering the full mapping + time-entry lifecycle for at least one Firm/User/Client/Matter.
- Auth negative tests (missing/invalid/expired token, timing attack resistance).
- Cross-firm leakage negative tests (Firm A cannot read/modify Firm B mappings or time entries).

### Exit criteria

- Gateway skeleton runs locally via `docker compose up`.
- `GET /health` returns `deps.kimai=ok` against a real Kimai container.
- Mapping + time-entry contract tests pass against real Kimai.

> **Note:** Real-Kimai contract test is a carried gap (mock-only in AGPL-01); it must land before AGPL-04 production readiness.

---

## 3. AGPL-02 — OpenSign integration

**STATUS: COMPLETE** — OpenSign integration foundation delivered. See `docs/AGPL_02_CLOSEOUT.md` and `docs/AGPL_02_EVIDENCE.md`.

### Deliverables

- Implement the **OpenSign API client** (Parse Server REST) in `gateway/src/opensign/`:
  - Base URL + `APP_ID` + `MASTER_KEY` from env. `MASTER_KEY` is server-side only.
  - Endpoints used: tenants, templates, envelopes (create, send, status, cancel, download).
- Implement the **signing workflow** in `gateway/src/signatures/`:
  - `create` — create an envelope from a template or ad-hoc document, attach signers.
  - `send` — dispatch to signers (OpenSign delivers email links).
  - `status` — query envelope status.
  - `cancel` — cancel an in-flight envelope.
  - `download` — fetch the signed PDF + audit trail.
- Implement **polling for completion detection**:
  - A worker polls OpenSign at `OPENSIGN_POLL_INTERVAL_MS` for envelope state changes.
  - On terminal state (completed / declined / expired), enqueue a webhook dispatch.
- Implement **webhook dispatch to Scentic**:
  - `POST {SCENTIC_CORE_URL}/api/agpl/webhooks/events` with HMAC signature using `SCENTIC_AGPL_WEBHOOK_SECRET`.
  - Retry with exponential backoff; idempotent event ids.
- Update `GET /health` to include `deps.opensign`.

### Tests

- Unit tests for OpenSign client (mocked Parse REST).
- Unit tests for signature workflow and polling worker.
- Webhook signature verification tests (valid signature accepted; tampered body / wrong secret rejected).
- Contract tests against a real OpenSign Docker instance (CI): create → send → poll → completed → webhook delivered.
- Download integrity test (signed PDF + audit trail match OpenSign output).

### Exit criteria

- Full signature lifecycle contract test passes against real OpenSign.
- Webhook dispatched to a test receiver with a valid HMAC signature on terminal status.

### What was delivered in AGPL-02

- OpenSign API client (`gateway/src/opensign/opensign-client.ts`) wrapping the Parse Server REST API; endpoints verified against `vendor/opensign/` source (login, createTenant, addUser, uploadFile, createDocument, getDocument, linkContactToDoc, declineDocument, getSignedUrl, generateCertificate).
- OpenSign service (`gateway/src/opensign/opensign-service.ts`) with firm-scoped operations, polling model, and idempotent firm init / user sync.
- 11 signature REST endpoints (`gateway/src/routes/signature.ts`): health, init, users/sync, workflows (create/get/send/cancel/remind/poll/completed/poll-due).
- Extended mapping store with OpenSign entity types (Firm/User/Workflow/Signer), firm-scoped.
- Extended event outbox with 12 OpenSign event types.
- Config/env validation for OpenSign (`OPENSIGN_ENABLED`, `OPENSIGN_BASE_URL`, `OPENSIGN_APP_ID`, `OPENSIGN_MASTER_KEY`, `OPENSIGN_ADMIN_EMAIL`, `OPENSIGN_ADMIN_PASSWORD`, `OPENSIGN_POLL_INTERVAL_SECONDS`, `OPENSIGN_COMPLETION_TIMEOUT_SECONDS`) with production checks.
- AGPL-01 fixes carried in: auth middleware `extractFirmIdFromPath` path-firm check; bodyless request canonical hash documented (`{}`).
- Source offer updated with OpenSign license inconsistency note (root AGPL-3.0 vs `package.json` MIT; treated as AGPL-3.0).
- OpenSign unsupported operations documented (manual reminders `NOT_SUPPORTED`, no native void/cancel — uses `declinedoc`, no native webhooks — polling).
- Scentic core: NOT MODIFIED (read-only inspection only).
- OpenSign upstream: NOT MODIFIED (at pinned SHA `f72624fa26211fe00776453d99a67120a4f5e060`).

### Remaining gaps (carry forward to AGPL-03 / AGPL-04)

- Per-user OpenSign session tokens (currently uses master key for all operations).
- In-memory mapping store (production needs SQLite/Postgres).
- Mock-only OpenSign tests (no real-OpenSign container contract test yet).
- Webhook dispatch to Scentic (outbox records events; dispatch is AGPL-03 scope).

---

## 4. AGPL-03 — Scentic-side provider adapters

**STATUS: COMPLETE** — Local deployment + connection interface documentation delivered. See `docs/AGPL_03_CLOSEOUT.md` and `docs/AGPL_03_EVIDENCE.md`.

> **Depends on AGPL-01 and AGPL-02** (both COMPLETE).

### Scope note (revised at closeout)

AGPL-03 was originally scoped to land Scentic-core-side code (provider type, env-schema, webhook receiver, time-tracking routes, provider-health entry). At closeout, AGPL-03 was reframed as **local deployment + connection interface documentation only**. No Scentic proprietary core file was modified (read-only inspection). The full Scentic-side change specification is documented in `docs/SCENTIC_CORE_REQUIRED_CHANGES.md` for Yair to land when he decides to integrate.

### Deliverables (gateway side — delivered)

- **Webhook dispatcher** (`gateway/src/events/webhook-dispatcher.ts`): HMAC-SHA256 signed outbound webhooks to `{SCENTIC_WEBHOOK_TARGET_URL}`, exponential backoff retry, idempotency key per event, disabled safely when target URL/secret not configured, no document contents/signing links/raw signer emails in payloads.
- **Webhook signer** (`gateway/src/events/webhook-signer.ts`): canonical-string HMAC signing with `X-Gateway-*` headers (`sha256=` prefix, constant-time verify by receiver).
- **Webhook types** (`gateway/src/events/webhook-types.ts`): `WebhookPayload`, `WebhookHeaders`, dispatch status types.
- **Local deployment** (`deploy/docker-compose.yml` + `docs/SCENTIC_AGPL_CONNECTION_MANUAL.md` §12): full stack (gateway + Kimai + OpenSign + MongoDB + MariaDB) runnable locally.
- **Interface documentation** (new): `docs/SCENTIC_INTERFACE_SPEC.md` (27 Scentic→Gateway routes + 21 webhook events + HMAC rules both directions + error codes + retry + data minimization + multi-firm mapping), `docs/SCENTIC_CORE_REQUIRED_CHANGES.md` (Scentic-side changes, documentation only), `docs/SCENTIC_ENV_VARS_REQUIRED.md` (Scentic-side env vars).

### Deliverables (Scentic core side — documentation only, NOT applied)

All described in `docs/SCENTIC_CORE_REQUIRED_CHANGES.md`:

- **New `SignatureProviderType`** — add `AGPL_GATEWAY` to the Scentic signature provider type union + Prisma enum.
- **New provider implementation** — `AgplGatewaySignatureProvider` implementing the 8-method `SignatureProvider` interface by calling the gateway.
- **Env-schema validation** — `SCENTIC_AGPL_*` vars with production checks.
- **Provider health service** — `AGPL_GATEWAY` entry in `ProviderTypeHealth` + `checkProviderConfig()` + `allProviders`.
- **Time tracking API routes** — proxy routes with Scentic authorization enforced before gateway calls.
- **Webhook receiver** — `POST /api/agpl/webhooks` with HMAC verification, idempotent persist, firm-scope check.
- **Audit events** — new `AuditEventType` values for AGPL operations.

### Exit criteria (revised)

- ✅ Gateway webhook dispatcher implemented and unit-tested (HMAC signing, retry, idempotency, disabled-state).
- ✅ Local docker-compose bring-up documented and verified.
- ✅ Full Scentic ↔ Gateway interface documented (27 routes + 21 webhooks + HMAC both directions).
- ✅ Scentic-side change spec documented (documentation only, no core edits).
- ⏳ `AGPL_GATEWAY` selectable as a signature provider in Scentic — **deferred to Yair's integration decision** (documentation provided).
- ⏳ End-to-end Scentic → gateway → Kimai/OpenSign → webhook → Scentic — **deferred to AGPL-04** (requires Scentic-side implementation + real upstream containers).

### Remaining gaps (carried forward to AGPL-04)

- Scentic-core-side implementation of `docs/SCENTIC_CORE_REQUIRED_CHANGES.md` (lands when Yair approves).
- Real-Kimai and real-OpenSign container contract tests (mock-only so far).
- Per-user upstream tokens (Kimai + OpenSign).
- Persistent mapping/nonce/idempotency stores (SQLite/Postgres + Redis).
- Production deployment (AGPL-04).

---

## 5. AGPL-04 — Deployment and production readiness  ← NEXT

> **Depends on AGPL-03** (see §7).

### Deliverables

- **Docker Compose for local dev** — finalize the compose file in `docs/DEPLOYMENT.md` §6 at the repo root; verify full-stack local bring-up.
- **GCloud deployment** — provision `scentic-agpl-prod` per `docs/DEPLOYMENT.md`: Cloud Run / GCE for gateway, Kimai, OpenSign; Cloud SQL for Kimai MySQL; MongoDB Atlas for OpenSign; GCS bucket for OpenSign files; VPC peering with the Scentic core project; Internal Load Balancer for the gateway.
- **Secret Manager integration** — all secrets in GCloud Secret Manager, mounted per service; no secrets in env files or images.
- **Health checks and monitoring** — uptime checks, alerts, dashboards per `docs/DEPLOYMENT.md` §7.
- **End-to-end integration tests** — production-like environment tests covering Scentic → gateway → Kimai/OpenSign → webhook → Scentic.
- **Security audit** — auth boundary review, cross-firm leakage tests, secret scan, dependency/license scan, network exposure review (internal-only gateway, public only signing pages).

### Exit criteria

- AGPL stack deployed and healthy in `scentic-agpl-prod`.
- Scentic core successfully calls the gateway over the internal route.
- E2E integration tests pass against the deployed environment.
- Security audit returns no open critical/high findings.

---

## 6. AGPL-05 — Source offer and license compliance verification

> **Depends on AGPL-04** (see §7).

### Deliverables

- **Source offer endpoint** — implement `GET /source-offer` per `docs/SOURCE_OFFER.md` §4.
- **Docker image labels** — add `org.opencontainers.image.license=AGPL-3.0` and `org.opencontainers.image.source` labels to every image (gateway, derived Kimai/OpenSign images).
- **License scan** — CI step that verifies all dependencies are AGPL-3.0-compatible and all required files carry license headers.
- **No proprietary code leakage verification** — CI step (per `docs/SOURCE_OFFER.md` §9) that fails on any `@scentic/*` import, proprietary path, internal hostname, or `.env` value in tracked files.
- **README and UI notices** — per `docs/SOURCE_OFFER.md` §10.
- **Modification log** — populate `docs/SOURCE_OFFER.md` §8 with any patches applied to Kimai/OpenSign.

### Exit criteria

- `GET /source-offer` returns accurate, repo-matching metadata.
- All images carry the required OCI labels.
- License scan and proprietary-leak scan are green in CI.
- README and runtime notices present and reviewed.

---

## 7. Dependencies and ordering

```
AGPL-00 (DONE)
   |
   +---> AGPL-01 (Gateway skeleton + Kimai)  [COMPLETE]  \
   |                                                      +--> AGPL-03 (Local deploy + connection interface) [COMPLETE] --> AGPL-04 (Deploy) [NEXT] --> AGPL-05 (Source offer)
   +---> AGPL-02 (OpenSign integration)  [COMPLETE]      /
```

- **AGPL-01 and AGPL-02 ran in parallel** — they touch separate gateway modules (`gateway/src/kimai/` vs `gateway/src/opensign/` + `gateway/src/signatures/`). Both are COMPLETE.
- **AGPL-03 depends on both AGPL-01 and AGPL-02** — the connection interface requires both Kimai and OpenSign surfaces to exist in the gateway. AGPL-03 delivered local deployment + interface documentation + the webhook dispatcher; Scentic-core-side code is documented but not applied (lands when Yair approves).
- **AGPL-04 depends on AGPL-03** — production deployment is only meaningful once the connection interface is defined and the Scentic side can actually use the gateway.
- **AGPL-05 depends on AGPL-04** — source-offer verification runs against the deployed, built images.

---

## 8. Scentic core changes required

These changes happen in the **Scentic core repository** (separate from this repo), tracked here for cross-team visibility. **AGPL-03 documented all of these in `docs/SCENTIC_CORE_REQUIRED_CHANGES.md` but did NOT apply any of them** (read-only inspection of `scentic.ai`). They land when Yair approves integration.

| Change | Location (Scentic core) | Phase | Status |
|---|---|---|---|
| New `SignatureProviderType` value `AGPL_GATEWAY` | signature provider type union + Prisma enum | AGPL-03 | Documented (not applied) |
| `AGPL_GATEWAY` provider implementation | `packages/signature/` | AGPL-03 | Documented (not applied) |
| Env-schema validation for `SCENTIC_AGPL_*` vars | `env-schema.ts` | AGPL-03 | Documented (not applied) |
| Gateway entry in provider health service | `provider-health-service.ts` | AGPL-03 | Documented (not applied) |
| Time tracking API routes (new feature) | Scentic API routes | AGPL-03 | Documented (not applied) |
| Webhook receiver `POST /api/agpl/webhooks` | Scentic API routes | AGPL-03 | Documented (not applied) |
| New `AuditEventType` values for AGPL ops | `schema.prisma` | AGPL-03 | Documented (not applied) |
| Scentic `.env` additions (see `docs/SCENTIC_ENV_VARS_REQUIRED.md`) | deployment config | AGPL-03 / AGPL-04 | Documented (not applied) |

---

## 9. Risks and blockers

| Risk / blocker | Impact | Mitigation / status |
|---|---|---|
| **OpenSign has no native webhooks.** | Completion detection relies on gateway polling; higher latency and more moving parts than a push model. | Accepted workaround: gateway polls at `OPENSIGN_POLL_INTERVAL_MS` and dispatches HMAC-signed webhooks to Scentic. Revisit if OpenSign adds webhooks upstream. |
| **License compatibility verification.** | AGPL-3.0 (this repo + OpenSign) vs AGPL-3.0-or-later (Kimai) must be confirmed compatible, and all transitive dependencies must be AGPL-compatible. | License scan in CI (AGPL-05); manual review at each release. Track in `docs/SOURCE_OFFER.md`. |
| **GCP project provisioning.** | `scentic-agpl-prod` project, billing, VPC peering, and IAM require admin action outside this repo. | BLOCKED on cloud admin until AGPL-04. Document required provisioning in `docs/DEPLOYMENT.md` and request the minimum admin action needed. |
| **Scentic core change dependency.** | AGPL-03 Scentic-side code lives in a separate repository (Scentic core). | AGPL-03 delivered the Scentic-side change spec as documentation only (`docs/SCENTIC_CORE_REQUIRED_CHANGES.md`); coordinate with Yair to land the implementation; gate AGPL-04 production cutover on the Scentic-side landing. |
| **MongoDB Atlas vs self-hosted.** | Atlas adds a managed-service dependency and cost; self-hosting adds ops burden. | Decision deferred to AGPL-04 based on cost/ops trade-off; both paths documented in `docs/DEPLOYMENT.md`. |
| **PFX certificate for PDF signing.** | Production signing requires a real certificate; dev requires a throwaway cert. | Provision a production certificate before AGPL-04 production cutover; use a dev cert for local/CI. |
| **Kimai API token model.** | Per-user Kimai API tokens must be provisioned and rotated; per-firm service tokens are simpler but reduce per-user attribution. | Decide token model in AGPL-01; store tokens in Secret Manager; rotate every 90 days. |

---

## References

- `docs/DEPLOYMENT.md` — GCloud deployment plan + local deployment.
- `docs/SOURCE_OFFER.md` — AGPL source-offer compliance.
- `docs/SCENTIC_AGPL_CONNECTION_MANUAL.md` — operator connection manual (incl. §12 local deployment).
- `docs/SCENTIC_INTERFACE_SPEC.md` — implemented interface (27 routes + 21 webhooks + HMAC rules).
- `docs/SCENTIC_CORE_REQUIRED_CHANGES.md` — Scentic-side changes (documentation only).
- `docs/SCENTIC_ENV_VARS_REQUIRED.md` — Scentic-side env vars.
- `docs/AGPL_03_CLOSEOUT.md` — AGPL-03 closeout.
- `docs/AGPL_03_EVIDENCE.md` — AGPL-03 executed evidence.
- `docs/API_CONTRACTS.md` — gateway API contracts (planning surface).
- `.env.example` — environment variable list.
- `factory/STATE.md` (Scentic core) — phase gate state, where AGPL-* progress is recorded.
