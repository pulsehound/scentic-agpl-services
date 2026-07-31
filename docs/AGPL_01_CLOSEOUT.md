# AGPL-01 Phase Closeout

> **Phase:** AGPL-01 — Gateway skeleton + Kimai integration foundation
> **Status:** GATEWAY SKELETON + KIMAI INTEGRATION FOUNDATION COMPLETE
> **Commit SHA:** `<FILL_AFTER_COMMIT>`
> **Date:** 2026-07-31

---

## 1. Summary

AGPL-01 delivered the Scentic-facing gateway skeleton and the Kimai integration foundation. The gateway is a Node.js / Express / TypeScript application with Vitest tests, living entirely in `gateway/` under this AGPL-licensed repository. No Scentic proprietary core code was modified and no OpenSign code was touched (OpenSign is AGPL-02 scope).

### What was implemented

- **Gateway Node.js/Express/TypeScript app** with Vitest test runner, strict TypeScript config, pnpm workspace wiring.
- **HMAC service-to-service auth** (`gateway/src/auth/`):
  - HMAC-SHA256 signature over canonical string (method, path, query, timestamp, nonce, body-hash, firm-id, user-id, correlation-id).
  - Constant-time signature comparison via `crypto.timingSafeEqual`.
  - Timestamp tolerance (5-minute window) + nonce replay protection via `InMemoryNonceStore`.
  - Firm scoping: `X-Scentic-Firm-Id` header validated against HMAC-signed firm ID; path-level firm ID mismatch detection (finding: enforcement at store/service layer when middleware mounted at app level).
  - Public routes: `GET /health` and `GET /source` (no auth required).
- **In-memory mapping store** (`gateway/src/mappings/`):
  - `Firm`, `User`, `Client`, `Matter`, `Activity`, `TimeEntry` entity types.
  - Firm-scoped CRUD with cross-firm leakage prevention.
  - Placeholder for OpenSign tenant mapping (AGPL-02).
- **Kimai API client** (`gateway/src/kimai/kimai-client.ts`):
  - REST client over `KIMAI_BASE_URL` + `KIMAI_ADMIN_API_TOKEN`.
  - Endpoints verified against Kimai source (`vendor/kimai/`): teams, users, customers, projects, activities, timesheets.
  - Typed response wrappers and error normalization.
- **Kimai service** (`gateway/src/kimai/kimai-service.ts`):
  - Firm-scoped operations (per-firm Kimai team/user/customer/project/activity).
  - Confidential label mode (`KIMAI_USE_CONFIDENTIAL_LABELS`) for sensitive matter/customer names.
  - Time entry create/list/update/delete against Kimai timesheets.
- **REST API endpoints** (`gateway/src/routes/`):
  - `GET /health` — liveness + Kimai dependency probe.
  - `GET /source` — AGPL-3.0 source-offer metadata (public, no auth).
  - `POST /api/v1/firms/:firmId/init` — initialize a Firm in the mapping store.
  - `POST /api/v1/firms/:firmId/users/sync` — Scentic user → Kimai user sync.
  - `POST /api/v1/firms/:firmId/clients/sync` — Scentic client → Kimai customer sync.
  - `POST /api/v1/firms/:firmId/matters/sync` — Scentic matter → Kimai project sync.
  - `POST /api/v1/firms/:firmId/activities/sync` — Scentic activity → Kimai activity sync.
  - `POST /api/v1/firms/:firmId/time-entries` — create time entry (idempotent via `scenticTimeEntryId`).
  - `GET /api/v1/firms/:firmId/time-entries` — list time entries (firm-filtered).
  - `GET /api/v1/firms/:firmId/time-entries/:entryId` — get single time entry.
  - `PATCH /api/v1/firms/:firmId/time-entries/:entryId` — update time entry.
  - `DELETE /api/v1/firms/:firmId/time-entries/:entryId` — delete time entry.
  - `POST /api/v1/firms/:firmId/time-entries/export` — export time entries (firm-filtered).
  - `GET /api/v1/providers/kimai/health` — Kimai health check.
  - `POST /api/v1/firms/:firmId/disable` — disable firm (admin).
  - `POST /api/v1/admin/test-connection` — test Kimai connection (admin).
- **Event outbox** (`gateway/src/events/outbox.ts`):
  - In-memory outbox for future webhook dispatch to Scentic core.
  - Event id idempotency, ready for AGPL-02 / AGPL-03 webhook delivery.
- **Upstream source pinning** (`docs/UPSTREAM_SOURCES.md`):
  - Kimai pinned to `7c2ed4b07cca2e15b1ab4cc5947afdf899a76401` (AGPL-3.0-or-later).
  - OpenSign pinned to `f72624fa26211fe00776453d99a67120a4f5e060` (AGPL-3.0).
  - Reproduction commands documented.
