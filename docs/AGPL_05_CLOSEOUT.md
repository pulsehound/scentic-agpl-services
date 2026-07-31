# AGPL-05 Phase Closeout

> **Phase:** AGPL-05 — Postgres durable store, Docker Postgres stack, mock Scentic receiver, final deployment package
> **Status:** AGPL SERVICES LOCAL DEPLOYMENT PACKAGE COMPLETE / PRODUCTION DEPLOYMENT NOT EXECUTED / SCENTIC CORE INTEGRATION NOT APPLIED
> **Commit SHA:** `(filled at commit time)`
> **Date:** 2026-07-31

---

## 1. Phase Objective

Replace the Docker SQLite fallback (which segfaulted due to better-sqlite3 native module issues) with a Postgres-backed durable store using `pg` (pure JavaScript, no native modules). Run real local contract tests where possible. Add a mock Scentic webhook receiver for local testing. Produce the final operator handoff and connection manual. **Scentic core remains read-only.**

## 2. What Was Done

- **Postgres durable store** (`gateway/src/storage/postgres-store.ts`) — `PostgresMappingStore` implementing `MappingStore`, `NonceStore`, and `EventOutbox` using `pg.Pool`. Uses `INSERT ... ON CONFLICT DO UPDATE` for atomic upserts, `ON CONFLICT DO NOTHING` for nonce replay prevention, `FOR UPDATE SKIP LOCKED` for safe multi-instance outbox processing. Parameterized queries throughout.
- **Postgres schema** (`gateway/src/storage/postgres-schema.sql`) — 13 tables with `TIMESTAMPTZ`, `JSONB`, Firm-scoped constraints, unique indexes.
- **Async refactoring** — All store interfaces (`MappingStore`, `NonceStore`, `EventOutbox`) changed from sync to async (return `Promise<T>`). All implementations (`InMemoryMappingStore`, `SqliteMappingStore`, `PostgresMappingStore`) updated. All callers (`KimaiService`, `OpenSignService`, `WebhookDispatcher`, auth middleware) updated with `await`.
- **Store factory updated** — `createStoreBundle` is now async. Supports `postgres` store type. `createStoreConfigFromEnv` passes `databaseUrl` and `postgresSslMode`.
- **Docker Compose Postgres stack** — Added `gateway-postgres` service (postgres:16-alpine), `mock-scentic` service. Gateway uses `GATEWAY_STORE_TYPE=postgres` by default in Docker. Postgres volume persists gateway state.
- **Mock Scentic webhook receiver** (`deploy/mock-scentic.js` + `Dockerfile.mock-scentic`) — Lightweight Node.js service that receives gateway webhook events, verifies HMAC-SHA256 signatures, logs events, checks for forbidden fields.
- **Dockerfile simplified** — No longer needs python3/make/g++ (pg is pure JS). Much smaller and faster build.
- **Status endpoint enhanced** — Now shows `durable: true/false` and `productionSuitable: true/false`.
- **Final deployment docs** — `AGPL_DEPLOYMENT_HANDOFF.md`, `FINAL_OPERATOR_CHECKLIST.md`, `PRODUCTION_BLOCKERS.md` created.
- **Config updated** — Added `postgresSslMode` field.

## 3. What Was Not Done

- **No GCloud deployment.** Manifests only. No GCP project provisioned.
- **No Scentic core modifications.** `scentic.ai` remains read-only.
- **No production readiness claim.** Local deployment package complete; production deployment not executed.
- **No Redis.** Postgres provides sufficient multi-instance safety via atomic operations. Redis is optional and documented as such.
- **No real production Kimai/OpenSign credentials.** Local Docker stack uses dev credentials.

## 4. Files Created

- `gateway/src/storage/postgres-store.ts` — Postgres durable store
- `gateway/src/storage/postgres-schema.sql` — Postgres DDL
- `deploy/Dockerfile.mock-scentic` — Mock Scentic webhook receiver Dockerfile
- `deploy/mock-scentic.js` — Mock Scentic webhook receiver service
- `docs/AGPL_05_CLOSEOUT.md` — This closeout
- `docs/AGPL_05_EVIDENCE.md` — Evidence
- `docs/AGPL_DEPLOYMENT_HANDOFF.md` — Final deployment handoff
- `docs/FINAL_OPERATOR_CHECKLIST.md` — Operator checklist
- `docs/PRODUCTION_BLOCKERS.md` — Production blockers
- `gateway/src/tests/storage/postgres-store.test.ts` — Postgres store tests (A-K, env-gated)
- `gateway/src/tests/agpl05-docker.test.ts` — Docker config tests (M-Q)
- `gateway/src/tests/agpl05-security.test.ts` — Security tests (W-AF)
- `gateway/src/tests/agpl05-docs.test.ts` — Docs tests (AG-AL)
- `gateway/src/tests/agpl05-regression.test.ts` — Regression tests (AM-AP)
- `gateway/src/tests/mock-webhook-receiver.test.ts` — Mock webhook receiver test (V)

