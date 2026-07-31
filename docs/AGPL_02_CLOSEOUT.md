# AGPL-02 Phase Closeout

> **Phase:** AGPL-02 — OpenSign integration foundation
> **Status:** OPENSIGN INTEGRATION FOUNDATION COMPLETE
> **Commit SHA:** `fd53268`
> **Date:** 2026-07-31

---

## 1. Summary

AGPL-02 delivered the OpenSign integration foundation inside the AGPL-licensed `scentic-agpl-services` gateway. The OpenSign client, service, mapping extensions, event outbox extensions, REST routes, and config/env validation all live in `gateway/` under this AGPL-licensed repository. No Scentic proprietary core code was modified and no OpenSign upstream code was touched (OpenSign remains pinned at the AGPL-01 SHA).

### What was implemented

- **OpenSign API client** (`gateway/src/opensign/opensign-client.ts`):
  - Wraps the Parse Server REST API (`<host>/api/app`).
  - Verified endpoints from `vendor/opensign/` source inspection: `login`, `createTenant`, `addUser`, `getUserId`, `uploadFile` (`savefile`), `createDocument` (`createdocumentfromapp`), `getDocument`, `linkContactToDoc` (`linkcontacttodoc`), `declineDocument` (`declinedoc`), `getSignedUrl` (`getsignedurl`), `generateCertificate` (`generatecertificate`).
  - Auth via `X-Parse-Application-Id` + `X-Parse-Session-Token` or `X-Parse-Master-Key`.
  - Typed `OpenSignResult<T>` wrappers and safe error normalization (raw upstream bodies never exposed to Scentic).
- **OpenSign service** (`gateway/src/opensign/opensign-service.ts`):
  - Firm-scoped operations (per-firm OpenSign tenant + user mappings).
  - Polling model for completion detection (no native OpenSign webhooks).
  - Idempotent firm init and user sync.
  - Workflow create / get / send / cancel / remind / poll / completed-status / poll-due.
- **11 signature REST endpoints** (`gateway/src/routes/signature.ts`):
  1. `GET  /api/v1/providers/opensign/health`
  2. `POST /api/v1/firms/:firmId/signature/init`
  3. `POST /api/v1/firms/:firmId/signature/users/sync`
  4. `POST /api/v1/firms/:firmId/signature/workflows`
  5. `GET  /api/v1/firms/:firmId/signature/workflows/:workflowId`
  6. `POST /api/v1/firms/:firmId/signature/workflows/:workflowId/send`
  7. `POST /api/v1/firms/:firmId/signature/workflows/:workflowId/cancel`
  8. `POST /api/v1/firms/:firmId/signature/workflows/:workflowId/remind`
  9. `POST /api/v1/firms/:firmId/signature/workflows/:workflowId/poll`
  10. `GET  /api/v1/firms/:firmId/signature/workflows/:workflowId/completed`
  11. `POST /api/v1/firms/:firmId/signature/poll-due`
- **Extended mapping store** (`gateway/src/mappings/`) with OpenSign entity types: `Firm` (tenant), `User`, `Workflow`, `Signer`. Firm-scoped with cross-firm leakage prevention inherited from the AGPL-01 store.
- **Extended event outbox** (`gateway/src/events/outbox.ts`) with **12 OpenSign event types**:
  `OPENSIGN_CONNECTION_HEALTH_CHANGED`, `OPENSIGN_FIRM_INITIALIZED`, `OPENSIGN_USER_SYNCED`, `OPENSIGN_WORKFLOW_CREATED`, `OPENSIGN_WORKFLOW_SENT`, `OPENSIGN_WORKFLOW_STATUS_CHANGED`, `OPENSIGN_WORKFLOW_COMPLETED`, `OPENSIGN_WORKFLOW_CANCELLED`, `OPENSIGN_WORKFLOW_REMINDER_SENT`, `OPENSIGN_COMPLETED_PDF_READY`, `OPENSIGN_CERTIFICATE_READY`, `OPENSIGN_SYNC_FAILED`.