- **Config / env validation** (`gateway/src/config.ts`):
  - Strict env loading with `GatewayConfig` typed shape.
  - Production checks reject placeholder secrets, public internal URLs, missing required vars.
  - Secret redaction helper.

## 2. Tests

37 tests across 6 suites covering:

- **Auth (A–G, 7 tests):** valid HMAC accepted; missing signature 401; bad signature 401; stale timestamp 401; replay nonce 401; path-vs-signed firm mismatch 403; secrets redacted from health endpoint.
- **Mappings (H–M, 6 tests):** firm init idempotency; user mapping firm-scoped; same user in two firms; cross-firm matter use rejected; client/matter cannot cross firm; time-entry list firm-filtered.
- **Kimai client (N–Q, 5 tests):** healthy response handled; down response safe; raw 500 body never exposed; `notSupported()`/`wrapUpstreamError()` produce safe errors.
- **Time API (R–X, 7 tests):** missing scenticUserId 400; create with mappings 200; list firm-filtered; update/delete cross-firm 404; export firm-filtered; idempotent create returns existing.
- **Security (Y–AD, 6 tests):** firm2 can't read firm1 mappings; no secrets in outbox events; confidential-label-off uses codes not names; `/source` exposes no secrets; non-existent entry probe 404 not 500; OpenSign at pinned SHA.
- **Docs / scans (AE–AJ, 6 tests):** UPSTREAM_SOURCES.md pins both SHAs; LICENSE is AGPL-3.0; README has source-offer; no `@scentic/*` imports in gateway; Scentic core git status clean of AGPL-01 artifacts.

Test runner: Vitest (`gateway/vitest.config.ts`).

## 3. Validator results

Validators not run for AGPL-01 (no custom droids configured for AGPL repo). Independent validation performed via:
- Typecheck: PASS (tsc --noEmit, zero errors)
- Test suite: 37/37 PASS (6 files, 842ms)
- Build: PASS (tsc compiled successfully)
- Scentic core boundary: PASS (no AGPL-01 modifications to scentic.ai)
- OpenSign boundary: PASS (vendor/opensign at pinned SHA, unmodified)
- No `@scentic/*` imports: PASS (zero matches in gateway source)
- License scan: PASS (AGPL-3.0 LICENSE present, README declares AGPL)

## 4. Boundary verification

- **Scentic core (`scentic.ai`):** NOT MODIFIED. Read-only inspection only. No tracked file in `scentic.ai` was edited during AGPL-01. See `AGPL_01_EVIDENCE.md` for the Scentic core git status snapshot.
- **OpenSign (`vendor/opensign/`):** NOT MODIFIED. OpenSign integration is AGPL-02 scope. The OpenSign client module directory (`gateway/opensign/`) contains a `.gitkeep` placeholder only.

## 5. Remaining gaps (carried forward)

| Gap | Current state | Production requirement |
|-----|---------------|--------------------------|
| Per-user Kimai API token | Gateway falls back to `KIMAI_ADMIN_API_TOKEN` for all firms/users. | Provision per-user Kimai API tokens, store in Secret Manager, rotate every 90 days. |
| Nonce store | In-memory nonce store inside the auth module. | Move to Redis (or equivalent shared, TTL-backed store) for multi-instance deployments. |
| Mapping store | In-memory `Map`-backed store. | Replace with SQLite (single-instance) or Postgres (multi-instance) before production. |
| Kimai integration test | Mock-only Kimai HTTP in unit tests. | Add a real-Kimai-container contract test in CI covering the full mapping + time-entry lifecycle. |
| Webhook dispatch | Event outbox records events but does not yet dispatch. | Dispatch wired in AGPL-02 / AGPL-03 with HMAC signing against `SCENTIC_WEBHOOK_HMAC_SECRET`. |

These gaps do not block AGPL-01 closeout (the phase scope is the gateway skeleton + Kimai foundation), but they MUST be resolved before AGPL-04 production readiness.

## 6. Next phase

**AGPL-02 — OpenSign integration.**

See `docs/NEXT_STEPS.md` §3 for the AGPL-02 deliverables, tests, and exit criteria. AGPL-01 and AGPL-02 are parallelizable; AGPL-02 touches `gateway/src/opensign/` and `gateway/src/signatures/`, which are disjoint from AGPL-01's `gateway/src/kimai/` and `gateway/src/mappings/`.

## 7. References

- `docs/AGPL_01_EVIDENCE.md` — executed evidence for this phase.
- `docs/UPSTREAM_SOURCES.md` — pinned upstream SHAs.
- `docs/API_CONTRACTS.md` — full API contract surface.
- `docs/KIMAI_MAPPING.md` — Scentic ↔ Kimai entity mapping.
- `docs/SECURITY_THREAT_MODEL.md` — security threat model.
- `docs/NEXT_STEPS.md` — phased roadmap.