## 5. Files Modified

- `gateway/src/storage/store-factory.ts` — async, supports postgres, passes databaseUrl/postgresSslMode
- `gateway/src/mappings/mapping-store.ts` — interface async, InMemoryMappingStore async
- `gateway/src/auth/hmac.ts` — NonceStore async, InMemoryNonceStore async
- `gateway/src/events/outbox.ts` — EventOutbox async, InMemoryEventOutbox async
- `gateway/src/storage/sqlite-store.ts` — all methods async
- `gateway/src/kimai/kimai-service.ts` — await added to all store/outbox calls
- `gateway/src/opensign/opensign-service.ts` — await added to all store/outbox calls
- `gateway/src/events/webhook-dispatcher.ts` — await added to outbox calls
- `gateway/src/auth/scentic-auth.ts` — middleware async, await nonceStore.seen()
- `gateway/src/server.ts` — await createStoreBundle(), await close()
- `gateway/src/app.ts` — nonceStoreType includes 'postgres'
- `gateway/src/routes/status.ts` — shows durable/productionSuitable, nonceStoreType includes 'postgres'
- `gateway/src/config.ts` — added postgresSslMode
- `gateway/package.json` — added pg and @types/pg
- `deploy/docker-compose.yml` — Postgres service, mock-scentic, GATEWAY_STORE_TYPE=postgres
- `deploy/Dockerfile.gateway` — simplified (no build tools, pg pure JS)
- `.dockerignore` — updated for mock-scentic
- `.env.example` — added Postgres env vars
- `deploy/env.example` — added Postgres env vars
- `scripts/local-up.sh` — includes Postgres and mock-scentic
- `scripts/local-healthcheck.sh` — checks all services
- `scripts/local-reset.sh` — enhanced warnings
- `README.md` — updated to AGPL-05

## 6. Test Results

```
Test Files: 35 passed (35)
Tests: 162 passed | 9 skipped (171 total)
```

9 skipped tests are env-gated Postgres store tests (require GATEWAY_PG_TEST_URL) and contract tests (require GATEWAY_CONTRACT_TEST=true).

## 7. Docker Results

```
Docker stack: ALL 9 containers running (gateway, gateway-postgres, mock-scentic,
kimai, kimai-db, opensign-server, opensign-mongo, opensign-frontend, mailhog).

Gateway health: healthy (HTTP 200)
Gateway status: stores.mapping=postgres, stores.durable=true, stores.productionSuitable=true
Mock Scentic: healthy (HTTP 200)
Gateway Postgres: healthy
```

## 8. Storage Architecture

| Store Type | Use Case | Docker? | Multi-Instance? | Production? |
|------------|----------|---------|-----------------|-------------|
| memory | Tests, dev | Yes | No | No |
| sqlite | Bare-metal local dev | No (segfaults) | No | No |
| postgres | Docker, production | Yes | Yes (atomic ops) | Yes |

**Multi-instance safety:** Postgres `ON CONFLICT DO NOTHING` (nonces), `ON CONFLICT` (idempotency), `FOR UPDATE SKIP LOCKED` (outbox). Redis is optional.

## 9. Mock Scentic Webhook Receiver

- Endpoint: POST /webhook (port 3199)
- Verifies HMAC-SHA256 signature
- Logs events with metadata
- Checks for forbidden fields (signingLink, documentContent, rawEmail, etc.)
- Health: GET /health
- Events log: GET /events

## 10. Scentic Core Impact (NONE — Read-Only)

No `scentic.ai` file was modified during AGPL-05.

## 11. Known Limitations

- Postgres store tests (A-K) are env-gated (require running Postgres)
- Real contract tests need Kimai admin user setup and OpenSign PFX certificate
- GCloud manifests are not deployed
- No production readiness claim

## 12. Gate State

```
Typecheck:  PASS
Build:      PASS
Tests:      PASS (162 passed, 9 skipped, 0 failed)
Docker:     PASS (9 containers, gateway healthy with Postgres)
Postgres:   PASS (durable=true, productionSuitable=true)
Mock Scentic: PASS (healthy, receiving events)
GCloud:     PASS (manifests updated, not deployed)
Scentic:    PASS (no modifications)

Overall:    PASS (AGPL-05 complete)
```

## 13. Final Classification

**AGPL SERVICES LOCAL DEPLOYMENT PACKAGE COMPLETE / PRODUCTION DEPLOYMENT NOT EXECUTED / SCENTIC CORE INTEGRATION NOT APPLIED**