- **Config / env validation for OpenSign** (`gateway/src/config.ts`):
  - `OPENSIGN_ENABLED`, `OPENSIGN_BASE_URL`, `OPENSIGN_APP_ID`, `OPENSIGN_MASTER_KEY`, `OPENSIGN_ADMIN_EMAIL`, `OPENSIGN_ADMIN_PASSWORD`, `OPENSIGN_POLL_INTERVAL_SECONDS`, `OPENSIGN_COMPLETION_TIMEOUT_SECONDS`.
  - Production checks reject placeholder master key / admin password, public OpenSign base URLs, and missing required vars when `OPENSIGN_ENABLED=true`.
- **AGPL-01 fixes carried into AGPL-02**:
  - Auth middleware path-firm check fixed: `extractFirmIdFromPath()` resolves `firmId` from `/api/v1/firms/:firmId/...` when middleware is mounted at app level (where `req.params` is empty). Without this, a signed firm ID could not be compared against the path firm ID.
  - Bodyless request canonical hash documented and enforced: `express.json()` initializes `req.body` to `{}` for GET/DELETE-without-body, so the body hash is `JSON.stringify({}) = '{}'`. All Scentic-core signers must replicate this for bodyless requests (see `docs/API_CONTRACTS.md`).
- **Source offer updated** (`docs/SOURCE_OFFER.md`): OpenSign license inconsistency note added (root `LICENSE` is AGPL-3.0; `apps/OpenSignServer/package.json` declares MIT). Treated conservatively as AGPL-3.0.
- **OpenSign unsupported operations documented** (`docs/OPENSIGN_MAPPING.md`):
  - Manual reminders: `NOT_SUPPORTED`. Automatic reminders are configured per-document via `AutomaticReminders` + `RemindOnceInEvery`.
  - Native void/cancel: not available. `declinedoc` is the closest function and is used as the cancel fallback.
  - Delegate signer: not exposed via stable Cloud Functions.
  - Native webhooks: none. The gateway polls `getDocument` for status changes.

### OpenSign API capabilities verified (from `vendor/opensign/` source)

- `login` (POST `/login`)
- `createTenant` (POST `/classes/partners_Tenant`)
- `addUser` (`adduser` Cloud Function)
- `uploadFile` (`savefile` Cloud Function)
- `createDocument` (`createdocumentfromapp` Cloud Function)
- `getDocument` (`getDocument` Cloud Function)
- `linkContactToDoc` (`linkcontacttodoc` Cloud Function)
- `declineDocument` (`declinedoc` Cloud Function)
- `getSignedUrl` (`getsignedurl` Cloud Function)
- `generateCertificate` (`generatecertificate` Cloud Function)

### OpenSign unsupported operations

| Operation | Status | Workaround |
|-----------|--------|------------|
| Manual reminders | `NOT_SUPPORTED` | Automatic reminders configured per-doc (`AutomaticReminders`, `RemindOnceInEvery`). |
| Native void/cancel | Not available | `declinedoc` used as closest equivalent (marks doc declined). |
| Delegate signer | Not exposed via stable Cloud Function | Not implemented in AGPL-02. |
| Native webhooks | None | Gateway polls `getDocument` per active workflow on `OPENSIGN_POLL_INTERVAL_SECONDS`. |

### Polling model

OpenSign emits no native webhooks. The gateway maintains a list of active (non-terminal) workflows per Firm and polls `getDocument` at `OPENSIGN_POLL_INTERVAL_SECONDS` (default 30s). On a status change (signer signed, declined, completed, expired), the gateway records an outbox event for future webhook dispatch to Scentic. Polling stops for a workflow once it reaches a terminal status. Webhook dispatch to Scentic is AGPL-03 scope.

## 2. Tests

42 tests across 8 new suites covering: OpenSign client (mocked Parse REST), signature workflow lifecycle, polling worker, mapping firm-scoping for OpenSign entities, event outbox OpenSign event types, config/env validation (production rejection of placeholder master key / public OpenSign URL), and docs/scans (OpenSign at pinned SHA, license inconsistency documented).

