# AGPL Services — Next Steps & Implementation Roadmap

> **Status:** Planning document (AGPL-00). Tracks the phased implementation of the Scentic AGPL services stack (gateway + Kimai + OpenSign) and the required Scentic core changes.

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

---

## 3. AGPL-02 — OpenSign integration

> **Parallelizable with AGPL-01** (see §7).

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

---

## 4. AGPL-03 — Scentic-side provider adapters

> **Depends on AGPL-01 and AGPL-02** (see §7).

### Deliverables (Scentic core changes — separate repository)

- **New `SignatureProviderType`** — add `AGPL_GATEWAY` to the Scentic signature provider type union.
- **New provider implementation** in `packages/signature/` — implements the Scentic signature provider interface by calling the AGPL gateway (create/send/status/cancel/download).
- **Env-schema validation** — add `SCENTIC_AGPL_GATEWAY_URL`, `SCENTIC_AGPL_SERVICE_TOKEN`, `SCENTIC_AGPL_WEBHOOK_SECRET`, `SCENTIC_AGPL_SIGNATURE_PROVIDER_TYPE` to `env-schema.ts` with correct types and secret-marking.
- **Provider health service** — register the gateway in `provider-health-service.ts` so `GET /health` and the admin UI surface gateway status.
- **Time tracking API routes** (new feature) — Scentic routes that proxy time-entry CRUD to the gateway for the calling user's Firm. Enforce Scentic authorization (firm/user scope) before calling the gateway.
- **Webhook receiver** — `POST /api/agpl/webhooks/events` with HMAC verification, idempotent persist, and dispatch to the signature status update pipeline.

### Tests (Scentic core)

- Unit tests for the `AGPL_GATEWAY` provider (mocked gateway).
- env-schema validation tests (valid/invalid `SCENTIC_AGPL_*`).
- Provider health service tests (gateway up/down propagation).
- Authorization tests: a user may only act within their Firm; cross-firm requests rejected.
- Webhook receiver tests (valid HMAC accepted, invalid rejected, duplicate idempotent).
- End-to-end test: Scentic → gateway → Kimai/OpenSign → webhook → Scentic status update.

### Exit criteria

- `AGPL_GATEWAY` is selectable as a signature provider in Scentic.
- A signature workflow can be initiated from Scentic, completed in OpenSign, and the status reflected back in Scentic via webhook.
- Time entries can be created/listed from Scentic through the gateway into Kimai.

---

## 5. AGPL-04 — Deployment and production readiness

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
   +---> AGPL-01 (Gateway skeleton + Kimai)  \
   |                                          +--> AGPL-03 (Scentic adapters) --> AGPL-04 (Deploy) --> AGPL-05 (Source offer)
   +---> AGPL-02 (OpenSign integration)      /
```

- **AGPL-01 and AGPL-02 can run in parallel** — they touch separate gateway modules (`gateway/src/kimai/` vs `gateway/src/opensign/` + `gateway/src/signatures/`).
- **AGPL-03 depends on both AGPL-01 and AGPL-02** — Scentic adapters require both Kimai and OpenSign surfaces to exist in the gateway.
- **AGPL-04 depends on AGPL-03** — production deployment is only meaningful once the Scentic side can actually use the gateway.
- **AGPL-05 depends on AGPL-04** — source-offer verification runs against the deployed, built images.

---

## 8. Scentic core changes required

These changes happen in the **Scentic core repository** (separate from this repo), tracked here for cross-team visibility:

| Change | Location (Scentic core) | Phase |
|---|---|---|
| New `SignatureProviderType` value `AGPL_GATEWAY` | signature provider type union | AGPL-03 |
| `AGPL_GATEWAY` provider implementation | `packages/signature/` | AGPL-03 |
| Env-schema validation for `SCENTIC_AGPL_*` vars | `env-schema.ts` | AGPL-03 |
| Gateway entry in provider health service | `provider-health-service.ts` | AGPL-03 |
| Time tracking API routes (new feature) | Scentic API routes | AGPL-03 |
| Webhook receiver `POST /api/agpl/webhooks/events` | Scentic API routes | AGPL-03 |
| Scentic `.env` additions (see connection manual §3) | deployment config | AGPL-03 / AGPL-04 |

---

## 9. Risks and blockers

| Risk / blocker | Impact | Mitigation / status |
|---|---|---|
| **OpenSign has no native webhooks.** | Completion detection relies on gateway polling; higher latency and more moving parts than a push model. | Accepted workaround: gateway polls at `OPENSIGN_POLL_INTERVAL_MS` and dispatches HMAC-signed webhooks to Scentic. Revisit if OpenSign adds webhooks upstream. |
| **License compatibility verification.** | AGPL-3.0 (this repo + OpenSign) vs AGPL-3.0-or-later (Kimai) must be confirmed compatible, and all transitive dependencies must be AGPL-compatible. | License scan in CI (AGPL-05); manual review at each release. Track in `docs/SOURCE_OFFER.md`. |
| **GCP project provisioning.** | `scentic-agpl-prod` project, billing, VPC peering, and IAM require admin action outside this repo. | BLOCKED on cloud admin until AGPL-04. Document required provisioning in `docs/DEPLOYMENT.md` and request the minimum admin action needed. |
| **Scentic core change dependency.** | AGPL-03 requires edits to a separate repository (Scentic core). | Coordinate cross-repo; gate AGPL-04 on AGPL-03 landing in Scentic core. |
| **MongoDB Atlas vs self-hosted.** | Atlas adds a managed-service dependency and cost; self-hosting adds ops burden. | Decision deferred to AGPL-04 based on cost/ops trade-off; both paths documented in `docs/DEPLOYMENT.md`. |
| **PFX certificate for PDF signing.** | Production signing requires a real certificate; dev requires a throwaway cert. | Provision a production certificate before AGPL-04 production cutover; use a dev cert for local/CI. |
| **Kimai API token model.** | Per-user Kimai API tokens must be provisioned and rotated; per-firm service tokens are simpler but reduce per-user attribution. | Decide token model in AGPL-01; store tokens in Secret Manager; rotate every 90 days. |

---

## References

- `docs/DEPLOYMENT.md` — GCloud deployment plan.
- `docs/SOURCE_OFFER.md` — AGPL source-offer compliance.
- `docs/SCENTIC_AGPL_CONNECTION_MANUAL.md` — operator connection manual.
- `docs/API_CONTRACTS.md` — gateway API contracts (referenced).
- `.env.example` — environment variable list.
- `factory/STATE.md` (Scentic core) — phase gate state, where AGPL-* progress is recorded.