> Test runner: Vitest (`gateway/vitest.config.ts`). Mock-only OpenSign HTTP in unit tests; no real OpenSign container contract test yet (carried gap).

## 3. Validator results

Independent validation performed via:

- Typecheck: PASS (`tsc --noEmit`, zero errors)
- Test suite: 79/79 PASS (14 files: 6 AGPL-01 + 8 AGPL-02 suites, all passing)
- Build: PASS (`tsc` compiled, dist/ emitted)
- Scentic core boundary: PASS (no AGPL-02 modifications to scentic.ai)
- OpenSign boundary: PASS (vendor/opensign at pinned SHA, unmodified)
- No `@scentic/*` imports: PASS (zero matches in gateway source)
- License scan: PASS (AGPL-3.0 LICENSE present; OpenSign license inconsistency documented in `docs/SOURCE_OFFER.md`)

Validators (custom droids) not run for AGPL-02 (no custom droids configured for the AGPL repo).

## 4. Boundary verification

- **Scentic core (`scentic.ai`):** NOT MODIFIED. Read-only inspection only. No tracked file in `scentic.ai` was edited during AGPL-02. See `docs/AGPL_02_EVIDENCE.md` for the Scentic core git status snapshot.
- **OpenSign (`vendor/opensign/`):** NOT MODIFIED. OpenSign remains checked out at the pinned SHA `f72624fa26211fe00776453d99a67120a4f5e060`. All integration is via the gateway-side client.

## 5. Remaining gaps (carried forward)

| Gap | Current state | Production requirement | Resolution phase |
|-----|---------------|--------------------------|------------------|
| Per-user session tokens | Gateway uses the master key for all OpenSign operations (admin login → session token held in client). | Provision per-user OpenSign session tokens; use master key only for tenant/user provisioning. | AGPL-04 |
| Mapping store | In-memory `Map`-backed store. | Replace with SQLite (single-instance) or Postgres (multi-instance). | AGPL-04 |
| OpenSign tests | Mock-only OpenSign HTTP in unit tests. | Add a real-OpenSign-container contract test in CI covering the full create → send → poll → completed lifecycle. | AGPL-04 |
| Real OpenSign container test | None. | Real OpenSign Docker contract test in CI. | AGPL-04 |
| Webhook dispatch to Scentic | Outbox records OpenSign events but does not dispatch. | Dispatch wired in AGPL-03 with HMAC signing against `SCENTIC_WEBHOOK_HMAC_SECRET`. | AGPL-03 |

These gaps do not block AGPL-02 closeout (the phase scope is the OpenSign integration foundation), but they MUST be resolved before AGPL-04 production readiness.

## 6. Next phase

**AGPL-03 — Scentic-side provider adapters.**

AGPL-03 lands the Scentic-core side: the `AGPL_GATEWAY` `SignatureProviderType`, the gateway provider implementation, env-schema validation, provider health service entry, time-tracking API routes, and the webhook receiver that consumes the OpenSign (and Kimai) events emitted by this gateway. See `docs/NEXT_STEPS.md` §4 for the AGPL-03 deliverables and exit criteria.

## 7. References

- `docs/AGPL_02_EVIDENCE.md` — executed evidence for this phase.
- `docs/UPSTREAM_SOURCES.md` — pinned upstream SHAs.
- `docs/API_CONTRACTS.md` — full API contract surface (including §6.3 Signature (OpenSign)).
- `docs/OPENSIGN_MAPPING.md` — Scentic ↔ OpenSign entity mapping with verified API details.
- `docs/SOURCE_OFFER.md` — OpenSign license inconsistency note.
- `docs/SECURITY_THREAT_MODEL.md` — T-02 / T-16 mitigation notes.
- `docs/SCENTIC_AGPL_CONNECTION_MANUAL.md` — OpenSign configuration section.
- `docs/NEXT_STEPS.md` — phased roadmap.
